const { pool } = require('../config/db');
const env = require('../config/env');
const { getPlan, normalizePlan } = require('../config/plans');
const billingService = require('./billingService');
const { sendPublicationConfirmation } = require('./mailService');

class PaymentError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
  }
}

function apiBase() {
  return env.zarinpal.sandbox ? 'https://sandbox.zarinpal.com/pg/v4/payment' : 'https://payment.zarinpal.com/pg/v4/payment';
}

function startPayBase() {
  return env.zarinpal.sandbox ? 'https://sandbox.zarinpal.com/pg/StartPay/' : 'https://payment.zarinpal.com/pg/StartPay/';
}

async function callZarinpal(path, body) {
  if (!env.zarinpal.merchantId) throw new PaymentError('Payment gateway is not configured', 503);
  const response = await fetch(`${apiBase()}/${path}.json`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new PaymentError('Payment gateway is temporarily unavailable', 502);
  return data;
}

async function createPayment(userId, email, planName) {
  const plan = getPlan(planName);
  if (!plan) throw new PaymentError('Invalid plan');
  const canonicalPlan = normalizePlan(planName);

  const account = await pool.query('SELECT id FROM users WHERE id = $1 AND is_active = true LIMIT 1', [userId]);
  if (!account.rows[0]) throw new PaymentError('Account is not available', 404);

  const publishable = await pool.query(
    `SELECT d.id FROM deployments d
     WHERE d.user_id = $1 AND d.status IN ('draft', 'live')
     ORDER BY d.updated_at DESC LIMIT 1`,
    [userId],
  );
  if (!publishable.rows[0]) throw new PaymentError('Create a resume draft before payment', 409);

  await pool.query(
    `UPDATE payment_transactions SET status = 'failed', updated_at = NOW(),
       provider_response = COALESCE(provider_response, '{}'::jsonb) || '{"reason":"expired_pending_request"}'::jsonb
     WHERE user_id = $1 AND status = 'pending' AND created_at < NOW() - INTERVAL '30 minutes'`,
    [userId],
  );
  const pending = await pool.query(
    `SELECT authority FROM payment_transactions
     WHERE user_id = $1 AND status = 'pending' ORDER BY created_at DESC LIMIT 1`,
    [userId],
  );
  if (pending.rows[0]) throw new PaymentError('A payment is already pending for this account', 409);

  let rows;
  try {
    ({ rows } = await pool.query(
      `INSERT INTO payment_transactions (user_id, plan, amount, currency, status)
       VALUES ($1, $2, $3, $4, 'pending') RETURNING id`,
      [userId, canonicalPlan, plan.amount, plan.currency],
    ));
  } catch (error) {
    if (error.code === '23505') throw new PaymentError('A payment is already pending for this account', 409);
    throw error;
  }
  const transactionId = rows[0].id;

  try {
    const result = await callZarinpal('request', {
      merchant_id: env.zarinpal.merchantId,
      amount: plan.amount,
      currency: plan.currency,
      description: 'drop.cv annual subscription',
      callback_url: `${env.backendUrl}/api/payments/callback`,
      metadata: { email, order_id: transactionId, auto_verify: false },
    });
    if (result?.data?.code !== 100 || !result?.data?.authority) throw new PaymentError('Payment request was rejected', 502);
    const authority = result.data.authority;
    await pool.query(
      `UPDATE payment_transactions SET authority = $2, provider_response = $3, updated_at = NOW() WHERE id = $1`,
      [transactionId, authority, JSON.stringify(result)],
    );
    return { authority, paymentUrl: `${startPayBase()}${authority}`, amount: plan.amount, currency: plan.currency };
  } catch (error) {
    await pool.query(
      `UPDATE payment_transactions SET status = 'failed', provider_response = $2, updated_at = NOW() WHERE id = $1`,
      [transactionId, JSON.stringify({ error: error.message })],
    );
    throw error;
  }
}

async function cancelPayment(authority) {
  await pool.query(
    `UPDATE payment_transactions SET status = 'cancelled', updated_at = NOW()
     WHERE authority = $1 AND status = 'pending'`,
    [authority],
  );
}

async function verifyPayment(authority) {
  const existing = await pool.query(
    `SELECT pt.*, u.email, d.full_url
     FROM payment_transactions pt JOIN users u ON u.id = pt.user_id
     LEFT JOIN domains d ON d.user_id = pt.user_id AND d.is_primary = true
     WHERE pt.authority = $1 LIMIT 1`,
    [authority],
  );
  const transaction = existing.rows[0];
  if (!transaction) throw new PaymentError('Unknown payment authority', 404);
  if (transaction.status === 'verified') return { transaction, alreadyVerified: true };
  if (transaction.status !== 'pending') throw new PaymentError('Payment is not pending', 409);

  const result = await callZarinpal('verify', {
    merchant_id: env.zarinpal.merchantId,
    amount: transaction.amount,
    authority,
  });
  const code = Number(result?.data?.code);
  if (![100, 101].includes(code) || !result?.data?.ref_id) {
    await pool.query(
      `UPDATE payment_transactions SET status = 'failed', provider_response = $2, updated_at = NOW() WHERE id = $1`,
      [transaction.id, JSON.stringify(result)],
    );
    throw new PaymentError('Payment could not be verified', 402);
  }

  const client = await pool.connect();
  let subscription;
  try {
    await client.query('BEGIN');
    const locked = await client.query('SELECT * FROM payment_transactions WHERE id = $1 FOR UPDATE', [transaction.id]);
    if (locked.rows[0].status === 'verified') {
      await client.query('COMMIT');
      return { transaction: locked.rows[0], alreadyVerified: true };
    }
    const referenceId = String(result.data.ref_id);
    await client.query(
      `UPDATE payment_transactions SET status = 'verified', reference_id = $2, provider_response = $3,
       verified_at = NOW(), updated_at = NOW() WHERE id = $1`,
      [transaction.id, referenceId, JSON.stringify(result)],
    );
    subscription = await billingService.activateSubscription(client, transaction.user_id, transaction.plan, referenceId, transaction.amount);
    await client.query('COMMIT');
    transaction.reference_id = referenceId;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  sendPublicationConfirmation({
    email: transaction.email,
    url: transaction.full_url,
    plan: transaction.plan,
    expiresAt: subscription?.expires_at,
    referenceId: transaction.reference_id,
  }).catch((error) => console.error('[mail] publication confirmation failed', error));

  return { transaction, subscription, alreadyVerified: false };
}

async function listPaymentHistory(userId) {
  const { rows } = await pool.query(
    `SELECT id, plan, amount, currency, authority, reference_id, status,
      verified_at, created_at, updated_at
     FROM payment_transactions
     WHERE user_id = $1
     ORDER BY created_at DESC
     LIMIT 50`,
    [userId],
  );

  return rows;
}

module.exports = { PaymentError, createPayment, verifyPayment, cancelPayment, listPaymentHistory };

const requireAuth = require('../middleware/requireAuth');
const env = require('../config/env');
const { PaymentError, createManualPayment, submitManualPayment, verifyPayment, cancelPayment } = require('../services/paymentService');
const { pool } = require('../config/db');

function resultUrl(status, extra = '') {
  return `${env.frontendUrl.replace(/\/$/, '')}/payment-result.html?status=${status}${extra}`;
}

async function paymentRoutes(fastify) {
  fastify.post('/request', { preHandler: requireAuth }, async function requestPayment(request, reply) {
    try {
      return reply.send(await createManualPayment(request.user.userId, request.user.email, request.body?.plan));
    } catch (error) {
      return reply.code(error instanceof PaymentError ? error.statusCode : 500).send({ error: error.message });
    }
  });

  fastify.get('/callback', async function paymentCallback(request, reply) {
    const authority = String(request.query?.Authority || '');
    const status = String(request.query?.Status || '').toUpperCase();
    if (!authority) return reply.redirect(resultUrl('failed'));
    if (status !== 'OK') {
      await cancelPayment(authority);
      return reply.redirect(resultUrl('cancelled'));
    }
    try {
      const result = await verifyPayment(authority);
      return reply.redirect(resultUrl('success', `&ref=${encodeURIComponent(result.transaction.reference_id || '')}`));
    } catch (error) {
      request.log.error(error, 'Payment verification failed');
      return reply.redirect(resultUrl('failed'));
    }
  });

  fastify.post('/:id/submit', { preHandler: requireAuth }, async function submitManual(request, reply) {
    try { return reply.send({ payment: await submitManualPayment(request.user.userId, request.params.id, request.body?.receiptCode, request.body?.payerCardLast4) }); }
    catch (error) { return reply.code(error instanceof PaymentError ? error.statusCode : 500).send({ error: error.message }); }
  });

  fastify.get('/history', { preHandler: requireAuth }, async function history(request, reply) {
    const { rows } = await pool.query(
      `SELECT id, plan, amount, currency, status, reference_id, created_at, updated_at
       FROM payment_transactions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 30`, [request.user.userId],
    );
    return reply.send({ payments: rows });
  });
}

module.exports = paymentRoutes;

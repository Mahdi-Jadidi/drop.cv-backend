const requireAuth = require('../middleware/requireAuth');
const { getUserById } = require('../services/authService');
const billingService = require('../services/billingService');
const conversionLimiter = require('../services/conversionLimiter');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const env = require('../config/env');
const { sendMail } = require('../services/mailService');
const rateLimiter = require('../middleware/rateLimiter');
const { deletePrefix } = require('../config/minio');

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function validEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

async function userRoutes(fastify) {
  const accountMutationLimit = rateLimiter({ keyPrefix: 'account-mutation', windowSeconds: 60 * 60, maxRequests: 12 });
  fastify.get('/me', { preHandler: requireAuth }, async function getCurrentUserHandler(request, reply) {
    const user = await getUserById(request.user.userId);
    const subscription = await billingService.checkSiteStatus(request.user.userId);
    const db = require('../config/db').pool;
    const { rows } = await db.query(
      `SELECT id, status FROM deployments WHERE user_id = $1 ORDER BY updated_at DESC LIMIT 1`,
      [request.user.userId],
    );
    return reply.send({
      success: true,
      user: {
        ...user,
        subscription,
        latestDeployment: rows[0] || null,
        publicUrl: ['trial', 'active'].includes(subscription.status) ? user.publicUrl || null : null,
        draftUrl: rows[0] ? `/api/preview/${rows[0].id}` : null,
        paymentState: subscription.status === 'active'
          ? 'paid'
          : (subscription.status === 'trial' ? 'trial' : 'required'),
      },
    });
  });

  fastify.get('/site-status', { preHandler: requireAuth }, async function getSiteStatusHandler(request, reply) {
    const result = await billingService.checkSiteStatus(request.user.userId);
    return reply.send(result);
  });

  fastify.get('/conversion-usage', { preHandler: requireAuth }, async function getConversionUsageHandler(request, reply) {
    const usage = await conversionLimiter.getUsage(request.user.userId);
    return reply.send({
      success: true,
      usage,
    });
  });

  fastify.patch('/settings', { preHandler: requireAuth }, async function updateSettingsHandler(request, reply) {
    const fullName = String(request.body?.fullName || '').trim();
    const language = request.body?.language === 'en' ? 'en' : 'fa';
    if (fullName.length < 2 || fullName.length > 120) {
      return reply.code(400).send({ error: 'Professional name must be between 2 and 120 characters', field: 'fullName' });
    }
    const db = require('../config/db').pool;
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await client.query('UPDATE professional_profiles SET full_name = $2, updated_at = NOW() WHERE user_id = $1', [request.user.userId, fullName]);
      await client.query('UPDATE users SET ui_language = $2, updated_at = NOW() WHERE id = $1', [request.user.userId, language]);
      await client.query('COMMIT');
      return reply.send({ success: true, fullName, language });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  });

  fastify.post('/password', { preHandler: [requireAuth, accountMutationLimit] }, async function changePasswordHandler(request, reply) {
    const currentPassword = String(request.body?.currentPassword || '');
    const newPassword = String(request.body?.newPassword || '');
    if (newPassword.length < 8 || !/[A-Za-z]/.test(newPassword) || !/\d/.test(newPassword)) {
      return reply.code(400).send({ error: 'New password must contain at least 8 characters, a letter, and a number', field: 'newPassword' });
    }
    const db = require('../config/db').pool;
    const { rows } = await db.query('SELECT password_hash FROM users WHERE id = $1 AND is_active = true LIMIT 1', [request.user.userId]);
    if (!rows[0] || !(await bcrypt.compare(currentPassword, rows[0].password_hash))) {
      return reply.code(401).send({ error: 'Current password is incorrect' });
    }
    const hash = await bcrypt.hash(newPassword, 12);
    await db.query('UPDATE users SET password_hash = $2, updated_at = NOW() WHERE id = $1', [request.user.userId, hash]);
    return reply.send({ success: true });
  });

  fastify.post('/email-change', { preHandler: [requireAuth, accountMutationLimit] }, async function requestEmailChangeHandler(request, reply) {
    const newEmail = normalizeEmail(request.body?.newEmail);
    if (!validEmail(newEmail)) return reply.code(400).send({ error: 'Enter a valid email address', field: 'newEmail' });
    const db = require('../config/db').pool;
    const exists = await db.query('SELECT 1 FROM users WHERE email = $1 AND id <> $2 LIMIT 1', [newEmail, request.user.userId]);
    if (exists.rowCount) return reply.code(409).send({ error: 'This email cannot be used' });
    const token = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    await db.query('DELETE FROM email_change_tokens WHERE user_id = $1 OR expires_at < NOW()', [request.user.userId]);
    await db.query(
      `INSERT INTO email_change_tokens (user_id, new_email, token_hash, expires_at)
       VALUES ($1, $2, $3, NOW() + INTERVAL '30 minutes')`,
      [request.user.userId, newEmail, tokenHash],
    );
    const confirmationUrl = `${env.frontendUrl.replace(/\/$/, '')}/settings-email-confirm.html?token=${encodeURIComponent(token)}`;
    await sendMail({
      to: newEmail,
      subject: 'Confirm your new drop.cv email',
      text: `Confirm this email address within 30 minutes: ${confirmationUrl}`,
      html: `<p>Confirm this email address for drop.cv:</p><p><a href="${confirmationUrl}">Confirm email</a></p>`,
    });
    return reply.send({ success: true });
  });

  fastify.post('/email-change/confirm', async function confirmEmailChangeHandler(request, reply) {
    const token = String(request.body?.token || '');
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const db = require('../config/db').pool;
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        `SELECT * FROM email_change_tokens
         WHERE token_hash = $1 AND used_at IS NULL AND expires_at > NOW()
         LIMIT 1 FOR UPDATE`,
        [tokenHash],
      );
      if (!rows[0]) { await client.query('ROLLBACK'); return reply.code(400).send({ error: 'Confirmation link is invalid or expired' }); }
      await client.query('UPDATE users SET email = $2, email_verified = true, updated_at = NOW() WHERE id = $1', [rows[0].user_id, rows[0].new_email]);
      await client.query('UPDATE email_change_tokens SET used_at = NOW() WHERE id = $1', [rows[0].id]);
      await client.query('COMMIT');
      return reply.send({ success: true });
    } catch (error) { await client.query('ROLLBACK'); if (error.code === '23505') return reply.code(409).send({ error: 'This email cannot be used' }); throw error; }
    finally { client.release(); }
  });

  fastify.delete('/account', { preHandler: [requireAuth, accountMutationLimit] }, async function deleteAccountHandler(request, reply) {
    const password = String(request.body?.password || '');
    if (request.body?.confirmation !== 'DELETE') return reply.code(400).send({ error: 'Type DELETE to confirm account deletion' });
    const db = require('../config/db').pool;
    const { rows } = await db.query('SELECT password_hash FROM users WHERE id = $1 AND is_active = true LIMIT 1', [request.user.userId]);
    if (!rows[0] || !(await bcrypt.compare(password, rows[0].password_hash))) return reply.code(401).send({ error: 'Password is incorrect' });
    const deployments = await db.query('SELECT minio_path FROM deployments WHERE user_id = $1 AND minio_path IS NOT NULL', [request.user.userId]);
    for (const deployment of deployments.rows) await deletePrefix(deployment.minio_path);
    await db.query('DELETE FROM users WHERE id = $1', [request.user.userId]);
    reply.clearCookie('dropcv_token', { path: '/', secure: env.nodeEnv === 'production', sameSite: 'lax', ...(env.cookieDomain ? { domain: env.cookieDomain } : {}) });
    return reply.send({ success: true });
  });
}

module.exports = userRoutes;

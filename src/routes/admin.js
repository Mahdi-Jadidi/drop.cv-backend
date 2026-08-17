const requireAuth = require('../middleware/requireAuth');
const requireAdmin = require('../middleware/requireAdmin');
const { pool } = require('../config/db');
const { PaymentError, approveManualPayment, rejectManualPayment } = require('../services/paymentService');

function sendError(reply, error) {
  return reply.code(error instanceof PaymentError ? error.statusCode : 500).send({ error: error.message || 'Internal server error' });
}

async function adminRoutes(fastify) {
  const guard = { preHandler: [requireAuth, requireAdmin] };
  fastify.get('/overview', guard, async function (request, reply) {
    const { rows } = await pool.query(`
      SELECT
        (SELECT COUNT(*)::int FROM users WHERE is_active = true) AS total_users,
        (SELECT COUNT(*)::int FROM subscriptions WHERE status = 'active' AND is_paid = true) AS active_subscriptions,
        (SELECT COUNT(*)::int FROM payment_transactions WHERE status = 'pending_review') AS pending_reviews,
        (SELECT COALESCE(SUM(amount), 0)::bigint FROM payment_transactions WHERE status = 'verified') AS verified_revenue,
        (SELECT COUNT(*)::int FROM payment_transactions WHERE status = 'verified' AND verified_at >= date_trunc('month', NOW())) AS approved_this_month
    `);
    return reply.send({ overview: rows[0] });
  });
  fastify.get('/payments', guard, async function (request, reply) {
    const status = String(request.query?.status || 'pending_review');
    const allowed = ['pending', 'pending_review', 'verified', 'rejected', 'failed', 'cancelled', 'all'];
    if (!allowed.includes(status)) return reply.code(400).send({ error: 'Invalid status filter' });
    const params = status === 'all' ? [] : [status];
    const where = status === 'all' ? '' : 'WHERE pt.status = $1';
    const { rows } = await pool.query(
      `SELECT pt.id, pt.plan, pt.amount, pt.currency, pt.status, pt.reference_id, pt.created_at, pt.updated_at,
       pt.reviewed_at, pt.reviewed_by, pt.review_note, pt.provider_response, u.email, pp.full_name
       FROM payment_transactions pt JOIN users u ON u.id = pt.user_id
       LEFT JOIN professional_profiles pp ON pp.user_id = u.id ${where}
       ORDER BY pt.created_at DESC LIMIT 100`, params,
    );
    return reply.send({ payments: rows });
  });
  fastify.post('/payments/:id/approve', guard, async function (request, reply) {
    try { return reply.send(await approveManualPayment(request.params.id, request.user.email, request.body?.note)); }
    catch (error) { return sendError(reply, error); }
  });
  fastify.post('/payments/:id/reject', guard, async function (request, reply) {
    try { return reply.send(await rejectManualPayment(request.params.id, request.user.email, request.body?.note)); }
    catch (error) { return sendError(reply, error); }
  });
}
module.exports = adminRoutes;

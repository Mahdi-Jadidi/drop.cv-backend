const requireAuth = require('../middleware/requireAuth');
const { getUserById } = require('../services/authService');
const billingService = require('../services/billingService');
const conversionLimiter = require('../services/conversionLimiter');

async function userRoutes(fastify) {
  fastify.get('/me', { preHandler: requireAuth }, async function getCurrentUserHandler(request, reply) {
    const user = await getUserById(request.user.userId);
    const subscription = await billingService.checkSiteStatus(request.user.userId);
    const db = require('../config/db').pool;
    const { rows } = await db.query(
      `SELECT id, status FROM deployments WHERE user_id = $1 ORDER BY updated_at DESC LIMIT 1`,
      [request.user.userId],
    );
    const domainResult = await db.query(
      `SELECT full_url FROM domains WHERE user_id = $1 AND is_primary = true AND is_active = true LIMIT 1`,
      [request.user.userId],
    );
    return reply.send({
      success: true,
      user: {
        ...user,
        subscription,
        latestDeployment: rows[0] || null,
        publicUrl: ['trial', 'active'].includes(subscription.status) ? domainResult.rows[0]?.full_url || null : null,
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
}

module.exports = userRoutes;

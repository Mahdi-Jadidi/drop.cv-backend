const { PLANS } = require('../config/plans');
const env = require('../config/env');

async function planRoutes(fastify) {
  fastify.get('/', async function getPlansHandler(request, reply) {
    return reply.send({
      success: true,
      plans: PLANS,
      capabilities: {
        aiGeneration: Boolean(env.anthropicApiKey || env.siteGenerationApiKey),
        payments: Boolean(env.zarinpal.merchantId),
        transactionalEmail: Boolean(env.smtp.host && env.smtp.user && env.smtp.pass),
      },
    });
  });
}

module.exports = planRoutes;

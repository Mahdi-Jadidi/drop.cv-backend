const { PLANS } = require('../config/plans');

async function planRoutes(fastify) {
  fastify.get('/', async function getPlansHandler(request, reply) {
    return reply.send({
      success: true,
      plans: PLANS,
    });
  });
}

module.exports = planRoutes;

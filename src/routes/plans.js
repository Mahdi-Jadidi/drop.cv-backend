const { PLANS } = require('../config/plans');
const env = require('../config/env');

async function planRoutes(fastify) {
  fastify.get('/', async function getPlansHandler(request, reply) {
    return reply.send({
      success: true,
      plans: PLANS,
      capabilities: {
        payments: Boolean(env.manualPayment.cardNumber && env.manualPayment.cardHolder),
        paymentMethod: 'card_transfer',
      },
    });
  });
}

module.exports = planRoutes;

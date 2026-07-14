const requireAuth = require('../middleware/requireAuth');
const rateLimiter = require('../middleware/rateLimiter');
const env = require('../config/env');
const {
  PaymentError,
  createPayment,
  verifyPayment,
  cancelPayment,
  listPaymentHistory,
} = require('../services/paymentService');

function resultUrl(status, extra = '') {
  return `${env.frontendUrl.replace(/\/$/, '')}/payment-result.html?status=${status}${extra}`;
}

async function paymentRoutes(fastify) {
  const paymentLimit = rateLimiter({ keyPrefix: 'payment', windowSeconds: 60 * 60, maxRequests: 10 });
  fastify.post('/request', { preHandler: [requireAuth, paymentLimit] }, async function requestPayment(request, reply) {
    try {
      return reply.send(await createPayment(request.user.userId, request.user.email, request.body?.plan));
    } catch (error) {
      return reply.code(error instanceof PaymentError ? error.statusCode : 500).send({ error: error.message });
    }
  });

  fastify.get('/history', { preHandler: requireAuth }, async function paymentHistory(request, reply) {
    return reply.send({
      success: true,
      payments: await listPaymentHistory(request.user.userId),
    });
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
}

module.exports = paymentRoutes;

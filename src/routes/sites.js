const requireAuth = require('../middleware/requireAuth');
const billingService = require('../services/billingService');
const { UploadError } = require('../services/uploadService');
const { uploadWebsiteBundle } = require('../services/siteUploadService');

function sendSiteError(reply, error) {
  if (error instanceof UploadError || typeof error.statusCode === 'number') {
    const body = { error: error.message };

    if (error.field) {
      body.field = error.field;
    }

    return reply.code(error.statusCode).send(body);
  }

  if (error.code === 'FST_REQ_FILE_TOO_LARGE') {
    return reply.code(413).send({ error: 'File is too large' });
  }

  console.error('Site upload route error', error);
  return reply.code(500).send({ error: 'Internal server error' });
}

async function siteRoutes(fastify) {
  fastify.post('/upload', {
    preHandler: requireAuth,
  }, async function uploadSiteHandler(request, reply) {
    try {
      const lifecycle = await billingService.checkSiteStatus(request.user.userId);

      if (!['trial', 'active'].includes(lifecycle.status)) {
        return reply.code(402).send({
          error: 'An active trial or subscription is required',
          upgradeUrl: '/signup.html?plan=Premium',
        });
      }

      // During the 3-day trial we allow all supported site upload formats
      // for both Standard and Premium so users can test the full flow.
      if (lifecycle.status !== 'trial' && lifecycle.plan !== 'Premium') {
        return reply.code(402).send({
          error: 'Upgrade to Premium to continue using the site upload section after the trial',
          upgradeUrl: '/signup.html?plan=Premium',
        });
      }

      const result = await uploadWebsiteBundle(request, request.user.userId);
      return reply.code(201).send(result);
    } catch (error) {
      return sendSiteError(reply, error);
    }
  });

  fastify.post('/:deploymentId/publish', { preHandler: requireAuth }, async function publish(request, reply) {
    const changed = await billingService.publishSite(request.user.userId, request.params.deploymentId);
    if (!changed) return reply.code(409).send({ error: 'An active subscription and private draft are required' });
    return reply.send({ success: true, status: 'live' });
  });

  fastify.post('/:deploymentId/unpublish', { preHandler: requireAuth }, async function unpublish(request, reply) {
    const changed = await billingService.unpublishSite(request.user.userId, request.params.deploymentId);
    if (!changed) return reply.code(404).send({ error: 'Published site not found' });
    return reply.send({ success: true, status: 'draft' });
  });
}

module.exports = siteRoutes;

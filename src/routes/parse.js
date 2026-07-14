const requireAuth = require('../middleware/requireAuth');
const requirePlan = require('../middleware/requirePlan');
const { parseFile, getParsedContent } = require('../services/parseService');

function sendParseError(reply, error) {
  const statusCode = error.message === 'Parsed content not found' || error.message === 'Deployment not found' ? 404 : 500;

  if (statusCode === 500) {
    console.error('Parse route error', error);
  }

  return reply.code(statusCode).send({ error: error.message || 'Internal server error' });
}

async function parseRoutes(fastify) {
  fastify.addHook('preHandler', requireAuth);

  fastify.post(
    '/:deploymentId',
    { preHandler: requirePlan('Standard', 'Premium') },
    async function parseDeploymentHandler(request, reply) {
      try {
        const result = await parseFile(request.params.deploymentId, request.user.userId);

        return reply.send({
          success: true,
          deploymentId: result.deploymentId,
          status: result.status,
        });
      } catch (error) {
        return sendParseError(reply, error);
      }
    },
  );

  fastify.get('/:deploymentId', async function getParsedContentHandler(request, reply) {
    try {
      const result = await getParsedContent(request.params.deploymentId, request.user.userId);

      return reply.send({
        success: true,
        parsedContent: result,
      });
    } catch (error) {
      return sendParseError(reply, error);
    }
  });
}

module.exports = parseRoutes;


const requireAuth = require('../middleware/requireAuth');
const requirePlan = require('../middleware/requirePlan');
const rateLimiter = require('../middleware/rateLimiter');
const conversionLimiter = require('../services/conversionLimiter');
const { parseFile } = require('../services/parseService');
const { generateFromStory } = require('../services/cvGeneratorService');
const {
  UploadError,
  uploadCvFile,
  submitStory,
  getDeploymentStatus,
} = require('../services/uploadService');

function sendUploadError(reply, error) {
  if (error instanceof UploadError || typeof error.statusCode === 'number') {
    const body = { error: error.message };

    if (error.field) {
      body.field = error.field;
    }

    if (error.usage) {
      body.usage = error.usage;
    }

    return reply.code(error.statusCode).send(body);
  }

  if (error.code === 'FST_REQ_FILE_TOO_LARGE') {
    return reply.code(413).send({ error: 'File is too large' });
  }

  console.error('Upload route error', error);
  return reply.code(500).send({ error: 'Internal server error' });
}

function runBackgroundJob(job, label) {
  job.catch((error) => {
    console.error(`${label} failed`, error);
  });
}

function getConversionAction(request) {
  return String(request.query?.mode || '').toLowerCase() === 'regenerate' ? 'regenerate' : 'convert';
}

async function uploadRoutes(fastify) {
  fastify.addHook('preHandler', requireAuth);
  fastify.addHook('preHandler', rateLimiter({ keyPrefix: 'conversion-upload', windowSeconds: 60 * 60, maxRequests: 30 }));

  fastify.post(
    '/cv',
    { preHandler: requirePlan('Annual', 'Standard', 'Premium') },
    async function uploadCvHandler(request, reply) {
      const action = getConversionAction(request);
      let reservation = null;

      try {
        reservation = await conversionLimiter.reserve(request.user.userId, action);
        const result = await uploadCvFile(request, request.user.userId);

        runBackgroundJob(
          parseFile(result.deploymentId, request.user.userId),
          `Parsing deployment ${result.deploymentId}`,
        );

        return reply.code(201).send(result);
      } catch (error) {
        if (reservation) {
          await conversionLimiter.refund(reservation).catch((refundError) => {
            console.error('Conversion limit refund failed', refundError);
          });
        }
        return sendUploadError(reply, error);
      }
    },
  );

  fastify.post(
    '/story',
    { preHandler: requirePlan('Annual', 'Standard', 'Premium') },
    async function uploadStoryHandler(request, reply) {
      const action = getConversionAction(request);
      let reservation = null;

      try {
        reservation = await conversionLimiter.reserve(request.user.userId, action);
        const result = await submitStory(request.user.userId, request.body || {});

        runBackgroundJob(
          generateFromStory(result.deploymentId, request.user.userId),
          `Story generation for deployment ${result.deploymentId}`,
        );

        return reply.code(201).send(result);
      } catch (error) {
        if (reservation) {
          await conversionLimiter.refund(reservation).catch((refundError) => {
            console.error('Conversion limit refund failed', refundError);
          });
        }
        return sendUploadError(reply, error);
      }
    },
  );

  fastify.get('/status/:deploymentId', async function uploadStatusHandler(request, reply) {
    try {
      const result = await getDeploymentStatus(request.user.userId, request.params.deploymentId);

      return reply.send(result);
    } catch (error) {
      return sendUploadError(reply, error);
    }
  });
}

module.exports = uploadRoutes;

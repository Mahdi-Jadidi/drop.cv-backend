const fastify = require('fastify');
const multipart = require('@fastify/multipart');
const staticFiles = require('@fastify/static');
const path = require('path');

const authPlugin = require('./plugins/auth');
const corsPlugin = require('./plugins/cors');
const env = require('./config/env');
const { connectRedis } = require('./config/redis');
const { pool } = require('./config/db');
const { ensureBucket } = require('./config/minio');
const { isTrustedFrontendOrigin, normalizeOrigin } = require('./config/origins');

const authRoutes = require('./routes/auth');
const planRoutes = require('./routes/plans');
const userRoutes = require('./routes/users');
const uploadRoutes = require('./routes/upload');
const deployRoutes = require('./routes/deploy');
const parseRoutes = require('./routes/parse');
const analyticsRoutes = require('./routes/analytics');
const statsRoutes = require('./routes/stats');
const paymentRoutes = require('./routes/payments');
const previewRoutes = require('./routes/preview');
const siteRoutes = require('./routes/sites');
const trustedOrigin = require('./middleware/trustedOrigin');

async function buildApp(options = {}) {
  const app = fastify({
    logger: true,
    ...options,
  });

  await connectRedis();
  await ensureBucket();

  app.addHook('onClose', async () => {
    await pool.end();
  });

  await app.register(corsPlugin);
  await app.register(authPlugin);
  app.addHook('preHandler', trustedOrigin);
  await app.register(multipart);
  await app.register(staticFiles, {
    root: path.join(__dirname, '..', 'public'),
    prefix: '/public/',
    decorateReply: false,
  });

  app.addHook('onSend', async (request, reply, payload) => {
    const origin = normalizeOrigin(request.headers.origin);
    if (origin && isTrustedFrontendOrigin(origin)) {
      reply.header('Access-Control-Allow-Origin', origin);
      reply.header('Access-Control-Allow-Credentials', 'true');
      reply.header('Vary', 'Origin');
    }
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'strict-origin-when-cross-origin');
    reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    reply.header('X-Frame-Options', 'DENY');
    return payload;
  });

  await app.register(authRoutes, { prefix: '/api/auth' });
  await app.register(planRoutes, { prefix: '/api/plans' });
  await app.register(userRoutes, { prefix: '/api/users' });
  await app.register(uploadRoutes, { prefix: '/api/upload' });
  await app.register(deployRoutes, { prefix: '/api/deploy' });
  await app.register(parseRoutes, { prefix: '/api/parse' });
  // Legacy marketplace code remains unregistered for the MVP.
  await app.register(analyticsRoutes, { prefix: '/api/analytics' });
  await app.register(statsRoutes, { prefix: '/api/stats' });
  await app.register(paymentRoutes, { prefix: '/api/payments' });
  await app.register(previewRoutes, { prefix: '/api/preview' });
  await app.register(siteRoutes, { prefix: '/api/sites' });
  await app.register(deployRoutes);

  app.get('/health', async function healthCheck() {
    return { status: 'ok' };
  });

  return app;
}

module.exports = buildApp;

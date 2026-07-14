const { redis } = require('../config/redis');

function rateLimiter(options = {}) {
  const windowSeconds = options.windowSeconds || 60;
  const maxRequests = options.maxRequests || 60;
  const keyPrefix = options.keyPrefix || 'general';

  return async function rateLimitMiddleware(request, reply) {
    const identifier = request.user?.userId || request.ip || 'anonymous';
    const key = `rate-limit:${keyPrefix}:${identifier}`;

    const currentCount = await redis.incr(key);

    if (currentCount === 1) {
      await redis.expire(key, windowSeconds);
    }

    if (currentCount > maxRequests) {
      return reply.code(429).send({
        error: 'Too Many Requests',
        message: 'Rate limit exceeded.',
      });
    }
  };
}

module.exports = rateLimiter;

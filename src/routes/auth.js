const {
  AuthError,
  registerUser,
  loginUser,
  getUserById,
  isTokenRevoked,
  revokeToken,
} = require('../services/authService');
const requireAuth = require('../middleware/requireAuth');
const env = require('../config/env');

const COOKIE_NAME = 'dropcv_token';
const COOKIE_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

function toJwtPayload(user) {
  return {
    userId: user.id,
    email: user.email,
    plan: user.plan,
    userType: user.userType,
  };
}

async function setAuthCookie(fastify, reply, user) {
  const token = await fastify.jwt.sign(toJwtPayload(user));

  const cookieOptions = {
    httpOnly: true,
    secure: env.nodeEnv === 'production',
    sameSite: env.nodeEnv === 'production' ? 'none' : 'lax',
    path: '/',
    maxAge: COOKIE_MAX_AGE_SECONDS,
  };
  if (env.cookieDomain) cookieOptions.domain = env.cookieDomain;
  reply.setCookie(COOKIE_NAME, token, cookieOptions);

  return token;
}

function clearAuthCookie(reply) {
  const cookieOptions = { path: '/' };
  if (env.cookieDomain) cookieOptions.domain = env.cookieDomain;
  reply.clearCookie(COOKIE_NAME, cookieOptions);
}

function sendError(reply, error) {
  if (error instanceof AuthError) {
    const body = { error: error.message };

    if (error.field) {
      body.field = error.field;
    }

    return reply.code(error.statusCode).send(body);
  }

  console.error('Auth route error', error);
  return reply.code(500).send({ error: 'Internal server error' });
}

async function authRoutes(fastify) {
  fastify.post('/register', async function registerHandler(request, reply) {
    try {
      const user = await registerUser(request.body || {});
      await setAuthCookie(fastify, reply, user);

      return reply.code(201).send({
        success: true,
        user,
      });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  fastify.post('/login', async function loginHandler(request, reply) {
    try {
      const user = await loginUser(request.body || {});
      await setAuthCookie(fastify, reply, user);

      return reply.send({
        success: true,
        user,
      });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  fastify.post('/logout', async function logoutHandler(request, reply) {
    const token = request.cookies?.[COOKIE_NAME];

    if (token) {
      const decodedToken = fastify.jwt.decode(token);
      await revokeToken(token, decodedToken);
    }

    clearAuthCookie(reply);
    return reply.send({ success: true });
  });

  fastify.get('/me', { preHandler: requireAuth }, async function meHandler(request, reply) {
    try {
      const user = await getUserById(request.user.userId);

      return reply.send({
        success: true,
        user,
      });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  fastify.post('/refresh', async function refreshHandler(request, reply) {
    try {
      const token = request.cookies?.[COOKIE_NAME];

      if (!token) {
        return reply.code(401).send({ error: 'Unauthorized' });
      }

      if (await isTokenRevoked(token)) {
        return reply.code(401).send({ error: 'Unauthorized' });
      }

      const decoded = await fastify.jwt.verify(token);
      const user = await getUserById(decoded.userId);
      await setAuthCookie(fastify, reply, user);

      return reply.send({
        success: true,
        user: {
          id: user.id,
          email: user.email,
          plan: user.plan,
          userType: user.userType,
          slug: user.slug,
          firstName: user.firstName,
        },
      });
    } catch (error) {
      if (error.code === 'FAST_JWT_EXPIRED' || error.name === 'TokenExpiredError') {
        return reply.code(401).send({ error: 'Unauthorized' });
      }

      if (error.code?.startsWith?.('FAST_JWT')) {
        return reply.code(401).send({ error: 'Unauthorized' });
      }

      return sendError(reply, error);
    }
  });
}

module.exports = authRoutes;

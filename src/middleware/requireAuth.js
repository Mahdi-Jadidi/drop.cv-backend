const COOKIE_NAME = 'dropcv_token';
const { isTokenRevoked } = require('../services/authService');

async function requireAuth(request, reply) {
  try {
    const token = request.cookies?.[COOKIE_NAME];

    if (!token) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }

    // Logout originally only cleared the browser cookie, so replaying the old JWT
    // from a test client still worked. We consult Redis to revoke logged-out tokens.
    if (await isTokenRevoked(token)) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }

    const payload = await request.server.jwt.verify(token);

    request.user = {
      userId: payload.userId,
      email: payload.email,
      plan: payload.plan,
      userType: payload.userType,
    };
  } catch (error) {
    return reply.code(401).send({ error: 'Unauthorized' });
  }
}

module.exports = requireAuth;


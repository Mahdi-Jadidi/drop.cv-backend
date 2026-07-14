function requirePlan(...plans) {
  return async function requirePlanMiddleware(request, reply) {
    if (!request.user) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }

    if (!plans.includes(request.user.plan)) {
      return reply.code(403).send({ error: 'This feature requires a higher plan' });
    }
  };
}

module.exports = requirePlan;

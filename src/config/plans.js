const PLANS = Object.freeze({
  Annual: Object.freeze({ amount: 690000, currency: 'IRT' }),
});

function getPlan(name) {
  return ['Annual', 'Standard', 'Premium'].includes(String(name || ''))
    ? PLANS.Annual
    : null;
}

function normalizePlan(name) {
  return getPlan(name) ? 'Annual' : null;
}

module.exports = { PLANS, getPlan, normalizePlan };

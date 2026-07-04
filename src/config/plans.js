const PLANS = Object.freeze({
  Standard: Object.freeze({ amount: 690000, currency: 'IRT' }),
  Premium: Object.freeze({ amount: 990000, currency: 'IRT' }),
});

function getPlan(name) {
  return Object.prototype.hasOwnProperty.call(PLANS, name) ? PLANS[name] : null;
}

module.exports = { PLANS, getPlan };

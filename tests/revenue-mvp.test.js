const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PLANS, getPlan } = require('../src/config/plans');
const {
  TRIAL_DURATION_DAYS,
  computeSubscriptionLifecycle,
} = require('../src/services/billingService');
const { createConversionLimiter } = require('../src/services/conversionLimiter');
const {
  CARD_TRANSFER_BASE_AMOUNT,
  MANUAL_PAYMENT_VALIDITY_MS,
  paymentAmountForCode,
  paymentExpiresAt,
} = require('../src/services/manualPaymentCode');

test('server-controlled annual prices use IRT', () => {
  assert.deepEqual(PLANS.Standard, { amount: 710000, currency: 'IRT' });
  assert.deepEqual(PLANS.Premium, { amount: 990000, currency: 'IRT' });
  assert.equal(getPlan('Enterprise'), null);
});

test('revenue migration installs private draft and payment invariants', () => {
  const trialSql = fs.readFileSync(path.join(__dirname, '..', 'migrations', '002_trial_billing.sql'), 'utf8');
  const sql = fs.readFileSync(path.join(__dirname, '..', 'migrations', '003_revenue_mvp.sql'), 'utf8');
  assert.match(trialSql, /INTERVAL '3 days'/);
  assert.doesNotMatch(trialSql, /INTERVAL '5 days'/);
  assert.match(trialSql, /site_status IN \('draft', 'trial', 'active', 'offline_grace', 'expired', 'released'\)/);
  assert.match(sql, /payment_transactions/);
  assert.match(sql, /CHECK \(plan IN \('Standard', 'Premium'\)\)/);
  assert.match(sql, /status IN \('draft', 'trial', 'active', 'expired', 'released'\)/);
  assert.match(sql, /site_status IN \('draft', 'trial', 'active', 'offline_grace', 'expired', 'released'\)/);
  assert.match(sql, /UPDATE domains SET is_active = false/);
  assert.match(sql, /NOT EXISTS[\s\S]*subscriptions/);
  assert.match(sql, /one_pending_per_user/);
});

test('subscription activation optionally publishes an existing website and preserves paid time', async () => {
  const { activateSubscription } = require('../src/services/billingService');
  const queries = [];
  const client = {
    async query(sql, params) {
      queries.push({ sql, params });
      if (/SELECT id, status FROM deployments/.test(sql)) return { rows: [{ id: 'draft-1', status: 'draft' }] };
      if (/UPDATE subscriptions/.test(sql)) return { rows: [{ expires_at: '2028-01-01T00:00:00Z' }] };
      return { rows: [] };
    },
  };

  await activateSubscription(client, 'user-1', 'Standard', 'ref-1', 710000);
  const subscriptionSql = queries.find((entry) => /UPDATE subscriptions/.test(entry.sql)).sql;
  assert.match(subscriptionSql, /GREATEST\(COALESCE\(expires_at, NOW\(\)\), NOW\(\)\)/);
  assert.match(subscriptionSql, /trial_ends_at = COALESCE\(trial_ends_at, COALESCE\(trial_started_at, started_at, NOW\(\)\) \+ INTERVAL '3 days'\)/);
  assert.match(subscriptionSql, /grace_ends_at = NULL/);
  assert.match(subscriptionSql, /day3_reminder_sent = true/);
  assert.match(subscriptionSql, /renewal_reminder_sent = false/);
  assert.ok(queries.some((entry) => /status IN \('draft', 'live'\)/.test(entry.sql)));
});

test('subscription activation allows payment before a website exists', async () => {
  const { activateSubscription } = require('../src/services/billingService');
  const client = {
    query: async (sql) => (/UPDATE subscriptions/.test(sql)
      ? { rows: [{ expires_at: '2028-01-01T00:00:00Z' }] }
      : { rows: [] }),
  };
  await assert.doesNotReject(
    activateSubscription(client, 'user-1', 'Standard', 'ref-1', 710000),
  );
});

test('trial lifecycle uses an exact 3-day trial and 3-day grace period', () => {
  const trialStart = new Date('2026-07-01T00:00:00Z');
  const trialEndsAt = new Date('2026-07-04T00:00:00Z');
  const graceEndsAt = new Date('2026-07-07T00:00:00Z');

  assert.equal(TRIAL_DURATION_DAYS, 3);

  const inTrial = computeSubscriptionLifecycle({
    status: 'trial',
    site_status: 'trial',
    is_paid: false,
    trial_started_at: trialStart.toISOString(),
    trial_ends_at: trialEndsAt.toISOString(),
    grace_ends_at: graceEndsAt.toISOString(),
    plan: 'Standard',
  }, new Date('2026-07-03T23:00:00Z'));

  assert.equal(inTrial.status, 'trial');
  assert.equal(inTrial.daysLeft, 1);
  assert.equal(new Date(inTrial.trialEndsAt).getTime() - trialStart.getTime(), 3 * 24 * 60 * 60 * 1000);

  const inGrace = computeSubscriptionLifecycle({
    status: 'expired',
    site_status: 'offline_grace',
    is_paid: false,
    trial_started_at: trialStart.toISOString(),
    trial_ends_at: trialEndsAt.toISOString(),
    grace_ends_at: graceEndsAt.toISOString(),
    plan: 'Standard',
  }, new Date('2026-07-04T01:00:00Z'));

  assert.equal(inGrace.status, 'offline_grace');
  assert.equal(inGrace.daysLeft, 3);

  const released = computeSubscriptionLifecycle({
    status: 'released',
    site_status: 'released',
    is_paid: false,
    trial_started_at: trialStart.toISOString(),
    trial_ends_at: trialEndsAt.toISOString(),
    grace_ends_at: graceEndsAt.toISOString(),
    plan: 'Standard',
    archived_at: '2026-07-07T00:00:00Z',
  }, new Date('2026-07-07T01:00:00Z'));

  assert.equal(released.status, 'released');
  assert.equal(released.daysLeft, 0);
});

test('generated resumes are script-free and choose Persian RTL automatically', () => {
  const { generateHTML } = require('../src/services/parseService');
  const html = generateHTML({ fullName: 'سارا احمدی', summary: 'طراح محصول' });
  assert.match(html, /<html lang="fa" dir="rtl">/);
  assert.match(html, /درباره من/);
  assert.doesNotMatch(html, /<script/i);
});

test('public deployment allows trial or active billing state', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'deploy.js'), 'utf8');
  assert.match(source, /status !== 'active' && status !== 'trial'/);
  assert.match(source, /status === 'released' \|\| status === 'draft'/);
});

test('authenticated dashboards can fetch monthly conversion usage', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'users.js'), 'utf8');
  assert.match(source, /conversion-usage/);
  assert.match(source, /conversionLimiter\.getUsage/);
});

test('payment verification is amount-bound and idempotent', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'paymentService.js'), 'utf8');
  assert.match(source, /amount: transaction\.amount/);
  assert.match(source, /\[100, 101\]\.includes\(code\)/);
  assert.match(source, /FOR UPDATE/);
  assert.match(source, /status === 'verified'/);
});

test('monthly conversion limiter enforces 5 converts and 10 regenerations', async () => {
  const store = new Map();
  const fakeRedis = {
    async mGet(keys) {
      return keys.map((key) => store.get(key) || null);
    },
    async get(key) {
      return store.get(key) || null;
    },
    async decr(key) {
      const next = Math.max(0, Number(store.get(key) || 0) - 1);
      store.set(key, String(next));
      return next;
    },
    async eval(script, { keys, arguments: args }) {
      const key = keys[0];
      const limit = Number(args[0]);
      const current = Number(store.get(key) || 0);
      if (current >= limit) {
        return [0, current];
      }
      const next = current + 1;
      store.set(key, String(next));
      return [1, next];
    },
  };

  const limiter = createConversionLimiter(fakeRedis);
  const windowStart = new Date('2026-07-01T00:00:00Z');

  for (let index = 0; index < 5; index += 1) {
    const reservation = await limiter.reserve('user-convert', 'convert', windowStart);
    assert.equal(reservation.limit, 5);
    assert.equal(reservation.action, 'convert');
  }

  await assert.rejects(
    limiter.reserve('user-convert', 'convert', windowStart),
    /Monthly convert limit reached/,
  );

  const convertUsage = await limiter.getUsage('user-convert', windowStart);
  assert.equal(convertUsage.convert.used, 5);
  assert.equal(convertUsage.convert.limit, 5);
  assert.equal(convertUsage.convert.remaining, 0);

  const convertRefund = await limiter.reserve('user-refund', 'convert', windowStart);
  await limiter.refund(convertRefund);
  const refundedUsage = await limiter.getUsage('user-refund', windowStart);
  assert.equal(refundedUsage.convert.used, 0);

  for (let index = 0; index < 10; index += 1) {
    const reservation = await limiter.reserve('user-regenerate', 'regenerate', windowStart);
    assert.equal(reservation.limit, 10);
    assert.equal(reservation.action, 'regenerate');
  }

  await assert.rejects(
    limiter.reserve('user-regenerate', 'regenerate', windowStart),
    /Monthly regenerate limit reached/,
  );

  const regenerateUsage = await limiter.getUsage('user-regenerate', windowStart);
  assert.equal(regenerateUsage.regenerate.used, 10);
  assert.equal(regenerateUsage.regenerate.limit, 10);
  assert.equal(regenerateUsage.regenerate.remaining, 0);
});

test('card transfer amount embeds a three-digit payment marker for exactly three hours', () => {
  assert.equal(CARD_TRANSFER_BASE_AMOUNT, 700000);
  assert.equal(paymentAmountForCode(123), 700123);
  assert.throws(() => paymentAmountForCode(99), /three-digit/);
  assert.equal(
    new Date(paymentExpiresAt('2026-08-21T10:00:00.000Z')).getTime(),
    new Date('2026-08-21T10:00:00.000Z').getTime() + MANUAL_PAYMENT_VALIDITY_MS,
  );
});

test('manual payment review supports databases with the legacy payment status constraint', () => {
  const paymentSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'paymentService.js'), 'utf8');
  const adminSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'admin.js'), 'utf8');
  const historySource = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'payments.js'), 'utf8');
  const submissionSource = paymentSource.slice(
    paymentSource.indexOf('async function submitManualPayment'),
    paymentSource.indexOf('async function approveManualPayment'),
  );

  assert.doesNotMatch(submissionSource, /SET status = 'pending_review'/);
  assert.match(submissionSource, /COALESCE\(provider_response->>'submitted_at', ''\) = ''/);
  assert.match(paymentSource, /status = 'failed', updated_at = NOW\(\)/);
  assert.doesNotMatch(paymentSource, /reviewed_at = NOW\(\)/);
  assert.match(adminSource, /SUBMITTED_MANUAL_PAYMENT_SQL/);
  assert.match(adminSource, /provider_response->>'submitted_at'/);
  assert.doesNotMatch(adminSource, /pt\.reviewed_at|pt\.reviewed_by|pt\.review_note/);
  assert.doesNotMatch(historySource, /review_note/);
});

test('resume-to-site generation allows 2 trial conversions and 3 weekly active conversions', async () => {
  const { createSiteGenerationLimiter } = require('../src/services/siteGenerationLimiter');
  const store = new Map();
  const fakeRedis = {
    async get(key) { return store.get(key) || null; },
    async decr(key) {
      const next = Math.max(0, Number(store.get(key) || 0) - 1);
      store.set(key, String(next));
      return next;
    },
    async eval(script, { keys, arguments: args }) {
      const key = keys[0];
      const limit = Number(args[0]);
      const current = Number(store.get(key) || 0);
      if (current >= limit) return [0, current];
      store.set(key, String(current + 1));
      return [1, current + 1];
    },
  };
  const limiter = createSiteGenerationLimiter(fakeRedis);
  const now = new Date('2026-08-21T10:00:00Z');
  const trial = { status: 'trial', trialStartedAt: '2026-08-20T10:00:00Z', trialEndsAt: '2026-08-23T10:00:00Z' };
  for (let index = 0; index < 2; index += 1) {
    const reservation = await limiter.reserve('trial-user', trial, now);
    assert.equal(reservation.usage.limit, 2);
    assert.equal(reservation.usage.period, 'trial');
  }
  await assert.rejects(limiter.reserve('trial-user', trial, now), /Trial site generation limit reached/);

  const active = { status: 'active' };
  for (let index = 0; index < 3; index += 1) {
    const reservation = await limiter.reserve('active-user', active, now);
    assert.equal(reservation.usage.limit, 3);
    assert.equal(reservation.usage.period, 'week');
  }
  await assert.rejects(limiter.reserve('active-user', active, now), /Weekly site generation limit reached/);
});

test('resume-to-site generation is unavailable without a configured generation API', async () => {
  const { buildSiteBundleFromResume } = require('../src/services/siteUploadService');
  await assert.rejects(
    buildSiteBundleFromResume([{ extension: '.txt', buffer: Buffer.from('Mahdi\nDesigner'), originalName: 'resume.txt' }], {}),
    (error) => error.statusCode === 503 && /temporarily unavailable/.test(error.message),
  );
});

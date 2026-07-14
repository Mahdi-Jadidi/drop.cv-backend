const { pool } = require('../config/db');

const DAY_MS = 24 * 60 * 60 * 1000;
const TRIAL_DURATION_DAYS = 3;
const GRACE_DURATION_DAYS = 3;

function toDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function addDays(date, days) {
  if (!date) return null;
  return new Date(date.getTime() + (days * DAY_MS));
}

function daysRemaining(target, now = new Date()) {
  const end = toDate(target);
  if (!end) return null;

  const diff = end.getTime() - now.getTime();
  if (diff <= 0) return 0;

  return Math.max(1, Math.round(diff / DAY_MS));
}

function computeSubscriptionLifecycle(subscription, now = new Date()) {
  if (!subscription) {
    return {
      status: 'draft',
      siteStatus: 'draft',
      daysLeft: null,
      trialStartedAt: null,
      trialEndsAt: null,
      graceEndsAt: null,
      expiresAt: null,
      isPaid: false,
      plan: null,
      archivedAt: null,
    };
  }

  const trialStartedAt = toDate(subscription.trial_started_at) || toDate(subscription.started_at) || toDate(subscription.created_at);
  const trialEndsAt = toDate(subscription.trial_ends_at) || addDays(trialStartedAt, TRIAL_DURATION_DAYS);
  const graceEndsAt = toDate(subscription.grace_ends_at) || addDays(trialEndsAt, GRACE_DURATION_DAYS);
  const expiresAt = toDate(subscription.expires_at);
  const isPaid = Boolean(subscription.is_paid);
  const storedStatus = String(subscription.status || '').toLowerCase();
  const storedSiteStatus = String(subscription.site_status || '').toLowerCase();

  if (
    storedStatus === 'released' ||
    storedSiteStatus === 'released' ||
    (toDate(subscription.archived_at) && graceEndsAt && graceEndsAt <= now)
  ) {
    return {
      status: 'released',
      siteStatus: 'released',
      daysLeft: 0,
      trialStartedAt,
      trialEndsAt,
      graceEndsAt,
      expiresAt,
      isPaid,
      plan: subscription.plan || null,
      archivedAt: subscription.archived_at || null,
    };
  }

  if (isPaid && expiresAt && expiresAt <= now) {
    return {
      status: 'expired',
      siteStatus: 'expired',
      daysLeft: 0,
      trialStartedAt,
      trialEndsAt,
      graceEndsAt,
      expiresAt,
      isPaid,
      plan: subscription.plan || null,
      archivedAt: subscription.archived_at || null,
    };
  }

  if (!isPaid && trialEndsAt && trialEndsAt > now) {
    return {
      status: 'trial',
      siteStatus: 'trial',
      daysLeft: daysRemaining(trialEndsAt, now),
      trialStartedAt,
      trialEndsAt,
      graceEndsAt,
      expiresAt,
      isPaid,
      plan: subscription.plan || null,
      archivedAt: subscription.archived_at || null,
    };
  }

  if (!isPaid && trialEndsAt && trialEndsAt <= now) {
    if (graceEndsAt && graceEndsAt > now) {
      return {
        status: 'offline_grace',
        siteStatus: 'offline_grace',
        daysLeft: daysRemaining(graceEndsAt, now),
        trialStartedAt,
        trialEndsAt,
        graceEndsAt,
        expiresAt,
        isPaid,
        plan: subscription.plan || null,
        archivedAt: subscription.archived_at || null,
      };
    }

    return {
      status: 'released',
      siteStatus: 'released',
      daysLeft: 0,
      trialStartedAt,
      trialEndsAt,
      graceEndsAt,
      expiresAt,
      isPaid,
      plan: subscription.plan || null,
      archivedAt: subscription.archived_at || null,
    };
  }

  if (!isPaid && graceEndsAt && graceEndsAt > now) {
    return {
      status: 'offline_grace',
      siteStatus: 'offline_grace',
      daysLeft: daysRemaining(graceEndsAt, now),
      trialStartedAt,
      trialEndsAt,
      graceEndsAt,
      expiresAt,
      isPaid,
      plan: subscription.plan || null,
      archivedAt: subscription.archived_at || null,
    };
  }

  if (isPaid && (!expiresAt || expiresAt > now)) {
    return {
      status: 'active',
      siteStatus: 'active',
      daysLeft: daysRemaining(expiresAt, now),
      trialStartedAt,
      trialEndsAt,
      graceEndsAt: null,
      expiresAt,
      isPaid,
      plan: subscription.plan || null,
      archivedAt: subscription.archived_at || null,
    };
  }

  if (storedStatus === 'expired' || storedSiteStatus === 'expired') {
    return {
      status: 'expired',
      siteStatus: 'expired',
      daysLeft: 0,
      trialStartedAt,
      trialEndsAt,
      graceEndsAt,
      expiresAt,
      isPaid,
      plan: subscription.plan || null,
      archivedAt: subscription.archived_at || null,
    };
  }

  const fallbackStatus = storedSiteStatus || storedStatus || 'draft';
  return {
    status: fallbackStatus,
    siteStatus: fallbackStatus,
    daysLeft: null,
    trialStartedAt,
    trialEndsAt,
    graceEndsAt,
    expiresAt,
    isPaid,
    plan: subscription.plan || null,
    archivedAt: subscription.archived_at || null,
  };
}

async function getSubscription(userId) {
  const { rows } = await pool.query('SELECT * FROM subscriptions WHERE user_id = $1 LIMIT 1', [userId]);
  return rows[0] || null;
}

async function checkSiteStatus(userId, now = new Date()) {
  const subscription = await getSubscription(userId);
  return computeSubscriptionLifecycle(subscription, now);
}

async function deactivatePublicSite(userId) {
  await pool.query(
    `UPDATE deployments
     SET status = 'draft', updated_at = NOW()
     WHERE user_id = $1 AND status = 'live'`,
    [userId],
  );
  await pool.query('UPDATE domains SET is_active = false WHERE user_id = $1', [userId]);
  await pool.query('UPDATE professional_profiles SET is_public = false, updated_at = NOW() WHERE user_id = $1', [userId]);
}

async function activateSubscription(client, userId, plan, referenceId, amount) {
  const eligible = await client.query(
    `SELECT id, status FROM deployments
     WHERE user_id = $1 AND status IN ('draft', 'live')
     ORDER BY updated_at DESC LIMIT 1 FOR UPDATE`,
    [userId],
  );
  if (!eligible.rows[0]) {
    const error = new Error('A publishable resume draft is required');
    error.statusCode = 409;
    throw error;
  }

  const { rows } = await client.query(
    `UPDATE subscriptions SET plan = $2, status = 'active', site_status = 'active', is_paid = true,
      started_at = CASE WHEN status = 'active' THEN started_at ELSE NOW() END,
      trial_started_at = COALESCE(trial_started_at, started_at, NOW()),
      trial_ends_at = COALESCE(trial_ends_at, COALESCE(trial_started_at, started_at, NOW()) + INTERVAL '3 days'),
      grace_ends_at = NULL,
      expires_at = GREATEST(COALESCE(expires_at, NOW()), NOW()) + INTERVAL '1 year', payment_reference = $3,
      amount_paid = $4, currency = 'IRT', archived_at = NULL, day3_reminder_sent = true,
      renewal_reminder_sent = false, updated_at = NOW()
     WHERE user_id = $1 RETURNING *`,
    [userId, plan, referenceId, amount],
  );

  await client.query('UPDATE users SET plan = $2, updated_at = NOW() WHERE id = $1', [userId, plan]);
  if (!rows[0]) throw new Error('Subscription record not found');
  if (eligible.rows[0].status === 'draft') {
    await client.query(
      `UPDATE deployments SET status = 'live', deployed_at = COALESCE(deployed_at, NOW()), updated_at = NOW()
       WHERE id = $1`,
      [eligible.rows[0].id],
    );
  }
  await client.query('UPDATE domains SET is_active = true WHERE user_id = $1', [userId]);
  await client.query('UPDATE professional_profiles SET is_public = true, updated_at = NOW() WHERE user_id = $1', [userId]);
  return rows[0] || null;
}

async function transitionTrialToGrace(userId) {
  const { rowCount } = await pool.query(
    `UPDATE subscriptions
     SET status = 'expired',
       site_status = 'offline_grace',
       is_paid = false,
       grace_ends_at = COALESCE(grace_ends_at, COALESCE(trial_ends_at, trial_started_at, started_at, NOW()) + INTERVAL '3 days'),
       archived_at = NULL,
       updated_at = NOW()
     WHERE user_id = $1 AND COALESCE(site_status, status) = 'trial'`,
    [userId],
  );

  if (rowCount === 0) return false;

  await deactivatePublicSite(userId);
  return true;
}

async function transitionGraceToReleased(userId) {
  const { rowCount } = await pool.query(
    `UPDATE subscriptions
     SET status = 'released',
       site_status = 'released',
       is_paid = false,
       archived_at = COALESCE(archived_at, NOW()),
       updated_at = NOW()
     WHERE user_id = $1 AND COALESCE(site_status, status) = 'offline_grace'`,
    [userId],
  );

  if (rowCount === 0) return false;

  await deactivatePublicSite(userId);
  return true;
}

async function expireSubscription(userId) {
  await pool.query(
    `UPDATE subscriptions
     SET status = 'expired', site_status = 'expired', is_paid = false, updated_at = NOW()
     WHERE user_id = $1`,
    [userId],
  );
  await deactivatePublicSite(userId);
}

async function unpublishSite(userId, deploymentId) {
  const { rows } = await pool.query(
    `UPDATE deployments SET status = 'draft', updated_at = NOW()
     WHERE id = $1 AND user_id = $2 AND status = 'live' RETURNING id`,
    [deploymentId, userId],
  );
  if (!rows[0]) return false;
  await pool.query('UPDATE domains SET is_active = false WHERE user_id = $1', [userId]);
  await pool.query('UPDATE professional_profiles SET is_public = false, updated_at = NOW() WHERE user_id = $1', [userId]);
  return true;
}

async function publishSite(userId, deploymentId, now = new Date()) {
  const lifecycle = await checkSiteStatus(userId, now);
  if (!['trial', 'active'].includes(lifecycle.status)) return false;

  const { rows } = await pool.query(
    `UPDATE deployments SET status = 'live', deployed_at = COALESCE(deployed_at, NOW()), updated_at = NOW()
     WHERE id = $1 AND user_id = $2 AND status IN ('draft', 'live') RETURNING id`,
    [deploymentId, userId],
  );
  if (!rows[0]) return false;
  await pool.query('UPDATE domains SET is_active = true WHERE user_id = $1', [userId]);
  await pool.query('UPDATE professional_profiles SET is_public = true, updated_at = NOW() WHERE user_id = $1', [userId]);
  return true;
}

module.exports = {
  DAY_MS,
  TRIAL_DURATION_DAYS,
  GRACE_DURATION_DAYS,
  getSubscription,
  computeSubscriptionLifecycle,
  checkSiteStatus,
  activateSubscription,
  transitionTrialToGrace,
  transitionGraceToReleased,
  expireSubscription,
  unpublishSite,
  publishSite,
};

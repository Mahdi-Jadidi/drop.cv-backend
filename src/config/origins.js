const env = require('./env');

const DROP_CV_HOST_REGEX = /(?:^|\.)drop\.cv$/i;

function normalizeOrigin(origin) {
  return String(origin || '').trim().replace(/\/$/, '');
}

function isTrustedFrontendOrigin(origin) {
  const normalizedOrigin = normalizeOrigin(origin);

  if (!normalizedOrigin) {
    return false;
  }

  if (env.trustedFrontendOrigins.includes(normalizedOrigin)) {
    return true;
  }

  try {
    const host = new URL(normalizedOrigin).hostname.toLowerCase();
    return DROP_CV_HOST_REGEX.test(host);
  } catch (error) {
    return false;
  }
}

module.exports = {
  DROP_CV_HOST_REGEX,
  normalizeOrigin,
  isTrustedFrontendOrigin,
};

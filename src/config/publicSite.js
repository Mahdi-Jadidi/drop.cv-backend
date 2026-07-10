const DEFAULT_PUBLIC_SITE_URL_TEMPLATE = 'https://drop-cv-backend.vercel.app/site/{slug}/';

function normalizePathPrefix(value) {
  const prefix = String(value || '').trim().replace(/\/+$/, '');

  if (!prefix || prefix === '/') {
    return '';
  }

  return prefix.startsWith('/') ? prefix : `/${prefix}`;
}

function getPublicSiteUrlTemplate() {
  const template = String(process.env.PUBLIC_SITE_URL_TEMPLATE || DEFAULT_PUBLIC_SITE_URL_TEMPLATE).trim();

  return template.includes('{slug}') ? template : DEFAULT_PUBLIC_SITE_URL_TEMPLATE;
}

function buildPublicSiteUrl(slug) {
  const normalizedSlug = String(slug || '').trim();

  if (!normalizedSlug) {
    return null;
  }

  return getPublicSiteUrlTemplate().replace(/{slug}/g, normalizedSlug);
}

function getPublicSitePathPrefix() {
  return normalizePathPrefix(process.env.PUBLIC_SITE_PATH_PREFIX || '');
}

function getRequestPath(request) {
  try {
    return new URL(request.raw.url, 'http://dropcv.local').pathname || '/';
  } catch (error) {
    return '/';
  }
}

function getHostSlug(request) {
  const host = String(request.hostname || request.headers.host || '').trim().toLowerCase();
  const match = host.match(/^([a-z0-9-]+)\.(?:drop\.cv|drop-cv-backend\.vercel\.app)$/i);

  return match ? match[1] : null;
}

function getPublicSiteRouteInfo(request) {
  const requestPath = getRequestPath(request);
  const hostSlug = getHostSlug(request);

  if (hostSlug) {
    return {
      slug: hostSlug,
      requestPath,
    };
  }

  const prefix = getPublicSitePathPrefix();
  if (prefix) {
    const escapedPrefix = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = requestPath.match(new RegExp(`^${escapedPrefix}/([a-z0-9-]+)(?:/(.*))?$`, 'i'));

    if (match) {
      return {
        slug: match[1],
        requestPath: match[2] ? `/${match[2]}` : '/',
      };
    }
  }

  return {
    slug: null,
    requestPath,
  };
}

module.exports = {
  buildPublicSiteUrl,
  getPublicSitePathPrefix,
  getPublicSiteRouteInfo,
  normalizePathPrefix,
};

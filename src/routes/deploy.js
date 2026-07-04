const path = require('path');
const { pool } = require('../config/db');
const { downloadFile } = require('../config/minio');
const billingService = require('../services/billingService');
const { trackAnalyticsEvent } = require('../services/analyticsService');
const { getContentTypeForPath } = require('../services/siteUploadService');

async function getDomainBySlug(slug) {
  const { rows } = await pool.query(
    `SELECT
      dom.id,
      dom.user_id,
      dom.slug,
      dom.full_url,
      dom.is_active
     FROM domains dom
     WHERE dom.slug = $1
     LIMIT 1`,
    [slug],
  );

  return rows[0] || null;
}

async function getLatestDeploymentForSlug(slug) {
  const { rows } = await pool.query(
    `SELECT
      d.id,
      d.method,
      d.minio_path,
      d.original_filename,
      pc.generated_html,
      pc.structured_json
     FROM domains dom
     JOIN deployments d ON d.domain_id = dom.id OR d.user_id = dom.user_id
     LEFT JOIN LATERAL (
       SELECT generated_html, structured_json
       FROM parsed_content
       WHERE deployment_id = d.id
       ORDER BY created_at DESC
       LIMIT 1
     ) pc ON true
     WHERE dom.slug = $1
      AND dom.is_active = true
      AND d.status = 'live'
     ORDER BY d.deployed_at DESC NULLS LAST, d.created_at DESC
     LIMIT 1`,
    [slug],
  );

  return rows[0] || null;
}

function renderNotFoundPage() {
  return '<!doctype html><h1>Resume not found</h1>';
}

function renderOfflinePage() {
  return `<!DOCTYPE html>
    <html lang="en">
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Site paused - drop.cv</title>
      </head>
      <body style="font-family:system-ui,sans-serif;text-align:center;padding:80px 24px;max-width:480px;margin:0 auto">
        <h1 style="font-size:28px;margin-bottom:12px;color:#111827">This site is paused</h1>
        <p style="color:#6B7280;margin-bottom:24px;line-height:1.6">
          The owner's free trial or subscription has ended. The site stays paused during the grace period.
        </p>
        <a href="https://drop.cv" style="color:#0F6E56;font-weight:600;text-decoration:none">
          Learn about drop.cv ->
        </a>
      </body>
    </html>`;
}

function parseStructuredJson(value) {
  if (!value) {
    return {};
  }

  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch (error) {
      return {};
    }
  }

  return value;
}

function getSlugFromRequest(request) {
  const headerSlug = request.headers['x-slug'];
  if (headerSlug) {
    return String(headerSlug).trim();
  }

  const host = String(request.hostname || request.headers.host || '').trim().toLowerCase();
  const match = host.match(/^([a-z0-9-]+)\.drop\.cv$/i);
  return match ? match[1] : null;
}

function getRequestPath(request) {
  try {
    return new URL(request.raw.url, 'http://dropcv.local').pathname || '/';
  } catch (error) {
    return '/';
  }
}

function normalizeRequestPath(requestPath) {
  const decoded = String(requestPath || '/');
  const stripped = decoded.replace(/^\/+/, '');

  if (!stripped) {
    return '';
  }

  const normalized = path.posix.normalize(stripped.replace(/\\/g, '/'));
  if (!normalized || normalized === '.' || normalized.startsWith('..')) {
    return null;
  }

  return normalized;
}

function resolveBundleAssetPath(requestPath, bundle) {
  const normalized = normalizeRequestPath(requestPath);
  const entryPoint = normalizeRequestPath(bundle?.entryPoint || 'index.html') || 'index.html';
  const availablePaths = new Set(Array.isArray(bundle?.files) ? bundle.files.map((file) => file.path) : []);

  if (normalized === '') {
    return entryPoint;
  }

  if (requestPath.endsWith('/')) {
    return path.posix.join(normalized, 'index.html');
  }

  if (availablePaths.has(normalized)) {
    return normalized;
  }

  if (!path.posix.extname(normalized)) {
    if (availablePaths.has(path.posix.join(normalized, 'index.html'))) {
      return path.posix.join(normalized, 'index.html');
    }

    if (availablePaths.has(`${normalized}.html`)) {
      return `${normalized}.html`;
    }

    return entryPoint;
  }

  return normalized;
}

function buildCspForMethod(method) {
  if (method === 'files') {
    return "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data: https:; base-uri 'self'; form-action 'self'; frame-ancestors 'none'";
  }

  return "default-src 'none'; style-src 'unsafe-inline'; img-src data: https:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
}

async function deployRoutes(fastify) {
  fastify.get('/*', async function wildcardSubdomainHandler(request, reply) {
    const slug = getSlugFromRequest(request);

    if (!slug) {
      return reply.code(404).send({ error: 'Not found' });
    }

    const domain = await getDomainBySlug(slug);

    if (!domain) {
      return reply.code(404).type('text/html').send(renderNotFoundPage());
    }

    const { status } = await billingService.checkSiteStatus(domain.user_id);

    if (status === 'released' || status === 'draft') {
      return reply.code(404).type('text/html').send(renderNotFoundPage());
    }

    if (status !== 'active' && status !== 'trial') {
      return reply.code(402).type('text/html').send(renderOfflinePage());
    }

    const deployment = await getLatestDeploymentForSlug(slug);

    if (!deployment) {
      return reply.code(404).type('text/html').send(renderNotFoundPage());
    }

    const bundle = parseStructuredJson(deployment.structured_json);
    const requestPath = getRequestPath(request);
    const isStaticFilesDeployment = deployment.method === 'files';
    let responseBody = deployment.generated_html || null;
    let responseType = 'text/html; charset=utf-8';
    let isHtmlDocument = true;

    if (isStaticFilesDeployment) {
      const assetPath = resolveBundleAssetPath(requestPath, bundle);

      try {
        responseBody = await downloadFile(`${deployment.minio_path}/${assetPath}`);
        responseType = getContentTypeForPath(assetPath);
        isHtmlDocument = responseType.startsWith('text/html');
      } catch (error) {
        const bundleEntry = normalizeRequestPath(bundle.entryPoint || 'index.html') || 'index.html';
        const shouldFallbackToEntry = requestPath === '/' || requestPath.endsWith('/') || !path.posix.extname(normalizeRequestPath(requestPath) || '');

        if (shouldFallbackToEntry && responseBody) {
          responseType = 'text/html; charset=utf-8';
          isHtmlDocument = true;
        } else if (shouldFallbackToEntry) {
          try {
            responseBody = await downloadFile(`${deployment.minio_path}/${bundleEntry}`);
            responseType = 'text/html; charset=utf-8';
            isHtmlDocument = true;
          } catch (fallbackError) {
            return reply.code(404).type('text/html').send('<!doctype html><h1>Resume not available</h1>');
          }
        } else {
          return reply.code(404).type('text/html').send('<!doctype html><h1>Resume not available</h1>');
        }
      }
    } else if (!responseBody) {
      return reply.code(404).type('text/html').send('<!doctype html><h1>Resume not available</h1>');
    }

    if (isHtmlDocument) {
      trackAnalyticsEvent({
        domainSlug: slug,
        ip: request.ip,
        referrer: request.headers.referer,
        userAgent: request.headers['user-agent'],
        skipGeo: true,
      }).catch((error) => request.log.warn({ error }, 'Public view analytics failed'));
    }

    return reply
      .type(responseType)
      .header('Cache-Control', 'no-store')
      .header('Content-Security-Policy', buildCspForMethod(deployment.method))
      .header('X-Content-Type-Options', 'nosniff')
      .header('Referrer-Policy', 'strict-origin-when-cross-origin')
      .header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
      .send(responseBody);
  });
}

module.exports = deployRoutes;

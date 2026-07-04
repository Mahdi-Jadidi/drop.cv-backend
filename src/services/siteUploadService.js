const path = require('path');
const JSZip = require('jszip');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const { v4: uuidv4 } = require('uuid');
const { pool } = require('../config/db');
const { uploadFile, deleteFile } = require('../config/minio');
const env = require('../config/env');
const { generateHTML } = require('./parseService');
const { UploadError } = require('./uploadService');

const SITE_MAX_BYTES = 25 * 1024 * 1024;
const SITE_MAX_FILES = 24;
const STATIC_EXTENSIONS = new Set(['.html', '.htm', '.css', '.js']);
const RESUME_EXTENSIONS = new Set(['.pdf', '.docx', '.doc', '.txt']);
const ZIP_EXTENSIONS = new Set(['.zip']);
const ALLOWED_SITE_EXTENSIONS = new Set([
  ...STATIC_EXTENSIONS,
  ...RESUME_EXTENSIONS,
  ...ZIP_EXTENSIONS,
]);

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.pdf': 'application/pdf',
};

function cleanText(value, max = 5000) {
  return String(value || '').trim().slice(0, max);
}

function cleanArray(value, maxItems = 50, maxItemLength = 120) {
  if (Array.isArray(value)) {
    return value.slice(0, maxItems).map((item) => cleanText(item, maxItemLength)).filter(Boolean);
  }

  return String(value || '')
    .split(/[,;\n]/)
    .map((item) => cleanText(item, maxItemLength))
    .filter(Boolean)
    .slice(0, maxItems);
}

function sanitizeFilename(filename) {
  const basename = path.basename(filename || 'upload');
  return basename.replace(/[^a-zA-Z0-9._-]/g, '-').replace(/-+/g, '-');
}

function sanitizeRelativePath(filename) {
  const sanitized = String(filename || '')
    .replace(/\\/g, '/')
    .replace(/^(\.\/)+/, '')
    .replace(/^\/+/, '')
    .trim();

  if (!sanitized) {
    return null;
  }

  const normalized = path.posix.normalize(sanitized);

  if (!normalized || normalized === '.' || normalized.startsWith('..') || path.posix.isAbsolute(normalized)) {
    return null;
  }

  return normalized;
}

function getExtension(filename) {
  return path.extname(String(filename || '')).toLowerCase();
}

function getContentTypeForPath(filePath) {
  return CONTENT_TYPES[getExtension(filePath)] || 'application/octet-stream';
}

function isTextLikeExtension(extension) {
  return ['.html', '.htm', '.css', '.js', '.json', '.txt', '.svg', '.xml', '.webmanifest', '.map'].includes(extension);
}

async function readMultipartFiles(request, fieldName, maxBytes = SITE_MAX_BYTES, maxFiles = SITE_MAX_FILES) {
  const files = [];
  const fields = {};
  const allowedLimits = {
    fileSize: maxBytes,
    files: maxFiles,
    parts: maxFiles + 24,
  };

  for await (const part of request.parts({ limits: allowedLimits })) {
    if (part.type === 'file') {
      if (part.fieldname !== fieldName) {
        throw new UploadError(`Expected file field "${fieldName}"`, 400, fieldName);
      }

      const buffer = await part.toBuffer();

      if (buffer.length === 0) {
        throw new UploadError('File is empty', 400, fieldName);
      }

      const originalName = sanitizeFilename(part.filename);
      const extension = getExtension(part.filename);

      if (!ALLOWED_SITE_EXTENSIONS.has(extension)) {
        throw new UploadError('Unsupported file type', 400, fieldName);
      }

      files.push({
        buffer,
        originalName,
        mimetype: part.mimetype || getContentTypeForPath(originalName),
        sizeBytes: buffer.length,
        extension,
        requestedName: String(part.filename || originalName),
      });
      continue;
    }

    fields[part.fieldname] = part.value;
  }

  if (files.length === 0) {
    throw new UploadError(`Missing file field "${fieldName}"`, 400, fieldName);
  }

  return { files, fields };
}

function determineUploadKind(files) {
  const extensions = files.map((file) => file.extension);

  if (extensions.length === 1 && ZIP_EXTENSIONS.has(extensions[0])) {
    return 'zip';
  }

  const hasZip = extensions.some((extension) => ZIP_EXTENSIONS.has(extension));
  const hasStatic = extensions.some((extension) => STATIC_EXTENSIONS.has(extension));
  const hasResume = extensions.some((extension) => RESUME_EXTENSIONS.has(extension));

  if (hasZip && (files.length > 1 || hasStatic || hasResume)) {
    throw new UploadError('Upload either a ZIP file or individual site/resume files, not both', 400, 'site');
  }

  if (hasStatic && hasResume) {
    throw new UploadError('Site files and resume files must be uploaded separately', 400, 'site');
  }

  if (hasStatic) {
    return 'static';
  }

  if (hasResume) {
    return 'resume';
  }

  throw new UploadError('Unsupported file type', 400, 'site');
}

function detectEntryPoint(fileEntries) {
  const normalized = fileEntries.map((file) => ({
    ...file,
    path: sanitizeRelativePath(file.relativePath || file.originalName),
  })).filter((file) => file.path);

  const indexHtml = normalized.find((file) => file.path.toLowerCase().endsWith('/index.html') || file.path.toLowerCase() === 'index.html');
  if (indexHtml) {
    return indexHtml.path;
  }

  const htmlFile = normalized.find((file) => ['.html', '.htm'].includes(getExtension(file.path)));
  if (htmlFile) {
    return htmlFile.path;
  }

  return null;
}

function stripCommonZipRoot(paths) {
  const segments = paths
    .map((item) => String(item || '').replace(/\\/g, '/').split('/').filter(Boolean))
    .filter((parts) => parts.length > 0);

  if (segments.length === 0) {
    return '';
  }

  const first = segments[0][0];
  if (!first) {
    return '';
  }

  if (!segments.every((parts) => parts[0] === first)) {
    return '';
  }

  const hasNestedContent = segments.some((parts) => parts.length > 1);
  return hasNestedContent ? `${first}/` : '';
}

async function extractZipBundle(file) {
  const archive = await JSZip.loadAsync(file.buffer);
  const entries = [];

  archive.forEach((relativePath, zipEntry) => {
    if (zipEntry.dir) {
      return;
    }

    const normalized = String(relativePath || '').replace(/\\/g, '/');
    if (!normalized || normalized.includes('__MACOSX/')) {
      return;
    }

    entries.push({
      relativePath: normalized,
      zipEntry,
    });
  });

  if (entries.length === 0) {
    throw new UploadError('ZIP file does not contain any files', 400, 'site');
  }

  const rootStrip = stripCommonZipRoot(entries.map((entry) => entry.relativePath));
  const files = [];

  for (const entry of entries) {
    const stripped = entry.relativePath.startsWith(rootStrip)
      ? entry.relativePath.slice(rootStrip.length)
      : entry.relativePath;
    const normalizedPath = sanitizeRelativePath(stripped);

    if (!normalizedPath) {
      continue;
    }

    const buffer = await entry.zipEntry.async('nodebuffer');
    files.push({
      buffer,
      originalName: path.posix.basename(normalizedPath),
      relativePath: normalizedPath,
      mimetype: getContentTypeForPath(normalizedPath),
      sizeBytes: buffer.length,
      extension: getExtension(normalizedPath),
    });
  }

  if (files.length === 0) {
    throw new UploadError('ZIP file does not contain any publishable files', 400, 'site');
  }

  return files;
}

function buildResumeSitePrompt({ fields, resumeText }) {
  const brief = {
    siteTitle: cleanText(fields.siteTitle || fields.title || '', 120),
    name: cleanText(fields.fullName || fields.name || '', 120),
    headline: cleanText(fields.headline || fields.jobTitle || '', 180),
    summary: cleanText(fields.summary || '', 1200),
    style: cleanText(fields.style || fields.tone || '', 180),
    palette: cleanText(fields.palette || fields.colors || '', 180),
    ctaText: cleanText(fields.ctaText || fields.cta || '', 120),
    sections: cleanArray(fields.sections || fields.features || '', 12, 120),
    notes: cleanText(fields.notes || fields.brief || '', 2000),
    links: {
      website: cleanText(fields.website || '', 240),
      linkedin: cleanText(fields.linkedin || '', 240),
      github: cleanText(fields.github || '', 240),
    },
  };

  return `You are a world-class resume website designer and front-end engineer.
Build a premium, mobile-first resume website that feels worth 12/10.

Return ONLY valid JSON. No markdown. No explanation.
The JSON must match this shape:
{
  "files": [
    { "path": "index.html", "content": "..." },
    { "path": "styles.css", "content": "..." },
    { "path": "script.js", "content": "..." }
  ],
  "entryPoint": "index.html",
  "meta": {
    "title": "...",
    "description": "...",
    "theme": "..."
  },
  "generatedPdfBase64": "optional base64 encoded PDF"
}

Rules:
- Make the design premium, editorial, and recruiter-friendly.
- Use semantic HTML5 and accessible markup.
- Avoid build tools and external runtime dependencies.
- Keep assets relative so the bundle works on the user's subdomain.
- If you need a PDF resume, include it as generatedPdfBase64.
- Prioritize a strong hero, clear social proof, skills, timeline, achievements, services, and a sharp CTA.
- If details are missing, infer conservatively and never invent experience.

User brief:
${JSON.stringify(brief, null, 2)}

Resume text:
${resumeText}`;
}

function buildFallbackStructuredResume(text, fields) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const fullName = cleanText(fields.fullName || fields.name || lines[0] || 'Professional', 160);
  const headline = cleanText(fields.headline || fields.jobTitle || lines[1] || '', 220);
  const summary = cleanText(fields.summary || text.slice(0, 600) || '', 1200);
  const skills = cleanArray(fields.skills || (String(text).match(/skills?\s*[:\-]\s*([^\n\r]+)/i)?.[1] || ''), 24, 80);
  const email = cleanText(fields.email || (text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] || ''), 220);
  const phone = cleanText(fields.phone || (text.match(/(\+?\d[\d\s().-]{7,}\d)/)?.[0] || ''), 80);
  const location = cleanText(fields.location || [fields.city, fields.country].filter(Boolean).join(', '), 120);

  return {
    fullName,
    headline,
    email,
    phone,
    city: cleanText(fields.city || '', 120),
    country: cleanText(fields.country || '', 120),
    summary,
    skills,
    languages: cleanArray(fields.languages || '', 12, 60),
    achievements: cleanArray(fields.achievements || '', 12, 220),
    experience: [],
    education: [],
    links: {
      linkedin: cleanText(fields.linkedin || '', 240),
      github: cleanText(fields.github || '', 240),
      website: cleanText(fields.website || '', 240),
    },
    location,
  };
}

async function extractResumeText(file) {
  if (file.extension === '.pdf') {
    try {
      const data = await pdfParse(file.buffer);
      return data.text || '';
    } catch (error) {
      return file.buffer.toString('latin1');
    }
  }

  if (file.extension === '.docx') {
    const result = await mammoth.extractRawText({ buffer: file.buffer });
    return result.value || '';
  }

  if (file.extension === '.doc') {
    throw new UploadError('Legacy .doc files are not supported. Please upload .docx, .pdf, or .txt.', 400, 'site');
  }

  if (file.extension === '.txt') {
    return file.buffer.toString('utf8');
  }

  throw new UploadError('Unsupported resume file type', 400, 'site');
}

function normalizeGeneratedFile(file, index) {
  if (!file) {
    return null;
  }

  const filePath = sanitizeRelativePath(file.path || file.name || file.filename || `file-${index}`);
  if (!filePath) {
    return null;
  }

  let buffer = null;
  let mimetype = file.mimetype || getContentTypeForPath(filePath);

  if (Buffer.isBuffer(file.content)) {
    buffer = file.content;
  } else if (Buffer.isBuffer(file.buffer)) {
    buffer = file.buffer;
  } else if (typeof file.contentBase64 === 'string') {
    buffer = Buffer.from(file.contentBase64, 'base64');
  } else if (typeof file.base64 === 'string') {
    buffer = Buffer.from(file.base64, 'base64');
  } else if (typeof file.contentText === 'string') {
    buffer = Buffer.from(file.contentText, 'utf8');
  } else if (typeof file.content === 'string') {
    buffer = Buffer.from(file.content, 'utf8');
  }

  if (!buffer) {
    return null;
  }

  if (!file.mimetype && isTextLikeExtension(getExtension(filePath))) {
    mimetype = getContentTypeForPath(filePath);
  }

  return {
    path: filePath,
    buffer,
    mimetype,
    sizeBytes: buffer.length,
    extension: getExtension(filePath),
  };
}

async function normalizeApiBundle(apiResult, fallbackMeta = {}) {
  if (!apiResult || typeof apiResult !== 'object') {
    throw new Error('Empty site generation response');
  }

  let files = [];

  if (Array.isArray(apiResult.files)) {
    files = apiResult.files
      .map((file, index) => normalizeGeneratedFile(file, index))
      .filter(Boolean);
  }

  if (typeof apiResult.zipBase64 === 'string' && apiResult.zipBase64) {
    const zipBuffer = Buffer.from(apiResult.zipBase64, 'base64');
    const archive = await JSZip.loadAsync(zipBuffer);
    const entries = [];

    archive.forEach((relativePath, zipEntry) => {
      if (!zipEntry.dir) {
        entries.push({
          relativePath: String(relativePath || '').replace(/\\/g, '/'),
          zipEntry,
        });
      }
    });

    const rootStrip = stripCommonZipRoot(entries.map((entry) => entry.relativePath));
    for (const entry of entries) {
      const stripped = entry.relativePath.startsWith(rootStrip)
        ? entry.relativePath.slice(rootStrip.length)
        : entry.relativePath;
      const normalizedPath = sanitizeRelativePath(stripped);
      if (!normalizedPath) {
        continue;
      }

      const buffer = await entry.zipEntry.async('nodebuffer');
      files.push({
        path: normalizedPath,
        buffer,
        mimetype: getContentTypeForPath(normalizedPath),
        sizeBytes: buffer.length,
        extension: getExtension(normalizedPath),
      });
    }
  }

  if (files.length === 0 && typeof apiResult.generatedHtml === 'string' && apiResult.generatedHtml.trim()) {
    const htmlBuffer = Buffer.from(apiResult.generatedHtml, 'utf8');
    files.push({
      path: 'index.html',
      buffer: htmlBuffer,
      mimetype: 'text/html; charset=utf-8',
      sizeBytes: htmlBuffer.length,
      extension: '.html',
    });
  }

  const pdfBase64 = apiResult.generatedPdfBase64 || apiResult.pdfBase64 || '';
  if (typeof pdfBase64 === 'string' && pdfBase64) {
    const pdfBuffer = Buffer.from(pdfBase64, 'base64');
    files.push({
      path: 'resume.pdf',
      buffer: pdfBuffer,
      mimetype: 'application/pdf',
      sizeBytes: pdfBuffer.length,
      extension: '.pdf',
    });
  }

  if (files.length === 0) {
    throw new Error('The site generation API did not return any files');
  }

  const entryPoint = sanitizeRelativePath(apiResult.entryPoint || fallbackMeta.entryPoint || detectEntryPoint(files) || 'index.html') || 'index.html';
  const generatedHtml = typeof apiResult.generatedHtml === 'string'
    ? apiResult.generatedHtml
    : (files.find((file) => file.path === entryPoint)?.buffer.toString('utf8') || '');

  return {
    files,
    entryPoint,
    generatedHtml,
    structuredJson: apiResult.meta || apiResult.metadata || {},
    generatedCvPdfBase64: pdfBase64,
    aiGenerated: true,
    rawText: apiResult.rawText || fallbackMeta.rawText || '',
  };
}

async function buildSiteBundleFromResume(files, fields) {
  const extractedTexts = [];
  for (const file of files) {
    extractedTexts.push(await extractResumeText(file));
  }

  const resumeText = extractedTexts.join('\n\n---\n\n').trim();
  const prompt = buildResumeSitePrompt({ fields, resumeText });

  if (env.siteGenerationApiUrl) {
    const response = await fetch(env.siteGenerationApiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(env.siteGenerationApiKey ? { Authorization: `Bearer ${env.siteGenerationApiKey}` } : {}),
      },
      body: JSON.stringify({
        prompt,
        fields,
        resumeText,
        files: files.map((file) => ({
          name: file.originalName,
          mimetype: file.mimetype,
          extension: file.extension,
          contentBase64: file.buffer.toString('base64'),
        })),
      }),
    });

    const responseJson = await response.json().catch(() => null);

    if (!response.ok) {
      throw new Error(responseJson?.error || `Site generation API failed with status ${response.status}`);
    }

    return await normalizeApiBundle(responseJson, { rawText: resumeText });
  }

  const structuredResume = buildFallbackStructuredResume(resumeText, fields);
  const generatedHtml = generateHTML(structuredResume);
  const htmlBuffer = Buffer.from(generatedHtml, 'utf8');

  return {
    files: [{
      path: 'index.html',
      buffer: htmlBuffer,
      mimetype: 'text/html; charset=utf-8',
      sizeBytes: htmlBuffer.length,
      extension: '.html',
    }],
    entryPoint: 'index.html',
    generatedHtml,
    structuredJson: structuredResume,
    generatedCvPdfBase64: '',
    aiGenerated: true,
    rawText: resumeText,
    prompt,
  };
}

async function buildStaticSiteBundle(files) {
  if (files.length === 1 && files[0].extension === '.zip') {
    const zippedFiles = await extractZipBundle(files[0]);
    const entryPoint = detectEntryPoint(zippedFiles);

    if (!entryPoint) {
      throw new UploadError('ZIP file must contain an index.html or another HTML entry point', 400, 'site');
    }

    const entryFile = zippedFiles.find((file) => file.relativePath === entryPoint);
    const generatedHtml = entryFile?.buffer.toString('utf8') || '';

    return {
      files: zippedFiles.map((file) => ({
        path: file.relativePath,
        buffer: file.buffer,
        mimetype: file.mimetype,
        sizeBytes: file.sizeBytes,
        extension: file.extension,
      })),
      entryPoint,
      generatedHtml,
      structuredJson: {
        type: 'static-site',
        source: 'zip',
        entryPoint,
        files: zippedFiles.map((file) => ({
          path: file.relativePath,
          mimetype: file.mimetype,
          sizeBytes: file.sizeBytes,
        })),
      },
      generatedCvPdfBase64: '',
      aiGenerated: false,
      rawText: JSON.stringify({
        source: 'zip',
        files: zippedFiles.map((file) => file.relativePath),
      }),
    };
  }

  const invalid = files.find((file) => !STATIC_EXTENSIONS.has(file.extension));
  if (invalid) {
    throw new UploadError('Static site uploads accept only HTML, CSS, JS, or ZIP files', 400, 'site');
  }

  const htmlFiles = files.filter((file) => ['.html', '.htm'].includes(file.extension));
  if (htmlFiles.length === 0) {
    throw new UploadError('A static site upload must include at least one HTML file', 400, 'site');
  }

  const entryFile = htmlFiles.find((file) => sanitizeFilename(file.originalName).toLowerCase() === 'index.html') || htmlFiles[0];
  const generatedHtml = entryFile.buffer.toString('utf8');

  return {
    files: files.map((file) => ({
      path: sanitizeRelativePath(file.originalName) || sanitizeFilename(file.originalName),
      buffer: file.buffer,
      mimetype: file.mimetype,
      sizeBytes: file.sizeBytes,
      extension: file.extension,
    })),
    entryPoint: sanitizeRelativePath(entryFile.originalName) || sanitizeFilename(entryFile.originalName),
    generatedHtml,
    structuredJson: {
      type: 'static-site',
      source: 'files',
      entryPoint: sanitizeRelativePath(entryFile.originalName) || sanitizeFilename(entryFile.originalName),
      files: files.map((file) => ({
        path: sanitizeRelativePath(file.originalName) || sanitizeFilename(file.originalName),
        mimetype: file.mimetype,
        sizeBytes: file.sizeBytes,
      })),
    },
    generatedCvPdfBase64: '',
    aiGenerated: false,
    rawText: JSON.stringify({
      source: 'files',
      files: files.map((file) => ({
        name: file.originalName,
        mimetype: file.mimetype,
        sizeBytes: file.sizeBytes,
      })),
    }),
  };
}

async function persistSiteBundle({
  userId,
  bundle,
  fields,
  sourceType,
  originalFilename,
}) {
  const deploymentId = uuidv4();
  const sitePrefix = `sites/${userId}/${deploymentId}`;
  const uploadedObjects = [];
  let totalBytes = 0;
  let generatedCvPdfPath = null;

  try {
    for (const file of bundle.files) {
      const objectPath = `${sitePrefix}/${file.path}`;
      const mimetype = file.mimetype || getContentTypeForPath(file.path);
      await uploadFile(file.buffer, objectPath, mimetype);
      uploadedObjects.push(objectPath);
      totalBytes += file.sizeBytes || file.buffer.length || 0;

      if (file.extension === '.pdf' && !generatedCvPdfPath) {
        generatedCvPdfPath = objectPath;
      }
    }

    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      const { rows } = await client.query(
        `INSERT INTO deployments (
          id, user_id, domain_id, method, status, minio_path, original_filename, file_size_bytes, deployed_at
        ) VALUES (
          $1,
          $2,
          (SELECT id FROM domains WHERE user_id = $2 ORDER BY is_primary DESC, created_at ASC LIMIT 1),
          'files',
          'live',
          $3,
          $4,
          $5,
          NOW()
        )
        RETURNING id, status, method, deployed_at`,
        [
          deploymentId,
          userId,
          sitePrefix,
          sanitizeFilename(originalFilename || bundle.entryPoint || 'site'),
          totalBytes,
        ],
      );

      const structuredJson = {
        ...(bundle.structuredJson || {}),
        upload: {
          kind: bundle.structuredJson?.source || sourceType,
          fields,
        },
        entryPoint: bundle.entryPoint,
        files: bundle.structuredJson?.files || bundle.files.map((file) => ({
          path: file.path,
          mimetype: file.mimetype,
          sizeBytes: file.sizeBytes,
        })),
        prompt: bundle.prompt || null,
      };

      await client.query(
        `INSERT INTO parsed_content (
          user_id, deployment_id, source_type, raw_text, structured_json,
          generated_html, generated_cv_pdf_path, ai_generated
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          userId,
          deploymentId,
          sourceType,
          bundle.rawText || null,
          JSON.stringify(structuredJson),
          bundle.generatedHtml || null,
          generatedCvPdfPath,
          Boolean(bundle.aiGenerated),
        ],
      );

      await client.query('UPDATE domains SET is_active = true WHERE user_id = $1', [userId]);
      await client.query('UPDATE professional_profiles SET is_public = true, updated_at = NOW() WHERE user_id = $1', [userId]);

      await client.query('COMMIT');

      return {
        deploymentId: rows[0].id,
        status: rows[0].status,
        method: rows[0].method,
        entryPoint: bundle.entryPoint,
        fileCount: bundle.files.length,
        bundleType: bundle.structuredJson?.source || sourceType,
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    await Promise.all(uploadedObjects.map((objectPath) => deleteFile(objectPath).catch(() => null)));
    throw error;
  }
}

async function uploadWebsiteBundle(request, userId) {
  const { files, fields } = await readMultipartFiles(request, 'site');
  const kind = determineUploadKind(files);
  const normalizedFields = {
    siteTitle: cleanText(fields.siteTitle || fields.title || '', 160),
    fullName: cleanText(fields.fullName || fields.name || '', 160),
    headline: cleanText(fields.headline || fields.jobTitle || '', 220),
    summary: cleanText(fields.summary || '', 1500),
    style: cleanText(fields.style || fields.tone || '', 220),
    palette: cleanText(fields.palette || fields.colors || '', 220),
    ctaText: cleanText(fields.ctaText || fields.cta || '', 120),
    sections: cleanArray(fields.sections || '', 12, 120),
    notes: cleanText(fields.notes || fields.brief || '', 2400),
    email: cleanText(fields.email || '', 220),
    phone: cleanText(fields.phone || '', 80),
    city: cleanText(fields.city || '', 120),
    country: cleanText(fields.country || '', 120),
    linkedin: cleanText(fields.linkedin || '', 240),
    github: cleanText(fields.github || '', 240),
    website: cleanText(fields.website || '', 240),
  };

  if (kind === 'resume') {
    const bundle = await buildSiteBundleFromResume(files, normalizedFields);
    const primaryExtension = files.find((file) => RESUME_EXTENSIONS.has(file.extension))?.extension.replace('.', '') || 'resume';
    return persistSiteBundle({
      userId,
      bundle,
      fields: normalizedFields,
      sourceType: primaryExtension,
      originalFilename: files.map((file) => file.originalName).join(', '),
    });
  }

  const bundle = await buildStaticSiteBundle(files);
  return persistSiteBundle({
    userId,
    bundle,
    fields: normalizedFields,
    sourceType: 'manual',
    originalFilename: files.map((file) => file.originalName).join(', '),
  });
}

module.exports = {
  uploadWebsiteBundle,
  buildResumeSitePrompt,
  readMultipartFiles,
  buildStaticSiteBundle,
  buildSiteBundleFromResume,
  persistSiteBundle,
  determineUploadKind,
  sanitizeRelativePath,
  getContentTypeForPath,
  ALLOWED_SITE_EXTENSIONS,
  STATIC_EXTENSIONS,
  RESUME_EXTENSIONS,
};

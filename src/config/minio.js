const Minio = require('minio');
const env = require('./env');

const bucketName = env.minio.bucket;
const DOWNLOAD_TIMEOUT_MS = 5000;

const minioClient = new Minio.Client({
  endPoint: env.minio.endPoint,
  port: env.minio.port,
  useSSL: env.minio.useSSL,
  accessKey: env.minio.accessKey,
  secretKey: env.minio.secretKey,
});

async function ensureBucket() {
  const exists = await minioClient.bucketExists(bucketName);

  if (!exists) {
    await minioClient.makeBucket(bucketName);
  }
}

async function uploadFile(buffer, filename, mimetype) {
  await ensureBucket();

  await minioClient.putObject(bucketName, filename, buffer, buffer.length, {
    'Content-Type': mimetype,
  });

  return filename;
}

async function getFileUrl(filename) {
  return minioClient.presignedGetObject(bucketName, filename, 60 * 60);
}

async function deleteFile(filename) {
  await minioClient.removeObject(bucketName, filename);
}

async function deletePrefix(prefix) {
  const normalizedPrefix = String(prefix || '').replace(/^\/+/, '').replace(/\/+$/, '');
  if (!normalizedPrefix) return;
  const objectNames = [];
  const stream = minioClient.listObjectsV2(bucketName, `${normalizedPrefix}/`, true);
  await new Promise((resolve, reject) => {
    stream.on('data', (item) => { if (item?.name) objectNames.push(item.name); });
    stream.once('end', resolve);
    stream.once('error', reject);
  });
  if (objectNames.length) await minioClient.removeObjects(bucketName, objectNames);
  try {
    await minioClient.removeObject(bucketName, normalizedPrefix);
  } catch (error) {
    if (error.code !== 'NoSuchKey' && error.code !== 'NotFound') throw error;
  }
}

async function downloadFile(filename, timeoutMs = DOWNLOAD_TIMEOUT_MS) {
  const stream = await minioClient.getObject(bucketName, filename);
  const chunks = [];

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      const error = new Error(`Timed out downloading ${filename}`);
      error.code = 'MINIO_DOWNLOAD_TIMEOUT';
      stream.destroy(error);
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timeout);
    };

    stream.on('data', (chunk) => {
      chunks.push(chunk);
    });

    stream.once('end', () => {
      cleanup();
      resolve(Buffer.concat(chunks));
    });

    stream.once('error', (error) => {
      cleanup();
      reject(error);
    });

    stream.once('close', cleanup);
  });
}

module.exports = {
  minioClient,
  ensureBucket,
  uploadFile,
  getFileUrl,
  deleteFile,
  deletePrefix,
  downloadFile,
  bucketName,
};

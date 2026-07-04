const buildApp = require('../src/app');

let appPromise;
let readyPromise;

function getApp() {
  if (!appPromise) {
    appPromise = buildApp({
      logger: true,
    });
    readyPromise = appPromise.then(async (app) => {
      await app.ready();
      return app;
    });
  }

  return readyPromise;
}

module.exports = async function vercelHandler(req, res) {
  const requestUrl = new URL(req.url, 'http://127.0.0.1');
  const path = requestUrl.searchParams.get('path') || '';

  requestUrl.searchParams.delete('path');
  req.url = `/${path}${requestUrl.search}`;

  const app = await getApp();
  app.server.emit('request', req, res);
};

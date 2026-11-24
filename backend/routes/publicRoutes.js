// Routes for every user who may use the module (core's module access already
// decided that before this router runs). Nothing here returns a secret, a
// path or a host: the browser only ever learns labels and capabilities.
const express = require('express');
const { readConfig } = require('../lib/config');

module.exports = function buildPublicRouter(coreApi) {
  const router = express.Router();

  // GET <api>/ai/config - what the chat page needs to draw itself.
  router.get('/config', coreApi.authenticateToken, (req, res) => {
    const cfg = readConfig(coreApi);
    res.json({
      configured: cfg.missing.length === 0 && cfg.modelErrors.length === 0,
      models: cfg.models
    });
  });

  return router;
};

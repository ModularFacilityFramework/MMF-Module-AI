// Routes for every user who may use the module (core's module access already
// decided that before this router runs). Nothing here returns a secret, a
// path or a host: the browser only ever learns labels and capabilities.
const express = require('express');
const { readConfig } = require('../lib/config');
const { overview } = require('../lib/status');

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

  // GET <api>/ai/status - is the AI usable right now, and with which model?
  // Polled by the chat page for its banner.
  router.get('/status', coreApi.authenticateToken, async (req, res) => {
    try {
      const o = await overview(coreApi);
      res.json({
        state: o.state,
        message: o.message,
        model: o.model,
        keyword: o.keyword,
        maxModelLen: o.vllm ? o.vllm.maxModelLen : null
      });
    } catch (err) {
      res.status(500).json({ error: 'Could not read the AI status' });
    }
  });

  return router;
};

// Routes for every user who may use the module (core's module access already
// decided that before this router runs). Nothing here returns a secret, a
// path or a host: the browser only ever learns labels and capabilities.
const express = require('express');
const { readConfig } = require('../lib/config');
const { overview } = require('../lib/status');
const { getLimits } = require('../lib/limits');
const speech = require('../lib/speech');
const safety = require('../lib/safety');

module.exports = function buildPublicRouter(coreApi) {
  const router = express.Router();

  // GET <api>/ai/config - what the chat page needs to draw itself.
  router.get('/config', coreApi.authenticateToken, async (req, res) => {
    const cfg = readConfig(coreApi);
    const limits = await getLimits(coreApi.pool);
    res.json({
      configured: cfg.missing.length === 0 && cfg.modelErrors.length === 0,
      speech: await speech.allowed(coreApi, req.user).catch(() => false),
      // the person's AI level (core's roles decide): 'standard' or 'advanced'
      level: await safety.levelFor(coreApi, req.user),
      models: cfg.models,
      limits: {
        maxPromptKB: limits.maxPromptKB,
        maxFileMB: limits.maxFileMB,
        maxImageMB: limits.maxImageMB,
        maxFilesPerMessage: limits.maxFilesPerMessage
      }
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
        notice: o.notice || null,
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

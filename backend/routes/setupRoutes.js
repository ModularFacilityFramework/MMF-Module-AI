// Setup page routes. The Setup page is the manifest page "setup": core's
// normal page access decides who may open it (Setup -> Preferences -> Access;
// a declared page with no grants is developer/administrator only). Actions on
// the shared GPU or on limits get their own, stricter checks in later steps.
const express = require('express');
const { configStatus } = require('../lib/config');

module.exports = function buildSetupRouter(coreApi) {
  const router = express.Router();
  const setupGate = [coreApi.authenticateToken, coreApi.requirePage('setup')];

  // GET <api>/ai/setup/status - is the module configured? Answers 403 to a
  // user without the Setup page, which the frontend also uses to decide
  // whether to show the Setup tab at all.
  router.get('/setup/status', ...setupGate, (req, res) => {
    res.json({ config: configStatus(coreApi) });
  });

  return router;
};

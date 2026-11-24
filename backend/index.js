// Module entry point. mff-core's auto-loader (App_backend/src/core/services/moduleLoader.js)
// requires this file and calls register(coreApi) once at startup - see docs/MFF-Core_module-core-api.md
// for the full coreApi contract. This file is the ONLY place this module talks to core.
const express = require('express');
const manifest = require('../module.manifest.json');
const modulePool = require('./config/database');
const buildAiRouter = require('./routes/aiRoutes');
const buildPageAccessRouter = require('./routes/pageAccessRoutes');

module.exports = function register(coreApi) {
  const moduleApi = { ...coreApi, pool: modulePool };
  const router = express.Router();
  router.use(buildAiRouter(moduleApi));
  router.use(buildPageAccessRouter(moduleApi));
  return {
    router,
    moduleId: manifest.id,
    label: manifest.label,
    version: manifest.version
  };
};

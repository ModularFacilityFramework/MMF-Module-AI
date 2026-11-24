// Module entry point. mff-core's auto-loader (App_backend/src/core/services/moduleLoader.js)
// requires this file and calls register(coreApi) once at startup - see
// docs/MFF-Core_module-core-api.md for the full coreApi contract. This file is
// the ONLY place this module talks to core.
const express = require('express');
const manifest = require('../module.manifest.json');
const createPool = require('./config/database');
const buildPublicRouter = require('./routes/publicRoutes');
const buildSetupRouter = require('./routes/setupRoutes');

module.exports = function register(coreApi) {
  // This module's own database (credentials from core's .env), shadowing
  // core's pool so no route can touch core's tables by accident.
  const moduleApi = { ...coreApi, pool: createPool(coreApi) };
  const router = express.Router();
  router.use(buildPublicRouter(moduleApi));
  router.use(buildSetupRouter(moduleApi));
  return {
    router,
    moduleId: manifest.id,
    label: manifest.label,
    version: manifest.version
  };
};

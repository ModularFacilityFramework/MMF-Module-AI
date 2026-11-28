// Module entry point. mff-core's auto-loader (App_backend/src/core/services/moduleLoader.js)
// requires this file and calls register(coreApi) once at startup - see
// docs/MFF-Core_module-core-api.md for the full coreApi contract. This file is
// the ONLY place this module talks to core.
const express = require('express');
const manifest = require('../module.manifest.json');
const createPool = require('./config/database');
const buildPublicRouter = require('./routes/publicRoutes');
const buildChatRouter = require('./routes/chatRoutes');
const buildSetupRouter = require('./routes/setupRoutes');
const cleanup = require('./lib/cleanup');

module.exports = function register(coreApi) {
  // This module's own database (credentials from core's .env), shadowing
  // core's pool so no route can touch core's tables by accident.
  const moduleApi = { ...coreApi, pool: createPool(coreApi) };
  const router = express.Router();
  router.use(buildPublicRouter(moduleApi));
  router.use(buildChatRouter(moduleApi));
  router.use(buildSetupRouter(moduleApi));
  cleanup.schedule(moduleApi);
  // Tool servers named in MODULE_AI_MCP_SERVERS: added once, after start-up,
  // then tried again every 10 minutes until their default tools are in use.
  const preload = () => require('./lib/mcp').preload(moduleApi)
    .then((r) => { if (r.added.length || r.tools.length) console.log(`[ai] tool servers preloaded: ${r.added.join(', ') || '-'}; tools put in use: ${r.tools.length}`); })
    .catch(err => console.error(`[ai] tool servers could not be preloaded: ${err.message}`));
  setTimeout(preload, 90000).unref();
  setInterval(preload, 600000).unref();
  return {
    router,
    moduleId: manifest.id,
    label: manifest.label,
    version: manifest.version
  };
};

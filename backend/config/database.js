const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const mariadb = require('mariadb');

// Own database, own credentials - written once by mff-core's install/update
// flow at ../../.env (this module's root, sibling to module.manifest.json).
// dotenv.parse (not dotenv.config) is required here: mff-core's own backend
// already calls dotenv.config() for its own .env at startup, which never
// overwrites a key already in process.env - a second dotenv.config() call
// for this module's .env would silently be a no-op if any variable name
// collided with core's, handing this module core's own credentials instead
// of its own. dotenv.parse() into a local object makes that structurally
// impossible, which is also why these variables are named MODULE_DB_* and
// not bare DB_* - never reuse core's exact names here, even by accident.
const envPath = path.join(__dirname, '..', '..', '.env');

// backend/index.js shadows coreApi.pool with this file's pool unconditionally
// (see docs/MFF-Core_module-core-api.md). A real install always has envPath
// by the time this loads (see docs/MFF-Core_module-database-provisioning.md).
function loadEnv() {
  if (fs.existsSync(envPath)) return dotenv.parse(fs.readFileSync(envPath));
  return {};
}
const env = loadEnv();

module.exports = mariadb.createPool({
  host: env.MODULE_DB_HOST || '127.0.0.1',
  user: env.MODULE_DB_USER,
  password: env.MODULE_DB_PASSWORD,
  database: env.MODULE_DB_NAME,
  connectionLimit: Number(env.MODULE_DB_CONNECTION_LIMIT) || 5,
  bigIntAsNumber: true,
  insertIdAsNumber: true
});

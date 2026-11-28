const mariadb = require('mariadb');

// This module's own database. Core provisions it at Install and writes the
// credentials to its one App_backend/.env as MODULE_AI_DB_*; we read them
// through coreApi.getModuleConfig() (prefix stripped). A module never has an
// .env of its own - see docs/MFF-Core_module-database-provisioning.md.
//
// The pool is made on first use, not when the module is registered: core loads
// the other modules after this one, which can block the backend for 10-120 s,
// and a pool made at registration then timed out connecting and logged
// "Error during pool initialization" (seen in production, 28/11/2026). The
// first use comes after start-up (a status poll, a chat, the hourly cleanup).
// Errors of the pool are logged with the module's name and their cause, at
// most once a minute; queries still fail and are retried as usual.

const LOG_EVERY_MS = 60000;

// Logs a pool's errors with a label and the underlying cause, rate-limited.
function errorLogger(label) {
  let lastAt = 0;
  let skipped = 0;
  return (err) => {
    const now = Date.now();
    if (now - lastAt < LOG_EVERY_MS) { skipped += 1; return; }
    const cause = err && err.cause ? ` (cause: ${err.cause.code || ''} ${err.cause.message || ''})`.replace(/\s+\)/, ')') : '';
    console.error(`[ai] ${label}: ${err && err.message ? err.message : err}${cause}${skipped ? ` (+${skipped} more since the last report)` : ''}`);
    lastAt = now;
    skipped = 0;
  };
}

// Options shared by this module's pools: no eager connections (at most one
// idle), and room for a slow first connection.
const POOL_DEFAULTS = { minimumIdle: 1, initializationTimeout: 30000, acquireTimeout: 15000 };

function createPool(coreApi) {
  let pool = null;
  const get = () => {
    if (pool) return pool;
    const { DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME, DB_CONNECTION_LIMIT } = coreApi.getModuleConfig() || {};
    pool = mariadb.createPool({
      host: DB_HOST || '127.0.0.1',
      port: Number(DB_PORT) || 3306,
      user: DB_USER,
      password: DB_PASSWORD,
      database: DB_NAME,
      connectionLimit: Number(DB_CONNECTION_LIMIT) || 5,
      ...POOL_DEFAULTS,
      bigIntAsNumber: true,
      insertIdAsNumber: true
    });
    pool.on('error', errorLogger('module database pool'));
    return pool;
  };
  // The same calls as a mariadb pool; the real pool is made on the first one.
  return {
    query: (...args) => get().query(...args),
    getConnection: () => get().getConnection(),
    end: () => (pool ? pool.end() : Promise.resolve())
  };
}

module.exports = createPool;
module.exports.errorLogger = errorLogger;
module.exports.POOL_DEFAULTS = POOL_DEFAULTS;

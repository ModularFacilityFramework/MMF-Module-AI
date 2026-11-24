const mariadb = require('mariadb');

// This module's own database. Core provisions it at Install and writes the
// credentials to its one App_backend/.env as MODULE_AI_DB_*; we read them
// through coreApi.getModuleConfig() (prefix stripped). A module never has an
// .env of its own - see docs/MFF-Core_module-database-provisioning.md.
module.exports = function createPool(coreApi) {
  const { DB_HOST, DB_USER, DB_PASSWORD, DB_NAME, DB_CONNECTION_LIMIT } = coreApi.getModuleConfig() || {};
  return mariadb.createPool({
    host: DB_HOST || '127.0.0.1',
    user: DB_USER,
    password: DB_PASSWORD,
    database: DB_NAME,
    connectionLimit: Number(DB_CONNECTION_LIMIT) || 5,
    bigIntAsNumber: true,
    insertIdAsNumber: true
  });
};

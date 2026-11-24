// Which roles can see which of this module's tabs - staff (canManageUsers,
// checked frontend-side via coreApi.useRoles) always see every tab
// regardless of what's configured here; this only ever adds visibility for
// non-staff roles. Everything this module needs from core comes through
// coreApi - see docs/MFF-Core_module-core-api.md for the full contract.
const express = require('express');

const KNOWN_PAGES = [
  { key: 'overview', label: 'Overview' }
];

module.exports = function buildRouter(coreApi) {
  const router = express.Router();

  router.get('/page-access', coreApi.authenticateToken, async (req, res) => {
    const conn = await coreApi.pool.getConnection();
    try {
      const roles = await coreApi.listRoles();
      const rows = await conn.query('SELECT page_key, role FROM example_page_access');
      const access = {};
      for (const page of KNOWN_PAGES) access[page.key] = [];
      for (const row of rows) {
        if (!access[row.page_key]) access[row.page_key] = [];
        access[row.page_key].push(row.role);
      }
      res.json({ pages: KNOWN_PAGES, roles, access });
    } catch (err) {
      res.status(500).json({ error: 'Failed to fetch page access', message: err.message });
    } finally {
      conn.release();
    }
  });

  router.put('/page-access', coreApi.authenticateToken, coreApi.checkRole(['developer', 'administrator']), async (req, res) => {
    const { access } = req.body;
    if (!access || typeof access !== 'object') return res.status(400).json({ error: 'access object is required' });

    const conn = await coreApi.pool.getConnection();
    try {
      const validRoles = await coreApi.listRoles();
      await conn.beginTransaction();
      await conn.query('DELETE FROM example_page_access');
      for (const page of KNOWN_PAGES) {
        const requestedRoles = Array.isArray(access[page.key]) ? access[page.key] : [];
        for (const role of requestedRoles) {
          if (!validRoles.includes(role)) continue;
          await conn.query('INSERT INTO example_page_access (page_key, role) VALUES (?, ?)', [page.key, role]);
        }
      }
      await conn.commit();
      res.json({ success: true });
    } catch (err) {
      await conn.rollback();
      res.status(500).json({ error: 'Failed to update page access', message: err.message });
    } finally {
      conn.release();
    }
  });

  return router;
};

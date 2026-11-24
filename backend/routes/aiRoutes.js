// Example route file - delete/replace once this module has its own real routes.
// Everything this module needs from core comes through coreApi (passed into
// register() in ../index.js and down to here) - never via a relative require
// into an mff-core checkout. See docs/MFF-Core_module-core-api.md for the full contract.
const express = require('express');

module.exports = function buildRouter(coreApi) {
  const router = express.Router();

  // GET /api/ai/things - any authenticated user
  router.get('/things', coreApi.authenticateToken, async (req, res) => {
    const conn = await coreApi.pool.getConnection();
    try {
      const rows = await conn.query(
        'SELECT id, name, owner_id, created_at FROM ai_things WHERE owner_id = ? ORDER BY created_at DESC',
        [req.user.id]
      );
      res.json(rows);
    } catch (err) {
      res.status(500).json({ error: 'Failed to fetch things', message: err.message });
    } finally {
      conn.release();
    }
  });

  // POST /api/ai/things - staff-only example (checkRole gate)
  router.post('/things', coreApi.authenticateToken, coreApi.checkRole(['developer', 'administrator']), async (req, res) => {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });

    const conn = await coreApi.pool.getConnection();
    try {
      const result = await conn.query(
        'INSERT INTO ai_things (name, owner_id) VALUES (?, ?)',
        [name, req.user.id]
      );
      // coreApi.pool is created with bigIntAsNumber/insertIdAsNumber (matching
      // core's own pool config) - result.insertId is already a plain Number.
      res.status(201).json({ id: result.insertId, name, owner_id: req.user.id });
    } catch (err) {
      res.status(500).json({ error: 'Failed to create thing', message: err.message });
    } finally {
      conn.release();
    }
  });

  return router;
};

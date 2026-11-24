// Small key/value store for settings that administrators and developers
// change on the Setup page (limits, who may switch models, ...). Values are
// JSON. Defaults live in code; a row only exists once someone saves a change.

async function getSetting(pool, key, fallback) {
  const rows = await pool.query('SELECT value_json FROM ai_settings WHERE setting_key = ?', [key]);
  if (!rows.length) return fallback;
  try {
    return JSON.parse(rows[0].value_json);
  } catch (err) {
    return fallback;
  }
}

async function setSetting(pool, key, value, userId) {
  await pool.query(
    `INSERT INTO ai_settings (setting_key, value_json, updated_by)
     VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE value_json = VALUES(value_json), updated_by = VALUES(updated_by)`,
    [key, JSON.stringify(value), userId || null]
  );
}

module.exports = { getSetting, setSetting };

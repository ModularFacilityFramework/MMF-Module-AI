// Hourly housekeeping in the storage of people who have used the chat:
// abandoned uploads (after a day) and chats the person deleted (after
// limits.trashDays). Everything else is kept until its owner deletes it.
// Someone whose storage is switched off is left alone, never emptied.
const fsp = require('fs').promises;
const path = require('path');
const storage = require('./storage');
const { readConfig } = require('./config');
const { getLimits } = require('./limits');

const EVERY_MS = 3600000;
const FIRST_MS = 300000;
const TMP_MAX_AGE_MS = 86400000;

async function cleanRoot(root, trashDays, now = Date.now()) {
  const done = { tmp: 0, chats: 0 };
  const tmp = path.join(root, 'uploads-tmp');
  for (const name of await fsp.readdir(tmp).catch(() => [])) {
    const file = path.join(tmp, name);
    const st = await fsp.lstat(file).catch(() => null);
    if (st && st.isFile() && now - st.mtimeMs > TMP_MAX_AGE_MS) {
      await fsp.rm(file, { force: true });
      done.tmp += 1;
    }
  }
  // Only a chat folder whose own chat.json says when it was deleted.
  for (const chat of await storage.listDir(path.join(root, 'trash'))) {
    const at = Date.parse(chat.deletedAt || '');
    if (storage.UUID_RE.test(chat.id) && Number.isFinite(at) && now - at > trashDays * 86400000) {
      await fsp.rm(path.join(root, 'trash', chat.id), { recursive: true, force: true });
      done.chats += 1;
    }
  }
  return done;
}

async function run(coreApi) {
  const limits = await getLimits(coreApi.pool);
  const { storageSubdir } = readConfig(coreApi);
  const rows = await coreApi.pool.query('SELECT user_id FROM ai_storage_users');
  const total = { people: 0, tmp: 0, chats: 0 };
  for (const { user_id: userId } of rows) {
    try {
      const ws = await coreApi.getUserWorkspacePathForUserId(Number(userId));
      if (!ws.active) continue;
      const root = path.join(ws.path, storageSubdir);
      if (!(await fsp.stat(root).catch(() => null))) continue;
      const done = await cleanRoot(root, limits.trashDays);
      const bytes = await storage.dirSize(root);
      await coreApi.pool.query('UPDATE ai_storage_users SET used_bytes = ?, checked_at = NOW() WHERE user_id = ?', [bytes, userId]);
      total.people += 1;
      total.tmp += done.tmp;
      total.chats += done.chats;
    } catch (err) {
      console.error(`[ai] cleanup failed for user ${userId}: ${err.code || err.name}`);
    }
  }
  return total;
}

function schedule(coreApi) {
  if (typeof coreApi.getUserWorkspacePathForUserId !== 'function') return;
  let running = false;
  const go = async () => {
    if (running) return;
    running = true;
    try { await run(coreApi); } catch (err) { console.error(`[ai] cleanup failed: ${err.code || err.name}`); }
    running = false;
  };
  setTimeout(go, FIRST_MS).unref();
  setInterval(go, EVERY_MS).unref();
}

// Remembers that this person has storage in use (once per backend run).
const seen = new Set();
async function noteUser(pool, userId) {
  if (seen.has(userId)) return;
  seen.add(userId);
  try {
    await pool.query('INSERT IGNORE INTO ai_storage_users (user_id) VALUES (?)', [userId]);
  } catch (err) { seen.delete(userId); }
}

module.exports = { schedule, run, cleanRoot, noteUser };

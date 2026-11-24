// A user's chats and uploads, kept only in that user's own server storage
// (core's per-user workspace). Nothing about a chat - not even its title - is
// written to the database, so administrators cannot read chats through MFF.
//
//   <workspace>/<STORAGE_SUBDIR>/
//     chats/<chatId>/chat.json        title, dates
//     chats/<chatId>/messages.jsonl   append-only: one message or edit per line
//     chats/<chatId>/files/<fileId>.* the upload (never changed), its
//                                     extracted text / reduced image, its meta
//     trash/<chatId>/                 deleted chats, purged later
//     uploads-tmp/                    uploads in progress
//
// Every path is built from ids that match UUID_RE, so no request can point
// outside the user's own folder.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { randomUUID } = require('crypto');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TITLE_MAX = 120;

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const notFound = () => new HttpError(404, 'not_found', 'This chat does not exist (it may have been deleted).');

function assertId(id) {
  if (typeof id !== 'string' || !UUID_RE.test(id)) throw notFound();
  return id;
}

async function mkdir(dir) {
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
}

// The user's module folder, created on first use. Throws HttpError 503 when
// the user has no server storage.
async function rootForWorkspace(ws, subdir) {
  if (!ws || !ws.active || !ws.path) {
    throw new HttpError(503, 'no_storage',
      'You do not have server storage yet, and the chat keeps your conversations there. Ask an administrator to enable "workspace storage" for your account.');
  }
  const root = path.join(ws.path, subdir);
  await mkdir(root);
  await Promise.all(['chats', 'trash', 'uploads-tmp'].map(d => mkdir(path.join(root, d))));
  return root;
}

const chatDir = (root, id) => path.join(root, 'chats', assertId(id));
const trashDir = (root, id) => path.join(root, 'trash', assertId(id));

async function writeAtomic(file, text) {
  const tmp = `${file}.${randomUUID()}.tmp`;
  try {
    await fsp.writeFile(tmp, text, { mode: 0o600 });
    await fsp.rename(tmp, file);
  } catch (err) {
    await fsp.rm(tmp, { force: true });
    throw err;
  }
}

// One writer at a time per folder (this backend is the only writer).
const locks = new Map();
function withLock(key, fn) {
  const prev = locks.get(key) || Promise.resolve();
  const next = prev.then(fn, fn);
  const settled = next.catch(() => {});
  locks.set(key, settled);
  settled.then(() => { if (locks.get(key) === settled) locks.delete(key); });
  return next;
}

async function readMeta(dir) {
  try {
    return JSON.parse(await fsp.readFile(path.join(dir, 'chat.json'), 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') throw notFound();
    throw err;
  }
}

function cleanTitle(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  return t.length > TITLE_MAX ? `${t.slice(0, TITLE_MAX - 1)}…` : t;
}

async function createChat(root) {
  const id = randomUUID();
  const dir = chatDir(root, id);
  await mkdir(path.join(dir, 'files'));
  const now = new Date().toISOString();
  const meta = { id, title: 'New chat', titleSetBy: 'default', createdAt: now, updatedAt: now };
  await writeAtomic(path.join(dir, 'chat.json'), JSON.stringify(meta));
  return meta;
}

function updateMeta(root, id, change) {
  const dir = chatDir(root, id);
  return withLock(dir, async () => {
    const meta = { ...(await readMeta(dir)), ...change };
    await writeAtomic(path.join(dir, 'chat.json'), JSON.stringify(meta));
    return meta;
  });
}

const getChat = (root, id) => readMeta(chatDir(root, id));

// An unreadable chat (half-written folder, disk error) is left out of the list
// instead of hiding all the others.
async function listDir(base) {
  let names;
  try {
    names = await fsp.readdir(base);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const metas = await Promise.all(names.filter(n => UUID_RE.test(n))
    .map(n => readMeta(path.join(base, n)).catch(() => null)));
  return metas.filter(Boolean).sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

const listChats = root => listDir(path.join(root, 'chats'));

// Messages are append-only. {op:"cut", from:id} drops that message and all
// after it (edit and regenerate), so nothing already written is rewritten.
function replay(text) {
  let messages = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let rec;
    try { rec = JSON.parse(line); } catch (err) { continue; } // torn last line after a crash
    if (rec.op === 'cut') {
      const i = messages.findIndex(m => m.id === rec.from);
      if (i >= 0) messages = messages.slice(0, i);
    } else if (rec.id && rec.role) {
      messages.push(rec);
    }
  }
  return messages;
}

async function readMessages(root, id) {
  const dir = chatDir(root, id);
  try {
    return replay(await fsp.readFile(path.join(dir, 'messages.jsonl'), 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

// Appends records and moves the chat to the top of the list. Refuses a chat
// that was deleted meanwhile rather than recreating its folder.
function append(root, id, records, metaChange = {}) {
  const dir = chatDir(root, id);
  return withLock(dir, async () => {
    const meta = { ...(await readMeta(dir)), ...metaChange, updatedAt: new Date().toISOString() };
    const file = path.join(dir, 'messages.jsonl');
    let lead = '';
    try {
      // a torn last line (crash while writing) must not swallow the next record
      const fh = await fsp.open(file, 'r');
      try {
        const { size } = await fh.stat();
        if (size) {
          const b = Buffer.alloc(1);
          await fh.read(b, 0, 1, size - 1);
          if (b[0] !== 10) lead = '\n';
        }
      } finally { await fh.close(); }
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    const text = lead + records.map(r => JSON.stringify(r)).join('\n') + '\n';
    await fsp.appendFile(file, text, { mode: 0o600 });
    await writeAtomic(path.join(dir, 'chat.json'), JSON.stringify(meta));
    return meta;
  });
}

async function deleteChat(root, id) {
  const dir = chatDir(root, id);
  return withLock(dir, async () => {
    await readMeta(dir);
    // A chat that was never used has nothing to restore.
    const empty = !(await readMessages(root, id)).length && !(await fsp.readdir(path.join(dir, 'files'))).length;
    if (empty) {
      await fsp.rm(dir, { recursive: true, force: true });
      return;
    }
    const meta = { ...(await readMeta(dir)), deletedAt: new Date().toISOString() };
    await writeAtomic(path.join(dir, 'chat.json'), JSON.stringify(meta));
    await fsp.rename(dir, trashDir(root, id));
  });
}

async function restoreChat(root, id) {
  const from = trashDir(root, id);
  const dir = chatDir(root, id);
  return withLock(dir, async () => {
    const meta = await readMeta(from);
    delete meta.deletedAt;
    await fsp.rename(from, dir);
    await writeAtomic(path.join(dir, 'chat.json'), JSON.stringify(meta));
    return meta;
  });
}

// Search titles and message text of the user's own chats.
async function searchChats(root, query, limit = 50) {
  const q = query.toLowerCase();
  const out = [];
  for (const meta of await listChats(root)) {
    if (meta.title.toLowerCase().includes(q)) {
      out.push({ ...meta, snippet: null });
    } else {
      const messages = await readMessages(root, meta.id).catch(() => []);
      for (const m of messages) {
        const text = m.role === 'user' ? m.text : m.content;
        const at = (text || '').toLowerCase().indexOf(q);
        if (at >= 0) {
          const start = Math.max(0, at - 30);
          const snippet = text.slice(start, at + q.length + 50).replace(/\s+/g, ' ');
          out.push({ ...meta, snippet: `${start ? '…' : ''}${snippet}…` });
          break;
        }
      }
    }
    if (out.length >= limit) break;
  }
  return out;
}

async function dirSize(dir) {
  let total = 0;
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return 0;
    throw err;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) total += await dirSize(p);
    else if (e.isFile()) total += (await fsp.stat(p).catch(() => ({ size: 0 }))).size;
  }
  return total;
}

// --- files -----------------------------------------------------------------

const filesDir = (root, chatId) => path.join(chatDir(root, chatId), 'files');

async function getFileMeta(root, chatId, fileId) {
  assertId(fileId);
  try {
    return JSON.parse(await fsp.readFile(path.join(filesDir(root, chatId), `${fileId}.json`), 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') throw new HttpError(404, 'file_not_found', 'This file does not exist any more.');
    throw err;
  }
}

const filePath = (root, chatId, meta, suffix) =>
  path.join(filesDir(root, chatId), `${assertId(meta.id)}${suffix === undefined ? meta.ext : suffix}`);

async function saveFileMeta(root, chatId, meta) {
  await readMeta(chatDir(root, chatId)); // the chat must still exist
  await writeAtomic(path.join(filesDir(root, chatId), `${assertId(meta.id)}.json`), JSON.stringify(meta));
}

// Removes an upload that was never sent. A file used by a message stays.
async function deleteFile(root, chatId, fileId) {
  const meta = await getFileMeta(root, chatId, fileId);
  const used = (await readMessages(root, chatId)).some(m => (m.files || []).some(f => f.id === fileId));
  if (used) throw new HttpError(409, 'file_in_use', 'This file is part of a message.');
  const dir = filesDir(root, chatId);
  const names = (await fsp.readdir(dir)).filter(n => n.startsWith(`${meta.id}.`));
  await Promise.all(names.map(n => fsp.rm(path.join(dir, n), { force: true })));
}

module.exports = {
  HttpError, UUID_RE, assertId, rootForWorkspace, createChat, updateMeta, getChat, listChats, listDir, readMessages,
  append, deleteChat, restoreChat, searchChats, dirSize, cleanTitle, replay,
  getFileMeta, filePath, filesDir, saveFileMeta, deleteFile, mkdir
};

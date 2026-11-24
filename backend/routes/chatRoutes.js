// The chat. Every route works only inside the calling user's own server
// storage (core's getUserWorkspacePath(req.user)), so no id can ever reach
// another person's chat. Core's module access decides who gets here at all.
const path = require('path');
const fsp = require('fs').promises;
const { randomUUID } = require('crypto');
const express = require('express');
const multer = require('multer');
const { readConfig } = require('../lib/config');
const { getLimits, MB } = require('../lib/limits');
const storage = require('../lib/storage');
const files = require('../lib/files');
const gens = require('../lib/generations');
const { startAnswer, requireReady } = require('../lib/answer');
const cleanup = require('../lib/cleanup');

const { HttpError } = storage;
const HEARTBEAT_MS = 15000;

module.exports = function buildChatRouter(coreApi) {
  const router = express.Router();

  const fail = (res, err) => {
    if (res.headersSent) { res.end(); return; }
    if (err.status) { res.status(err.status).json({ error: err.message, code: err.code || null }); return; }
    // Only the error's type: messages can hold paths, and never any chat text.
    console.error(`[ai] chat request failed: ${err.code || err.name}`);
    res.status(500).json({ error: 'Something went wrong in the AI module.', code: 'internal' });
  };
  const wrap = fn => (req, res) => Promise.resolve(fn(req, res)).catch(err => fail(res, err));

  // Resolves the user's storage folder for the routes below.
  const withRoot = async (req, res, next) => {
    try {
      const ws = await coreApi.getUserWorkspacePath(req.user);
      req.aiRoot = await storage.rootForWorkspace(ws, readConfig(coreApi).storageSubdir);
      cleanup.noteUser(coreApi.pool, req.user.id);
      next();
    } catch (err) { fail(res, err); }
  };
  const user = [coreApi.authenticateToken, withRoot];

  const generationInfo = g => g && {
    id: g.id, chatId: g.chatId, state: g.state, position: g.position, assistantId: g.meta.assistantId,
    model: g.meta.model, content: g.content, reasoning: g.reasoning, notices: g.notices, result: g.result,
    elapsedMs: Date.now() - g.createdAt
  };
  const listItem = ({ id, title, createdAt, updatedAt, snippet, deletedAt }) => ({
    id, title, createdAt, updatedAt, ...(snippet !== undefined && { snippet }), ...(deletedAt && { deletedAt }),
    answering: Boolean(gens.activeForChat(id))
  });

  // --- chats -----------------------------------------------------------------

  router.get('/chats', ...user, wrap(async (req, res) => {
    const q = typeof req.query.search === 'string' ? req.query.search.trim().slice(0, 200) : '';
    const list = q ? await storage.searchChats(req.aiRoot, q) : await storage.listChats(req.aiRoot);
    res.json({ chats: list.map(listItem) });
  }));

  router.post('/chats', ...user, wrap(async (req, res) => {
    res.status(201).json({ chat: listItem(await storage.createChat(req.aiRoot)) });
  }));

  router.get('/chats/:id', ...user, wrap(async (req, res) => {
    const meta = await storage.getChat(req.aiRoot, req.params.id);
    const messages = await storage.readMessages(req.aiRoot, req.params.id);
    const g = gens.activeForChat(req.params.id);
    res.json({ chat: listItem(meta), messages, generation: generationInfo(g) });
  }));

  router.patch('/chats/:id', ...user, wrap(async (req, res) => {
    const title = storage.cleanTitle(req.body && req.body.title);
    if (!title) throw new HttpError(400, 'no_title', 'Enter a name for the chat.');
    res.json({ chat: listItem(await storage.updateMeta(req.aiRoot, req.params.id, { title, titleSetBy: 'user' })) });
  }));

  router.delete('/chats/:id', ...user, wrap(async (req, res) => {
    storage.assertId(req.params.id);
    const g = gens.activeForChat(req.params.id);
    await storage.deleteChat(req.aiRoot, req.params.id);
    if (g && g.userId === req.user.id) await gens.stop(g, 'deleted');
    res.json({ success: true });
  }));

  router.get('/trash', ...user, wrap(async (req, res) => {
    const limits = await getLimits(coreApi.pool);
    const list = await storage.listDir(path.join(req.aiRoot, 'trash'));
    res.json({ chats: list.map(listItem), days: limits.trashDays });
  }));

  router.post('/trash/:id/restore', ...user, wrap(async (req, res) => {
    res.json({ chat: listItem(await storage.restoreChat(req.aiRoot, req.params.id)) });
  }));

  router.get('/storage', ...user, wrap(async (req, res) => {
    const limits = await getLimits(coreApi.pool);
    res.json({ usedBytes: await storage.dirSize(req.aiRoot), quotaBytes: limits.quotaMB * MB });
  }));

  // --- questions and answers ---------------------------------------------------

  const busyChats = new Set(); // chats with a question being saved right now
  const starting = new Map();  // user id -> questions being saved right now

  // Checks every limit, saves the question (prepare), starts the answer.
  async function ask(req, res, prepare) {
    req.body = req.body || {};
    const { id } = req.params;
    const userId = req.user.id;
    const limits = await getLimits(coreApi.pool);
    await storage.getChat(req.aiRoot, id);
    await requireReady(coreApi);
    if (busyChats.has(id) || gens.activeForChat(id)) {
      throw new HttpError(409, 'answering', 'This chat is still answering the last question.');
    }
    if (gens.activeForUser(userId).length + (starting.get(userId) || 0) >= limits.perUserRunning) {
      throw new HttpError(429, 'one_at_a_time', limits.perUserRunning === 1
        ? 'Another of your chats is still being answered. Wait for it, or stop it first.'
        : `You already have ${limits.perUserRunning} answers running. Wait for one to finish.`);
    }
    const c = gens.counts();
    if (c.running >= limits.maxConcurrent && c.waiting >= limits.maxQueue) {
      throw new HttpError(503, 'queue_full', 'Too many people are asking the AI right now. Try again in a moment.');
    }
    busyChats.add(id);
    starting.set(userId, (starting.get(userId) || 0) + 1);
    try {
      const commit = await prepare(limits);
      const wait = gens.takeQuestion(userId, limits);
      if (wait !== null) {
        throw new HttpError(429, 'too_many', `You have asked ${limits.perUserQuestions} questions in ${limits.perUserWindowMin} minutes. You can ask again in ${wait < 90 ? `${wait} seconds` : `${Math.ceil(wait / 60)} minutes`}.`);
      }
      const question = await commit();
      const g = startAnswer(coreApi, {
        user: req.user, root: req.aiRoot, chatId: id, think: req.body.think !== false, limits
      });
      res.status(202).json({ question, generation: generationInfo(g), chat: listItem(await storage.getChat(req.aiRoot, id)) });
    } finally {
      busyChats.delete(id);
      const n = (starting.get(userId) || 1) - 1;
      if (n > 0) starting.set(userId, n); else starting.delete(userId);
    }
  }

  function cleanText(value, limits) {
    const text = typeof value === 'string' ? value : '';
    if (Buffer.byteLength(text, 'utf8') > limits.maxPromptKB * 1024) {
      throw new HttpError(413, 'too_long', `A question can be at most ${limits.maxPromptKB} KB of text. Attach long text as a file instead.`);
    }
    return text;
  }

  const lastQuestion = messages => [...messages].reverse().find(m => m.role === 'user') || null;

  router.post('/chats/:id/messages', ...user, wrap(async (req, res) => {
    const { id } = req.params;
    await ask(req, res, async (limits) => {
      const text = cleanText(req.body.text, limits);
      const ids = Array.isArray(req.body.fileIds) ? [...new Set(req.body.fileIds)] : [];
      if (ids.length > limits.maxFilesPerMessage) {
        throw new HttpError(400, 'too_many_files', `Attach at most ${limits.maxFilesPerMessage} files to one question.`);
      }
      const attached = [];
      for (const fid of ids) {
        const f = await storage.getFileMeta(req.aiRoot, id, fid);
        attached.push({ id: f.id, name: f.name, kind: f.kind, bytes: f.bytes });
      }
      if (!text.trim() && !attached.length) throw new HttpError(400, 'empty', 'Type a question first.');
      return async () => {
        const question = { id: randomUUID(), role: 'user', text, files: attached, at: new Date().toISOString() };
        const meta = await storage.getChat(req.aiRoot, id);
        const change = {};
        if (meta.titleSetBy === 'default') {
          const first = text.split('\n').find(l => l.trim()) || (attached[0] && attached[0].name) || 'New chat';
          const t = storage.cleanTitle(first);
          Object.assign(change, { title: t.length > 60 ? `${t.slice(0, 59)}…` : t, titleSetBy: 'question' });
        }
        await storage.append(req.aiRoot, id, [question], change);
        return question;
      };
    });
  }));

  // A new answer to the last question.
  router.post('/chats/:id/regenerate', ...user, wrap(async (req, res) => {
    const { id } = req.params;
    await ask(req, res, async () => {
      const messages = await storage.readMessages(req.aiRoot, id);
      const q = lastQuestion(messages);
      if (!q) throw new HttpError(400, 'no_question', 'There is no question to answer.');
      const after = messages[messages.indexOf(q) + 1];
      return async () => {
        if (after) await storage.append(req.aiRoot, id, [{ op: 'cut', from: after.id }]);
        return q;
      };
    });
  }));

  // Change the last question and ask again (its files stay attached).
  router.post('/chats/:id/edit', ...user, wrap(async (req, res) => {
    const { id } = req.params;
    await ask(req, res, async (limits) => {
      const text = cleanText(req.body.text, limits);
      const q = lastQuestion(await storage.readMessages(req.aiRoot, id));
      if (!q || q.id !== req.body.messageId) throw new HttpError(409, 'not_last', 'Only the last question can be changed.');
      if (!text.trim() && !q.files.length) throw new HttpError(400, 'empty', 'Type a question first.');
      return async () => {
        const question = { ...q, id: randomUUID(), text, at: new Date().toISOString() };
        await storage.append(req.aiRoot, id, [{ op: 'cut', from: q.id }, question]);
        return question;
      };
    });
  }));

  // --- answers in progress -----------------------------------------------------

  const ownGeneration = (req) => {
    const g = gens.get(req.params.id);
    if (!g || g.userId !== req.user.id) throw new HttpError(404, 'gone', 'This answer is finished.');
    return g;
  };

  // Long-poll fallback for browsers or proxies that cannot stream: answers as
  // soon as there is more text than the caller has (or after 20 s).
  router.get('/generations/:id', coreApi.authenticateToken, wrap(async (req, res) => {
    const g = ownGeneration(req);
    const haveC = Number(req.query.content) || 0;
    const haveR = Number(req.query.reasoning) || 0;
    const until = Date.now() + (req.query.wait === '1' ? 20000 : 0);
    let closed = false;
    res.on('close', () => { closed = true; });
    while (!closed && g.state !== 'finished' && g.content.length <= haveC && g.reasoning.length <= haveR && Date.now() < until) {
      await new Promise(r => setTimeout(r, 200));
    }
    if (!closed) res.json({ generation: generationInfo(g) });
  }));

  // Server-sent events: one "snapshot", then the text as it is written. A tab
  // that reloads simply connects again.
  router.get('/generations/:id/events', coreApi.authenticateToken, wrap(async (req, res) => {
    const g = ownGeneration(req);
    res.status(200).set({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no'
    });
    res.flushHeaders();
    const send = (event) => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(event)}\n\n`); };
    send({ type: 'snapshot', generation: generationInfo(g) });
    if (g.state === 'finished') { res.end(); return; }
    const listener = (event) => {
      send(event);
      if (event.type === 'done') { clearInterval(beat); res.end(); }
    };
    const beat = setInterval(() => { if (!res.writableEnded) res.write(': still here\n\n'); }, HEARTBEAT_MS);
    g.listeners.add(listener);
    res.on('close', () => { clearInterval(beat); g.listeners.delete(listener); });
  }));

  router.post('/generations/:id/stop', coreApi.authenticateToken, wrap(async (req, res) => {
    await gens.stop(ownGeneration(req), 'user');
    res.json({ success: true });
  }));

  // --- files -------------------------------------------------------------------

  const receive = async (req, res, next) => {
    try {
      const limits = await getLimits(coreApi.pool);
      req.aiLimits = limits;
      await storage.getChat(req.aiRoot, req.params.id);
      const used = await storage.dirSize(req.aiRoot);
      if (used + (Number(req.headers['content-length']) || 0) > limits.quotaMB * MB) {
        throw new HttpError(413, 'quota', `Your AI storage is full (${limits.quotaMB} MB). Delete old chats to make room.`);
      }
      multer({
        dest: path.join(req.aiRoot, 'uploads-tmp'),
        defParamCharset: 'utf8',
        limits: { fileSize: limits.maxFileMB * MB, files: 1, fields: 5, parts: 10 }
      }).single('file')(req, res, (err) => {
        if (!err) return next();
        if (err.code === 'LIMIT_FILE_SIZE') return fail(res, new HttpError(413, 'too_large', `Files can be at most ${limits.maxFileMB} MB.`));
        return fail(res, new HttpError(400, 'upload_failed', 'The upload did not complete.'));
      });
    } catch (err) { fail(res, err); }
  };

  router.post('/chats/:id/files', ...user, receive, wrap(async (req, res) => {
    if (!req.file) throw new HttpError(400, 'no_file', 'No file was sent.');
    try {
      const f = await files.ingest({
        root: req.aiRoot, chatId: req.params.id, tmpPath: req.file.path, name: req.file.originalname, limits: req.aiLimits
      });
      res.status(201).json({ file: { id: f.id, name: f.name, kind: f.kind, bytes: f.bytes, truncated: Boolean(f.truncated) } });
    } finally {
      await fsp.rm(req.file.path, { force: true });
    }
  }));

  router.get('/chats/:id/files', ...user, wrap(async (req, res) => {
    const ids = String(req.query.ids || '').split(',').filter(Boolean).slice(0, 50);
    const found = [];
    for (const fid of ids) {
      const f = await storage.getFileMeta(req.aiRoot, req.params.id, fid).catch(() => null);
      if (f) found.push({ id: f.id, name: f.name, kind: f.kind, bytes: f.bytes });
    }
    res.json({ files: found });
  }));

  // The original upload, unchanged. Always a download, never shown as a page.
  router.get('/chats/:id/files/:fileId', ...user, wrap(async (req, res) => {
    const f = await storage.getFileMeta(req.aiRoot, req.params.id, req.params.fileId);
    res.attachment(f.name);
    res.set({
      'Content-Type': files.MIME[f.ext] || 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "sandbox; default-src 'none'",
      'Cache-Control': 'private, no-store'
    });
    await new Promise((resolve, reject) => {
      res.sendFile(storage.filePath(req.aiRoot, req.params.id, f), { dotfiles: 'allow', cacheControl: false }, err => (err && !res.headersSent ? reject(new HttpError(404, 'file_not_found', 'This file does not exist any more.')) : resolve()));
    });
  }));

  router.delete('/chats/:id/files/:fileId', ...user, wrap(async (req, res) => {
    await storage.deleteFile(req.aiRoot, req.params.id, req.params.fileId);
    res.json({ success: true });
  }));

  return router;
};

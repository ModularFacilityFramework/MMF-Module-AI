// Answers being produced right now. An answer belongs to the server, not to
// the browser tab that asked: the tab can reload or close, and come back to
// the same answer. One object per answer, in memory, until shortly after it
// has been saved.
const { randomUUID } = require('crypto');

const KEEP_FINISHED_MS = 120000;

const all = new Map();      // generation id -> generation
const waiting = [];         // FIFO of generations not started yet
let running = 0;
let holdReason = null;      // set while the model is being switched
const questionTimes = new Map(); // user id -> timestamps of recent questions

const isActive = g => g.state === 'queued' || g.state === 'running';
const activeForUser = userId => [...all.values()].filter(g => g.userId === userId && isActive(g));
const activeForChat = chatId => [...all.values()].find(g => g.chatId === chatId && isActive(g)) || null;

function counts() {
  return { running, waiting: waiting.length };
}

// Counts a question against the per-person limit. Returns null when allowed,
// else the number of seconds to wait.
function takeQuestion(userId, limits) {
  const now = Date.now();
  const windowMs = limits.perUserWindowMin * 60000;
  const times = (questionTimes.get(userId) || []).filter(t => now - t < windowMs);
  if (times.length >= limits.perUserQuestions) {
    questionTimes.set(userId, times);
    return Math.ceil((windowMs - (now - times[0])) / 1000);
  }
  times.push(now);
  questionTimes.set(userId, times);
  return null;
}

function emit(g, event) {
  for (const fn of g.listeners) {
    try { fn(event); } catch (err) { /* one broken connection must not stop the others */ }
  }
}

function positions() {
  waiting.forEach((g, i) => {
    if (g.position !== i + 1) {
      g.position = i + 1;
      emit(g, { type: 'queued', position: g.position });
    }
  });
}

function pump() {
  while (!holdReason && waiting.length && running < waiting[0].limits.maxConcurrent) {
    start(waiting.shift());
  }
  positions();
}

function start(g) {
  running += 1;
  g.state = 'running';
  g.position = 0;
  emit(g, { type: 'start' });
  Promise.resolve()
    .then(() => g.run(g))
    .catch(() => { g.result = g.result || { status: 'error', error: 'The answer failed.' }; })
    .then(() => {
      running -= 1;
      finish(g);
      pump();
    });
}

function finish(g) {
  if (g.state === 'finished') return;
  g.state = 'finished';
  emit(g, { type: 'done', result: g.result });
  g.listeners.clear();
  clearTimeout(g.timer);
  g.timer = setTimeout(() => all.delete(g.id), KEEP_FINISHED_MS);
  g.timer.unref();
}

// run(g) does the work: it calls add() as text arrives, honours g.abort.signal,
// saves the answer, and sets g.result.
function create({ userId, chatId, limits, meta, run, onCancelled }) {
  const g = {
    id: randomUUID(), userId, chatId, limits, meta, run, onCancelled,
    state: 'queued', position: 0, content: '', reasoning: '', tools: [], files: [], notices: [], scan: null, pending: {},
    abort: new AbortController(), stopReason: null, listeners: new Set(), result: null, createdAt: Date.now()
  };
  all.set(g.id, g);
  waiting.push(g);
  pump();
  return g;
}

function show(g, kind, text) {
  if (!g[kind]) text = text.trimStart(); // models often open with blank lines
  if (!text) return;
  g[kind] += text;
  emit(g, { type: kind, text });
}

// With g.scan set (the output scan, safety.js), text is shown in pieces that
// end at white space, each scanned first: what a pattern needs is never split.
const HOLD_MAX = 400;
function add(g, kind, text) {
  if (!text) return;
  if (!g.scan) { show(g, kind, text); return; }
  const buf = (g.pending[kind] || '') + text;
  const cut = Math.max(buf.lastIndexOf(' '), buf.lastIndexOf('\n'), buf.lastIndexOf('\t'));
  if (cut < 0 && buf.length < HOLD_MAX) { g.pending[kind] = buf; return; }
  const upto = cut < 0 ? buf.length : cut + 1;
  g.pending[kind] = buf.slice(upto);
  show(g, kind, g.scan(buf.slice(0, upto)));
}

// Shows what add() still holds back (at the end of an answer).
function flush(g) {
  for (const kind of ['reasoning', 'content']) {
    const rest = g.pending[kind];
    g.pending[kind] = '';
    if (rest) show(g, kind, g.scan ? g.scan(rest) : rest);
  }
}

// Replaces the whole text (an answer stopped by the safety check).
function set(g, kind, text) {
  g.pending[kind] = '';
  g[kind] = text;
  emit(g, { type: 'set', kind, text });
}

function tool(g, entry) {
  if (g.scan) {
    for (const k of ['args', 'result', 'call']) if (typeof entry[k] === 'string') entry[k] = g.scan(entry[k]);
  }
  g.tools.push(entry);
  emit(g, { type: 'tool', entry });
}

function notice(g, text) {
  g.notices.push(text);
  emit(g, { type: 'notice', text });
}

// reason: 'user' | 'switch' | 'deleted' | 'timeout'
async function stop(g, reason = 'user') {
  if (!isActive(g)) return;
  g.stopReason = g.stopReason || reason;
  const i = waiting.indexOf(g);
  if (i >= 0) {
    waiting.splice(i, 1);
    try { if (g.onCancelled) await g.onCancelled(g); } catch (err) { /* saved best effort */ }
    g.result = g.result || { status: 'stopped' };
    finish(g);
    positions();
  } else {
    g.abort.abort();
  }
}

// Holding keeps new answers in the queue (used while the model is switched).
function hold(reason) { holdReason = reason; }
function release() { holdReason = null; pump(); }
const held = () => holdReason;

// Stops what is running; questions still waiting keep their place.
async function stopRunning(reason) {
  await Promise.all([...all.values()].filter(g => g.state === 'running').map(g => stop(g, reason)));
}

// Resolves once nothing is running, or after timeoutMs.
async function drained(timeoutMs) {
  const until = Date.now() + timeoutMs;
  while (running > 0 && Date.now() < until) await new Promise(r => setTimeout(r, 250));
  return running === 0;
}

const get = id => all.get(id) || null;

module.exports = {
  create, get, add, flush, set, tool, notice, stop, stopRunning, hold, release, held, drained, counts,
  takeQuestion, activeForUser, activeForChat, isActive
};

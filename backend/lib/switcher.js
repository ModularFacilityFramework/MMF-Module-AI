// Changes the model on the AI server. One switch at a time. While it runs, new
// answers are held in the queue (waiting phase) or refused with a message
// (model down), and everyone sees a banner.
const { EventEmitter } = require('events');
const ctl = require('./ctl');
const vllm = require('./vllm');
const gens = require('./generations');
const { readConfig } = require('./config');
const { getLimits } = require('./limits');
const { setSetting } = require('./settings');
const { HttpError } = require('./storage');

const READY_WAIT_MS = 180000;
const OUTSIDE_IDLE_WAIT_MS = 15 * 60000;

const bus = new EventEmitter();
let current = null; // { to, from, phase, by, startedAt, lines, cancel, ... }
let lastDone = null;

const pause = ms => new Promise(r => setTimeout(r, ms));
const hidePaths = line => line.replace(/(?:\/[\w.@-]+)+\/([\w.@-]+)/g, '$1');

// phase: waiting -> switching -> checking -> (finished)
function state() {
  const view = s => s && {
    to: s.to, toLabel: s.toLabel, from: s.from, phase: s.phase, mode: s.mode, purpose: s.purpose,
    startedAt: s.startedAt, seconds: Math.round((Date.now() - s.startedAt) / 1000),
    lines: s.lines.slice(-40), status: s.status || null, message: s.message || null
  };
  return { active: view(current), last: view(lastDone) };
}

const isActive = () => Boolean(current);

async function log(pool, s) {
  try {
    const r = await pool.query(
      'INSERT INTO ai_model_switch_log (from_keyword, to_keyword, user_id, source, status) VALUES (?, ?, ?, ?, ?)',
      [s.from, s.to, s.by, s.purpose, 'running']);
    s.logId = r.insertId;
  } catch (err) { /* the log must not stop a switch */ }
}

async function logEnd(pool, s) {
  if (!s.logId) return;
  try {
    await pool.query('UPDATE ai_model_switch_log SET status = ?, message = ?, seconds = ?, finished_at = NOW() WHERE id = ?',
      [s.status, (s.message || '').slice(0, 250), Math.round((Date.now() - s.startedAt) / 1000), s.logId]);
  } catch (err) { /* as above */ }
}

// The controller reports a model that MFF did not load: note it once.
let outsideNoted = null;
async function noteOutside(pool, keyword, expected) {
  if (outsideNoted === keyword) return;
  outsideNoted = keyword;
  try {
    await pool.query(
      `INSERT INTO ai_model_switch_log (from_keyword, to_keyword, user_id, source, status, message, finished_at)
       VALUES (?, ?, NULL, 'outside', 'done', 'Changed outside MFF', NOW())`, [expected, keyword]);
    await setSetting(pool, 'model.expected', keyword, null);
  } catch (err) { outsideNoted = null; }
}

// Answers running right now: MFF's own, and what vLLM sees in total (people
// who use the AI server directly are the difference).
async function load(cfg) {
  const c = gens.counts();
  const snap = await vllm.snapshot(cfg);
  const total = snap.metrics && snap.metrics.running !== null ? snap.metrics.running + (snap.metrics.waiting || 0) : null;
  return { mffRunning: c.running, mffWaiting: c.waiting, vllmTotal: total, vllmModel: snap.modelId, reachable: snap.reachable };
}

// mode 'wait': let every running answer finish first. 'stop': stop MFF's
// answers now (answers of direct users of the server are cut off by the
// switch itself). Resolves when the switch is over; never rejects.
async function perform(coreApi, s) {
  const cfg = readConfig(coreApi);
  const status = require('./status');
  const pool = coreApi.pool;
  await log(pool, s);
  gens.hold('switch');
  try {
    if (s.mode === 'stop') {
      await gens.stopRunning('switch');
      await gens.drained(15000);
    } else {
      const limits = await getLimits(pool);
      const until = Date.now() + Math.max(OUTSIDE_IDLE_WAIT_MS, limits.totalTimeoutS * 1000 + 30000);
      for (;;) {
        if (s.cancelled) { s.status = 'cancelled'; s.message = 'Cancelled before anything was changed.'; return; }
        const l = await load(cfg);
        s.waitingFor = l;
        if (l.mffRunning === 0 && !(l.vllmTotal > 0)) break;
        if (Date.now() > until) { s.status = 'failed'; s.message = 'Answers were still running after a long wait, so nothing was changed.'; return; }
        await pause(1000);
      }
    }
    if (s.cancelled) { s.status = 'cancelled'; s.message = 'Cancelled before anything was changed.'; return; }
    s.phase = 'switching';
    s.switchStartedAt = Date.now();
    bus.emit('change');
    const r = await ctl.stream(cfg, `switch ${s.to}`, cfg.switchTimeoutS * 1000, (line) => {
      s.lines.push(hidePaths(line));
      bus.emit('change');
    });
    if (!r.ok) {
      s.status = 'failed';
      s.message = hidePaths(`The switch did not succeed: ${r.error}`);
      return;
    }
    s.phase = 'checking';
    const until = Date.now() + READY_WAIT_MS;
    while (Date.now() < until) {
      const [snap, info] = await Promise.all([vllm.snapshot(cfg), ctl.info(cfg)]);
      if (snap.reachable && status.keywordForModelId(snap.modelId, info) === s.to) {
        s.loadSeconds = Math.round((Date.now() - s.switchStartedAt) / 1000);
        s.status = 'done';
        s.message = `Ready after ${s.loadSeconds} seconds.`;
        await setSetting(pool, 'model.expected', s.to, s.by).catch(() => {});
        status.setExpectedKeyword(s.to);
        outsideNoted = null;
        return;
      }
      await pause(1000);
    }
    s.status = 'failed';
    s.message = 'The server reported success, but the new model does not answer.';
  } catch (err) {
    s.status = 'failed';
    s.message = 'The switch failed unexpectedly.';
  } finally {
    s.phase = 'finished';
    status.forgetCache();
    await logEnd(pool, s);
    lastDone = s;
    current = null;
    if (!s.keepHold) gens.release();
    bus.emit('change');
  }
}

async function start(coreApi, { keyword, mode, user, purpose = 'mff', keepHold = false }) {
  const cfg = readConfig(coreApi);
  const model = cfg.models.find(m => m.keyword === keyword);
  if (!model) throw new HttpError(400, 'unknown_model', 'This model is not offered.');
  if (!['wait', 'stop'].includes(mode)) throw new HttpError(400, 'bad_mode', 'Choose whether to wait for running answers or stop them.');
  if (current) throw new HttpError(409, 'busy', `A switch to ${current.toLabel} is already under way.`);
  const s = {
    to: keyword, toLabel: model.label, from: null, mode, purpose, by: user ? user.id : null, phase: 'waiting',
    startedAt: Date.now(), lines: [], cancelled: false, keepHold
  };
  current = s; // from here on no second switch can start
  try {
    const st = await ctl.status(cfg);
    if (!st.ok) throw new HttpError(502, 'controller', `The model switcher on the AI server could not be reached: ${st.error}`);
    if (st.switching) throw new HttpError(409, 'busy', 'A switch started outside MFF is already under way.');
    s.from = st.keyword;
    if (st.keyword === keyword) {
      const snap = await vllm.snapshot(cfg);
      if (snap.reachable) throw new HttpError(409, 'already', `${model.label} is already loaded.`);
    }
  } catch (err) {
    current = null;
    throw err;
  }
  s.done = perform(coreApi, s);
  return s;
}

function cancel() {
  if (!current || current.phase !== 'waiting') throw new HttpError(409, 'too_late', 'It is too late to cancel: the model is already being changed.');
  current.cancelled = true;
}

module.exports = { start, cancel, state, isActive, load, noteOutside, bus };

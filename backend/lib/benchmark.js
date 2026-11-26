// Runs the same questions on several models, one after the other, and records
// speed and answers. Chat questions are held while it runs. Afterwards the
// model that was loaded before is loaded again.
const gens = require('./generations');
const switcher = require('./switcher');
const vllm = require('./vllm');
const ctl = require('./ctl');
const { readConfig } = require('./config');
const { HttpError } = require('./storage');
const precision = require('./precision');
const { STARTER, longText, IMAGE_SVG } = require('./benchmarkPrompts');

const ANSWER_TOKENS = 1024;
const THINK_TOKENS = 8192;
const ANSWER_TIMEOUT_MS = 600000;
const KINDS = ['text', 'image', 'long'];

let job = null; // the run in progress

async function ensurePrompts(pool) {
  const [{ n }] = await pool.query('SELECT COUNT(*) AS n FROM ai_benchmark_prompts');
  if (Number(n)) return;
  for (let i = 0; i < STARTER.length; i++) {
    const p = STARTER[i];
    await pool.query('INSERT INTO ai_benchmark_prompts (title, kind, prompt, check_regex, sort_order) VALUES (?, ?, ?, ?, ?)',
      [p.title, p.kind, p.prompt, p.check, i]);
  }
}

async function listPrompts(pool) {
  await ensurePrompts(pool);
  const rows = await pool.query('SELECT * FROM ai_benchmark_prompts WHERE deleted = 0 ORDER BY sort_order, id');
  return rows.map(r => ({ id: Number(r.id), title: r.title, kind: r.kind, prompt: r.prompt, check: r.check_regex, enabled: Boolean(r.enabled) }));
}

function cleanPrompt(body) {
  const b = body || {};
  const title = String(b.title || '').trim().slice(0, 100);
  const prompt = String(b.prompt || '').trim();
  const check = b.check ? String(b.check).slice(0, 500) : null;
  if (!title || !prompt) throw new HttpError(400, 'empty', 'A question needs a title and a text.');
  if (prompt.length > 20000) throw new HttpError(400, 'too_long', 'The question is too long (20,000 characters at most).');
  if (!KINDS.includes(b.kind)) throw new HttpError(400, 'bad_kind', 'Unknown kind of question.');
  if (check) {
    try { RegExp(check, 'i'); } catch (err) { throw new HttpError(400, 'bad_check', 'The expected answer is not a valid pattern.'); }
  }
  return { title, kind: b.kind, prompt, check, enabled: b.enabled === false ? 0 : 1 };
}

async function savePrompt(pool, id, body) {
  const p = cleanPrompt(body);
  if (id) {
    await pool.query('UPDATE ai_benchmark_prompts SET title = ?, kind = ?, prompt = ?, check_regex = ?, enabled = ? WHERE id = ? AND deleted = 0',
      [p.title, p.kind, p.prompt, p.check, p.enabled, id]);
    return id;
  }
  const r = await pool.query('INSERT INTO ai_benchmark_prompts (title, kind, prompt, check_regex, enabled, sort_order) VALUES (?, ?, ?, ?, ?, 1000)',
    [p.title, p.kind, p.prompt, p.check, p.enabled]);
  return Number(r.insertId);
}

// Kept in the database (hidden), so older results still show their question.
const deletePrompt = (pool, id) => pool.query('UPDATE ai_benchmark_prompts SET deleted = 1 WHERE id = ?', [id]);

async function messagesFor(p) {
  if (p.kind === 'long') return [{ role: 'user', content: `${longText()}\n\n${p.prompt}` }];
  if (p.kind === 'image') {
    const sharp = require('sharp');
    const jpeg = await sharp(Buffer.from(IMAGE_SVG)).jpeg({ quality: 92 }).toBuffer();
    return [{ role: 'user', content: [{ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${jpeg.toString('base64')}` } }, { type: 'text', text: p.prompt }] }];
  }
  return [{ role: 'user', content: p.prompt }];
}

// A pattern typed by an administrator is tried in a worker with a time limit,
// so that a badly built one cannot freeze the backend.
function matches(pattern, answer) {
  const { Worker } = require('worker_threads');
  return new Promise((resolve) => {
    const w = new Worker("const{parentPort,workerData:d}=require('worker_threads');parentPort.postMessage(new RegExp(d.p,'i').test(d.a))",
      { eval: true, env: {}, workerData: { p: pattern, a: answer } });
    const timer = setTimeout(() => { w.terminate(); resolve(null); }, 2000);
    w.once('message', (v) => { clearTimeout(timer); resolve(v); });
    w.once('error', () => { clearTimeout(timer); resolve(null); });
  });
}

async function askOne(cfg, modelId, caps, p, think, signal) {
  const started = Date.now();
  let first = null;
  let content = '';
  let reasoning = '';
  const thinking = caps.includes('thinking-r1') || (caps.includes('thinking') && think);
  const body = { model: modelId, messages: await messagesFor(p), temperature: 0, max_tokens: thinking ? THINK_TOKENS : ANSWER_TOKENS };
  if (caps.includes('thinking')) body.chat_template_kwargs = { enable_thinking: thinking };
  try {
    const r = await vllm.streamChat(cfg, body, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(ANSWER_TIMEOUT_MS)]),
      onDelta: (d) => {
        if (!first && (d.content || d.reasoning)) first = Date.now();
        content += d.content;
        reasoning += d.reasoning;
      }
    });
    const end = Date.now();
    const tokens = r.usage ? r.usage.completion_tokens : null;
    const seconds = first ? (end - first) / 1000 : 0;
    return {
      status: r.finishReason === 'length' ? 'length' : 'done', answer: content.trim(), reasoningChars: reasoning.length,
      firstMs: first ? first - started : null, totalMs: end - started,
      promptTokens: r.usage ? r.usage.prompt_tokens : null, tokens,
      // the first token is not part of the writing time
      perSecond: tokens > 1 && seconds > 0.05 ? (tokens - 1) / seconds : null,
      pass: p.check ? await matches(p.check, content.trim()) : null
    };
  } catch (err) {
    return { status: 'error', answer: '', reasoningChars: 0, firstMs: null, totalMs: Date.now() - started, promptTokens: null, tokens: null, perSecond: null, pass: p.check && !signal.aborted ? false : null };
  }
}

function view() {
  if (!job) return null;
  return { runId: job.runId, step: job.step, done: job.done, total: job.total, startedAt: job.startedAt, cancelled: job.abort.signal.aborted };
}

// The model is (or becomes) `keyword` (a controller keyword: a model, or one
// of its precision variants); the load time when it was really loaded now.
async function loadModel(coreApi, keyword, user, mode) {
  const st = await ctl.status(readConfig(coreApi));
  const snap = await vllm.snapshot(readConfig(coreApi));
  if (st.ok && st.keyword === keyword && snap.reachable && !st.switching) return null;
  const s = await switcher.start(coreApi, { keyword: precision.modelOf(keyword), variant: keyword, mode, user, purpose: 'benchmark', keepHold: true });
  job.currentSwitch = s;
  await s.done;
  job.currentSwitch = null;
  if (s.status === 'cancelled') throw new Error('cancelled');
  if (s.status !== 'done') throw new Error(s.message || 'the model could not be loaded');
  return s.loadSeconds;
}

async function run(coreApi, { user, models, prompts, think, mode, original }) {
  const { pool } = coreApi;
  const cfg = readConfig(coreApi);
  const signal = job.abort.signal;
  const { runId } = job;
  let outcome = 'done';
  let message = null;
  gens.hold('benchmark');
  try {
    if (mode === 'stop') await gens.stopRunning('switch');
    job.step = 'Waiting for running answers to finish';
    const until = Date.now() + 15 * 60000;
    for (;;) {
      if (signal.aborted) throw new Error('cancelled');
      const l = await switcher.load(cfg);
      if (l.mffRunning === 0 && !(l.vllmTotal > 0)) break;
      if (Date.now() > until) throw new Error('Answers were still running after 15 minutes, so the benchmark did not start.');
      await new Promise(r => setTimeout(r, 1000));
    }
    for (const m of models) {
      if (signal.aborted) throw new Error('cancelled');
      job.step = `Loading ${m.label}`;
      const loadSeconds = await loadModel(coreApi, m.keyword, user, 'wait');
      const [snap, info] = await Promise.all([vllm.snapshot(cfg), ctl.info(cfg)]);
      const gpu = info.ok && Array.isArray(info.data.gpu) ? info.data.gpu[0] : null;
      const mm = snap.metrics || {};
      await pool.query(
        'INSERT INTO ai_benchmark_models (run_id, keyword, label, load_seconds, gpu_memory_mib, kv_cache_tokens, max_concurrency, max_model_len) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [job.runId, m.keyword, m.label, loadSeconds, gpu ? gpu.memory_used_mib : null, mm.kvCacheTokens || null, mm.maxConcurrency || null, snap.maxModelLen]);
      // One unmeasured question first: the first answer after loading is slower.
      await askOne(cfg, snap.modelId, m.capabilities, { kind: 'text', prompt: 'Say ok.', check: null }, false, signal);
      for (const p of prompts) {
        if (signal.aborted) throw new Error('cancelled');
        job.step = `${m.label}: ${p.title}`;
        let r;
        if (p.kind === 'image' && !m.capabilities.includes('vision')) {
          r = { status: 'skipped', answer: '', reasoningChars: 0, firstMs: null, totalMs: null, promptTokens: null, tokens: null, perSecond: null, pass: null };
        } else {
          r = await askOne(cfg, snap.modelId, m.capabilities, p, think, signal);
          if (signal.aborted) throw new Error('cancelled');
        }
        await pool.query(
          `INSERT INTO ai_benchmark_results (run_id, keyword, prompt_id, title, kind, prompt, status, answer, reasoning_chars, first_ms, total_ms, prompt_tokens, tokens, tokens_per_second, auto_pass)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [job.runId, m.keyword, p.id, p.title, p.kind, p.prompt, r.status, r.answer, r.reasoningChars, r.firstMs, r.totalMs, r.promptTokens, r.tokens, r.perSecond,
            r.pass === null ? null : Number(r.pass)]);
        job.done += 1;
      }
    }
  } catch (err) {
    outcome = err.message === 'cancelled' ? 'cancelled' : 'failed';
    message = outcome === 'cancelled' ? 'Cancelled.' : String(err.message).slice(0, 250);
  }
  try {
    job.step = 'Loading the model that was there before';
    if (original) await loadModel(coreApi, original, user, 'wait');
  } catch (err) {
    outcome = 'failed';
    message = `${message ? `${message} ` : ''}The original model could not be loaded again: switch it by hand on Setup → Model.`.slice(0, 250);
  }
  await pool.query('UPDATE ai_benchmark_runs SET status = ?, message = ?, finished_at = NOW() WHERE id = ?', [outcome, message, runId]).catch(() => {});
  job = null;
  gens.release();
}

async function start(coreApi, { user, keywords, think, mode }) {
  if (job) throw new HttpError(409, 'busy', 'A benchmark is already running.');
  if (switcher.isActive()) throw new HttpError(409, 'busy', 'The model is being switched right now.');
  const cfg = readConfig(coreApi);
  const models = cfg.models.filter(m => Array.isArray(keywords) && keywords.includes(m.keyword));
  if (!models.length) throw new HttpError(400, 'no_models', 'Choose at least one model.');
  job = { runId: null, step: 'Starting', done: 0, total: 0, startedAt: Date.now(), abort: new AbortController(), currentSwitch: null };
  try {
    const st = await ctl.status(cfg);
    if (!st.ok) throw new HttpError(502, 'controller', `The model switcher on the AI server could not be reached: ${st.error}`);
    if (st.switching) throw new HttpError(409, 'busy', 'The model is being switched right now.');
    const prompts = (await listPrompts(coreApi.pool)).filter(p => p.enabled);
    if (!prompts.length) throw new HttpError(400, 'no_prompts', 'Switch on at least one question.');
    // Start with the loaded model: saves a switch.
    models.sort((a, b) => (b.keyword === st.keyword) - (a.keyword === st.keyword));
    const r = await coreApi.pool.query('INSERT INTO ai_benchmark_runs (user_id, models, think, status) VALUES (?, ?, ?, ?)',
      [user.id, models.map(m => m.keyword).join(','), think ? 1 : 0, 'running']);
    job.runId = Number(r.insertId);
    job.total = models.length * prompts.length;
    run(coreApi, { user, models, prompts, think: Boolean(think), mode: mode === 'stop' ? 'stop' : 'wait', original: st.keyword });
    return job.runId;
  } catch (err) {
    job = null;
    throw err;
  }
}

function cancel() {
  if (!job) throw new HttpError(409, 'not_running', 'No benchmark is running.');
  job.abort.abort();
  // A switch that is still waiting can be called off; one under way must finish.
  if (job.currentSwitch && job.currentSwitch.phase === 'waiting') job.currentSwitch.cancelled = true;
}

const isRunning = () => Boolean(job);

module.exports = { start, cancel, view, isRunning, listPrompts, savePrompt, deletePrompt };

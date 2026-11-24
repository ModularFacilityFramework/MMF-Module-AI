// Combines what vLLM says (HTTP) with what the controller says (ai-ctl over
// SSH) into one state for the chat banner and the Setup "Model" card.
//
// The controller is asked through SSH, so its answer is cached for a short
// time and shared by concurrent callers: many users polling the chat banner
// cause at most one SSH call per CTL_CACHE_MS.
const vllm = require('./vllm');
const ctl = require('./ctl');
const { readConfig } = require('./config');
const { getSetting } = require('./settings');
const switcher = require('./switcher');

const CTL_CACHE_MS = 15000;
let infoCache = { at: 0, value: null, pending: null };

async function cachedInfo(cfg, fresh) {
  const now = Date.now();
  if (!fresh && infoCache.value && now - infoCache.at < CTL_CACHE_MS) return infoCache.value;
  if (infoCache.pending) return infoCache.pending;
  infoCache.pending = ctl.info(cfg).then(value => {
    infoCache = { at: Date.now(), value, pending: null };
    return value;
  });
  return infoCache.pending;
}

function forgetCache() {
  infoCache = { at: 0, value: null, pending: null };
}

// Folder name of a model path, e.g. "/home/ai/models/llm/Qwen3.6-27B" -> "Qwen3.6-27B".
const baseName = p => (p || '').split('/').filter(Boolean).pop() || '';

// Which configured keyword is vLLM serving? Prefer the controller's own
// keyword -> path table; fall back to the controller status line.
function keywordForModelId(modelId, info) {
  const table = info && info.ok ? info.data.controller_table || {} : {};
  for (const [kw, path] of Object.entries(table)) {
    if (path === modelId || baseName(path) === baseName(modelId) || kw === modelId) return kw;
  }
  return null;
}

async function overview(coreApi, { fresh = false } = {}) {
  const cfg = readConfig(coreApi);
  if (!cfg.vllmUrl) {
    return { cfg, state: 'unconfigured', message: 'The AI is not set up yet.', vllm: null, info: null };
  }
  const [snap, info] = await Promise.all([vllm.snapshot(cfg), cachedInfo(cfg, fresh)]);
  const controller = info && info.ok ? info.controller : null;

  let state;
  let message;
  const sw = switcher.state().active;
  if (sw && sw.phase !== 'waiting') {
    state = 'switching';
    message = `The AI is switching to ${sw.toLabel}. This takes about 1-2 minutes. You can keep typing; nothing is lost.`;
  } else if (controller && controller.switching) {
    state = 'switching';
    message = `The AI is switching to ${labelFor(cfg, controller.keyword)}. This takes about 1-2 minutes.`;
  } else if (snap.reachable && snap.modelId) {
    state = 'ready';
    message = null;
  } else if (controller && controller.state === 'running') {
    // The controller has a model process but vLLM does not answer yet:
    // starting up, or a switch begun outside MFF.
    state = 'starting';
    message = `The AI is starting ${labelFor(cfg, controller.keyword)}. This takes about 1-2 minutes.`;
  } else {
    state = 'down';
    message = 'The AI is not available right now.';
  }

  const keyword = keywordForModelId(snap.modelId, info) || (controller ? controller.keyword : null);
  const model = cfg.models.find(m => m.keyword === keyword) || null;

  // Waiting for running answers to finish before a switch: still usable, but
  // new questions wait until the new model is ready.
  let notice = null;
  if (sw && sw.phase === 'waiting') {
    notice = `The AI will switch to ${sw.toLabel} as soon as the running answers have finished. New questions wait until then.`;
  }

  const expected = await expectedKeyword(coreApi.pool);
  const changedOutside = Boolean(expected && keyword && state === 'ready' && expected !== keyword);

  if (changedOutside && !sw) switcher.noteOutside(coreApi.pool, keyword, expected);

  return { cfg, state, message, notice, keyword, model, changedOutside, vllm: snap, info, controller };
}

// The model MFF last switched to (written by the switch step). Cached, and
// never allowed to hold a status answer up for more than DB_WAIT_MS: the
// status must work even when the database is slow or down.
const DB_WAIT_MS = 1500;
const EXPECTED_CACHE_MS = 60000;
let expectedCache = { at: 0, value: null };

async function expectedKeyword(pool) {
  if (Date.now() - expectedCache.at < EXPECTED_CACHE_MS) return expectedCache.value;
  const timeout = new Promise(resolve => setTimeout(() => resolve(undefined), DB_WAIT_MS));
  const value = await Promise.race([getSetting(pool, 'model.expected', null).catch(() => undefined), timeout]);
  if (value !== undefined) expectedCache = { at: Date.now(), value };
  else expectedCache = { at: Date.now() - EXPECTED_CACHE_MS + 10000, value: expectedCache.value }; // retry in 10 s
  return expectedCache.value;
}

function setExpectedKeyword(keyword) {
  expectedCache = { at: Date.now(), value: keyword };
}

function labelFor(cfg, keyword) {
  const m = cfg.models.find(x => x.keyword === keyword);
  return m ? m.label : (keyword || 'another model');
}

module.exports = { overview, forgetCache, keywordForModelId, setExpectedKeyword };

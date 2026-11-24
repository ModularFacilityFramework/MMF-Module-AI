// Every quota and limit, with its default. A row in ai_settings ("limits")
// overrides a default; the Setup page edits them, so a change takes effect
// without a restart (cached for a few seconds).
const { getSetting, setSetting } = require('./settings');

const MB = 1024 * 1024;

// key -> { def, min, max, unit, label, help }
const LIMITS = {
  maxConcurrent: { def: 8, min: 1, max: 64, unit: 'answers', label: 'Answers at the same time (everyone)', help: 'More than this wait in a queue.' },
  maxQueue: { def: 20, min: 0, max: 500, unit: 'questions', label: 'Queue length', help: 'A question is refused when this many are already waiting.' },
  perUserRunning: { def: 1, min: 1, max: 10, unit: 'answers', label: 'Answers at the same time (one person)', help: 'Running and waiting answers together.' },
  perUserQuestions: { def: 30, min: 1, max: 1000, unit: 'questions', label: 'Questions per person', help: 'Counted over the time window below.' },
  perUserWindowMin: { def: 10, min: 1, max: 1440, unit: 'minutes', label: 'Time window for the question limit', help: '' },
  maxTokens: { def: 4096, min: 128, max: 16384, unit: 'tokens', label: 'Answer length', help: 'About three quarters of a word per token.' },
  maxTokensThinking: { def: 8192, min: 512, max: 16384, unit: 'tokens', label: 'Answer length when thinking', help: 'Thinking and answer together.' },
  firstTokenTimeoutS: { def: 120, min: 10, max: 900, unit: 'seconds', label: 'Wait for the first word', help: '' },
  idleTimeoutS: { def: 120, min: 10, max: 900, unit: 'seconds', label: 'Longest pause inside an answer', help: '' },
  totalTimeoutS: { def: 900, min: 60, max: 7200, unit: 'seconds', label: 'Longest answer', help: '' },
  maxPromptKB: { def: 200, min: 1, max: 800, unit: 'KB', label: 'Question length', help: 'Typed text only; files have their own limit.' },
  maxFileMB: { def: 25, min: 1, max: 500, unit: 'MB', label: 'File size', help: 'Largest single upload.' },
  maxImageMB: { def: 10, min: 1, max: 100, unit: 'MB', label: 'Image size', help: 'Largest single image.' },
  maxFilesPerMessage: { def: 10, min: 1, max: 50, unit: 'files', label: 'Files per question', help: '' },
  quotaMB: { def: 1024, min: 10, max: 1048576, unit: 'MB', label: 'Storage per person', help: 'Chats and uploads together, deleted chats included until they are purged.' },
  trashDays: { def: 30, min: 1, max: 3650, unit: 'days', label: 'Keep deleted chats', help: 'Deleted chats are removed for good after this.' }
};

const DEFAULTS = Object.fromEntries(Object.entries(LIMITS).map(([k, v]) => [k, v.def]));
const CACHE_MS = 5000;
let cache = { at: 0, value: null };

function clean(saved) {
  const out = { ...DEFAULTS };
  for (const [key, value] of Object.entries(saved || {})) {
    const spec = LIMITS[key];
    if (spec && Number.isInteger(value) && value >= spec.min && value <= spec.max) out[key] = value;
  }
  return out;
}

// A database problem must not stop the chat: fall back to what was last read,
// else to the defaults.
async function getLimits(pool) {
  if (cache.value && Date.now() - cache.at < CACHE_MS) return cache.value;
  let value;
  try {
    value = clean(await getSetting(pool, 'limits', {}));
  } catch (err) {
    value = cache.value || { ...DEFAULTS };
  }
  cache = { at: Date.now(), value };
  return value;
}

// changes: { key: integer | null }. null resets that limit to its default.
async function saveLimits(pool, changes, userId) {
  const saved = { ...(await getSetting(pool, 'limits', {})) };
  for (const [key, value] of Object.entries(changes || {})) {
    const spec = LIMITS[key];
    if (!spec) throw Object.assign(new Error(`Unknown limit "${key}"`), { status: 400 });
    if (value === null) { delete saved[key]; continue; }
    if (!Number.isInteger(value) || value < spec.min || value > spec.max) {
      throw Object.assign(new Error(`${spec.label}: enter a whole number from ${spec.min} to ${spec.max}`), { status: 400 });
    }
    saved[key] = value;
  }
  await setSetting(pool, 'limits', saved, userId);
  cache = { at: 0, value: null };
  return getLimits(pool);
}

module.exports = { LIMITS, DEFAULTS, MB, getLimits, saveLimits };

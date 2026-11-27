// Speech to text: the microphone button of the chat sends a recording here, the
// backend passes it to Whisper on the AI server (MODULE_AI_WHISPER_URL,
// tools/gpu6/whisper_server.py) and returns the text, which goes into the
// question box for the person to check and send. It is the "speech_to_text"
// entry of Setup -> Tools (install, switch, audience, roles); it is never
// offered to the model as a tool. The question itself goes through the guard
// when it is sent. Each use is logged (ai_transcribe_log, no text).
const tools = require('./tools');
const safety = require('./safety');
const { HttpError } = require('./storage');

const MAX_BYTES = 25 * 1024 * 1024;
const PER_WINDOW = 30;
const WINDOW_MS = 10 * 60000;
const recent = new Map(); // user id -> timestamps

// May this person use the microphone? (installed, on, roles, audience)
async function allowed(coreApi, user) {
  const cfg = require('./config').readConfig(coreApi);
  if (!cfg.whisperUrl) return false;
  const level = await safety.levelFor(coreApi, user);
  const state = (await tools.getState(coreApi.pool).catch(() => ({}))).speech_to_text;
  if (!state || !state.enabled) return false;
  const roles = await coreApi.getUserRoles(user);
  return (!state.roles.length || state.roles.some(r => roles.includes(r))) && safety.allowed(state.audience || 'standard', level);
}

async function transcribe(coreApi, user, audio, { language } = {}) {
  const cfg = require('./config').readConfig(coreApi);
  if (!(await allowed(coreApi, user))) throw new HttpError(403, 'not_allowed', 'Speech to text is not switched on for you.');
  if (!audio || !audio.length) throw new HttpError(400, 'no_audio', 'Nothing was recorded.');
  if (audio.length > MAX_BYTES) throw new HttpError(413, 'too_large', 'The recording is too long (25 MB at most).');
  const now = Date.now();
  const times = (recent.get(user.id) || []).filter(t => now - t < WINDOW_MS);
  if (times.length >= PER_WINDOW) throw new HttpError(429, 'too_many', 'Too many recordings in a short time. Wait a few minutes.');
  times.push(now);
  recent.set(user.id, times);
  const started = Date.now();
  let res;
  let data = {};
  try {
    const qs = /^[a-z]{2}$/.test(language || '') ? `?language=${language}` : '';
    res = await fetch(`${cfg.whisperUrl}/transcribe${qs}`, {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: audio, signal: AbortSignal.timeout(120000)
    });
    data = await res.json().catch(() => ({}));
  } catch (err) {
    res = null;
  }
  const ok = Boolean(res && res.ok);
  await coreApi.pool.query('INSERT INTO ai_transcribe_log (user_id, seconds_audio, ms, ok) VALUES (?, ?, ?, ?)',
    [user.id, ok ? data.duration : null, Date.now() - started, ok ? 1 : 0]).catch(() => {});
  if (!res) throw new HttpError(503, 'whisper_down', 'Speech to text is not available right now.');
  if (!res.ok) throw new HttpError(res.status === 413 ? 413 : 422, 'unreadable', data.error ? `The recording could not be used: ${data.error}.` : 'The recording could not be used.');
  return { text: data.text || '', language: data.language, duration: data.duration };
}

module.exports = { allowed, transcribe };

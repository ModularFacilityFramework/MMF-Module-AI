// Safety and scope, checked in the backend for every answer (the model's
// prompt is never the only guard):
//  1. the guard model (Qwen3Guard, served beside the main model) reads every
//     question and every answer, and blocks unsafe ones (weapons, hacking,
//     terrorism, ...); a question about self-harm gets a kind answer with help;
//  2. the scope check: only MFF, the facility, its servers, structural biology
//     and scientific writing; anything else gets a polite refusal;
//  3. the audience: what each tool and skill is for (user, facility staff,
//     developer), and the output scan, which hides internal addresses, host
//     names and server paths in what normal users see.
// Developers are not slowed down: no scope check and no scan for them, and the
// guard only when it is switched on for them on Setup -> Safety.
const { getSetting, setSetting } = require('./settings');
const { POLICY_ROLES } = require('./permissions');

const LEVELS = ['user', 'staff', 'developer'];
const LEVEL_LABEL = { user: 'everyone', staff: 'facility staff', developer: 'developers and administrators' };
const GUARD_TIMEOUT_MS = 8000;
const SCOPE_TIMEOUT_MS = 15000;
const GUARD_MAX_CHARS = 12000; // the guard serves 8,192 tokens; keep well inside
const ANSWER_CHECK_EVERY = 2000; // characters of new answer between checks while it is written

const DEFAULTS = {
  guardUsers: true,        // guard for normal users and facility staff
  guardDevelopers: false,  // guard for developers and administrators
  guardDown: 'refuse',     // guard configured but not answering: 'refuse' or 'answer'
  scope: true,             // scope check for normal users and facility staff
  scan: true,              // output scan for normal users and facility staff
  staffRoles: [],          // core roles that count as facility staff
  hosts: []                // extra host names to hide from users
};

const TEXT = {
  selfHarm: 'I\'m really sorry you\'re feeling like this. You don\'t have to deal with it alone, and talking to someone can help.\n\n'
    + '- **If you are in danger right now**, call **999** (or 112).\n'
    + '- **Samaritans** are there day and night, free: call **116 123** or email jo@samaritans.org.\n'
    + '- Your **university\'s wellbeing and support services** (for students and for staff) can help too; your supervisor, line manager or the university\'s support web pages can tell you how to reach them.\n\n'
    + 'Please reach out to one of them now.',
  blocked: category => `I can't help with this request: the safety check flagged it${category ? ` (${category})` : ''}. `
    + 'This AI is for the facility\'s work. If you think this is a mistake, please contact the facility staff.',
  blockedAnswer: 'This answer was stopped by the safety check. If you think this is a mistake, please contact the facility staff.',
  outOfScope: 'I can only help with MFF, the facility and its servers, structural biology (for example MX and cryo-EM) and scientific writing such as papers, grants and materials and methods. Please ask me something in those areas.',
  guardDown: 'The safety check is not available right now, so I cannot answer. Please try again in a few minutes.'
};

async function getSettings(pool) {
  const s = await getSetting(pool, 'safety', null).catch(() => null);
  return { ...DEFAULTS, ...(s && typeof s === 'object' ? s : {}) };
}

async function saveSettings(coreApi, body, userId) {
  const b = body || {};
  const roles = await coreApi.listRoles();
  const clean = {
    guardUsers: b.guardUsers !== false,
    guardDevelopers: Boolean(b.guardDevelopers),
    guardDown: b.guardDown === 'answer' ? 'answer' : 'refuse',
    scope: b.scope !== false,
    scan: b.scan !== false,
    staffRoles: [...new Set(Array.isArray(b.staffRoles) ? b.staffRoles : [])].filter(r => roles.includes(r) && !POLICY_ROLES.includes(r)),
    hosts: [...new Set((Array.isArray(b.hosts) ? b.hosts : []).map(h => String(h).trim()).filter(h => /^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/.test(h)))].slice(0, 100)
  };
  await setSetting(coreApi.pool, 'safety', clean, userId);
  return clean;
}

// 'developer' (administrator or developer), 'staff' (a role chosen on
// Setup -> Safety) or 'user'.
async function levelFor(coreApi, user, settings) {
  const roles = await coreApi.getUserRoles(user).catch(() => []);
  if (roles.some(r => POLICY_ROLES.includes(r))) return 'developer';
  if (roles.some(r => (settings.staffRoles || []).includes(r))) return 'staff';
  return 'user';
}

const allowed = (audience, level) => LEVELS.indexOf(level) >= LEVELS.indexOf(LEVELS.includes(audience) ? audience : 'user');

function policy(settings, level) {
  const dev = level === 'developer';
  return {
    guard: dev ? settings.guardDevelopers : settings.guardUsers,
    scope: !dev && settings.scope,
    scan: !dev && settings.scan
  };
}

// --- the guard model -----------------------------------------------------------

// Keeps the end of a long text (the newest part matters most) within the guard's room.
const clip = t => (t.length > GUARD_MAX_CHARS ? t.slice(-GUARD_MAX_CHARS) : t);

// messages: [{role:'user', content}] for a question, plus {role:'assistant'}
// for an answer. -> { ok, label: 'Safe'|'Unsafe'|'Controversial', categories, ms, error }
async function guard(cfg, messages) {
  const started = Date.now();
  if (!cfg.guardUrl) return { ok: false, configured: false, ms: 0, error: 'not configured' };
  try {
    const res = await fetch(`${cfg.guardUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'guard', messages: messages.map(m => ({ role: m.role, content: clip(m.content || '') })), max_tokens: 40, temperature: 0 }),
      signal: AbortSignal.timeout(GUARD_TIMEOUT_MS)
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = ((await res.json()).choices || [{}])[0].message.content || '';
    const label = (/Safety:\s*(Safe|Unsafe|Controversial)/.exec(text) || [])[1];
    if (!label) throw new Error('unreadable answer');
    const line = (/Categories:\s*(.*)/.exec(text) || [])[1] || '';
    const categories = line.split(',').map(c => c.trim()).filter(c => c && c !== 'None');
    return { ok: true, configured: true, label, categories, ms: Date.now() - started };
  } catch (err) {
    return { ok: false, configured: true, ms: Date.now() - started, error: err.name === 'TimeoutError' ? 'timed out' : err.message };
  }
}

const isSelfHarm = r => r.ok && r.label !== 'Safe' && r.categories.includes('Suicide & Self-Harm');
const isUnsafe = r => r.ok && r.label === 'Unsafe';

async function guardStatus(cfg) {
  if (!cfg.guardUrl) return { configured: false, reachable: false };
  try {
    const res = await fetch(`${cfg.guardUrl}/v1/models`, { signal: AbortSignal.timeout(4000) });
    const data = await res.json();
    const m = (data.data || [])[0];
    return { configured: true, reachable: true, model: m ? String(m.root || m.id).split('/').filter(Boolean).pop() : null, maxModelLen: m ? m.max_model_len : null };
  } catch (err) {
    return { configured: true, reachable: false, error: err.name === 'TimeoutError' ? 'timed out' : 'does not answer' };
  }
}

// --- the scope check, by the loaded model ------------------------------------------

const SCOPE_PROMPT = 'You decide whether a message to the AI assistant of a structural biology research facility is within its scope. '
  + 'In scope: the MFF web application and its modules; the facility itself (instruments, bookings, samples, projects, data, jobs, safety, people\'s roles, '
  + 'how finance and charges work); its servers and computing (HPC, Slurm, GPUs, storage, software); structural biology and the science around it '
  + '(macromolecular crystallography, cryo-EM, proteins, biochemistry, molecular biology, lab methods, data processing, model building, figures, '
  + 'and the chemistry, physics, maths, calculations, unit conversions, statistics, data analysis and programming that this work needs); scientific writing (papers, grants, materials and methods, reports, '
  + 'posters, presentations, emails about this work). Also in scope: greetings, thanks, questions about the assistant itself, requests to reformat, '
  + 'translate, shorten or continue earlier answers, and follow-ups to an in-scope conversation. '
  + 'Out of scope: everything else, for example general news, sport, entertainment, celebrities, holidays, shopping, personal finance, dating, '
  + 'homework or coursework in unrelated subjects. When a message could reasonably belong to this work (for example a calculation, a unit conversion, a chemistry, biology or physics question, a coding or computing question, or a writing task), answer IN; answer OUT only when it is clearly about something else. Arithmetic and calculations of any kind are always IN. Reply with exactly one word: IN or OUT.';

// history: the stored messages, the last one being the question.
// -> { inScope, ms, ok, error }
async function scope(o, history) {
  const started = Date.now();
  const question = history[history.length - 1];
  const before = history.slice(0, -1).filter(m => m.role === 'user' || m.content).slice(-2);
  const context = before.map(m => (m.role === 'user' ? `Earlier question: ${(m.text || '').slice(0, 600)}` : `Earlier answer (start): ${(m.content || '').slice(0, 400)}`)).join('\n');
  const files = (question.files || []).map(f => f.name).join(', ');
  const message = `${context ? `${context}\n\n` : ''}Message to classify: ${(question.text || '').slice(0, 4000)}${files ? `\n(Attached files: ${files})` : ''}`;
  const caps = o.model ? o.model.capabilities : [];
  const body = {
    model: o.vllm.modelId,
    messages: [{ role: 'system', content: SCOPE_PROMPT }, { role: 'user', content: message }],
    max_tokens: 3,
    temperature: 0
  };
  if (caps.includes('thinking')) body.chat_template_kwargs = { enable_thinking: false };
  if (caps.includes('thinking-r1')) {
    // A model that always thinks: start its answer after an empty thought.
    body.messages.push({ role: 'assistant', content: '<think>\n\n</think>\n\n' });
    body.continue_final_message = true;
    body.add_generation_prompt = false;
  }
  try {
    const res = await fetch(`${o.cfg.vllmUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(o.cfg.vllmApiKey ? { Authorization: `Bearer ${o.cfg.vllmApiKey}` } : {}) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(SCOPE_TIMEOUT_MS)
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = (((await res.json()).choices || [{}])[0].message.content || '').trim().toUpperCase();
    return { ok: true, inScope: !text.startsWith('OUT'), answer: text.slice(0, 10), ms: Date.now() - started };
  } catch (err) {
    // The scope check is not a safety guard: when it fails, the question goes on.
    return { ok: false, inScope: true, ms: Date.now() - started, error: err.message };
  }
}

// --- the output scan ------------------------------------------------------------------

const HIDDEN = '[hidden]';
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const hostOf = (url) => { try { return new URL(url).hostname; } catch (err) { return ''; } };

// A function text -> text that hides internal IP addresses, host names and
// server paths. Applied to text in pieces that end at white space, so a
// pattern is never split.
function redactor(cfg, settings) {
  const names = new Set((settings.hosts || []).map(h => h.toLowerCase()));
  for (const h of [hostOf(cfg.vllmUrl), hostOf(cfg.guardUrl || ''), cfg.ssh && cfg.ssh.host]) {
    if (h && !/^\d+(\.\d+){3}$/.test(h) && !['localhost'].includes(h.toLowerCase())) names.add(h.toLowerCase());
  }
  const patterns = [
    // private and loopback IPv4 addresses, with an optional port
    /\b(?:10(?:\.\d{1,3}){3}|127(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2})(?::\d{1,5})?\b/g,
    // host names on internal domains
    /\b[A-Za-z0-9][A-Za-z0-9-]*(?:\.[A-Za-z0-9-]+)*\.(?:local|lan|internal|intranet|corp|localdomain)\b/gi,
    // absolute server paths (two parts or more), and home-relative ones
    /(?<![\w:/.~-])\/(?:[\w.@+-]+\/)+[\w.@+-]*/g,
    /(?<![\w/])~\/[\w.@+/-]*/g,
    // Windows shares and drive paths
    /\\\\[\w.$-]+(?:\\[\w.$ -]+)+/g,
    /\b[A-Za-z]:\\(?:[\w.$ -]+\\?)+/g
  ];
  if (names.size) patterns.push(new RegExp(`(?<![\\w.-])(?:${[...names].map(escapeRe).join('|')})(?![\\w-])`, 'gi'));
  return text => patterns.reduce((t, re) => t.replace(re, HIDDEN), text);
}

// --- the log ---------------------------------------------------------------------------

// One row per check, without any question or answer text.
async function log(pool, row) {
  await pool.query(
    'INSERT INTO ai_safety_log (answer_id, user_id, level, stage, result, label, categories, ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [row.answerId, row.userId || null, row.level, row.stage, row.result, row.label || null, (row.categories || []).join(', ').slice(0, 200) || null, Math.round(row.ms || 0)]
  ).catch(() => console.error('[ai] could not log a safety check'));
}

module.exports = {
  LEVELS, LEVEL_LABEL, DEFAULTS, TEXT, ANSWER_CHECK_EVERY,
  getSettings, saveSettings, levelFor, allowed, policy, guard, guardStatus, isSelfHarm, isUnsafe, scope, redactor, log
};

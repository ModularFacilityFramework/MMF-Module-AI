// The MFF docs as tools for the AI: an index of every doc and what it covers,
// search, and read. The AI looks here first for any question about MFF, a
// module or a procedure (the user's first tool).
//
// Where the docs come from: coreApi.docs (core 0.1.219: available/list/read)
// when it has docs, else the folder MODULE_AI_DOCS_DIR. Where neither has any
// (production until an MFF-docs checkout is put beside core), the tools are
// not offered and the AI says the docs are not available on this server.
//
// Who may read which doc (the user's rule, 26/11/2026): user guides are for
// everyone; install, admin, security, server and deployment docs, and any doc
// not known to be for users, are for facility staff and developers. INDEX.json
// in MODULE_AI_DOCS_DIR, when present, can set a doc's audience ("user",
// "staff", "developer"; "developer-admin" = "developer"). The check is made
// here, for the asker, before any text reaches the model: a doc above the
// asker's level is never listed, searched or read.
const fsp = require('fs').promises;
const path = require('path');
const safety = require('./safety');

const CACHE_MS = 60000;
const PART_CHARS = 8000;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,150}\.md$/;
let cache = { at: 0, key: '', docs: null };

// The instruction for the model, naming only the docs tools it has.
function PROMPT(keys) {
  if (!keys.length) return '';
  const how = keys.includes('search_docs') && keys.includes('read_doc') ? ' (search_docs, then read_doc for the right section)' : '';
  return `The MFF documentation is available through the tools ${keys.join(', ')}. `
    + `For any question about MFF, one of its modules, the facility's procedures or its servers, look in the docs first${how} `
    + 'and say which doc your answer comes from. If the docs do not cover it, say so instead of guessing.';
}

async function source(coreApi, cfg) {
  const core = coreApi.docs;
  if (core && typeof core.list === 'function' && typeof core.read === 'function'
      && (typeof core.available !== 'function' || await core.available().catch(() => false))) {
    return {
      key: 'core',
      list: async () => (await core.list()) || [],
      read: async (name) => { const r = await core.read(name); if (!r) throw new Error('gone'); return typeof r === 'string' ? r : r.text; }
    };
  }
  if (!cfg.docsDir) return null;
  try { await fsp.access(cfg.docsDir); } catch (err) { return null; }
  return {
    key: `dir:${cfg.docsDir}`,
    list: async () => (await fsp.readdir(cfg.docsDir)).filter(n => NAME_RE.test(n)).map(name => ({ name })),
    read: name => fsp.readFile(path.join(cfg.docsDir, name), 'utf8')
  };
}

// INDEX.json, as { files: { name: entry } } or { files: [ { file, ...entry } ] }
// (the form mff-docs proposed). audience 'developer-admin' means 'developer'.
// -> { found, entries: { name: { audience, summary } } }
async function readIndexFile(cfg) {
  if (!cfg.docsDir) return { found: false, entries: {} };
  let data;
  try { data = JSON.parse(await fsp.readFile(path.join(cfg.docsDir, 'INDEX.json'), 'utf8')); } catch (err) { return { found: false, entries: {} }; }
  const list = Array.isArray(data) ? data : data && data.files;
  const entries = {};
  const add = (name, e) => {
    if (!name || !e || typeof e !== 'object') return;
    const audience = e.audience === 'developer-admin' ? 'developer' : e.audience;
    entries[String(name)] = { audience: safety.LEVELS.includes(audience) ? audience : null, summary: typeof e.summary === 'string' ? e.summary : '' };
  };
  if (Array.isArray(list)) list.forEach(e => add(e && (e.file || e.name), e));
  else if (list && typeof list === 'object') Object.entries(list).forEach(([name, e]) => add(name, e));
  return { found: true, entries };
}

// "MFF-Module-AI_safety.md" -> "AI module"; "MFF-Core_api.md" -> "Core"
function areaOf(name) {
  const m = /^MFF-(?:Module[-_]([A-Za-z0-9.]+)|(Core))_/.exec(name);
  if (!m) return 'Other';
  return m[2] ? 'Core' : `${m[1]} module`;
}

function sections(text) {
  const out = [];
  let current = { heading: '(start)', start: 0 };
  const re = /^(#{1,4})\s+(.+)$/gm;
  let m;
  while ((m = re.exec(text))) {
    if (m.index > current.start || out.length === 0) { current.end = m.index; if (current.end > current.start) out.push(current); }
    current = { heading: m[2].trim(), start: m.index };
  }
  current.end = text.length;
  out.push(current);
  return out.filter(s => s.end > s.start);
}

function summaryOf(text) {
  const body = text.replace(/^#.*$/gm, '').split(/\n\s*\n/).map(p => p.replace(/\s+/g, ' ').trim()).find(p => p && !p.startsWith('|') && !p.startsWith('```'));
  return body ? (body.length > 220 ? `${body.slice(0, 219)}…` : body) : '';
}

// All docs with title, area, summary, audience and sections; cached a minute.
async function load(coreApi, cfg) {
  const src = await source(coreApi, cfg);
  if (!src) return null;
  if (cache.docs && cache.key === src.key && Date.now() - cache.at < CACHE_MS) return cache.docs;
  const [list, index] = await Promise.all([src.list(), readIndexFile(cfg)]);
  const meta = index.entries;
  const docs = [];
  for (const { name } of list) {
    if (!NAME_RE.test(name)) continue;
    let text;
    try { text = String(await src.read(name)); } catch (err) { continue; }
    const m = meta[name] || {};
    // No entry, or no audience in it: user guides are for everyone, the rest
    // for facility staff and developers.
    const fallback = /_user-guide\.md$/.test(name) ? 'user' : 'staff';
    const title = ((/^#\s+(.+)$/m.exec(text) || [])[1] || name.replace(/\.md$/, '')).trim();
    docs.push({
      name, title, area: areaOf(name), text,
      summary: m.summary || summaryOf(text),
      audience: m.audience || fallback,
      indexed: Boolean(meta[name] && m.audience),
      sections: sections(text)
    });
  }
  docs.sort((a, b) => a.name.localeCompare(b.name));
  if (!docs.length) return null;
  cache = { at: Date.now(), key: src.key, docs };
  return docs;
}

function forget() { cache = { at: 0, key: '', docs: null }; }

// The docs this answer's asker may read (ctx from answer.js: coreApi, cfg, level).
async function visible(ctx) {
  const all = await load(ctx.coreApi, ctx.cfg);
  if (!all) throw new Error('the MFF docs are not available on this server');
  return all.filter(d => safety.allowed(d.audience, ctx.level || 'user'));
}

function findDoc(docs, wanted) {
  const w = String(wanted || '').trim().toLowerCase().replace(/^docs\//, '');
  const d = docs.find(x => x.name.toLowerCase() === w || x.name.toLowerCase() === `${w}.md`);
  if (!d) throw new Error(`there is no doc "${String(wanted).slice(0, 80)}" that you may read; use docs_index or search_docs`);
  return d;
}

// Entries for the tools catalogue (tools.js): installed, switched on and given
// an audience on Setup -> Tools like any other tool.
const TOOLS = [
  {
    key: 'docs_index',
    name: 'MFF docs: index',
    what: 'Lets the AI see the list of MFF docs and what each one covers, so it knows where things are documented.',
    example: 'Where is the Slurm set-up documented?',
    sees: 'The MFF docs the person asking may read (by audience: everyone, facility staff or developers).',
    risk: 'reads only',
    status: 'tested',
    definition: {
      name: 'docs_index',
      description: 'Lists the MFF docs: file name, title, area (Core or a module) and what each covers. Optional filter by words in the name, title, area or summary.',
      parameters: { type: 'object', properties: { filter: { type: 'string', description: 'Optional words, for example "slurm" or "finance"' } } }
    },
    run: async (args, ctx) => {
      const docs = await visible(ctx);
      const words = String(args.filter || '').toLowerCase().split(/\s+/).filter(Boolean);
      const hits = docs.filter(d => words.every(w => `${d.name} ${d.title} ${d.area} ${d.summary}`.toLowerCase().includes(w)));
      return hits.length
        ? `${hits.length} docs${words.length ? ` matching "${args.filter}"` : ''}:\n${hits.map(d => `- ${d.name} (${d.area}): ${d.title}. ${d.summary}`).join('\n')}`
        : `No doc matches "${args.filter}". There are ${docs.length} docs; call docs_index without a filter to see them all.`;
    }
  },
  {
    key: 'search_docs',
    name: 'MFF docs: search',
    what: 'Lets the AI search the MFF docs and find the right section.',
    example: 'How do I install a module?',
    sees: 'The MFF docs the person asking may read.',
    risk: 'reads only',
    status: 'tested',
    definition: {
      name: 'search_docs',
      description: 'Searches the MFF docs and returns the best matching sections (doc, section heading, a short extract). Then read the right section with read_doc.',
      parameters: { type: 'object', properties: { query: { type: 'string', description: 'Words to look for' } }, required: ['query'] }
    },
    run: async (args, ctx) => {
      const docs = await visible(ctx);
      const words = String(args.query || '').toLowerCase().split(/[^\p{L}\p{N}_.-]+/u).filter(w => w.length > 1);
      if (!words.length) throw new Error('give some words to search for');
      const scored = [];
      for (const d of docs) {
        for (const s of d.sections) {
          const body = d.text.slice(s.start, s.end).toLowerCase();
          const head = `${s.heading} ${d.title}`.toLowerCase();
          let score = 0;
          for (const w of words) {
            const n = body.split(w).length - 1;
            if (n) score += 1 + Math.min(n, 5) * 0.2 + (head.includes(w) ? 2 : 0);
          }
          if (score) scored.push({ d, s, score: score + (words.every(w => body.includes(w) || head.includes(w)) ? 3 : 0) });
        }
      }
      scored.sort((a, b) => b.score - a.score);
      if (!scored.length) return `Nothing in the docs matches "${args.query}".`;
      return scored.slice(0, 8).map(({ d, s }) => {
        const body = d.text.slice(s.start, s.end);
        const first = words.find(w => body.toLowerCase().includes(w)) || '';
        const at = Math.max(0, body.toLowerCase().indexOf(first) - 120);
        return `- ${d.name}, section "${s.heading}": …${body.slice(at, at + 400).replace(/\s+/g, ' ')}…`;
      }).join('\n');
    }
  },
  {
    key: 'read_doc',
    name: 'MFF docs: read',
    what: 'Lets the AI read one MFF doc, or one section of it, to answer from it and say where the answer comes from.',
    example: 'What does the user guide say about the Usage tab?',
    sees: 'The MFF docs the person asking may read.',
    risk: 'reads only',
    status: 'tested',
    definition: {
      name: 'read_doc',
      description: 'Reads one MFF doc: one section by its heading, or the whole doc in parts.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'The doc file name, for example MFF-Core_user-guide.md' },
          section: { type: 'string', description: 'Optional section heading (or words of it)' },
          start: { type: 'integer', description: 'Optional position to read from, for a long doc' }
        },
        required: ['name']
      }
    },
    target: args => String(args.name || '').slice(0, 100),
    run: async (args, ctx) => {
      const d = findDoc(await visible(ctx), args.name);
      if (args.section) {
        const w = String(args.section).toLowerCase();
        const s = d.sections.find(x => x.heading.toLowerCase() === w) || d.sections.find(x => x.heading.toLowerCase().includes(w));
        if (!s) return `${d.name} has no section "${args.section}". Sections: ${d.sections.map(x => x.heading).join('; ')}`;
        const part = d.text.slice(s.start, Math.min(s.end, s.start + PART_CHARS));
        return `${d.name}, section "${s.heading}":\n${part}${s.end - s.start > PART_CHARS ? '\n(cut: read on with start)' : ''}`;
      }
      const start = Math.min(Math.max(0, Math.floor(Number(args.start) || 0)), d.text.length);
      const part = d.text.slice(start, start + PART_CHARS);
      const end = start + part.length;
      return `${d.name}, characters ${start} to ${end} of ${d.text.length}${end < d.text.length ? ` (continue with start=${end})` : ' (end)'}:\n${part}`;
    }
  }
];

// For Setup: every doc with its audience (no text).
// Which source the docs come from right now: 'core', 'folder' or null.
async function sourceName(coreApi, cfg) {
  const src = await source(coreApi, cfg).catch(() => null);
  return src ? (src.key === 'core' ? 'core' : 'folder') : null;
}

const UNAVAILABLE = 'The MFF docs are not available on this server, so you cannot look anything up in them. '
  + 'If asked about MFF documentation, say that the docs are not available here.';

async function overview(coreApi, cfg) {
  const all = await load(coreApi, cfg);
  return all ? all.map(d => ({ name: d.name, title: d.title, area: d.area, audience: d.audience, indexed: d.indexed, chars: d.text.length, summary: d.summary })) : null;
}

module.exports = { TOOLS, PROMPT, UNAVAILABLE, overview, sourceName, forget, load };

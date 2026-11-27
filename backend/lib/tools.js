// Tools the model may use while answering. Every tool is code in this module:
// "installing" one only switches it on here, nothing is downloaded. They see only
// what the person asking can already see; the file tools can add new files to
// that person's own chat, and never change an existing one.
const fsp = require('fs').promises;
const storage = require('./storage');
const { getSetting, setSetting } = require('./settings');
const calc = require('./calculator');
const fileTools = require('./fileTools');
const safety = require('./safety');
const docs = require('./docs');
const slurmTools = require('./slurmTools');
const webTools = require('./webTools');
const mcp = require('./mcp');

const MAX_RESULT_CHARS = 9000;

// Each entry: plain-language card for Setup, the definition sent to the model,
// and run(args, ctx) -> text.
const CATALOGUE = [
  {
    key: 'date_time',
    name: 'Date and time',
    what: 'Tells the AI today\'s date and the current time. Without it, the AI does not know what day it is.',
    example: 'How many days are there until 1 March?',
    sees: 'Only the server\'s clock.',
    risk: 'reads only',
    definition: {
      name: 'date_time',
      description: 'Current date and time at the facility, and the number of days from today to another date.',
      parameters: {
        type: 'object',
        properties: { date: { type: 'string', description: 'Optional date as YYYY-MM-DD, to get the number of days from today to it.' } }
      }
    },
    run: (args) => {
      const now = new Date();
      let out = `Now: ${now.toLocaleString('en-GB', { dateStyle: 'full', timeStyle: 'short', timeZone: 'Europe/London' })} (UK time).`;
      if (args.date !== undefined) {
        const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(args.date));
        const target = m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : NaN;
        if (!m || !Number.isFinite(target) || new Date(target).getUTCDate() !== +m[3]) throw new Error('the date must be a real date as YYYY-MM-DD');
        const uk = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(now).split('-').map(Number);
        out += ` Days from today to ${args.date}: ${Math.round((target - Date.UTC(uk[0], uk[1] - 1, uk[2])) / 86400000)}.`;
      }
      return out;
    }
  },
  {
    key: 'calculator',
    name: 'Calculator',
    what: 'Does exact arithmetic. AI models often get long calculations wrong; with this they work them out instead of guessing.',
    example: 'What is 17.5 mg/ml × 0.35 ml divided by 48212 g/mol?',
    sees: 'Only the numbers the AI types in.',
    risk: 'reads only',
    definition: {
      name: 'calculator',
      description: 'Evaluates one arithmetic expression exactly. Supports + - * / ^ ( ), scientific notation, pi, e, and sqrt, abs, exp, ln, log10, log2, sin, cos, tan, asin, acos, atan (radians), round, floor, ceil, min, max.',
      parameters: { type: 'object', properties: { expression: { type: 'string', description: 'For example (17.5*0.35)/48212' } }, required: ['expression'] }
    },
    run: args => `${args.expression} = ${calc.evaluate(args.expression)}`
  },
  {
    key: 'unit_converter',
    name: 'Unit converter',
    what: 'Converts between units of length, mass, volume, time, temperature, pressure, energy, concentration and angle.',
    example: 'How many Å are 0.31 nm? What is 4 °C in kelvin?',
    sees: 'Only the numbers the AI types in.',
    risk: 'reads only',
    definition: {
      name: 'unit_converter',
      description: `Converts a value between units of the same kind. Units: ${calc.UNIT_NAMES}.`,
      parameters: {
        type: 'object',
        properties: { value: { type: 'number' }, from: { type: 'string' }, to: { type: 'string' } },
        required: ['value', 'from', 'to']
      }
    },
    run: args => `${args.value} ${args.from} = ${calc.convert(args.value, args.from, args.to)} ${args.to}`
  },
  {
    key: 'read_attached_file',
    name: 'Read attached file',
    what: 'Lets the AI look up parts of a long file you attached to the chat, instead of only seeing its beginning.',
    example: 'In the attached log, what does it say about beamline I24?',
    sees: 'Only the files attached to the same chat, by the person asking.',
    risk: 'reads only',
    definition: {
      name: 'read_attached_file',
      description: 'Reads part of a file attached to this conversation, or searches it. Use it when a file was too long to be included completely.',
      parameters: {
        type: 'object',
        properties: {
          file: { type: 'string', description: 'The file name' },
          search: { type: 'string', description: 'Optional text to look for (case-insensitive); returns the matching places with their positions.' },
          start: { type: 'integer', description: 'Optional position (character number) to read from; default 0.' }
        },
        required: ['file']
      }
    },
    run: readAttached
  },
  {
    key: 'edit_excel',
    name: 'Edit Excel file',
    what: 'Lets the AI change cells in an Excel file you attached and give you the result as a new file. Formatting, charts and the other sheets stay as they were. Your original is never changed.',
    example: 'In stock.xlsx, set Tris to 120 g and add a row for glycerol.',
    sees: 'Only the files in the same chat, by the person asking.',
    risk: 'makes new files',
    definition: {
      name: 'edit_excel',
      description: 'Changes cells of an attached .xlsx file and saves the result as a new file. Use the row numbers and columns shown in the file text. Give all changes of one request in one call.',
      parameters: {
        type: 'object',
        properties: {
          file: { type: 'string', description: 'The file name' },
          sheet: { type: 'string', description: 'Sheet name; default the first sheet' },
          cells: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                cell: { type: 'string', description: 'For example B2' },
                value: { description: 'New value: a number, text or true/false; empty text clears the cell' },
                formula: { type: 'string', description: 'A formula instead of a value, for example =SUM(B2:B9)' }
              },
              required: ['cell']
            }
          }
        },
        required: ['file', 'cells']
      }
    },
    run: (args, ctx) => fileTools.edit('xlsx', args, ctx)
  },
  {
    key: 'edit_word',
    name: 'Edit Word file',
    what: 'Lets the AI replace or add text in a Word file you attached and give you the result as a new file. Formatting and pictures stay as they were. Your original is never changed.',
    example: 'In report.docx, replace "HEPES" by "Tris" and add a closing sentence.',
    sees: 'Only the files in the same chat, by the person asking.',
    risk: 'makes new files',
    definition: {
      name: 'edit_word',
      description: 'Changes the text of an attached .docx file and saves the result as a new file. Give all changes of one request in one call. "find" must be text exactly as it stands inside one paragraph.',
      parameters: {
        type: 'object',
        properties: {
          file: { type: 'string', description: 'The file name' },
          changes: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                find: { type: 'string' }, replace: { type: 'string' },
                insert_after: { type: 'string', description: 'Text of the paragraph after which to insert a new one' },
                text: { type: 'string', description: 'The paragraph to insert' },
                append: { type: 'string', description: 'Text to add at the end of the document' }
              }
            }
          }
        },
        required: ['file', 'changes']
      }
    },
    run: (args, ctx) => fileTools.edit('docx', args, ctx)
  },
  {
    key: 'make_file',
    name: 'Make a file',
    what: 'Lets the AI give you its answer as a file: Word, Excel, text, CSV or code.',
    example: 'Put this table in an Excel file.',
    sees: 'Nothing: it only saves what the AI wrote.',
    risk: 'makes new files',
    definition: {
      name: 'make_file',
      description: 'Saves text as a new file for the person to download. Use it only when the person asks for a file.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'File name ending in .docx, .xlsx, .txt, .md, .csv, .json, .py, .r or .sh' },
          content: { type: 'string', description: 'For .docx: text with simple Markdown (# headings, - lists, **bold**). For .xlsx and .csv: comma-separated rows. Otherwise the plain text.' }
        },
        required: ['name', 'content']
      }
    },
    run: (args, ctx) => fileTools.make(args, ctx)
  },
  ...docs.TOOLS,
  ...slurmTools.TOOLS,
  ...webTools.TOOLS
];

// Shown in the catalogue, but not available.
const UNAVAILABLE = [
];

async function readAttached(args, ctx) {
  const refs = new Map(); // newest file of each name wins
  for (const m of ctx.history) for (const f of m.files || []) refs.set(f.name, f);
  for (const f of ctx.created || []) refs.set(f.name, f);
  const names = [...refs.keys()];
  const wanted = String(args.file || '');
  const name = refs.has(wanted) ? wanted : names.find(n => n.toLowerCase() === wanted.toLowerCase());
  if (!name) throw new Error(names.length ? `there is no such file; attached files: ${names.join(', ')}` : 'no file is attached to this conversation');
  const meta = await storage.getFileMeta(ctx.root, ctx.chatId, refs.get(name).id);
  if (meta.kind === 'image') throw new Error('this file is an image and has no text');
  const text = await fsp.readFile(storage.filePath(ctx.root, ctx.chatId, meta, '.text'), 'utf8');
  if (args.search) {
    const needle = String(args.search).toLowerCase();
    const hay = text.toLowerCase();
    const found = [];
    let total = 0;
    let last = -1000;
    for (let at = hay.indexOf(needle); at >= 0; at = hay.indexOf(needle, at + needle.length)) {
      total += 1;
      if (found.length < 12 && at > last + 400) {
        found.push(`[at ${at}] …${text.slice(Math.max(0, at - 150), at + needle.length + 350)}…`);
        last = at;
      }
    }
    return total ? `${total} places in ${name} (${text.length} characters):\n${found.join('\n\n')}` : `"${args.search}" does not occur in ${name}.`;
  }
  const start = Math.min(Math.max(0, Math.floor(Number(args.start) || 0)), text.length);
  const part = text.slice(start, start + MAX_RESULT_CHARS - 300);
  const end = start + part.length;
  return `${name}, characters ${start} to ${end} of ${text.length}${end < text.length ? ` (continue with start=${end})` : ' (end of file)'}:\n${part}`;
}

// The built-in tools and every tool of the switched-on MCP servers (mcp.js).
async function catalogue(pool) {
  const extra = await mcp.entries(pool).catch(() => []);
  return [...CATALOGUE, ...extra];
}

// Saved state: { key: { enabled, roles: [], audience: 'user'|'staff'|'developer' } }.
// Present = installed.
async function getState(pool) {
  const s = await getSetting(pool, 'tools', {});
  return s && typeof s === 'object' ? s : {};
}

async function audit(pool, userId, key, action) {
  await pool.query('INSERT INTO ai_tool_log (user_id, tool, action) VALUES (?, ?, ?)', [userId, key, action]);
}

async function change(coreApi, key, body, userId) {
  if (!(await catalogue(coreApi.pool)).some(t => t.key === key)) throw new storage.HttpError(404, 'unknown_tool', 'There is no such tool.');
  const state = { ...(await getState(coreApi.pool)) };
  const { action } = body || {};
  if (action === 'install') {
    if (state[key]) throw new storage.HttpError(409, 'installed', 'This tool is already installed.');
    state[key] = { enabled: true, roles: [], audience: 'user' };
  } else {
    if (!state[key]) throw new storage.HttpError(409, 'not_installed', 'This tool is not installed.');
    if (action === 'remove') delete state[key];
    else if (action === 'enable' || action === 'disable') state[key] = { ...state[key], enabled: action === 'enable' };
    else if (action === 'roles') {
      const roles = await coreApi.listRoles();
      state[key] = { ...state[key], roles: [...new Set(Array.isArray(body.roles) ? body.roles : [])].filter(r => roles.includes(r)) };
    } else if (action === 'audience') {
      if (!safety.LEVELS.includes(body.audience)) throw new storage.HttpError(400, 'bad_audience', 'Choose who the tool is for.');
      state[key] = { ...state[key], audience: body.audience };
    } else throw new storage.HttpError(400, 'bad_action', 'Unknown action.');
  }
  await setSetting(coreApi.pool, 'tools', state, userId);
  await audit(coreApi.pool, userId, key, action);
  return state;
}

// The tools this person's question may use, as the model sees them: switched
// on, for one of their roles, and for their audience level (safety.js).
async function forUser(coreApi, user, level = 'user') {
  const state = await getState(coreApi.pool).catch(() => ({}));
  const roles = await coreApi.getUserRoles(user);
  return (await catalogue(coreApi.pool)).filter((t) => {
    const s = state[t.key];
    return s && s.enabled && (!s.roles.length || s.roles.some(r => roles.includes(r))) && safety.allowed(s.audience || 'user', level);
  });
}

async function call(available, name, rawArgs, ctx) {
  const tool = available.find(t => t.definition.name === name);
  if (!tool) return { ok: false, text: `Error: there is no tool "${String(name).slice(0, 60)}".` };
  let args;
  try {
    args = rawArgs ? JSON.parse(rawArgs) : {};
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('not an object');
  } catch (err) {
    return { ok: false, text: 'Error: the arguments are not valid JSON.', label: tool.name };
  }
  try {
    const text = String(await tool.run(args, ctx));
    return { ok: true, text: text.slice(0, MAX_RESULT_CHARS), label: tool.name, args, target: tool.target ? tool.target(args) : null };
  } catch (err) {
    const message = err.syscall ? 'the file could not be read' : err.message;
    return { ok: false, text: `Error: ${String(message).slice(0, 500)}`, label: tool.name, args };
  }
}

const card = ({ key, name, what, example, sees, risk, needs, status, mcp: m }) => ({ key, name, what, example, sees, risk, needs: needs || null, status: status || 'tested', mcp: m || null });

module.exports = { CATALOGUE, UNAVAILABLE, catalogue, getState, change, forUser, call, card };

// Tools that give the person a file back: edited copies of attached Word and
// Excel files, and new files. The original is never changed; every edit is a new
// file in the same chat, in the person's own storage.
const fsp = require('fs').promises;
const path = require('path');
const { randomUUID } = require('crypto');
const { Worker } = require('worker_threads');
const storage = require('./storage');
const files = require('./files');
const { MB } = require('./limits');
const { checkCsv } = require('./officeEdit');

const TIMEOUT_MS = 30000;
const MAX_FILES = 5; // per answer

function inWorker(data) {
  return new Promise((resolve, reject) => {
    const w = new Worker(path.join(__dirname, 'editWorker.js'), { workerData: data, resourceLimits: { maxOldGenerationSizeMb: 768 }, env: {}, stdout: true, stderr: true });
    const timer = setTimeout(() => { w.terminate(); reject(new Error('editing the file took too long')); }, TIMEOUT_MS);
    const end = (fn, v) => { clearTimeout(timer); w.terminate(); fn(v); };
    w.once('message', m => (m.ok ? end(resolve, m) : end(reject, new Error(m.error))));
    w.once('error', () => end(reject, new Error('the file could not be edited')));
    w.once('exit', () => { clearTimeout(timer); reject(new Error('the file could not be edited')); });
  });
}

// Attached and created files of the chat; the newest of each name wins.
function fileRefs(ctx) {
  const refs = new Map();
  for (const m of ctx.history) for (const f of m.files || []) refs.set(f.name, f);
  for (const f of ctx.created) refs.set(f.name, f);
  return refs;
}

async function findFile(ctx, wanted, kind) {
  const refs = fileRefs(ctx);
  const names = [...refs.keys()];
  const name = names.find(n => n === wanted) || names.find(n => n.toLowerCase() === String(wanted || '').toLowerCase());
  if (!name) throw new Error(names.length ? `there is no such file; files: ${names.join(', ')}` : 'no file is attached to this conversation');
  const meta = await storage.getFileMeta(ctx.root, ctx.chatId, refs.get(name).id);
  if (meta.kind !== kind) throw new Error(`"${name}" is not ${kind === 'xlsx' ? 'an Excel (.xlsx)' : 'a Word (.docx)'} file`);
  return meta;
}

// report.docx -> report (version 2).docx -> report (version 3).docx
function nextName(name, taken) {
  const ext = path.extname(name);
  const base = name.slice(0, name.length - ext.length).replace(/ \(version \d+\)$/, '');
  for (let n = 2; ; n++) {
    const candidate = `${base} (version ${n})${ext}`;
    if (!taken.has(candidate)) return candidate;
  }
}

async function store(ctx, name, data) {
  if (ctx.created.length >= MAX_FILES) throw new Error(`at most ${MAX_FILES} files can be made in one answer`);
  if (data.length > ctx.limits.maxFileMB * MB) throw new Error(`the file would be larger than ${ctx.limits.maxFileMB} MB`);
  if (await storage.dirSize(ctx.root) + data.length > ctx.limits.quotaMB * MB) throw new Error('the AI storage of this person is full');
  const tmp = path.join(ctx.root, 'uploads-tmp', randomUUID());
  try {
    await fsp.writeFile(tmp, data, { mode: 0o600 });
    const meta = await files.ingest({ root: ctx.root, chatId: ctx.chatId, tmpPath: tmp, name, limits: ctx.limits });
    const ref = { id: meta.id, name: meta.name, kind: meta.kind, bytes: meta.bytes };
    ctx.created.push(ref);
    return ref;
  } finally {
    await fsp.rm(tmp, { force: true });
  }
}

async function edit(kind, args, ctx) {
  const meta = await findFile(ctx, args.file, kind);
  const r = await inWorker({ op: kind, path: storage.filePath(ctx.root, ctx.chatId, meta), args });
  const ref = await store(ctx, nextName(meta.name, fileRefs(ctx)), Buffer.from(r.data));
  return `Saved as a new file "${ref.name}" (the original is unchanged; the person sees a download button). ${r.summary}`;
}

// A file made by a tool (for example a chart from the sandbox), under a free name.
async function storeData(ctx, name, data) {
  const clean = files.safeName(name);
  const taken = fileRefs(ctx);
  return store(ctx, taken.has(clean) ? nextName(clean, taken) : clean, data);
}

async function make(args, ctx) {
  const name = files.safeName(args.name);
  const ext = path.extname(name).toLowerCase();
  const content = String(args.content === undefined ? '' : args.content);
  if (!content.trim()) throw new Error('the content is empty');
  let data;
  if (ext === '.docx' || ext === '.xlsx') data = Buffer.from((await inWorker({ op: ext === '.docx' ? 'newDocx' : 'newXlsx', args: { content } })).data);
  else if (ext === '.csv' || ext === '.tsv') {
    checkCsv(content);
    data = Buffer.from(content, 'utf8');
  } else if (['.txt', '.md', '.json', '.py', '.r', '.sh', '.xml', '.yaml'].includes(ext)) data = Buffer.from(content, 'utf8');
  else throw new Error('the name must end in .docx, .xlsx, .txt, .md, .csv, .tsv, .json, .py, .r, .sh, .xml or .yaml');
  const taken = fileRefs(ctx);
  const ref = await store(ctx, taken.has(name) ? nextName(name, taken) : name, data);
  return `Created "${ref.name}" (the person sees a download button).`;
}

module.exports = { edit, make, nextName, storeData };

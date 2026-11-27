// Takes in one upload: checks what it really is (by content, not by name),
// keeps the original unchanged, and prepares what the model can read - plain
// text for documents, a reduced copy for images.
const fsp = require('fs').promises;
const path = require('path');
const { isUtf8 } = require('buffer');
const { randomUUID } = require('crypto');
const { Worker } = require('worker_threads');
const storage = require('./storage');
const { MB } = require('./limits');
const { HttpError } = storage;

const IMAGE_EDGE = 1540;
const IMAGE_MAX_PIXELS = 100e6;
const TEXT_MAX_CHARS = 2000000;
const EXTRACT_TIMEOUT_MS = 60000;
const MAX_EXTRACTORS = 2;

const MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
};

const REFUSED = 'This type of file cannot be read. Supported: PDF, Word (.docx), Excel (.xlsx), PowerPoint (.pptx), PNG, JPEG and WebP images, MTZ reflection files, and text files (code, CSV, JSON, mmCIF, PDB, ...).';

function imageExt(b) {
  if (b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10]))) return '.png';
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return '.jpg';
  if (b.length > 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return '.webp';
  return null;
}

function decodeText(b) {
  if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) return b.subarray(2).toString('utf16le');
  if (b.includes(0)) return null;
  if (isUtf8(b)) return b.toString('utf8').replace(/^﻿/, '');
  // old Windows/Latin-1 text: accept it if it has no control characters
  for (const c of b) if (c < 32 && c !== 9 && c !== 10 && c !== 13 && c !== 12 && c !== 27) return null;
  return b.toString('latin1');
}

let extracting = 0;
const extractQueue = [];
async function slot() {
  if (extracting >= MAX_EXTRACTORS) await new Promise(resolve => extractQueue.push(resolve));
  else extracting += 1;
}
function freeSlot() {
  const next = extractQueue.shift();
  if (next) next();
  else extracting -= 1;
}

async function extract(file, kind) {
  await slot();
  try {
    return await new Promise((resolve, reject) => {
      const worker = new Worker(path.join(__dirname, 'extractWorker.js'), {
        workerData: { path: file, kind, maxChars: TEXT_MAX_CHARS },
        resourceLimits: { maxOldGenerationSizeMb: 768 },
        env: {}, stdout: true, stderr: true
      });
      const timer = setTimeout(() => {
        worker.terminate();
        reject(new Error('reading the file took too long'));
      }, EXTRACT_TIMEOUT_MS);
      const end = (fn, v) => { clearTimeout(timer); worker.terminate(); fn(v); };
      worker.once('message', m => (m.ok ? end(resolve, m) : end(reject, new Error(m.error))));
      worker.once('error', () => end(reject, new Error('the file could not be read')));
      worker.once('exit', () => { clearTimeout(timer); reject(new Error('the file could not be read')); });
    });
  } finally {
    freeSlot();
  }
}

async function reduceImage(src, dest) {
  const sharp = require('sharp'); // loaded on first use: no image support must not stop the module
  const info = await sharp(src, { limitInputPixels: IMAGE_MAX_PIXELS, failOn: 'error' })
    .rotate()
    .resize({ width: IMAGE_EDGE, height: IMAGE_EDGE, fit: 'inside', withoutEnlargement: true })
    .flatten({ background: '#ffffff' })
    .jpeg({ quality: 90 })
    .toFile(dest);
  await fsp.chmod(dest, 0o600);
  return { width: info.width, height: info.height };
}

function safeName(name) {
  const base = String(name || 'file').split(/[\\/]/).pop().replace(/\p{Cc}/gu, '').trim();
  return (base || 'file').slice(-200);
}

// tmpPath: where multer put the upload. Returns the stored file's meta.
async function ingest({ root, chatId, tmpPath, name, limits }) {
  const buf = await fsp.readFile(tmpPath);
  const fileName = safeName(name);
  const nameExt = path.extname(fileName).toLowerCase();
  if (!buf.length) throw new HttpError(400, 'empty_file', 'This file is empty.');

  let kind;
  let ext;
  let text = null;
  const img = imageExt(buf);
  if (img) {
    kind = 'image';
    ext = img;
    if (buf.length > limits.maxImageMB * MB) throw new HttpError(413, 'too_large', `Images can be at most ${limits.maxImageMB} MB.`);
  } else if (buf.toString('latin1', 0, 4) === 'MTZ ') {
    kind = 'mtz';
    ext = '.mtz';
  } else if (buf.toString('latin1', 0, 1024).includes('%PDF-')) {
    kind = 'pdf';
    ext = '.pdf';
  } else if (buf.length > 4 && buf.readUInt32LE(0) === 0x04034b50) {
    if (!['.docx', '.xlsx', '.pptx'].includes(nameExt)) throw new HttpError(415, 'unsupported', REFUSED);
    kind = nameExt.slice(1);
    ext = nameExt;
  } else {
    text = decodeText(buf);
    if (text === null) throw new HttpError(415, 'unsupported', REFUSED);
    kind = 'text';
    ext = /^\.[a-z0-9]{1,8}$/.test(nameExt) && !['.json', '.txt'].includes(nameExt) ? nameExt : '.original';
  }

  // "<id>.json" is the meta and "<id>.text" the extracted text, so an upload
  // never uses those names itself.
  const meta = { id: randomUUID(), name: fileName, kind, ext, bytes: buf.length, at: new Date().toISOString() };
  if (ext === '.text') meta.ext = '.original';
  const original = storage.filePath(root, chatId, meta);
  const created = [original];
  try {
    await fsp.copyFile(tmpPath, original);
    await fsp.chmod(original, 0o600);
    if (kind === 'image') {
      const reduced = storage.filePath(root, chatId, meta, '.model.jpg');
      created.push(reduced);
      Object.assign(meta, await reduceImage(original, reduced));
    } else {
      let truncated = false;
      if (kind === 'mtz') {
        // A binary reflection file: the model gets gemmi's summary (sandbox).
        try {
          text = await require('./sandboxTools').mtzSummary(original, fileName);
        } catch (err) {
          text = `MTZ reflection file ${fileName} (${buf.length} bytes). No summary: ${err.message}.`;
        }
      } else if (text === null) {
        const r = await extract(original, kind);
        text = r.text;
        truncated = r.truncated;
      } else if (text.length > TEXT_MAX_CHARS) {
        text = text.slice(0, TEXT_MAX_CHARS);
        truncated = true;
      }
      const plain = text.replace(/\[(Page|Slide) \d+\]/g, '').trim();
      if (!plain) {
        throw new HttpError(422, 'no_text', kind === 'pdf'
          ? 'No text was found in this PDF. It may be a scan: upload the pages as images instead.'
          : 'No text was found in this file.');
      }
      const textFile = storage.filePath(root, chatId, meta, '.text');
      created.push(textFile);
      await fsp.writeFile(textFile, text, { mode: 0o600 });
      meta.chars = text.length;
      meta.truncated = truncated;
    }
    await storage.saveFileMeta(root, chatId, meta);
    return meta;
  } catch (err) {
    await Promise.all(created.map(f => fsp.rm(f, { force: true })));
    if (err instanceof HttpError) throw err;
    // file-system errors carry server paths: never pass those on
    if (err.code === 'ENOSPC' || err.syscall) throw new HttpError(500, 'storage_error', 'The file could not be saved.');
    throw new HttpError(422, 'unreadable', `This file could not be read (${err.message}).`);
  }
}

module.exports = { ingest, MIME, safeName };

// OCR, in the code sandbox (sandbox.js): ocrmypdf (Tesseract) for scanned
// PDFs, Tesseract for images (photos or scans of documents). Chosen because it
// runs on the CPU of the backend host, handles many pages, and its text is
// kept with the file: it is there for every later question and for models
// that cannot see images. Photos are also read by the vision of the loaded
// model when it has one (Qwen, Mistral), which copes better with handwriting
// and layout. Installed by tools/nusbf/ocr-install.sh (Debian packages).
const fs = require('fs');
const sandbox = require('./sandbox');

const MAX_PAGES = 30;
const PDF_TIMEOUT_S = 120;
const IMAGE_TIMEOUT_S = 60;

const available = () => sandbox.available().ok && fs.existsSync('/usr/bin/ocrmypdf') && fs.existsSync('/usr/bin/tesseract');

function textOf(r) {
  const out = r.outputs.find(o => o.name === 'text.txt');
  return out ? out.data.toString('utf8').replace(/\f/g, '\n').replace(/\n{3,}/g, '\n\n').trim() : '';
}

// -> text ('' when nothing was found); throws when OCR is not possible.
async function pdf(src, name) {
  if (!available()) throw new Error('OCR is not installed on this server');
  const file = sandbox.safeName(name);
  const r = await sandbox.run({
    argv: ['/usr/bin/ocrmypdf', '--skip-text', '-l', 'eng', '--jobs', '4', '--pages', `1-${MAX_PAGES}`, '--sidecar', '/work/out/text.txt',
      '--output-type', 'none', `/work/in/${file}`, '-'],
    inputs: [{ name, src }], timeoutS: PDF_TIMEOUT_S, cpuQuota: '400%', memory: '4G'
  });
  if (r.timedOut) throw new Error('OCR took too long');
  return textOf(r);
}

async function image(src, name) {
  if (!available()) throw new Error('OCR is not installed on this server');
  const file = sandbox.safeName(name);
  const r = await sandbox.run({
    argv: ['/usr/bin/tesseract', `/work/in/${file}`, '/work/out/text', '-l', 'eng'],
    inputs: [{ name, src }], timeoutS: IMAGE_TIMEOUT_S, cpuQuota: '200%', memory: '2G'
  });
  return textOf(r);
}

// Enough real text to be worth keeping (not noise from a photo of a crystal).
const meaningful = t => (t.match(/[A-Za-z]{3,}/g) || []).length >= 5;

module.exports = { pdf, image, available, meaningful, MAX_PAGES };

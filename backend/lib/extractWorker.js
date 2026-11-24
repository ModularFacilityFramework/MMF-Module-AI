// Runs in a worker thread (see files.js): turns one uploaded document into
// plain text. Isolated so that a slow or malicious file can be stopped without
// affecting the MFF backend.
const fs = require('fs');
const { parentPort, workerData } = require('worker_threads');
const { docxText, pptxText, xlsxText } = require('./officeText');

async function pdfText(buf) {
  const { extractText, getDocumentProxy } = await import('unpdf');
  const pdf = await getDocumentProxy(new Uint8Array(buf));
  const { text } = await extractText(pdf, { mergePages: false });
  return text.map((t, i) => `[Page ${i + 1}]\n${t}`).join('\n\n');
}

(async () => {
  const buf = fs.readFileSync(workerData.path);
  let text;
  if (workerData.kind === 'pdf') text = await pdfText(buf);
  else if (workerData.kind === 'docx') text = docxText(buf);
  else if (workerData.kind === 'pptx') text = pptxText(buf);
  else if (workerData.kind === 'xlsx') text = xlsxText(buf);
  else throw new Error('unknown file kind');
  const full = text.length;
  parentPort.postMessage({ ok: true, text: text.slice(0, workerData.maxChars), truncated: full > workerData.maxChars });
})().catch(err => parentPort.postMessage({ ok: false, error: String((err && err.message) || err).slice(0, 200) }));

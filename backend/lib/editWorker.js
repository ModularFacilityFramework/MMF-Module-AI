// Runs in a worker thread (see fileTools.js): makes or edits one Office file.
const fs = require('fs');
const { parentPort, workerData: d } = require('worker_threads');
const office = require('./officeEdit');

try {
  let out;
  if (d.op === 'xlsx') out = office.editXlsx(fs.readFileSync(d.path), d.args);
  else if (d.op === 'docx') out = office.editDocx(fs.readFileSync(d.path), d.args);
  else if (d.op === 'newDocx') out = { data: office.makeDocx(d.args.content), summary: '' };
  else if (d.op === 'newXlsx') out = { data: office.makeXlsx(d.args.content), summary: '' };
  else throw new Error('unknown operation');
  parentPort.postMessage({ ok: true, data: out.data, summary: out.summary });
} catch (err) {
  // file-system errors carry server paths: never pass those on
  parentPort.postMessage({ ok: false, error: err.syscall ? 'the file could not be read' : String(err.message).slice(0, 400) });
}

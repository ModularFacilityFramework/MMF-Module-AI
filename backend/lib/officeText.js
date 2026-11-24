// Plain text out of .docx, .xlsx and .pptx files (zip files of XML). Only the
// parts that hold text are unpacked, and nothing in the file is executed. Runs
// inside extractWorker.js.
const { openZip } = require('./zip');

const NAMED = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
function decode(s) {
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-z]+);/g, (whole, e) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '';
    }
    return NAMED[e] || whole;
  });
}

// prefix: 'w' (Word) or 'a' (PowerPoint)
function paragraphs(xml, prefix) {
  const re = new RegExp(
    `<${prefix}:t(?: [^>]*)?>([^<]*)</${prefix}:t>|<${prefix}:(tab|br|cr)(?: [^>]*)?/>|</${prefix}:(p|tc|tr)>`, 'g');
  let out = '';
  let m;
  while ((m = re.exec(xml))) {
    if (m[1] !== undefined) out += decode(m[1]);
    else if (m[2]) out += m[2] === 'tab' ? '\t' : '\n';
    else if (m[3] === 'p') out += '\n';
    else if (m[3] === 'tc') out = `${out.replace(/\n$/, '')}\t`;
    else if (m[3] === 'tr') out = `${out.replace(/\t$/, '')}\n`;
  }
  return out.replace(/\n{3,}/g, '\n\n').trim();
}

function docxText(buf) {
  const zip = openZip(buf);
  const main = zip.read('word/document.xml');
  if (main === null) throw new Error('this does not look like a Word document');
  const parts = [paragraphs(main, 'w')];
  for (const name of ['word/footnotes.xml', 'word/endnotes.xml']) {
    const xml = zip.read(name);
    const t = xml && paragraphs(xml, 'w');
    if (t) parts.push(`[${name.includes('foot') ? 'Footnotes' : 'Endnotes'}]\n${t}`);
  }
  return parts.join('\n\n');
}

function pptxText(buf) {
  const zip = openZip(buf);
  const num = n => Number(n.match(/(\d+)\.xml$/)[1]);
  const slides = zip.names.filter(n => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort((a, b) => num(a) - num(b));
  if (!slides.length) throw new Error('this does not look like a PowerPoint file');
  return slides.map(n => `[Slide ${num(n)}]\n${paragraphs(zip.read(n), 'a')}`).join('\n\n');
}

function columnIndex(ref) {
  let n = 0;
  for (const c of ref) {
    if (c < 'A' || c > 'Z') break;
    n = n * 26 + (c.charCodeAt(0) - 64);
  }
  return n - 1;
}

const attr = (tag, name) => {
  const m = tag.match(new RegExp(`(?:^|\\s)${name}="([^"]*)"`));
  return m ? decode(m[1]) : null;
};
const innerText = xml => [...xml.matchAll(/<t(?: [^>]*)?>([^<]*)<\/t>/g)].map(m => decode(m[1])).join('');

// Each sheet as tab-separated rows, with the row number. Formulas show their
// last calculated value; dates show as Excel's day numbers.
function xlsxText(buf) {
  const zip = openZip(buf);
  const workbook = zip.read('xl/workbook.xml');
  if (workbook === null) throw new Error('this does not look like an Excel file');
  const rels = {};
  for (const m of (zip.read('xl/_rels/workbook.xml.rels') || '').matchAll(/<Relationship\b([^>]*)>/g)) {
    rels[attr(m[1], 'Id')] = (attr(m[1], 'Target') || '').replace(/^\/?(xl\/)?/, 'xl/');
  }
  const shared = [...(zip.read('xl/sharedStrings.xml') || '').matchAll(/<si(?: [^>]*)?>([\s\S]*?)<\/si>/g)].map(m => innerText(m[1]));
  const out = [];
  for (const s of workbook.matchAll(/<sheet\b([^>]*)>/g)) {
    const xml = zip.read(rels[attr(s[1], 'r:id')] || '');
    if (!xml) continue;
    const rows = [];
    for (const r of xml.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
      const cells = [];
      for (const c of (r[2] || '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const body = c[2] || '';
        const type = attr(c[1], 't');
        const v = (body.match(/<v(?: [^>]*)?>([^<]*)<\/v>/) || [])[1];
        let value = '';
        if (type === 's') value = shared[Number(v)] || '';
        else if (type === 'inlineStr') value = innerText(body);
        else if (type === 'b') value = v === '1' ? 'TRUE' : 'FALSE';
        else if (v !== undefined) value = decode(v);
        const at = columnIndex(attr(c[1], 'r') || '');
        const col = at >= 0 && at < 16384 ? at : cells.length;
        while (cells.length < col) cells.push('');
        cells[col] = value.replace(/[\t\n\r]+/g, ' ');
      }
      if (cells.some(x => x !== '')) rows.push(`${attr(r[1], 'r') || rows.length + 1}\t${cells.join('\t')}`);
    }
    out.push(`[Sheet "${attr(s[1], 'name')}", columns: row number, then A, B, C, ...]\n${rows.join('\n')}`);
  }
  return out.join('\n\n');
}

module.exports = { docxText, pptxText, xlsxText, decode, attr };

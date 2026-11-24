// Plain text out of .docx, .xlsx and .pptx files. These are zip files of XML;
// only the few entries that hold text are unpacked, each with a hard size cap,
// so a crafted ("zip bomb") file cannot fill the server's memory. Nothing in
// the file is executed. Runs inside extractWorker.js.
const zlib = require('zlib');

const ENTRY_MAX = 64 * 1024 * 1024;
const TOTAL_MAX = 160 * 1024 * 1024;

function openZip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a valid Office file');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) break;
    const nameLen = buf.readUInt16LE(p + 28);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    entries.set(name, { method: buf.readUInt16LE(p + 10), size: buf.readUInt32LE(p + 20), offset: buf.readUInt32LE(p + 42) });
    p += 46 + nameLen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
  }
  let total = 0;
  return {
    names: [...entries.keys()],
    read(name) {
      const e = entries.get(name);
      if (!e) return null;
      if (e.offset + 30 > buf.length || buf.readUInt32LE(e.offset) !== 0x04034b50) throw new Error('not a valid Office file');
      const start = e.offset + 30 + buf.readUInt16LE(e.offset + 26) + buf.readUInt16LE(e.offset + 28);
      const raw = buf.subarray(start, start + e.size);
      let data;
      if (e.method === 0) data = raw;
      else if (e.method === 8) {
        try {
          data = zlib.inflateRawSync(raw, { maxOutputLength: ENTRY_MAX });
        } catch (err) {
          throw new Error(err.code === 'ERR_BUFFER_TOO_LARGE' ? 'it is too large once unpacked' : 'not a valid Office file');
        }
      }
      else throw new Error('unsupported compression in this Office file');
      total += data.length;
      if (total > TOTAL_MAX) throw new Error('it is too large once unpacked');
      return data.toString('utf8');
    }
  };
}

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

module.exports = { docxText, pptxText, xlsxText };

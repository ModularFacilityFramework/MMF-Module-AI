// Changes to .xlsx and .docx files, made directly in the file's own XML so that
// formatting, pictures and everything else stay as they were; and simple new
// .docx and .xlsx files. Runs inside editWorker.js.
const { openZip, writeZip, pack, rewrite } = require('./zip');
const { decode, attr } = require('./officeText');

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const MAX_CHANGES = 500;

// Characters XML does not allow are dropped.
const clean = s => String(s === null || s === undefined ? '' : s).replace(/\p{Cc}/gu, c => ('\t\n\r'.includes(c) ? c : '')).replace(/[￾￿]/g, '').replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, '');
const esc = s => clean(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// --- Excel ---------------------------------------------------------------------

function columnNumber(letters) {
  let n = 0;
  for (const c of letters) n = n * 26 + (c.charCodeAt(0) - 64);
  return n;
}
const columnName = (n) => {
  let s = '';
  for (let x = n; x > 0; x = Math.floor((x - 1) / 26)) s = String.fromCharCode(65 + ((x - 1) % 26)) + s;
  return s;
};

// Formulas that reach outside the workbook could send its data away when the
// file is opened (a document can try to talk the AI into writing one).
const OUTSIDE = /\b(WEBSERVICE|HYPERLINK|IMAGE|RTD|CALL|REGISTER(\.ID)?|EXEC|FILTERXML|STOCKHISTORY|IMPORT\w+|CUBE\w+)\s*\(|[|[\]]|:\/\/|\\\\/i;
function checkFormula(f) {
  if (OUTSIDE.test(f)) throw new Error('formulas that reach outside the file (links, web, other workbooks) are not allowed');
  if (f.length > 4000) throw new Error('the formula is too long');
}

function cellXml(ref, style, c) {
  const s = style ? ` s="${esc(style)}"` : '';
  if (typeof c.formula === 'string' && c.formula.trim()) checkFormula(c.formula);
  if (typeof c.formula === 'string' && c.formula.trim()) return `<c r="${ref}"${s}><f>${esc(c.formula.trim().replace(/^=/, ''))}</f></c>`;
  const v = c.value;
  if (v === null || v === undefined || v === '') return `<c r="${ref}"${s}/>`;
  if (typeof v === 'boolean') return `<c r="${ref}"${s} t="b"><v>${v ? 1 : 0}</v></c>`;
  if (typeof v === 'number' && Number.isFinite(v)) return `<c r="${ref}"${s}><v>${v}</v></c>`;
  if (typeof v === 'string' && v.startsWith('=') && v.length > 1) return cellXml(ref, style, { formula: v });
  return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${esc(String(v).slice(0, 32000))}</t></is></c>`;
}

function setCell(xml, ref, change) {
  const [, letters, digits] = /^([A-Z]{1,3})([1-9]\d{0,6})$/.exec(ref) || [];
  if (!letters || columnNumber(letters) > 16384 || Number(digits) > 1048576) throw new Error(`"${ref}" is not a cell`);
  const row = Number(digits);
  const col = columnNumber(letters);
  const data = /<sheetData(?:\s[^>]*)?(?:\/>|>([\s\S]*?)<\/sheetData>)/.exec(xml);
  if (!data) throw new Error('this sheet has no cells');
  const body = data[1] || '';
  const rowRe = /<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g;
  let m;
  let out = null;
  while ((m = rowRe.exec(body))) {
    const r = Number(attr(m[1], 'r'));
    if (!r) throw new Error('this sheet is stored in a way that cannot be edited here');
    if (r > row) {
      out = `${body.slice(0, m.index)}<row r="${row}">${cellXml(ref, null, change)}</row>${body.slice(m.index)}`;
      break;
    }
    if (r === row) {
      const cells = m[2] || '';
      const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
      let c;
      let next = null;
      while ((c = cellRe.exec(cells))) {
        const cref = attr(c[1], 'r') || '';
        const ccol = columnNumber((/^[A-Z]+/.exec(cref) || [''])[0]);
        if (!ccol) throw new Error('this sheet is stored in a way that cannot be edited here');
        if (cref === ref) {
          if (/<f\b[^>]*\bt="(shared|array|dataTable)"/.test(c[2] || '')) throw new Error(`cell ${ref} is part of a shared or array formula and cannot be changed here`);
          next = cells.slice(0, c.index) + cellXml(ref, attr(c[1], 's'), change) + cells.slice(c.index + c[0].length);
          break;
        }
        if (ccol > col) {
          next = cells.slice(0, c.index) + cellXml(ref, null, change) + cells.slice(c.index);
          break;
        }
      }
      if (next === null) next = cells + cellXml(ref, null, change);
      // "spans" is only a hint for the reader, and would now be wrong
      const attrs = m[1].replace(/\sspans="[^"]*"/, '').replace(/\s+$/, '');
      out = `${body.slice(0, m.index)}<row${attrs}>${next}</row>${body.slice(m.index + m[0].length)}`;
      break;
    }
  }
  if (out === null) out = `${body}<row r="${row}">${cellXml(ref, null, change)}</row>`;
  return `${xml.slice(0, data.index)}<sheetData>${out}</sheetData>${xml.slice(data.index + data[0].length)}`;
}

function sheetList(zip) {
  const workbook = zip.read('xl/workbook.xml');
  if (workbook === null) throw new Error('this does not look like an Excel file');
  const rels = {};
  for (const m of (zip.read('xl/_rels/workbook.xml.rels') || '').matchAll(/<Relationship\b([^>]*)>/g)) {
    rels[attr(m[1], 'Id')] = (attr(m[1], 'Target') || '').replace(/^\/?(xl\/)?/, 'xl/');
  }
  return [...workbook.matchAll(/<sheet\b([^>]*)>/g)].map(m => ({ name: attr(m[1], 'name'), path: rels[attr(m[1], 'r:id')] }));
}

// Header cells of an Excel table are also stored in the table's own part.
function tableHeaders(zip, sheetPath) {
  const relPath = sheetPath.replace(/([^/]+)$/, '_rels/$1.rels');
  const out = [];
  for (const m of (zip.read(relPath) || '').matchAll(/<Relationship\b([^>]*)>/g)) {
    const target = attr(m[1], 'Target') || '';
    const t = /tables\/[^/]+\.xml$/.exec(target);
    const xml = t && zip.read(`xl/${t[0]}`);
    const ref = xml && /^([A-Z]+)(\d+):([A-Z]+)\d+$/.exec(attr((/<table\b([^>]*)>/.exec(xml) || ['', ''])[1], 'ref') || '');
    if (ref) out.push({ row: Number(ref[2]), from: columnNumber(ref[1]), to: columnNumber(ref[3]) });
  }
  return out;
}

// args: { sheet?, cells: [{ cell, value | formula }] }
function editXlsx(buf, args) {
  const zip = openZip(buf);
  const sheets = sheetList(zip);
  const wanted = args.sheet ? String(args.sheet) : null;
  const sheet = wanted ? sheets.find(s => s.name === wanted) || sheets.find(s => s.name.toLowerCase() === wanted.toLowerCase()) : sheets[0];
  if (!sheet || !zip.entries.has(sheet.path)) throw new Error(`there is no such sheet; sheets: ${sheets.map(s => s.name).join(', ')}`);
  const cells = Array.isArray(args.cells) ? args.cells : [];
  if (!cells.length) throw new Error('no cells to change were given');
  if (cells.length > MAX_CHANGES) throw new Error(`at most ${MAX_CHANGES} cells can be changed at once`);
  const headers = tableHeaders(zip, sheet.path);
  let xml = zip.read(sheet.path);
  for (const c of cells) {
    const ref = String(c.cell || '').toUpperCase().replace(/\$/g, '');
    const m = /^([A-Z]+)(\d+)$/.exec(ref);
    if (m && headers.some(h => h.row === Number(m[2]) && columnNumber(m[1]) >= h.from && columnNumber(m[1]) <= h.to)) {
      throw new Error(`cell ${ref} is the header of an Excel table and cannot be changed here`);
    }
    xml = setCell(xml, ref, c);
  }
  xml = xml.replace(/<dimension\b[^>]*\/>/, ''); // only a hint, and now perhaps wrong
  const changes = new Map([[sheet.path, xml]]);
  // Excel works every formula out again when it opens the file.
  let wb = zip.read('xl/workbook.xml');
  if (/<calcPr\b/.test(wb)) {
    wb = wb.replace(/<calcPr\b([^>]*?)\/?>/, (m, a) => `<calcPr${a.replace(/\sfullCalcOnLoad="[^"]*"/, '')} fullCalcOnLoad="1"${m.endsWith('/>') ? '/>' : '>'}`);
  } else {
    const after = ['</definedNames>', '</externalReferences>', '</functionGroups>', '</sheets>'].find(t => wb.includes(t));
    if (after) wb = wb.replace(after, `${after}<calcPr fullCalcOnLoad="1"/>`);
  }
  changes.set('xl/workbook.xml', wb);
  if (zip.entries.has('xl/calcChain.xml')) {
    changes.set('xl/calcChain.xml', null);
    changes.set('[Content_Types].xml', zip.read('[Content_Types].xml').replace(/<Override\b[^>]*calcChain[^>]*\/>/, ''));
    changes.set('xl/_rels/workbook.xml.rels', zip.read('xl/_rels/workbook.xml.rels').replace(/<Relationship\b[^>]*calcChain[^>]*\/>/, ''));
  }
  return { data: rewrite(zip, changes), summary: `${cells.length} cell${cells.length === 1 ? '' : 's'} changed on sheet "${sheet.name}". Formulas are recalculated when the file is opened in Excel.` };
}

// --- Word ------------------------------------------------------------------------

const PARA = /<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g;
const TEXT = /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g;
const tText = s => `<w:t xml:space="preserve">${esc(s).replace(/\r?\n/g, '</w:t><w:br/><w:t xml:space="preserve">')}</w:t>`;

// Same length in and out: special spaces, quotes and dashes are treated as the
// plain ones, because the model usually writes those.
const plain = s => s.replace(/[\u00a0\u2007\u2009\u202f]/g, ' ').replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"').replace(/[\u2010-\u2014]/g, '-');

// Replaces text inside one paragraph; it may run across differently formatted
// pieces. The new text takes the formatting of the first piece.
function replaceInParagraph(para, find, replace) {
  const nodes = [...para.matchAll(TEXT)].map(m => ({ at: m.index, len: m[0].length, text: decode(m[1]) }));
  const wanted = plain(find);
  let joined = plain(nodes.map(n => n.text).join(''));
  let count = 0;
  let from = 0;
  for (let hit = joined.indexOf(wanted, from); hit >= 0; hit = joined.indexOf(wanted, from)) {
    let pos = 0;
    let first = true;
    for (const n of nodes) {
      const a = Math.max(hit, pos);
      const b = Math.min(hit + find.length, pos + n.text.length);
      const start = pos;
      pos += n.text.length;
      if (a < b) {
        n.text = n.text.slice(0, a - start) + (first ? replace : '') + n.text.slice(b - start);
        n.changed = true;
        first = false;
      }
    }
    joined = plain(nodes.map(n => n.text).join(''));
    from = hit + replace.length;
    count += 1;
    if (count > MAX_CHANGES) break;
  }
  if (!count) return { para, count: 0 };
  let out = para;
  for (const n of nodes.reverse()) if (n.changed) out = out.slice(0, n.at) + tText(n.text) + out.slice(n.at + n.len);
  return { para: out, count };
}

const paraText = p => [...p.matchAll(TEXT)].map(m => decode(m[1])).join('');
const newPara = (text, pPr = '') => `<w:p>${pPr}<w:r>${tText(text)}</w:r></w:p>`;

// args: { changes: [{ find, replace } | { insert_after, text } | { append }] }
function editDocx(buf, args) {
  const zip = openZip(buf);
  if (!zip.entries.has('word/document.xml')) throw new Error('this does not look like a Word document');
  const list = Array.isArray(args.changes) ? args.changes : [];
  if (!list.length) throw new Error('no changes were given');
  if (list.length > MAX_CHANGES) throw new Error(`at most ${MAX_CHANGES} changes can be made at once`);
  const parts = new Map();
  for (const name of zip.names) if (/^word\/(document|header\d*|footer\d*|footnotes|endnotes)\.xml$/.test(name)) parts.set(name, zip.read(name));
  const done = [];
  for (const c of list) {
    if (typeof c.find === 'string' && c.find) {
      const hits = { n: 0 };
      for (const [name, xml] of parts) {
        parts.set(name, xml.replace(PARA, (p) => {
          const r = replaceInParagraph(p, c.find, String(c.replace === undefined ? '' : c.replace));
          hits.n += r.count;
          return r.para;
        }));
      }
      if (!hits.n) throw new Error(`the text "${c.find.slice(0, 80)}" was not found inside one paragraph of the document; nothing was changed`);
      done.push(`replaced "${c.find.slice(0, 40)}" ${hits.n} time${hits.n === 1 ? '' : 's'}`);
    } else if (typeof c.insert_after === 'string' && c.insert_after) {
      const xml = parts.get('word/document.xml');
      let inserted = false;
      const next = xml.replace(PARA, (p) => {
        if (inserted || !plain(paraText(p)).includes(plain(c.insert_after)) || (p.match(/<w:p(?:\s|>)/g) || []).length > 1) return p;
        inserted = true;
        const pPr = (/<w:pPr>[\s\S]*?<\/w:pPr>/.exec(p) || [''])[0].replace(/<w:sectPr[\s\S]*?<\/w:sectPr>/, '');
        return p + newPara(c.text, pPr);
      });
      if (!inserted) throw new Error(`no paragraph containing "${c.insert_after.slice(0, 80)}" was found; nothing was changed`);
      parts.set('word/document.xml', next);
      done.push('inserted a paragraph');
    } else if (typeof c.append === 'string' && c.append) {
      const xml = parts.get('word/document.xml');
      const end = xml.lastIndexOf('</w:body>');
      const sect = xml.lastIndexOf('<w:sectPr');
      const lastPara = xml.lastIndexOf('</w:p>');
      const at = sect > lastPara ? sect : end;
      if (at < 0) throw new Error('this does not look like a Word document');
      parts.set('word/document.xml', xml.slice(0, at) + c.append.split(/\n{2,}/).map(t => newPara(t)).join('') + xml.slice(at));
      done.push('added text at the end');
    } else {
      throw new Error('each change needs find and replace, or insert_after and text, or append');
    }
  }
  const changes = new Map([...parts].filter(([name, xml]) => xml !== zip.read(name)));
  return { data: rewrite(zip, changes), summary: `${done.join('; ')}.` };
}

// --- new files --------------------------------------------------------------------

const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PKG = 'http://schemas.openxmlformats.org/package/2006';

// Plain text with simple Markdown: # headings, - lists, **bold**.
function makeDocx(content) {
  const runs = text => text.split(/(\*\*[^*]+\*\*)/).filter(Boolean)
    .map(t => (/^\*\*[^*]+\*\*$/.test(t) ? `<w:r><w:rPr><w:b/></w:rPr>${tText(t.slice(2, -2))}</w:r>` : `<w:r>${tText(t)}</w:r>`)).join('');
  const paras = clean(content).split(/\r?\n/).map((line) => {
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    if (h) return `<w:p><w:pPr><w:pStyle w:val="Heading${h[1].length}"/></w:pPr>${runs(h[2])}</w:p>`;
    const li = /^\s*[-*]\s+(.*)$/.exec(line);
    if (li) return `<w:p><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr><w:r>${tText('•  ')}</w:r>${runs(li[1])}</w:p>`;
    return `<w:p>${runs(line)}</w:p>`;
  }).join('');
  const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  const heading = (n, size) => `<w:style w:type="paragraph" w:styleId="Heading${n}"><w:name w:val="heading ${n}"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="240" w:after="80"/></w:pPr><w:rPr><w:b/><w:sz w:val="${size}"/></w:rPr></w:style>`;
  return writeZip([
    pack('[Content_Types].xml', `${XML_HEAD}<Types xmlns="${PKG}/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`),
    pack('_rels/.rels', `${XML_HEAD}<Relationships xmlns="${PKG}/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="word/document.xml"/></Relationships>`),
    pack('word/_rels/document.xml.rels', `${XML_HEAD}<Relationships xmlns="${PKG}/relationships"><Relationship Id="rId1" Type="${REL}/styles" Target="styles.xml"/></Relationships>`),
    pack('word/styles.xml', `${XML_HEAD}<w:styles xmlns:w="${W}"><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:pPr><w:spacing w:after="120"/></w:pPr><w:rPr><w:sz w:val="22"/></w:rPr></w:style>${heading(1, 34)}${heading(2, 28)}${heading(3, 24)}</w:styles>`),
    pack('word/document.xml', `${XML_HEAD}<w:document xmlns:w="${W}"><w:body>${paras}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>`)
  ]);
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i += 1; } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && cell === '') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; } else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; } else if (ch !== '\r') cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

// Comma-separated text -> one sheet. Numbers become numbers, "=..." formulas.
function makeXlsx(content) {
  const rows = parseCsv(clean(content));
  if (!rows.length) throw new Error('there are no rows');
  const xml = rows.map((r, i) => `<row r="${i + 1}">${r.map((v, j) => {
    const value = /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(v.trim()) && v.trim().length < 16 && !/^-?0\d/.test(v.trim()) ? Number(v) : v;
    return value === '' ? '' : cellXml(`${columnName(j + 1)}${i + 1}`, null, { value });
  }).join('')}</row>`).join('');
  const S = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
  return writeZip([
    pack('[Content_Types].xml', `${XML_HEAD}<Types xmlns="${PKG}/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`),
    pack('_rels/.rels', `${XML_HEAD}<Relationships xmlns="${PKG}/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`),
    pack('xl/_rels/workbook.xml.rels', `${XML_HEAD}<Relationships xmlns="${PKG}/relationships"><Relationship Id="rId1" Type="${REL}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`),
    pack('xl/workbook.xml', `${XML_HEAD}<workbook xmlns="${S}" xmlns:r="${REL}"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets><calcPr fullCalcOnLoad="1"/></workbook>`),
    pack('xl/worksheets/sheet1.xml', `${XML_HEAD}<worksheet xmlns="${S}"><sheetData>${xml}</sheetData></worksheet>`)
  ]);
}

// Spreadsheets also run formulas in plain .csv and .tsv files.
function checkCsv(content) {
  for (const cell of content.split(/[,;\t\r\n]/)) {
    if (/^["'\s]*[=+\-@]/.test(cell) && /[A-Za-z|]/.test(cell)) checkFormula(cell);
  }
}

module.exports = { editXlsx, editDocx, makeDocx, makeXlsx, checkCsv };

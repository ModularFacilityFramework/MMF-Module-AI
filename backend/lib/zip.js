// Reading and rewriting the zip container of Office files. Unchanged parts are
// copied byte for byte, so an edit touches nothing but what it changes.
const zlib = require('zlib');

const ENTRY_MAX = 64 * 1024 * 1024;
const TOTAL_MAX = 160 * 1024 * 1024;

const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? (0xedb88320 ^ (c >>> 1)) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// Each unpacked part has a hard size cap, so a crafted file ("zip bomb")
// cannot fill the memory.
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
    entries.set(name, {
      method: buf.readUInt16LE(p + 10), crc: buf.readUInt32LE(p + 16), size: buf.readUInt32LE(p + 20),
      full: buf.readUInt32LE(p + 24), offset: buf.readUInt32LE(p + 42)
    });
    p += 46 + nameLen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
  }
  let total = 0;
  const raw = (e) => {
    if (e.offset + 30 > buf.length || buf.readUInt32LE(e.offset) !== 0x04034b50) throw new Error('not a valid Office file');
    const start = e.offset + 30 + buf.readUInt16LE(e.offset + 26) + buf.readUInt16LE(e.offset + 28);
    return buf.subarray(start, start + e.size);
  };
  return {
    names: [...entries.keys()],
    entries,
    raw: name => raw(entries.get(name)),
    read(name) {
      const e = entries.get(name);
      if (!e) return null;
      let data;
      if (e.method === 0) data = raw(e);
      else if (e.method === 8) {
        try {
          data = zlib.inflateRawSync(raw(e), { maxOutputLength: ENTRY_MAX });
        } catch (err) {
          throw new Error(err.code === 'ERR_BUFFER_TOO_LARGE' ? 'it is too large once unpacked' : 'not a valid Office file');
        }
      } else throw new Error('unsupported compression in this Office file');
      total += data.length;
      if (total > TOTAL_MAX) throw new Error('it is too large once unpacked');
      return data.toString('utf8');
    }
  };
}

// parts: [{ name, method, crc, full, data(compressed) }]
function writeZip(parts) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const part of parts) {
    const name = Buffer.from(part.name, 'utf8');
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt16LE(0x0800, 6); // names are UTF-8
    head.writeUInt16LE(part.method, 8);
    head.writeUInt16LE(0x21, 12); // 1 January 1980
    head.writeUInt32LE(part.crc, 14);
    head.writeUInt32LE(part.data.length, 18);
    head.writeUInt32LE(part.full, 22);
    head.writeUInt16LE(name.length, 26);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(0x0800, 8);
    c.writeUInt16LE(part.method, 10);
    c.writeUInt16LE(0x21, 14);
    c.writeUInt32LE(part.crc, 16);
    c.writeUInt32LE(part.data.length, 20);
    c.writeUInt32LE(part.full, 24);
    c.writeUInt16LE(name.length, 28);
    c.writeUInt32LE(offset, 42);
    chunks.push(head, name, part.data);
    central.push(c, name);
    offset += 30 + name.length + part.data.length;
  }
  const dir = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(parts.length, 8);
  end.writeUInt16LE(parts.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, dir, end]);
}

function pack(name, text) {
  const data = Buffer.from(text, 'utf8');
  return { name, method: 8, crc: crc32(data), full: data.length, data: zlib.deflateRawSync(data) };
}

// A copy of the file with some parts replaced (Map name -> text) or removed (null).
function rewrite(zip, changes) {
  const parts = [];
  for (const name of zip.names) {
    if (changes.has(name)) {
      const text = changes.get(name);
      if (text !== null) parts.push(pack(name, text));
    } else {
      const e = zip.entries.get(name);
      parts.push({ name, method: e.method, crc: e.crc, full: e.full, data: zip.raw(name) });
    }
  }
  for (const [name, text] of changes) if (text !== null && !zip.entries.has(name)) parts.push(pack(name, text));
  return writeZip(parts);
}

module.exports = { openZip, writeZip, pack, rewrite };

// Arithmetic and unit conversion for the tools. A small parser of its own:
// nothing the model writes is ever run as code.
/* global BigInt */

const FUNCTIONS = {
  sqrt: Math.sqrt, abs: Math.abs, exp: Math.exp, ln: Math.log, log10: Math.log10, log2: Math.log2, log: Math.log10,
  sin: Math.sin, cos: Math.cos, tan: Math.tan, asin: Math.asin, acos: Math.acos, atan: Math.atan,
  round: Math.round, floor: Math.floor, ceil: Math.ceil, min: Math.min, max: Math.max
};
const CONSTANTS = { pi: Math.PI, e: Math.E };
const MAX_LENGTH = 1000;
const MAX_DEPTH = 100;

function evaluate(input) {
  const text = String(input === undefined ? '' : input).replace(/×/g, '*').replace(/÷/g, '/').replace(/−/g, '-').replace(/\*\*/g, '^');
  if (!text.trim() || text.length > MAX_LENGTH) throw new Error('the expression is empty or too long');
  const tokens = [];
  const re = /\s*(?:(\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)|([A-Za-z][A-Za-z0-9]*)|([-+*/^(),]))/y;
  let at = 0;
  while (at < text.length) {
    if (!text.slice(at).trim()) break;
    re.lastIndex = at;
    const m = re.exec(text);
    if (!m) throw new Error(`cannot understand "${text.slice(at, at + 20)}"`);
    at = re.lastIndex;
    if (m[1]) tokens.push({ n: Number(m[1]), raw: m[1] });
    else if (m[2]) tokens.push({ w: m[2].toLowerCase() });
    else tokens.push({ o: m[3] });
  }
  // Whole numbers with only + - * ( ) are worked out exactly, however long.
  const whole = tokens.every(t => (t.raw ? /^\d+$/.test(t.raw) : t.o && '+-*()'.includes(t.o)));
  if (whole) tokens.forEach((t) => { if (t.raw) t.n = BigInt(t.raw); });
  let i = 0;
  let depth = 0;
  const is = o => tokens[i] && tokens[i].o === o;
  const need = (o) => { if (!is(o)) throw new Error(`"${o}" is missing`); i += 1; };

  function sum() {
    let v = product();
    while (is('+') || is('-')) { const o = tokens[i++].o; const r = product(); v = o === '+' ? v + r : v - r; }
    return v;
  }
  function product() {
    let v = unary();
    while (is('*') || is('/')) {
      const o = tokens[i++].o;
      const r = unary();
      if (o === '/' && r === 0) throw new Error('division by zero');
      v = o === '*' ? v * r : v / r;
    }
    return v;
  }
  function unary() {
    if (++depth > MAX_DEPTH) throw new Error('the expression is nested too deeply');
    try {
      if (is('-')) { i += 1; return -unary(); }
      if (is('+')) { i += 1; return unary(); }
      const base = atom();
      if (is('^')) { i += 1; return base ** unary(); }
      return base;
    } finally { depth -= 1; }
  }
  function atom() {
    const t = tokens[i];
    if (!t) throw new Error('the expression is incomplete');
    i += 1;
    if (t.n !== undefined) return t.n;
    if (t.o === '(') { const v = sum(); need(')'); return v; }
    if (t.w !== undefined) {
      if (is('(')) {
        if (!Object.prototype.hasOwnProperty.call(FUNCTIONS, t.w)) throw new Error(`unknown function "${t.w}"`);
        i += 1;
        const args = [sum()];
        while (is(',')) { i += 1; args.push(sum()); }
        need(')');
        return FUNCTIONS[t.w](...args);
      }
      if (Object.prototype.hasOwnProperty.call(CONSTANTS, t.w)) return CONSTANTS[t.w];
      throw new Error(`unknown name "${t.w}"`);
    }
    throw new Error(`unexpected "${t.o}"`);
  }
  const v = sum();
  if (i < tokens.length) throw new Error('the expression has something left over at the end');
  if (whole) return v.toString();
  if (!Number.isFinite(v)) throw new Error('the result is not a finite number');
  return tidy(v);
}

const tidy = v => (Number.isSafeInteger(v) ? v : Number(v.toPrecision(14)));

// kind -> unit -> factor to the first unit of the kind
const UNITS = {
  length: { m: 1, km: 1e3, cm: 1e-2, mm: 1e-3, um: 1e-6, 'µm': 1e-6, nm: 1e-9, pm: 1e-12, angstrom: 1e-10, 'Å': 1e-10, inch: 0.0254, in: 0.0254, ft: 0.3048, mile: 1609.344 },
  mass: { g: 1, kg: 1e3, mg: 1e-3, ug: 1e-6, 'µg': 1e-6, ng: 1e-9, pg: 1e-12, t: 1e6, lb: 453.59237, oz: 28.349523125, Da: 1.6605390666e-24, kDa: 1.6605390666e-21 },
  volume: { l: 1, L: 1, ml: 1e-3, mL: 1e-3, ul: 1e-6, uL: 1e-6, 'µl': 1e-6, 'µL': 1e-6, nl: 1e-9, nL: 1e-9, m3: 1e3, cm3: 1e-3, gal: 3.785411784 },
  time: { s: 1, ms: 1e-3, us: 1e-6, 'µs': 1e-6, ns: 1e-9, min: 60, h: 3600, day: 86400, week: 604800 },
  pressure: { Pa: 1, kPa: 1e3, MPa: 1e6, bar: 1e5, mbar: 100, atm: 101325, psi: 6894.757293168, mmHg: 133.322387415, Torr: 133.32236842105 },
  energy: { J: 1, kJ: 1e3, cal: 4.184, kcal: 4184, eV: 1.602176634e-19, keV: 1.602176634e-16, Wh: 3600, kWh: 3.6e6 },
  concentration: { M: 1, mM: 1e-3, uM: 1e-6, 'µM': 1e-6, nM: 1e-9, pM: 1e-12 },
  angle: { rad: 1, mrad: 1e-3, deg: Math.PI / 180, '°': Math.PI / 180 },
  temperature: { K: null, C: null, '°C': null, F: null, '°F': null }
};
const UNIT_NAMES = Object.entries(UNITS).map(([k, u]) => `${k}: ${Object.keys(u).join(' ')}`).join('; ');

function convert(value, from, to) {
  const v = Number(value);
  if (!Number.isFinite(v)) throw new Error('the value must be a number');
  const has = (u, name) => Object.prototype.hasOwnProperty.call(u, name);
  const kind = Object.keys(UNITS).find(k => has(UNITS[k], from) && has(UNITS[k], to));
  if (!kind) throw new Error(`cannot convert "${from}" to "${to}"; units: ${UNIT_NAMES}`);
  if (kind === 'temperature') {
    const f = from.replace('°', '');
    const t = to.replace('°', '');
    const k = f === 'K' ? v : f === 'C' ? v + 273.15 : (v - 32) * 5 / 9 + 273.15;
    return tidy(t === 'K' ? k : t === 'C' ? k - 273.15 : (k - 273.15) * 9 / 5 + 32);
  }
  return tidy(v * UNITS[kind][from] / UNITS[kind][to]);
}

module.exports = { evaluate, convert, UNIT_NAMES };

// Read-only database tools for developers (the user's rule: databases are for
// developers and administrators only; this module enforces that in code, so no
// setting on Setup can open them to anyone else).
//
// MFF's MariaDB, through a dedicated read-only account created by the user
// (MODULE_AI_MARIADB_RO_HOST/_PORT/_USER/_PASSWORD; the account's grants decide
// which databases and tables). Every call is checked and limited here as well:
// one statement only (SELECT, WITH, SHOW, DESCRIBE, EXPLAIN), run in a
// read-only transaction that is always rolled back, with a 10 s statement time
// limit and at most 200 rows. Every query is logged (ai_db_query_log: who, the
// query, rows, time, result).
// The MSSQL server waits for its own read-only account (not built yet).
const mariadb = require('mariadb');

const MAX_ROWS = 200;
const STATEMENT_S = 10;
const MAX_SQL = 8000;
const MAX_CELL = 500;
const ALLOWED = /^(select|with|show|describe|desc|explain)\b/i;
const FORBIDDEN = /\b(into\s+(out|dump)file|load_file|sleep\s*\(|benchmark\s*\(|get_lock|release_lock|master_pos_wait|for\s+update|lock\s+in\s+share\s+mode)\b/i;

let pool = null;
let poolKey = '';

function configOf(coreApi) {
  const c = coreApi.getModuleConfig() || {};
  if (!c.MARIADB_RO_USER || !c.MARIADB_RO_PASSWORD) return null;
  return { host: c.MARIADB_RO_HOST || '127.0.0.1', port: Number(c.MARIADB_RO_PORT) || 3306, user: c.MARIADB_RO_USER, password: c.MARIADB_RO_PASSWORD };
}

function getPool(cfg) {
  const key = `${cfg.host}:${cfg.port}:${cfg.user}`;
  if (pool && poolKey === key) return pool;
  if (pool) pool.end().catch(() => {});
  pool = mariadb.createPool({ ...cfg, connectionLimit: 2, connectTimeout: 5000, acquireTimeout: 8000, bigIntAsNumber: true, dateStrings: true, multipleStatements: false });
  poolKey = key;
  return pool;
}

// Comments and string contents removed, to check the statement's shape.
function shape(sql) {
  return sql
    .replace(/'(?:[^'\\]|\\.|'')*'/g, "''")
    .replace(/"(?:[^"\\]|\\.|"")*"/g, '""')
    .replace(/`[^`]*`/g, '``')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(--|#)[^\n]*/g, ' ')
    .trim();
}

function check(sql) {
  const text = String(sql || '').trim();
  if (!text) throw new Error('the query is empty');
  if (text.length > MAX_SQL) throw new Error('the query is too long');
  const s = shape(text).replace(/;\s*$/, '');
  if (s.includes(';')) throw new Error('one statement only');
  if (!ALLOWED.test(s)) throw new Error('only SELECT, WITH, SHOW, DESCRIBE and EXPLAIN are allowed');
  if (/\/\*!/.test(text)) throw new Error('version comments are not allowed');
  if (FORBIDDEN.test(s)) throw new Error('this kind of query is not allowed');
  return text.replace(/;\s*$/, '');
}

const cell = v => (v === null || v === undefined ? null : typeof v === 'string' && v.length > MAX_CELL ? `${v.slice(0, MAX_CELL)}…` : Buffer.isBuffer(v) ? `(${v.length} bytes)` : v);

async function log(ctx, db, sql, rows, ms, error) {
  await ctx.pool.query('INSERT INTO ai_db_query_log (answer_id, user_id, db, query, rows_returned, ms, ok, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [ctx.answerId, ctx.userId, db, sql.slice(0, 16000), rows, ms, error ? 0 : 1, error ? String(error).slice(0, 300) : null]).catch(() => {});
}

async function runMariadb(ctx, sql) {
  const cfg = configOf(ctx.coreApi);
  if (!cfg) throw new Error('the read-only MariaDB account is not set up (MODULE_AI_MARIADB_RO_*)');
  const started = Date.now();
  let conn;
  const rows = [];
  let columns = [];
  let cut = false;
  try {
    conn = await getPool(cfg).getConnection();
    await conn.query(`SET SESSION max_statement_time = ${STATEMENT_S}`);
    await conn.query('START TRANSACTION READ ONLY');
    await new Promise((resolve, reject) => {
      const stream = conn.queryStream({ sql, rowsAsArray: false });
      stream.on('fields', (f) => { columns = (f || []).map(x => x.name()); });
      stream.on('data', (row) => {
        if (rows.length >= MAX_ROWS) { cut = true; stream.close(); return; }
        rows.push(row);
      });
      stream.on('error', reject);
      stream.on('end', resolve);
      stream.on('close', resolve);
    });
    await log(ctx, 'mariadb', sql, rows.length, Date.now() - started, null);
  } catch (err) {
    await log(ctx, 'mariadb', sql, 0, Date.now() - started, err.text || err.message);
    throw new Error(err.code === 'ER_STATEMENT_TIMEOUT' || /max_statement_time/i.test(err.message) ? `the query took longer than ${STATEMENT_S} s` : (err.text || err.message).slice(0, 400));
  } finally {
    if (conn) { await conn.query('ROLLBACK').catch(() => {}); conn.release(); }
  }
  if (!columns.length && rows.length) columns = Object.keys(rows[0]);
  const lines = rows.map(r => columns.map(c => cell(r[c])));
  return `${rows.length} row${rows.length === 1 ? '' : 's'}${cut ? ` (cut at ${MAX_ROWS})` : ''}, ${Date.now() - started} ms.\n${JSON.stringify({ columns, rows: lines })}`;
}

const TOOLS = [
  {
    key: 'db_query_mariadb',
    name: 'MFF database (MariaDB, read-only)',
    what: 'Lets the AI read MFF\'s MariaDB databases with SQL, through a read-only account: one SELECT, SHOW, DESCRIBE or EXPLAIN at a time, at most 200 rows, 10 s. Developers and administrators only.',
    example: 'How many bookings were made per month this year?',
    sees: 'What the read-only database account may read (its grants decide). Every query is logged.',
    risk: 'reads your MFF data',
    status: 'done',
    minAudience: 'developer',
    target: () => 'mariadb',
    definition: {
      name: 'db_query_mariadb',
      description: 'Runs one read-only SQL statement on the MFF MariaDB server (SELECT, WITH, SHOW, DESCRIBE or EXPLAIN; no data changes). '
        + 'Returns at most 200 rows as JSON. Use SHOW DATABASES, SHOW TABLES FROM <db> and DESCRIBE <db>.<table> to find your way; qualify tables with their database.',
      parameters: { type: 'object', properties: { sql: { type: 'string', description: 'One SQL statement' } }, required: ['sql'] }
    },
    run: async (args, ctx) => {
      if (ctx.level !== 'developer') throw new Error('the databases are for developers and administrators only');
      return runMariadb(ctx, check(args.sql));
    }
  }
];

module.exports = { TOOLS, check, shape };

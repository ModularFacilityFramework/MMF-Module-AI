// Read-only database tools: DIRECT tools, for the advanced level only
// (developers and administrators; the user's rule, enforced in code - no
// setting on Setup can open them to the standard level). They may read all
// databases the read-only accounts can read (the user's decision, 27/11/2026).
//
// MFF's MariaDB, through a dedicated read-only account created by the user
// (MODULE_AI_MARIADB_RO_HOST/_PORT/_USER/_PASSWORD; the account's grants decide
// which databases and tables). Every call is checked and limited here as well:
// one statement only (SELECT, WITH, SHOW, DESCRIBE, EXPLAIN), run in a
// read-only transaction that is always rolled back, with a 10 s statement time
// limit and at most 200 rows. Every query is logged (ai_db_query_log: who, the
// query, rows, time, result).
//
// The MSSQL server on the backend host, through its own read-only account
// (MODULE_AI_MSSQL_RO_HOST/_PORT/_USER/_PASSWORD/_DATABASE): SELECT or WITH
// only (no SELECT ... INTO, EXEC, OPENROWSET, ...), in a transaction that is
// rolled back, lock timeout 5 s, query timeout 10 s, at most 200 rows. It runs
// through a small Python helper (mssql_query.py with pymssql, installed by
// tools/nusbf/dbtools-install.sh): the Node driver (tedious) now needs Node 22
// through its Azure dependencies, and this module must install on Node 20.
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const mariadb = require('mariadb');

const MSSQL_PYTHON = '/usr/local/ai-dbtools/venv/bin/python';
const MSSQL_ALLOWED = /^(select|with)\b/i;
const MSSQL_FORBIDDEN = /\b(into|exec|execute|openrowset|openquery|opendatasource|openxml|waitfor|bulk|shutdown|reconfigure|dbcc|kill|grant|revoke|deny|create|alter|drop|insert|update|delete|merge|truncate|backup|restore|use|go|xp_\w*|sp_\w*)\b/i;

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
    .replace(/\[[^\]]*\]/g, '[]')
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

function checkMssql(sql) {
  const text = String(sql || '').trim();
  if (!text) throw new Error('the query is empty');
  if (text.length > MAX_SQL) throw new Error('the query is too long');
  const s = shape(text).replace(/;\s*$/, '');
  if (s.includes(';')) throw new Error('one statement only');
  if (!MSSQL_ALLOWED.test(s)) throw new Error('only SELECT and WITH ... SELECT are allowed');
  const bad = MSSQL_FORBIDDEN.exec(s);
  if (bad) throw new Error(`"${bad[1]}" is not allowed in a read-only query`);
  return text.replace(/;\s*$/, '');
}

function mssqlConfig(coreApi) {
  const c = coreApi.getModuleConfig() || {};
  if (!c.MSSQL_RO_USER || !c.MSSQL_RO_PASSWORD) return null;
  return { host: c.MSSQL_RO_HOST || '127.0.0.1', port: Number(c.MSSQL_RO_PORT) || 1433, user: c.MSSQL_RO_USER, password: c.MSSQL_RO_PASSWORD, database: c.MSSQL_RO_DATABASE || '' };
}

async function runMssql(ctx, sql) {
  const cfg = mssqlConfig(ctx.coreApi);
  if (!cfg) throw new Error('the read-only MSSQL account is not set up (MODULE_AI_MSSQL_RO_*)');
  if (!fs.existsSync(MSSQL_PYTHON)) throw new Error('the MSSQL helper is not installed on this server (tools/nusbf/dbtools-install.sh)');
  const started = Date.now();
  const result = await new Promise((resolve) => {
    const child = spawn(MSSQL_PYTHON, ['-I', path.join(__dirname, 'mssql_query.py')], { env: { PATH: '/usr/bin:/bin' }, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { if (out.length < 2e6) out += d; });
    child.stderr.on('data', () => {});
    const timer = setTimeout(() => child.kill('SIGKILL'), (STATEMENT_S + 10) * 1000);
    child.on('close', () => { clearTimeout(timer); try { resolve(JSON.parse(out)); } catch (err) { resolve({ error: 'the MSSQL helper gave no answer' }); } });
    child.on('error', () => { clearTimeout(timer); resolve({ error: 'the MSSQL helper could not start' }); });
    child.stdin.end(JSON.stringify({ ...cfg, sql, max_rows: MAX_ROWS, timeout: STATEMENT_S }));
  });
  const ms = Date.now() - started;
  await log(ctx, 'mssql', sql, result.rows ? result.rows.length : 0, ms, result.error || null);
  if (result.error) throw new Error(result.error);
  const n = result.rows.length;
  return `${n} row${n === 1 ? '' : 's'}${result.cut ? ` (cut at ${MAX_ROWS})` : ''}, ${ms} ms.\n${JSON.stringify({ columns: result.columns, rows: result.rows })}`;
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
    kind: 'direct',
    target: () => 'mariadb',
    definition: {
      name: 'db_query_mariadb',
      description: 'Runs one read-only SQL statement on the MFF MariaDB server (SELECT, WITH, SHOW, DESCRIBE or EXPLAIN; no data changes). '
        + 'Returns at most 200 rows as JSON. Use SHOW DATABASES, SHOW TABLES FROM <db> and DESCRIBE <db>.<table> to find your way; qualify tables with their database.',
      parameters: { type: 'object', properties: { sql: { type: 'string', description: 'One SQL statement' } }, required: ['sql'] }
    },
    run: async (args, ctx) => {
      if (ctx.level !== 'advanced') throw new Error('the databases are for the advanced level only (developers and administrators)');
      return runMariadb(ctx, check(args.sql));
    }
  },
  {
    key: 'db_query_mssql',
    name: 'MSSQL server (read-only)',
    what: 'Lets the AI read the facility\'s MSSQL server with SQL, through a read-only account: one SELECT at a time, at most 200 rows, 10 s. Advanced level only.',
    example: 'Which tables does the instrument database have?',
    sees: 'What the read-only MSSQL account may read (its grants decide). Every query is logged.',
    risk: 'reads your MFF data',
    status: 'done',
    kind: 'direct',
    target: () => 'mssql',
    definition: {
      name: 'db_query_mssql',
      description: 'Runs one read-only T-SQL statement on the MSSQL server (SELECT or WITH ... SELECT only; no SELECT INTO, EXEC or system procedures). '
        + 'Returns at most 200 rows as JSON. To find your way: SELECT name FROM sys.databases; SELECT TABLE_SCHEMA, TABLE_NAME FROM <db>.INFORMATION_SCHEMA.TABLES; '
        + 'SELECT COLUMN_NAME, DATA_TYPE FROM <db>.INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = \'...\'.',
      parameters: { type: 'object', properties: { sql: { type: 'string', description: 'One T-SQL SELECT statement' } }, required: ['sql'] }
    },
    run: async (args, ctx) => {
      if (ctx.level !== 'advanced') throw new Error('the databases are for the advanced level only (developers and administrators)');
      return runMssql(ctx, checkMssql(args.sql));
    }
  }
];

module.exports = { TOOLS, check, checkMssql, shape };

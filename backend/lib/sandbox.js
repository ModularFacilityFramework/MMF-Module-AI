// The code sandbox: Python (numpy, scipy, pandas, matplotlib, biopython, gemmi,
// rdkit) run in isolation on the backend host, for the run_python and
// read_structure_file tools and for MTZ uploads.
//
// Isolation (no Docker on the backend host, so not Qwen-Agent's Docker
// interpreter): bubblewrap gives each run empty namespaces - no network, its
// own process tree, no view of /home, /etc or anyone's files; it sees only the
// read-only system and runtime (/usr) and a fresh work folder holding the files
// the chat hands in (/work/in) and room for results (/work/out). A systemd user
// scope (cgroup) caps memory (no swap), processes and CPU, and stops the run
// after its time; prlimit caps CPU seconds and file size inside. The runtime is
// installed by tools/nusbf/sandbox-install.sh (which also enables lingering for
// the backend's user, so its systemd user manager is always there).
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const BASE = '/usr/local/ai-sandbox';
const PYTHON = `${BASE}/venv/bin/python`;
const LIMITS = { memory: '2G', tasks: 64, cpuQuota: '200%', timeoutS: 60, fileBytes: 50 * 1024 * 1024 };
const MAX_OUTPUT_FILES = 10;
const MAX_OUTPUT_BYTES = 20 * 1024 * 1024;
const MAX_TEXT = 20000;
const MAX_RUNNING = 2;
const NOISE = /^(Fontconfig error:.*|Matplotlib created a temporary cache directory.*|.*is not a writable directory)$/;

let running = 0;
const queue = [];

function which(cmd) {
  for (const dir of ['/usr/bin', '/bin', '/usr/local/bin']) if (fs.existsSync(path.join(dir, cmd))) return path.join(dir, cmd);
  return null;
}

// Is the sandbox there? -> { ok, scope, why }
function available() {
  if (process.platform !== 'linux') return { ok: false, why: 'the sandbox needs Linux' };
  if (!fs.existsSync(PYTHON)) return { ok: false, why: 'the sandbox runtime is not installed on this server (tools/nusbf/sandbox-install.sh)' };
  if (!which('bwrap')) return { ok: false, why: 'bubblewrap is not installed on this server' };
  const uid = process.getuid();
  const scope = Boolean(which('systemd-run')) && fs.existsSync(`/run/user/${uid}/bus`);
  return { ok: true, scope };
}

async function slot() {
  if (running < MAX_RUNNING) { running += 1; return; }
  await new Promise(resolve => queue.push(resolve));
  running += 1;
}
function release() {
  running -= 1;
  const next = queue.shift();
  if (next) next();
}

const safeName = n => String(n || 'file').split(/[\\/]/).pop().replace(/[^\w.+-]/g, '_').replace(/^\.+/, '').slice(-120) || 'file';

// code: a Python program, or argv: a program of the system (/usr) and its
// arguments (for OCR). inputs: [{ name, src }] copied to /work/in/<name>.
// -> { exitCode, timedOut, stdout, stderr, outputs: [{ name, data }] }
async function run({ code, argv, inputs = [], timeoutS = LIMITS.timeoutS, cpuQuota = LIMITS.cpuQuota, memory = LIMITS.memory }) {
  const a = available();
  if (!a.ok) throw new Error(a.why);
  await slot();
  const work = await fsp.mkdtemp(path.join(os.tmpdir(), 'aisbx-'));
  try {
    await fsp.chmod(work, 0o700);
    for (const d of ['in', 'out', '.mpl']) await fsp.mkdir(path.join(work, d), { mode: 0o700 });
    for (const f of await fsp.readdir(`${BASE}/mplconfig`).catch(() => [])) {
      if (f.endsWith('.json')) await fsp.copyFile(`${BASE}/mplconfig/${f}`, path.join(work, '.mpl', f)).catch(() => {});
    }
    const names = new Set();
    for (const i of inputs) {
      let n = safeName(i.name);
      while (names.has(n)) n = `_${n}`;
      names.add(n);
      await fsp.copyFile(i.src, path.join(work, 'in', n));
      await fsp.chmod(path.join(work, 'in', n), 0o400);
    }
    if (!argv) await fsp.writeFile(path.join(work, 'main.py'), code, { mode: 0o600 });
    const program = argv || [PYTHON, '-I', '/work/main.py'];

    const bwrap = [
      'bwrap', '--unshare-all', '--die-with-parent', '--new-session',
      '--ro-bind', '/usr', '/usr', '--symlink', 'usr/lib', '/lib', '--symlink', 'usr/lib64', '/lib64', '--symlink', 'usr/bin', '/bin',
      '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp',
      '--bind', work, '/work', '--ro-bind', path.join(work, 'in'), '/work/in', '--chdir', '/work',
      '--clearenv', '--setenv', 'HOME', '/work', '--setenv', 'PATH', '/usr/bin', '--setenv', 'MPLCONFIGDIR', '/work/.mpl',
      '--setenv', 'MPLBACKEND', 'Agg', '--setenv', 'OPENBLAS_NUM_THREADS', '2', '--setenv', 'OMP_NUM_THREADS', '2', '--setenv', 'PYTHONDONTWRITEBYTECODE', '1',
      '--', '/usr/bin/prlimit', `--cpu=${timeoutS * Math.max(1, parseInt(cpuQuota, 10) / 100)}`, `--fsize=${LIMITS.fileBytes}`, '--', ...program
    ];
    const uid = process.getuid();
    const [cmd, ...args] = a.scope
      ? ['systemd-run', '--user', '--scope', '--quiet', '--collect', '-p', `MemoryMax=${memory}`, '-p', 'MemorySwapMax=0',
        '-p', `TasksMax=${LIMITS.tasks}`, '-p', `CPUQuota=${cpuQuota}`, '-p', `RuntimeMaxSec=${timeoutS + 5}`, '--', ...bwrap]
      : bwrap;
    const env = { PATH: '/usr/bin:/bin', XDG_RUNTIME_DIR: `/run/user/${uid}`, DBUS_SESSION_BUS_ADDRESS: `unix:path=/run/user/${uid}/bus` };
    const result = await new Promise((resolve) => {
      const child = spawn(cmd, args, { env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      child.stdout.on('data', (d) => { if (stdout.length < MAX_TEXT * 2) stdout += d; });
      child.stderr.on('data', (d) => { if (stderr.length < MAX_TEXT * 2) stderr += d; });
      const timer = setTimeout(() => { timedOut = true; try { process.kill(-child.pid, 'SIGKILL'); } catch (err) { /* gone */ } }, (timeoutS + 10) * 1000);
      child.on('close', (code2, signal) => { clearTimeout(timer); resolve({ exitCode: code2 === null ? (signal || 'killed') : code2, timedOut, stdout, stderr }); });
      child.on('error', (err) => { clearTimeout(timer); resolve({ exitCode: 'error', timedOut, stdout, stderr: err.message }); });
    });
    const outputs = [];
    let total = 0;
    for (const f of (await fsp.readdir(path.join(work, 'out'), { withFileTypes: true })).filter(e => e.isFile()).slice(0, MAX_OUTPUT_FILES)) {
      const p = path.join(work, 'out', f.name);
      const st = await fsp.stat(p);
      if (total + st.size > MAX_OUTPUT_BYTES) break;
      total += st.size;
      outputs.push({ name: safeName(f.name), data: await fsp.readFile(p) });
    }
    const clean = t => t.split('\n').filter(l => !NOISE.test(l)).join('\n').slice(-MAX_TEXT).trim();
    return { ...result, stdout: clean(result.stdout), stderr: clean(result.stderr), outputs };
  } finally {
    await fsp.rm(work, { recursive: true, force: true }).catch(() => {});
    release();
  }
}

module.exports = { run, available, safeName, LIMITS };

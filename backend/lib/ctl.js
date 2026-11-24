// Client for ai-ctl, the forced-command bridge on the AI GPU host
// (tools/gpu6/ai-ctl in this repo). Runs the system ssh binary with a fixed
// argument array - no shell - and strict host-key checking, using the
// dedicated key from MODULE_AI_CTL_SSH_KEY_PATH. The key itself can only run
// ai-ctl, and ai-ctl only accepts status, switch <kw> and info.
//
// Safety: if the key file named in the config were missing, ssh would quietly
// fall back to the backend user's own default keys and get a full shell on
// the GPU host (seen in testing). So the key file must exist before ssh runs,
// the user's ssh config and agent are ignored (-F /dev/null, IdentityAgent
// none), and only public-key auth with that one file is allowed.
const fs = require('fs');
const { execFile } = require('child_process');

function sshArgs(cfg, command) {
  const s = cfg.ssh;
  return [
    '-F', '/dev/null',
    '-i', s.keyPath,
    '-p', String(s.port),
    '-o', 'BatchMode=yes',
    '-o', 'IdentitiesOnly=yes',
    '-o', 'IdentityAgent=none',
    '-o', 'PreferredAuthentications=publickey',
    '-o', 'PasswordAuthentication=no',
    '-o', 'KbdInteractiveAuthentication=no',
    '-o', 'StrictHostKeyChecking=yes',
    '-o', `UserKnownHostsFile=${s.knownHosts}`,
    '-o', 'GlobalKnownHostsFile=/dev/null',
    '-o', 'ConnectTimeout=10',
    '-T',
    `${s.user}@${s.host}`,
    command
  ];
}

function configured(cfg) {
  const s = cfg.ssh;
  return Boolean(s.host && s.user && s.keyPath && s.knownHosts);
}

function isReadableFile(p) {
  try {
    const st = fs.statSync(p);
    if (!st.isFile()) return false;
    fs.accessSync(p, fs.constants.R_OK);
    return true;
  } catch (err) {
    return false;
  }
}

// Runs one short ai-ctl command. Never throws: { ok, stdout, error }.
function run(cfg, command, timeoutMs = 30000) {
  return new Promise(resolve => {
    if (!configured(cfg)) {
      resolve({ ok: false, error: 'the ai-ctl connection is not configured' });
      return;
    }
    if (!isReadableFile(cfg.ssh.keyPath)) {
      resolve({ ok: false, error: 'the ai-ctl key file is missing or unreadable (MODULE_AI_CTL_SSH_KEY_PATH)' });
      return;
    }
    if (!isReadableFile(cfg.ssh.knownHosts)) {
      resolve({ ok: false, error: 'the known_hosts file is missing or unreadable (MODULE_AI_CTL_SSH_KNOWN_HOSTS)' });
      return;
    }
    execFile('ssh', sshArgs(cfg, command), { timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const msg = (stdout || '').trim().split('\n').pop() || (stderr || '').trim().split('\n').pop() || err.message;
        resolve({ ok: false, stdout, error: err.killed ? 'timed out' : msg });
        return;
      }
      resolve({ ok: true, stdout });
    });
  });
}

// Controller state, parsed from "RUNNING qwen (pid 123) [switch in progress]"
// or "STOPPED".
function parseStatus(line) {
  const text = (line || '').trim();
  const m = text.match(/^RUNNING\s+(\S+)\s+\(pid\s+(\d+)\)(\s+\[switch in progress\])?/);
  if (m) return { state: 'running', keyword: m[1], pid: Number(m[2]), switching: Boolean(m[3]), raw: text };
  if (text.startsWith('STOPPED')) return { state: 'stopped', keyword: null, pid: null, switching: text.includes('switch in progress'), raw: text };
  return { state: 'unknown', keyword: null, pid: null, switching: false, raw: text };
}

async function status(cfg) {
  const r = await run(cfg, 'status', 20000);
  if (!r.ok) return { ok: false, error: r.error };
  return { ok: true, ...parseStatus(r.stdout) };
}

async function info(cfg) {
  const r = await run(cfg, 'info', 30000);
  if (!r.ok) return { ok: false, error: r.error };
  try {
    const data = JSON.parse(r.stdout);
    return { ok: true, data, controller: parseStatus(data.controller_status) };
  } catch (err) {
    return { ok: false, error: 'ai-ctl info did not return JSON' };
  }
}

module.exports = { run, status, info, parseStatus, sshArgs, configured, isReadableFile };

// Read-only Slurm tools for the AI, through the slurm module's /external
// routes (slurm 0.1.46, 3d6b2df; built by mff-slurm for this, approved by the
// user 26/11/2026). Called as the asking user, never as anyone else, and each
// answer is made only from that user's own result (nothing is cached).
// The slurm module decides what each person may see, for the person asking:
// a normal user gets only their own jobs and anonymous totals; its staff roles
// also get other jobs and per-node detail. This module never widens that, and
// narrows it to the AI's levels (the user's rule, 27/11/2026): at the Standard
// level only the person's own jobs and per-partition totals, even for someone
// the slurm module counts as staff; every job and per-node detail only at the
// Advanced level. It calls only these GET routes.
const MAX_JOBS = 60;
// The slurm module's staff roles (its own rule) and the first slurm version that
// honours scope=own on job-state and cluster-state (mff-slurm, ed44c73).
const SLURM_STAFF_ROLES = ['facility_manager', 'facility_staff'];
const SCOPE_OWN_FROM = [0, 1, 49];
const MFF_JOBS = 'Jobs sent to Slurm through an MFF module run under MFF\'s own account, so they are not listed as yours here; see them in that module.';

const newer = (v, min) => {
  const p = String(v || '').split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < min.length; i++) { if ((p[i] || 0) !== min[i]) return (p[i] || 0) > min[i]; }
  return true;
};

// At the standard level, can job-state be trusted to answer with the person's
// own jobs only? Yes for anyone the slurm module does not count as staff; for
// its staff only when the installed slurm honours scope=own (0.1.49 or newer).
async function ownJobStateSafe(ctx) {
  const roles = ctx.user ? await ctx.coreApi.getUserRoles(ctx.user).catch(() => []) : [];
  if (!roles.some(r => SLURM_STAFF_ROLES.includes(r))) return true;
  if (typeof ctx.coreApi.getModulesForUser !== 'function') return false;
  const mods = await ctx.coreApi.getModulesForUser(ctx.user).catch(() => []);
  const slurm = (mods || []).find(m => m.id === 'slurm');
  return Boolean(slurm && newer(slurm.version, SCOPE_OWN_FROM));
}

// By status only: the body of an error answer may not reach us.
function why(r, what) {
  if (r.refused || r.status === 0) return 'the Slurm module cannot be reached from the AI module here';
  if (r.status === 403) {
    return what === 'all'
      ? 'only facility staff and developers may see every job'
      : 'you have no Slurm access on the cluster (no Slurm account, or it is not set up for you); facility staff can help';
  }
  if (r.status === 404) return `there is no job ${what} that you can see. ${MFF_JOBS}`;
  if (r.status === 400) return 'the Slurm module did not accept this request (bad job id or option)';
  if (r.status === 502) return 'Slurm is unavailable right now';
  return `the Slurm module answered ${r.status}`;
}

async function get(ctx, pathname, params, what) {
  if (!ctx.coreApi || typeof ctx.coreApi.callModuleAsUser !== 'function') throw new Error('the Slurm module cannot be reached from the AI module here');
  const r = await ctx.coreApi.callModuleAsUser(ctx.userId, 'slurm', 'GET', pathname, { ...(params && { params }), timeoutMs: 15000 });
  if (!r || !r.ok) throw new Error(why(r || {}, what));
  return r.data;
}
const NOTE = 'Note: partitions share nodes, so never add figures across partitions; "free" does not promise that a job will start. Times are Unix epoch seconds.';

// Compact JSON: the model reads it well, and no field the module chose to
// send is lost or invented.
const compact = v => JSON.stringify(v, (k, x) => (x === null || x === '' ? undefined : x));

const TOOLS = [
  {
    key: 'slurm_queue',
    name: 'Slurm: my jobs in the queue',
    what: 'Lets the AI see your own jobs in the Slurm queue (running and waiting, with the reason) and how busy the cluster is overall. At the advanced level it can also list every user\'s jobs.',
    example: 'Why is my job still pending?',
    sees: 'Your own Slurm jobs and anonymous cluster totals; every user\'s jobs only at the advanced level (and only if the Slurm module allows it).',
    risk: 'reads your MFF data',
    status: 'done',
    definition: {
      name: 'slurm_queue',
      description: 'The Slurm queue: the asking user\'s own jobs (id, name, state, reason, partition, GPUs, CPUs, memory, times as Unix epoch seconds) and cluster totals. all=true (every user\'s jobs) works only at the advanced level.',
      parameters: { type: 'object', properties: { all: { type: 'boolean', description: 'Every job, not only the asker\'s (facility staff and developers only)' } } }
    },
    run: async (args, ctx) => {
      const all = args.all === true;
      if (all && ctx.level !== 'advanced') throw new Error('every user\'s jobs can only be listed at the advanced level (developers and administrators); here you can see your own jobs');
      const data = await get(ctx, '/external/queue', { scope: all ? 'all' : 'own' }, all ? 'all' : 'own');
      const jobs = Array.isArray(data && data.jobs) ? data.jobs : [];
      const shown = jobs.slice(0, MAX_JOBS);
      // Named so the model cannot take the cluster's totals for the person's own jobs.
      const { totals, jobs: _drop, ...rest } = data || {};
      const out = { ...rest, [all ? 'jobsOfAllUsers' : 'yourJobs']: shown, [all ? 'jobsListed' : 'yourJobCount']: jobs.length, clusterTotalsAllUsers: totals };
      return `${compact(out)}${jobs.length > shown.length ? `\n(${jobs.length - shown.length} more jobs not shown)` : ''}\n`
        + `clusterTotalsAllUsers counts every user's jobs on the cluster, not only ${all ? 'those listed' : 'yours'}.${all ? '' : ` ${MFF_JOBS}`}\n${NOTE}`;
    }
  },
  {
    key: 'slurm_job',
    name: 'Slurm: state of a job',
    what: 'Lets the AI look up the state of one Slurm job by its number: running, pending (and why), finished, failed, its exit code and times.',
    example: 'What happened to job 123456?',
    sees: 'Your own jobs; other jobs only if the Slurm module allows it for your roles (state and times, no owner).',
    risk: 'reads your MFF data',
    status: 'done',
    definition: {
      name: 'slurm_job',
      description: 'State of one Slurm job by job id: state, reason, exit code, submit/start/end times.',
      parameters: { type: 'object', properties: { job_id: { type: 'string', description: 'The Slurm job id, for example 123456 or 123456_7' } }, required: ['job_id'] }
    },
    run: async (args, ctx) => {
      const id = String(args.job_id || '').trim();
      if (!/^[1-9]\d{0,9}(_\d{1,9})?$/.test(id)) throw new Error('a job id is a number, for example 123456 or 123456_7');
      // at the standard level only the person's own jobs, even for the slurm module's staff
      if (ctx.level !== 'advanced' && !(await ownJobStateSafe(ctx))) {
        throw new Error('looking up a single job is not available at the standard level for your roles until the Slurm module is updated (0.1.49 or newer); your own queue (slurm_queue) still works');
      }
      return `${compact(await get(ctx, `/external/job-state/${id}`, ctx.level === 'advanced' ? null : { scope: 'own' }, id))}\nexitCode is empty until the job has finished; state may be several values joined with "+".`;
    }
  },
  {
    key: 'slurm_cluster',
    name: 'Slurm: state of the cluster',
    what: 'Lets the AI see how busy the cluster is: per partition, which nodes are up or down and how many GPUs and CPUs are free. At the advanced level it also sees each node.',
    example: 'Are there free GPUs right now?',
    sees: 'Per-partition totals; per-node detail (names, state reasons) only at the advanced level.',
    risk: 'reads your MFF data',
    status: 'done',
    definition: {
      name: 'slurm_cluster',
      description: 'State of the Slurm cluster: per partition the node states and free/total GPUs and CPUs (per node for staff).',
      parameters: { type: 'object', properties: {} }
    },
    run: async (args, ctx) => {
      const data = await get(ctx, '/external/cluster-state', ctx.level === 'advanced' ? null : { scope: 'own' }, 'cluster');
      // per-node detail (host names, state reasons) only at the advanced level
      const shown = ctx.level === 'advanced' ? data : { ...data, nodes: undefined };
      return `${compact(shown)}\n${NOTE}`;
    }
  }
];

module.exports = { TOOLS };

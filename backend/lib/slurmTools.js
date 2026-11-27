// Read-only Slurm tools for the AI, through the slurm module's /external
// routes (slurm 0.1.46, 3d6b2df; built by mff-slurm for this, approved by the
// user 26/11/2026). Called as the asking user, never as anyone else, and each
// answer is made only from that user's own result (nothing is cached).
// The slurm module decides what each person may see, for the person asking:
// a normal user gets only their own jobs and anonymous totals; facility staff
// and developers also get other jobs and per-node detail. This module never
// widens that, and calls only these GET routes.
const MAX_JOBS = 60;

// By status only: the body of an error answer may not reach us.
function why(r, what) {
  if (r.refused || r.status === 0) return 'the Slurm module cannot be reached from the AI module here';
  if (r.status === 403) {
    return what === 'all'
      ? 'only facility staff and developers may see every job'
      : 'you have no Slurm access on the cluster (no Slurm account, or it is not set up for you); facility staff can help';
  }
  if (r.status === 404) return `there is no job ${what} that you can see`;
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
    what: 'Lets the AI see your own jobs in the Slurm queue (running and waiting, with the reason) and how busy the cluster is overall. Facility staff and developers can ask about all jobs.',
    example: 'Why is my job still pending?',
    sees: 'Your own Slurm jobs and anonymous totals; all jobs for facility staff and developers (decided by the Slurm module).',
    risk: 'reads your MFF data',
    status: 'done',
    definition: {
      name: 'slurm_queue',
      description: 'The Slurm queue: the asking user\'s own jobs (id, name, state, reason, partition, GPUs, CPUs, memory, times as Unix epoch seconds) and cluster totals. Set all=true only when a facility staff member asks about every user\'s jobs.',
      parameters: { type: 'object', properties: { all: { type: 'boolean', description: 'Every job, not only the asker\'s (facility staff and developers only)' } } }
    },
    run: async (args, ctx) => {
      const all = args.all === true;
      const data = await get(ctx, '/external/queue', { scope: all ? 'all' : 'own' }, all ? 'all' : 'own');
      const jobs = Array.isArray(data && data.jobs) ? data.jobs : [];
      const shown = jobs.slice(0, MAX_JOBS);
      // Named so the model cannot take the cluster's totals for the person's own jobs.
      const { totals, jobs: _drop, ...rest } = data || {};
      const out = { ...rest, [all ? 'jobsOfAllUsers' : 'yourJobs']: shown, [all ? 'jobsListed' : 'yourJobCount']: jobs.length, clusterTotalsAllUsers: totals };
      return `${compact(out)}${jobs.length > shown.length ? `\n(${jobs.length - shown.length} more jobs not shown)` : ''}\n`
        + `clusterTotalsAllUsers counts every user's jobs on the cluster, not only ${all ? 'those listed' : 'yours'}.\n${NOTE}`;
    }
  },
  {
    key: 'slurm_job',
    name: 'Slurm: state of a job',
    what: 'Lets the AI look up the state of one Slurm job by its number: running, pending (and why), finished, failed, its exit code and times.',
    example: 'What happened to job 123456?',
    sees: 'Your own jobs only; any job for facility staff and developers.',
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
      return `${compact(await get(ctx, `/external/job-state/${id}`, null, id))}\nexitCode is empty until the job has finished; state may be several values joined with "+".`;
    }
  },
  {
    key: 'slurm_cluster',
    name: 'Slurm: state of the cluster',
    what: 'Lets the AI see how busy the cluster is: per partition, which nodes are up or down and how many GPUs and CPUs are free. Facility staff and developers also see each node.',
    example: 'Are there free GPUs right now?',
    sees: 'Per-partition totals; per-node detail for facility staff and developers.',
    risk: 'reads your MFF data',
    status: 'done',
    definition: {
      name: 'slurm_cluster',
      description: 'State of the Slurm cluster: per partition the node states and free/total GPUs and CPUs (per node for staff).',
      parameters: { type: 'object', properties: {} }
    },
    run: async (args, ctx) => `${compact(await get(ctx, '/external/cluster-state', null, 'cluster'))}\n${NOTE}`
  }
];

module.exports = { TOOLS };

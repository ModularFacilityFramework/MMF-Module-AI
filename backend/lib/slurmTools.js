// Read-only Slurm tools for the AI, through the slurm module's /external
// routes (built by mff-slurm for this; approved by the user 26/11/2026).
// The slurm module decides what each person may see, for the person asking:
// a normal user gets only their own jobs and anonymous totals; facility staff
// and developers also get other jobs and per-node detail. This module never
// widens that, and calls only these GET routes.
const MAX_JOBS = 60;

function why(r) {
  if (r.refused) return 'the Slurm module cannot be reached from the AI module here';
  if (r.status === 403) {
    const reason = r.data && r.data.reason;
    if (reason === 'not_slurm_user' || reason === 'no_association') return 'you have no Slurm account on the cluster (or it is not set up for you)';
    return (r.data && (r.data.message || r.data.error)) || 'not allowed';
  }
  if (r.status === 404) return 'there is no such job among the jobs you may see';
  if (r.status === 502) return 'Slurm did not answer (sacct/squeue failed)';
  return (r.data && r.data.error) || r.error || `the Slurm module answered ${r.status}`;
}

async function get(ctx, pathname, params) {
  if (!ctx.coreApi || typeof ctx.coreApi.callModuleAsUser !== 'function') throw new Error('the Slurm module cannot be reached from the AI module here');
  const r = await ctx.coreApi.callModuleAsUser(ctx.userId, 'slurm', 'GET', pathname, { params, timeoutMs: 20000 });
  if (!r || !r.ok) throw new Error(why(r || {}));
  return r.data;
}

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
      description: 'The Slurm queue: the asking user\'s own jobs (id, name, state, reason, partition, GPUs, CPUs, memory, times) and cluster totals. Staff may set all=true to see every job.',
      parameters: { type: 'object', properties: { all: { type: 'boolean', description: 'Every job, not only the asker\'s (facility staff and developers only)' } } }
    },
    run: async (args, ctx) => {
      const data = await get(ctx, '/external/queue', args.all ? { scope: 'all' } : {});
      const jobs = Array.isArray(data && data.jobs) ? data.jobs : [];
      const shown = jobs.slice(0, MAX_JOBS);
      return `${compact({ ...data, jobs: shown })}${jobs.length > shown.length ? `\n(${jobs.length - shown.length} more jobs not shown)` : ''}`;
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
      if (!/^\d{1,12}(?:_\d{1,7})?$/.test(id)) throw new Error('a job id is a number, for example 123456 or 123456_7');
      return compact(await get(ctx, `/external/job-state/${id}`));
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
    run: async (args, ctx) => compact(await get(ctx, '/external/cluster-state'))
  }
];

module.exports = { TOOLS };

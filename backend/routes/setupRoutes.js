// Setup page routes. The Setup page is the manifest page "setup": core's
// normal page access decides who may open it (Setup -> Preferences -> Access;
// a declared page with no grants is developer/administrator only). Actions on
// the shared GPU or on limits get their own, stricter checks in later steps.
const express = require('express');
const { configStatus } = require('../lib/config');
const { overview } = require('../lib/status');
const switcher = require('../lib/switcher');
const { readConfig } = require('../lib/config');
const { getSetting, setSetting } = require('../lib/settings');
const { LIMITS, DEFAULTS, getLimits, saveLimits } = require('../lib/limits');
const vllm = require('../lib/vllm');
const gens = require('../lib/generations');
const tools = require('../lib/tools');
const skills = require('../lib/skills');
const precision = require('../lib/precision');
const safety = require('../lib/safety');
const benchmark = require('../lib/benchmark');
const perms = require('../lib/permissions');
const { DEFAULT_SYSTEM } = require('../lib/answer');

const baseName = p => (p || '').split('/').filter(Boolean).pop() || '';

module.exports = function buildSetupRouter(coreApi) {
  const router = express.Router();
  const setupGate = [coreApi.authenticateToken, coreApi.requirePage('setup')];
  const policyGate = [...setupGate, perms.requirePolicy(coreApi)];
  const switchGate = [...setupGate, perms.requireSwitch(coreApi)];
  const wrap = fn => (req, res) => Promise.resolve(fn(req, res)).catch((err) => {
    if (err.status) return res.status(err.status).json({ error: err.message, code: err.code || null });
    console.error(`[ai] setup request failed: ${err.code || err.name}`);
    return res.status(500).json({ error: 'Something went wrong in the AI module.' });
  });

  // GET <api>/ai/setup/status - is the module configured? Answers 403 to a
  // user without the Setup page, which the frontend also uses to decide
  // whether to show the Setup tab at all.
  router.get('/setup/status', ...setupGate, (req, res) => {
    res.json({ config: configStatus(coreApi) });
  });

  // GET <api>/ai/setup/model?fresh=1 - everything for the "Model" card.
  // Model folders are reported by name only, never by full path.
  router.get('/setup/model', ...setupGate, async (req, res) => {
    try {
      const o = await overview(coreApi, { fresh: req.query.fresh === '1' });
      const infoData = o.info && o.info.ok ? o.info.data : null;
      const table = infoData ? infoData.controller_table || {} : {};
      const summaries = infoData ? infoData.models || {} : {};
      const vllmProc = infoData && infoData.vllm && infoData.vllm[0];
      const gpu = infoData && Array.isArray(infoData.gpu) ? infoData.gpu[0] : null;

      const contexts = infoData ? infoData.controller_context || {} : {};
      const loadedSummary = vllmProc ? summaries[vllmProc.args[0]] : null;
      const variantView = v => ({ key: v.key, label: v.label, context: contexts[v.key] || null });

      const catalogue = o.cfg.models.map(m => {
        const path = table[m.keyword];
        const s = path ? summaries[path] : null;
        return {
          keyword: m.keyword,
          label: m.label,
          capabilities: m.capabilities,
          knownToController: Boolean(path),
          variants: precision.offered(m.keyword, table).map(variantView),
          folder: path ? baseName(path) : null,
          details: s ? {
            architecture: s.architecture,
            dtype: s.dtype,
            quantized: s.quantized,
            nativeContext: s.native_context,
            layers: s.layers,
            weightsGB: s.weights_bytes ? Math.round(s.weights_bytes / 1e8) / 10 : null,
            vision: s.vision
          } : null
        };
      });
      const extraOnController = Object.keys(table).filter(kw => !o.cfg.models.some(m => m.keyword === precision.modelOf(kw)));

      res.json({
        state: o.state,
        message: o.message,
        keyword: o.keyword,
        model: o.model,
        // which precision variant the controller runs, and what is really loaded
        controllerKeyword: o.controller ? o.controller.keyword : null,
        variantLabel: o.controller && precision.variant(o.controller.keyword) && precision.offered(o.keyword, table).length
          ? precision.variant(o.controller.keyword).label : null,
        precision: precision.live(vllmProc ? vllmProc.args : null, loadedSummary),
        changedOutside: o.changedOutside,
        controller: o.controller ? { state: o.controller.state, keyword: o.controller.keyword, switching: o.controller.switching } : null,
        controllerError: o.info && !o.info.ok ? o.info.error : null,
        vllm: o.vllm ? {
          reachable: o.vllm.reachable,
          error: o.vllm.error,
          version: o.vllm.version,
          maxModelLen: o.vllm.maxModelLen,
          metrics: o.vllm.metrics
        } : null,
        // vllm serve arguments, with the model path shortened to its folder name
        serveArgs: vllmProc ? vllmProc.args.map((a, i) => (i === 0 ? baseName(a) : a)) : null,
        gpu: gpu ? {
          name: gpu.name,
          index: gpu.index,
          memoryUsedMiB: gpu.memory_used_mib,
          memoryTotalMiB: gpu.memory_total_mib,
          utilizationPct: gpu.utilization_pct,
          temperatureC: gpu.temperature_c,
          powerW: gpu.power_w
        } : null,
        catalogue,
        extraOnController,
        checkedAt: new Date().toISOString()
      });
    } catch (err) {
      res.status(500).json({ error: 'Could not read the model status' });
    }
  });

  // --- switching the model -----------------------------------------------------

  const personLabel = u => `${`${u.first_name || ''} ${u.last_name || ''}`.trim() || u.username} (${u.username})`;

  router.get('/setup/switch', ...setupGate, wrap(async (req, res) => {
    const cfg = readConfig(coreApi);
    const s = switcher.state();
    const [load, o] = await Promise.all([switcher.load(cfg), overview(coreApi)]);
    const infoData = o.info && o.info.ok ? o.info.data : null;
    const table = infoData ? infoData.controller_table || {} : {};
    const contexts = infoData ? infoData.controller_context || {} : {};
    res.json({
      canSwitch: await perms.canSwitch(coreApi, req.user),
      canEditPolicy: await perms.isPolicyUser(coreApi, req.user),
      models: cfg.models.map(m => ({
        ...m, variants: precision.offered(m.keyword, table).map(v => ({ key: v.key, label: v.label, context: contexts[v.key] || null }))
      })),
      loaded: o.controller && o.controller.state === 'running' ? o.controller.keyword : null,
      ...s,
      load
    });
  }));

  router.post('/setup/switch', ...switchGate, wrap(async (req, res) => {
    const { keyword, variant, mode } = req.body || {};
    await switcher.start(coreApi, { keyword, variant: typeof variant === 'string' && variant ? variant : undefined, mode, user: req.user });
    res.status(202).json(switcher.state());
  }));

  router.post('/setup/switch/cancel', ...switchGate, wrap(async (req, res) => {
    switcher.cancel();
    res.json(switcher.state());
  }));

  router.get('/setup/switch/log', ...setupGate, wrap(async (req, res) => {
    const rows = await coreApi.pool.query('SELECT * FROM ai_model_switch_log ORDER BY id DESC LIMIT 50');
    const people = new Map((await coreApi.listUsers()).map(u => [Number(u.id), personLabel(u)]));
    const label = (kw) => {
      const m = readConfig(coreApi).models.find(x => x.keyword === precision.modelOf(kw));
      return m ? precision.label(m.label, kw) : kw;
    };
    const active = switcher.isActive();
    res.json({
      log: rows.map((r, i) => ({
        id: r.id, from: r.from_keyword && label(r.from_keyword), to: label(r.to_keyword), source: r.source,
        by: r.user_id ? people.get(Number(r.user_id)) || 'a removed user' : null,
        // "running" with no switch going on: the backend was restarted meanwhile
        status: r.status === 'running' && !(active && i === 0) ? 'interrupted' : r.status,
        message: r.message, seconds: r.seconds, startedAt: r.started_at
      }))
    });
  }));

  router.get('/setup/switchers', ...setupGate, wrap(async (req, res) => {
    const saved = await perms.getSwitchers(coreApi.pool);
    const roles = (await coreApi.listRoles()).filter(r => !perms.POLICY_ROLES.includes(r));
    const users = (await coreApi.listUsers()).filter(u => saved.users.includes(Number(u.id)));
    res.json({
      always: perms.POLICY_ROLES, roles: saved.roles, users: saved.users, availableRoles: roles,
      people: users.map(u => ({ id: Number(u.id), label: personLabel(u) })),
      canEdit: await perms.isPolicyUser(coreApi, req.user)
    });
  }));

  router.put('/setup/switchers', ...policyGate, wrap(async (req, res) => {
    res.json(await perms.saveSwitchers(coreApi, req.body || {}, req.user.id));
  }));

  // --- per-model answer settings --------------------------------------------------

  const NUMBERS = { temperature: [0, 2], top_p: [0.01, 1], top_k: [1, 1000] };

  router.get('/setup/model-settings', ...setupGate, wrap(async (req, res) => {
    res.json({
      settings: await getSetting(coreApi.pool, 'model.settings', {}),
      defaultSystemPrompt: DEFAULT_SYSTEM,
      ranges: NUMBERS,
      models: readConfig(coreApi).models,
      canEdit: await perms.isPolicyUser(coreApi, req.user)
    });
  }));

  router.put('/setup/model-settings/:keyword', ...policyGate, wrap(async (req, res) => {
    const { keyword } = req.params;
    if (!readConfig(coreApi).models.some(m => m.keyword === keyword)) return res.status(404).json({ error: 'This model is not offered.' });
    const body = req.body || {};
    const clean = {};
    if (typeof body.systemPrompt === 'string') clean.systemPrompt = body.systemPrompt.slice(0, 8000);
    for (const [key, [min, max]] of Object.entries(NUMBERS)) {
      const v = body[key];
      if (v === null || v === undefined || v === '') continue;
      if (typeof v !== 'number' || !(v >= min && v <= max) || (key === 'top_k' && !Number.isInteger(v))) {
        return res.status(400).json({ error: `${key} must be between ${min} and ${max}` });
      }
      clean[key] = v;
    }
    const all = { ...(await getSetting(coreApi.pool, 'model.settings', {})) };
    if (Object.keys(clean).length) all[keyword] = clean; else delete all[keyword];
    await setSetting(coreApi.pool, 'model.settings', all, req.user.id);
    return res.json({ settings: all });
  }));

  // --- limits and usage --------------------------------------------------------

  router.get('/setup/limits', ...setupGate, wrap(async (req, res) => {
    res.json({
      values: await getLimits(coreApi.pool), defaults: DEFAULTS,
      specs: Object.entries(LIMITS).map(([key, s]) => ({ key, min: s.min, max: s.max, unit: s.unit, label: s.label, help: s.help })),
      canEdit: await perms.isPolicyUser(coreApi, req.user)
    });
  }));

  // Body: { key: number, or null for the default }
  router.put('/setup/limits', ...policyGate, wrap(async (req, res) => {
    res.json({ values: await saveLimits(coreApi.pool, req.body, req.user.id) });
  }));

  // Figures only: no names and no text, ever.
  router.get('/setup/usage', ...setupGate, wrap(async (req, res) => {
    const days = [1, 7, 30, 90, 365].includes(Number(req.query.days)) ? Number(req.query.days) : 7;
    const cfg = readConfig(coreApi);
    const rows = await coreApi.pool.query(
      `SELECT DATE_FORMAT(created_at, '%Y-%m-%d') AS day, keyword, COUNT(*) AS answers, COUNT(DISTINCT user_id) AS people,
              CAST(COALESCE(SUM(prompt_tokens), 0) AS DOUBLE) AS prompt_tokens,
              CAST(COALESCE(SUM(completion_tokens), 0) AS DOUBLE) AS completion_tokens,
              CAST(AVG(duration_ms) AS DOUBLE) AS avg_ms, CAST(AVG(first_token_ms) AS DOUBLE) AS avg_first_ms,
              CAST(MAX(queue_ms) AS DOUBLE) AS max_queue_ms,
              CAST(SUM(status = 'error') AS DOUBLE) AS errors, CAST(SUM(status = 'stopped') AS DOUBLE) AS stopped
         FROM ai_usage WHERE created_at >= NOW() - INTERVAL ? DAY
        GROUP BY day, keyword ORDER BY day DESC, keyword`, [days]);
    const [people] = await coreApi.pool.query('SELECT COUNT(DISTINCT user_id) AS n FROM ai_usage WHERE created_at >= NOW() - INTERVAL ? DAY', [days]);
    const [disk] = await coreApi.pool.query('SELECT COUNT(*) AS people, CAST(COALESCE(SUM(used_bytes), 0) AS DOUBLE) AS bytes, MAX(checked_at) AS checked FROM ai_storage_users');
    const snap = await vllm.snapshot(cfg);
    let server = null;
    if (snap.metrics && snap.metrics.startedAt) {
      const [mff] = await coreApi.pool.query(
        `SELECT CAST(COALESCE(SUM(prompt_tokens), 0) AS DOUBLE) AS p, CAST(COALESCE(SUM(completion_tokens), 0) AS DOUBLE) AS c
           FROM ai_usage WHERE created_at >= FROM_UNIXTIME(?)`, [Math.floor(snap.metrics.startedAt / 1000)]);
      server = {
        since: new Date(snap.metrics.startedAt).toISOString(),
        read: snap.metrics.promptTokensTotal, written: snap.metrics.generationTokensTotal, mffRead: mff.p, mffWritten: mff.c
      };
    }
    const label = kw => (cfg.models.find(m => m.keyword === kw) || { label: kw || 'no model' }).label;
    res.json({
      days, people: Number(people.n), now: gens.counts(),
      rows: rows.map(r => ({ ...r, answers: Number(r.answers), people: Number(r.people), model: label(r.keyword) })),
      storage: { people: Number(disk.people), bytes: disk.bytes, checkedAt: disk.checked }, server
    });
  }));

  // --- tools -----------------------------------------------------------------------

  router.get('/setup/tools', ...setupGate, wrap(async (req, res) => {
    const state = await tools.getState(coreApi.pool);
    const cfg = readConfig(coreApi);
    const o = await overview(coreApi);
    const people = new Map((await coreApi.listUsers()).map(u => [Number(u.id), personLabel(u)]));
    const log = await coreApi.pool.query('SELECT * FROM ai_tool_log ORDER BY id DESC LIMIT 30');
    res.json({
      tools: [
        ...tools.CATALOGUE.map(t => ({ ...tools.card(t), available: true, installed: Boolean(state[t.key]), ...(state[t.key] || {}) })),
        ...tools.UNAVAILABLE.map(t => ({ ...tools.card(t), available: false, installed: false }))
      ],
      capableModels: cfg.models.filter(m => m.capabilities.includes('tools')).map(m => m.label),
      loadedModel: o.model ? o.model.label : null,
      loadedCanUse: Boolean(o.model && o.model.capabilities.includes('tools')),
      roles: await coreApi.listRoles(),
      canEdit: await perms.isPolicyUser(coreApi, req.user),
      log: log.map(r => ({ id: r.id, tool: r.tool, action: r.action, at: r.created_at, by: people.get(Number(r.user_id)) || 'a removed user' }))
    });
  }));

  router.post('/setup/tools/:key', ...policyGate, wrap(async (req, res) => {
    await tools.change(coreApi, req.params.key, req.body, req.user.id);
    res.json({ success: true });
  }));

  // --- skills ----------------------------------------------------------------------

  router.get('/setup/skills', ...setupGate, wrap(async (req, res) => {
    const cfg = readConfig(coreApi);
    const o = await overview(coreApi);
    const people = new Map((await coreApi.listUsers()).map(u => [Number(u.id), personLabel(u)]));
    const label = kw => (cfg.models.find(m => m.keyword === kw) || { label: kw || '?' }).label;
    const [list, uses, changes] = await Promise.all([
      skills.list(coreApi.pool),
      coreApi.pool.query('SELECT * FROM ai_skill_log ORDER BY id DESC LIMIT 50'),
      coreApi.pool.query('SELECT * FROM ai_skill_audit ORDER BY id DESC LIMIT 30')
    ]);
    const who = id => (id === null || id === undefined ? 'unknown' : people.get(Number(id)) || 'a removed user');
    res.json({
      skills: list.map(s => ({ ...s, updatedBy: s.updatedBy === null ? null : who(s.updatedBy) })),
      max: skills.MAX,
      template: skills.TEMPLATE,
      capableModels: cfg.models.filter(m => m.capabilities.includes('tools')).map(m => m.label),
      loadedModel: o.model ? o.model.label : null,
      loadedCanUse: Boolean(o.model && o.model.capabilities.includes('tools')),
      canEdit: await perms.isPolicyUser(coreApi, req.user),
      uses: uses.map(r => ({
        id: Number(r.id), answer: r.answer_id.slice(0, 8), skill: r.skill, file: r.file_name, model: label(r.keyword), by: who(r.user_id), at: r.created_at
      })),
      changes: changes.map(r => ({ id: Number(r.id), skill: r.skill, action: r.action, by: who(r.user_id), at: r.created_at }))
    });
  }));

  router.get('/setup/skills/:id', ...setupGate, wrap(async (req, res) => {
    res.json({ skill: await skills.get(coreApi.pool, intId(req.params.id) || -1) });
  }));
  router.post('/setup/skills', ...policyGate, wrap(async (req, res) => {
    res.status(201).json({ id: await skills.save(coreApi.pool, 0, req.body, req.user.id) });
  }));
  router.put('/setup/skills/:id', ...policyGate, wrap(async (req, res) => {
    res.json({ id: await skills.save(coreApi.pool, intId(req.params.id) || -1, req.body, req.user.id) });
  }));
  router.post('/setup/skills/:id/enabled', ...policyGate, wrap(async (req, res) => {
    await skills.setEnabled(coreApi.pool, intId(req.params.id) || -1, Boolean(req.body && req.body.enabled), req.user.id);
    res.json({ success: true });
  }));
  router.delete('/setup/skills/:id', ...policyGate, wrap(async (req, res) => {
    await skills.remove(coreApi.pool, intId(req.params.id) || -1, req.user.id);
    res.json({ success: true });
  }));

  // --- safety and scope ------------------------------------------------------------

  router.get('/setup/safety', ...setupGate, wrap(async (req, res) => {
    const cfg = readConfig(coreApi);
    const days = [1, 7, 30].includes(Number(req.query.days)) ? Number(req.query.days) : 7;
    const people = new Map((await coreApi.listUsers()).map(u => [Number(u.id), personLabel(u)]));
    const [settings, guard, events, delay, counts] = await Promise.all([
      safety.getSettings(coreApi.pool),
      safety.guardStatus(cfg),
      coreApi.pool.query("SELECT * FROM ai_safety_log WHERE result <> 'pass' ORDER BY id DESC LIMIT 50"),
      // added delay per answer: the checks the asker waits for
      coreApi.pool.query(
        `SELECT level, COUNT(*) AS answers, AVG(t) AS avg_ms, MAX(t) AS max_ms FROM (
           SELECT answer_id, level, SUM(ms) AS t FROM ai_safety_log
            WHERE stage IN ('question', 'scope', 'answer') AND created_at > NOW() - INTERVAL ? DAY GROUP BY answer_id, level) x
          GROUP BY level`, [days]),
      coreApi.pool.query(
        `SELECT stage, result, COUNT(*) AS n, AVG(ms) AS avg_ms FROM ai_safety_log
          WHERE created_at > NOW() - INTERVAL ? DAY GROUP BY stage, result ORDER BY stage, result`, [days])
    ]);
    res.json({
      settings,
      guard,
      roles: (await coreApi.listRoles()).filter(r => !perms.POLICY_ROLES.includes(r)),
      developerRoles: perms.POLICY_ROLES,
      levels: safety.LEVELS.map(l => ({ key: l, label: safety.LEVEL_LABEL[l] })),
      canEdit: await perms.isPolicyUser(coreApi, req.user),
      days,
      delay: delay.map(d => ({ level: d.level, answers: Number(d.answers), avgMs: Math.round(Number(d.avg_ms)), maxMs: Number(d.max_ms) })),
      counts: counts.map(c => ({ stage: c.stage, result: c.result, n: Number(c.n), avgMs: Math.round(Number(c.avg_ms)) })),
      events: events.map(e => ({
        id: Number(e.id), at: e.created_at, by: e.user_id ? people.get(Number(e.user_id)) || 'a removed user' : '-', level: e.level,
        stage: e.stage, result: e.result, label: e.label, categories: e.categories, ms: e.ms, answer: e.answer_id.slice(0, 8)
      }))
    });
  }));

  router.put('/setup/safety', ...policyGate, wrap(async (req, res) => {
    res.json({ settings: await safety.saveSettings(coreApi, req.body, req.user.id) });
  }));

  // --- benchmark -------------------------------------------------------------------

  const intId = (v) => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : 0; };

  router.get('/setup/benchmark', ...setupGate, wrap(async (req, res) => {
    const cfg = readConfig(coreApi);
    const people = new Map((await coreApi.listUsers()).map(u => [Number(u.id), personLabel(u)]));
    const runs = await coreApi.pool.query('SELECT * FROM ai_benchmark_runs ORDER BY id DESC LIMIT 50');
    const active = benchmark.view();
    const label = kw => (cfg.models.find(m => m.keyword === kw) || { label: kw }).label;
    res.json({
      active, models: cfg.models, load: await switcher.load(cfg),
      canRun: await perms.canSwitch(coreApi, req.user), canEdit: await perms.isPolicyUser(coreApi, req.user),
      prompts: await benchmark.listPrompts(coreApi.pool),
      runs: runs.map(r => ({
        id: Number(r.id), by: people.get(Number(r.user_id)) || null, models: r.models.split(',').map(label), think: Boolean(r.think),
        status: r.status === 'running' && !(active && active.runId === Number(r.id)) ? 'interrupted' : r.status,
        message: r.status === 'running' && !(active && active.runId === Number(r.id))
          ? 'MFF was restarted while it ran. Check on Setup → Model which model is loaded.' : r.message,
        startedAt: r.started_at, finishedAt: r.finished_at
      }))
    });
  }));

  router.get('/setup/benchmark/runs/:id', ...setupGate, wrap(async (req, res) => {
    const id = intId(req.params.id);
    const [models, results] = await Promise.all([
      coreApi.pool.query('SELECT * FROM ai_benchmark_models WHERE run_id = ? ORDER BY id', [id]),
      coreApi.pool.query('SELECT * FROM ai_benchmark_results WHERE run_id = ? ORDER BY id', [id])
    ]);
    if (!models.length && !results.length) return res.status(404).json({ error: 'This benchmark has no results.' });
    return res.json({
      models: models.map(m => ({
        keyword: m.keyword, label: m.label, loadSeconds: m.load_seconds, gpuMemoryMiB: m.gpu_memory_mib,
        kvCacheTokens: m.kv_cache_tokens, maxConcurrency: m.max_concurrency, maxModelLen: m.max_model_len
      })),
      results: results.map(r => ({
        id: Number(r.id), keyword: r.keyword, promptId: Number(r.prompt_id), title: r.title, kind: r.kind, prompt: r.prompt, status: r.status,
        answer: r.answer, firstMs: r.first_ms, totalMs: r.total_ms, promptTokens: r.prompt_tokens, tokens: r.tokens,
        perSecond: r.tokens_per_second, pass: r.auto_pass === null ? null : Boolean(r.auto_pass), score: r.score
      }))
    });
  }));

  router.post('/setup/benchmark/start', ...switchGate, wrap(async (req, res) => {
    const { models, think, mode } = req.body || {};
    const runId = await benchmark.start(coreApi, { user: req.user, keywords: models, think, mode });
    res.status(202).json({ runId });
  }));

  router.post('/setup/benchmark/cancel', ...switchGate, wrap(async (req, res) => {
    benchmark.cancel();
    res.json({ success: true });
  }));

  router.put('/setup/benchmark/results/:id/score', ...switchGate, wrap(async (req, res) => {
    const score = req.body && req.body.score;
    if (score !== null && !(Number.isInteger(score) && score >= 1 && score <= 5)) return res.status(400).json({ error: 'A score is 1 to 5.' });
    await coreApi.pool.query('UPDATE ai_benchmark_results SET score = ?, scored_by = ? WHERE id = ?', [score, req.user.id, intId(req.params.id)]);
    return res.json({ success: true });
  }));

  router.post('/setup/benchmark/prompts', ...policyGate, wrap(async (req, res) => {
    res.status(201).json({ id: await benchmark.savePrompt(coreApi.pool, 0, req.body) });
  }));
  router.put('/setup/benchmark/prompts/:id', ...policyGate, wrap(async (req, res) => {
    res.json({ id: await benchmark.savePrompt(coreApi.pool, intId(req.params.id) || -1, req.body) });
  }));
  router.delete('/setup/benchmark/prompts/:id', ...policyGate, wrap(async (req, res) => {
    await benchmark.deletePrompt(coreApi.pool, intId(req.params.id));
    res.json({ success: true });
  }));

  return router;
};

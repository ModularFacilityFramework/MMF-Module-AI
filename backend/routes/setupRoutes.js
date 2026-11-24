// Setup page routes. The Setup page is the manifest page "setup": core's
// normal page access decides who may open it (Setup -> Preferences -> Access;
// a declared page with no grants is developer/administrator only). Actions on
// the shared GPU or on limits get their own, stricter checks in later steps.
const express = require('express');
const { configStatus } = require('../lib/config');
const { overview } = require('../lib/status');

const baseName = p => (p || '').split('/').filter(Boolean).pop() || '';

module.exports = function buildSetupRouter(coreApi) {
  const router = express.Router();
  const setupGate = [coreApi.authenticateToken, coreApi.requirePage('setup')];

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

      const catalogue = o.cfg.models.map(m => {
        const path = table[m.keyword];
        const s = path ? summaries[path] : null;
        return {
          keyword: m.keyword,
          label: m.label,
          capabilities: m.capabilities,
          knownToController: Boolean(path),
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
      const extraOnController = Object.keys(table).filter(kw => !o.cfg.models.some(m => m.keyword === kw));

      res.json({
        state: o.state,
        message: o.message,
        keyword: o.keyword,
        model: o.model,
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

  return router;
};

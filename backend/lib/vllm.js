// Read-only client for the vLLM OpenAI-compatible server. Uses Node 20's
// global fetch. Never throws: every call answers { ok, ... } so callers can
// show "down" instead of crashing.

function headers(cfg) {
  const h = { Accept: 'application/json' };
  if (cfg.vllmApiKey) h.Authorization = `Bearer ${cfg.vllmApiKey}`;
  return h;
}

async function getJson(cfg, path, timeoutMs) {
  try {
    const res = await fetch(cfg.vllmUrl + path, { headers: headers(cfg), signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return { ok: false, status: res.status, error: `HTTP ${res.status}` };
    return { ok: true, data: await res.json() };
  } catch (err) {
    return { ok: false, error: err.name === 'TimeoutError' ? 'timed out' : (err.cause?.code || err.message) };
  }
}

async function getText(cfg, path, timeoutMs) {
  try {
    const res = await fetch(cfg.vllmUrl + path, { headers: headers(cfg), signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return { ok: false, status: res.status, error: `HTTP ${res.status}` };
    return { ok: true, data: await res.text() };
  } catch (err) {
    return { ok: false, error: err.name === 'TimeoutError' ? 'timed out' : (err.cause?.code || err.message) };
  }
}

// Prometheus text -> the few vLLM figures we show. Labels other than the
// ones we read are ignored.
function parseMetrics(text) {
  const out = {};
  const num = (name) => {
    const m = text.match(new RegExp(`^${name}\\{[^}]*\\}\\s+([0-9.eE+-]+)`, 'm'));
    return m ? Number(m[1]) : null;
  };
  out.running = num('vllm:num_requests_running');
  out.waiting = num('vllm:num_requests_waiting');
  out.kvCacheUsage = num('vllm:kv_cache_usage_perc');
  out.promptTokensTotal = num('vllm:prompt_tokens_total');
  out.generationTokensTotal = num('vllm:generation_tokens_total');
  const info = text.match(/^vllm:cache_config_info\{([^}]*)\}/m);
  if (info) {
    const label = (k) => {
      const m = info[1].match(new RegExp(`(?:^|,)${k}="([^"]*)"`));
      return m ? m[1] : null;
    };
    out.kvCacheTokens = Number(label('kv_cache_size_tokens')) || null;
    out.maxConcurrency = Number(label('kv_cache_max_concurrency')) || null;
    out.gpuMemoryUtilization = Number(label('gpu_memory_utilization')) || null;
    out.prefixCaching = label('enable_prefix_caching') === 'True';
  }
  return out;
}

// Everything the status card needs from vLLM, fetched in parallel.
async function snapshot(cfg) {
  const t = Math.min(cfg.requestTimeoutS * 1000, 10000);
  const [health, models, version, metrics] = await Promise.all([
    getText(cfg, '/health', t),
    getJson(cfg, '/v1/models', t),
    getJson(cfg, '/version', t),
    getText(cfg, '/metrics', t)
  ]);
  const model = models.ok && Array.isArray(models.data.data) && models.data.data[0];
  return {
    reachable: health.ok,
    error: health.ok ? null : health.error,
    modelId: model ? model.id : null,
    maxModelLen: model ? model.max_model_len : null,
    version: version.ok ? version.data.version : null,
    metrics: metrics.ok ? parseMetrics(metrics.data) : null
  };
}

module.exports = { snapshot, parseMetrics };

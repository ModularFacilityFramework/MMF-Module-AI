// Client for the vLLM OpenAI-compatible server. Uses Node 20's global fetch.
// The status calls never throw: they answer { ok, ... } so callers can show
// "down" instead of crashing. streamChat() throws.

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

// Number of tokens in a text, or null when vLLM cannot say.
async function tokenize(cfg, modelId, text) {
  try {
    const res = await fetch(`${cfg.vllmUrl}/tokenize`, {
      method: 'POST',
      headers: { ...headers(cfg), 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: modelId, prompt: text, add_special_tokens: false }),
      signal: AbortSignal.timeout(15000)
    });
    if (!res.ok) return null;
    const data = await res.json();
    return Number.isInteger(data.count) ? data.count : null;
  } catch (err) {
    return null;
  }
}

// Streams one answer. onDelta({ reasoning?, content?, toolCalls? }) is called
// as text arrives. Aborting the signal closes the connection, which makes
// vLLM stop generating. Returns { finishReason, usage }.
async function streamChat(cfg, body, { signal, onDelta }) {
  const res = await fetch(`${cfg.vllmUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { ...headers(cfg), 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify({ ...body, stream: true, stream_options: { include_usage: true } }),
    signal
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let detail = '';
    try { detail = JSON.parse(text).error.message; } catch (err) { /* not JSON */ }
    throw Object.assign(new Error(detail || `HTTP ${res.status}`), { vllmStatus: res.status });
  }
  const out = { finishReason: null, usage: null };
  const decoder = new TextDecoder();
  let buffer = '';
  let done = false;
  const line = (l) => {
    if (!l.startsWith('data:')) return;
    const data = l.slice(5).trim();
    if (data === '[DONE]') { done = true; return; }
    let chunk;
    try { chunk = JSON.parse(data); } catch (err) { return; }
    if (chunk.error) throw new Error(chunk.error.message || 'vLLM error');
    if (chunk.usage) out.usage = chunk.usage;
    const choice = chunk.choices && chunk.choices[0];
    if (!choice) return;
    if (choice.finish_reason) out.finishReason = choice.finish_reason;
    const d = choice.delta || {};
    onDelta({ reasoning: d.reasoning || d.reasoning_content || '', content: d.content || '', toolCalls: d.tool_calls || null });
  };
  for await (const part of res.body) {
    buffer += decoder.decode(part, { stream: true });
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      line(buffer.slice(0, nl).replace(/\r$/, ''));
      buffer = buffer.slice(nl + 1);
    }
  }
  if (!done && !out.finishReason) throw new Error('the connection to the model closed early');
  return out;
}

module.exports = { snapshot, parseMetrics, tokenize, streamChat };

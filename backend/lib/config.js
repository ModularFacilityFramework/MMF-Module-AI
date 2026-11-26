// Reads this module's settings from core's one .env through
// coreApi.getModuleConfig() (MODULE_AI_* with the prefix stripped). Nothing
// site-specific is hard-coded here: the defaults below are only for optional
// keys. See docs/MFF-Core_module-core-api.md, "getModuleConfig()".

const REQUIRED_KEYS = ['VLLM_URL', 'CTL_SSH_HOST', 'CTL_SSH_USER', 'CTL_SSH_KEY_PATH', 'CTL_SSH_KNOWN_HOSTS', 'MODELS'];
const KNOWN_CAPABILITIES = ['vision', 'thinking', 'thinking-r1', 'tools'];
const KEYWORD_RE = /^[a-z0-9_-]{1,32}$/;

// "qwen=Qwen3.6 27B|vision,thinking,tools;mistral=Mistral Small|vision"
// -> { models: [{ keyword, label, capabilities }], errors: [...] }
function parseModels(raw) {
  const models = [];
  const errors = [];
  if (!raw) return { models, errors };
  for (const part of String(raw).split(';')) {
    const entry = part.trim();
    if (!entry) continue;
    const eq = entry.indexOf('=');
    if (eq < 1) {
      errors.push(`"${entry}" has no keyword=label`);
      continue;
    }
    const keyword = entry.slice(0, eq).trim();
    const [labelPart, capsPart = ''] = entry.slice(eq + 1).split('|');
    const label = labelPart.trim() || keyword;
    if (!KEYWORD_RE.test(keyword)) {
      errors.push(`"${keyword}" is not a valid keyword (a-z, 0-9, _ or -)`);
      continue;
    }
    if (models.some(m => m.keyword === keyword)) {
      errors.push(`"${keyword}" is listed twice`);
      continue;
    }
    const capabilities = capsPart.split(',').map(c => c.trim()).filter(Boolean);
    const unknown = capabilities.filter(c => !KNOWN_CAPABILITIES.includes(c));
    if (unknown.length) errors.push(`"${keyword}" has unknown capabilities: ${unknown.join(', ')}`);
    models.push({ keyword, label, capabilities: capabilities.filter(c => KNOWN_CAPABILITIES.includes(c)) });
  }
  return { models, errors };
}

function positiveInt(value, fallback) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

// The full config, for backend use only. Never send this object to a browser:
// it holds paths and (optionally) the vLLM key.
function readConfig(coreApi) {
  const cfg = coreApi.getModuleConfig() || {};
  const { models, errors } = parseModels(cfg.MODELS);
  return {
    vllmUrl: (cfg.VLLM_URL || '').replace(/\/+$/, ''),
    vllmApiKey: cfg.VLLM_API_KEY || '',
    // the guard model (Qwen3Guard) served beside the main model; optional
    guardUrl: (cfg.GUARD_URL || '').replace(/\/+$/, ''),
    ssh: {
      host: cfg.CTL_SSH_HOST || '',
      port: positiveInt(cfg.CTL_SSH_PORT, 22),
      user: cfg.CTL_SSH_USER || '',
      keyPath: cfg.CTL_SSH_KEY_PATH || '',
      knownHosts: cfg.CTL_SSH_KNOWN_HOSTS || ''
    },
    models,
    modelErrors: errors,
    storageSubdir: /^[A-Za-z0-9_.-]+$/.test(cfg.STORAGE_SUBDIR || '') ? cfg.STORAGE_SUBDIR : 'module-AI',
    requestTimeoutS: positiveInt(cfg.REQUEST_TIMEOUT_S, 60),
    switchTimeoutS: positiveInt(cfg.SWITCH_TIMEOUT_S, 600),
    missing: REQUIRED_KEYS.filter(k => !cfg[k])
  };
}

// What the Setup page may see: which keys are set (never their values, except
// the model list, which is display data) and any problems.
function configStatus(coreApi) {
  const cfg = coreApi.getModuleConfig() || {};
  const parsed = readConfig(coreApi);
  return {
    keys: REQUIRED_KEYS.concat(['GUARD_URL', 'VLLM_API_KEY', 'CTL_SSH_PORT', 'STORAGE_SUBDIR', 'REQUEST_TIMEOUT_S', 'SWITCH_TIMEOUT_S'])
      .map(key => ({ key: `MODULE_AI_${key}`, required: REQUIRED_KEYS.includes(key), set: Boolean(cfg[key]) })),
    missing: parsed.missing.map(k => `MODULE_AI_${k}`),
    models: parsed.models,
    modelErrors: parsed.modelErrors,
    apiKeyInUse: Boolean(parsed.vllmApiKey),
    storageSubdir: parsed.storageSubdir
  };
}

module.exports = { readConfig, configStatus, parseModels, REQUIRED_KEYS };

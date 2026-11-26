// Precision variants of a model. The AI server's controller knows each variant
// as its own keyword (for example "qwen-fp8"); every variant is served under
// the model's own name ("qwen"), so the chat sees the same model with the same
// capabilities. A variant is offered only when the controller knows it.
//
// The context length of each variant is set in the controller, from the
// measurements on the AI server (26/11/2026, see docs/MFF-Module-AI_config.md);
// the page shows what vLLM really reports.
const VARIANTS = {
  qwen: [
    { key: 'qwen', label: 'bf16 weights, bf16 KV cache', weights: 'bf16', kv: 'bf16' },
    { key: 'qwen-fp8kv', label: 'bf16 weights, FP8 KV cache', weights: 'bf16', kv: 'fp8' },
    { key: 'qwen-fp8', label: 'FP8 weights, FP8 KV cache', weights: 'fp8', kv: 'fp8' }
  ]
};

// The model keyword a controller keyword belongs to.
function modelOf(controllerKeyword) {
  if (!controllerKeyword) return null;
  for (const [model, list] of Object.entries(VARIANTS)) {
    if (list.some(v => v.key === controllerKeyword)) return model;
  }
  return controllerKeyword;
}

function variant(controllerKeyword) {
  const list = VARIANTS[modelOf(controllerKeyword)] || [];
  return list.find(v => v.key === controllerKeyword) || null;
}

// The variants of a model that the controller knows, or [] when it has none.
function offered(modelKeyword, controllerTable) {
  const list = VARIANTS[modelKeyword] || [];
  const known = list.filter(v => Object.prototype.hasOwnProperty.call(controllerTable || {}, v.key));
  return known.length > 1 ? known : [];
}

// "Qwen3.6 27B" + "qwen-fp8" -> "Qwen3.6 27B (FP8 weights, FP8 KV cache)"; a
// model without variants keeps its own label.
function label(modelLabel, controllerKeyword) {
  const v = variant(controllerKeyword);
  return v ? `${modelLabel} (${v.label})` : modelLabel;
}

// What is really loaded, from the running vllm serve arguments and the model
// folder's config: { weights, kv } as shown on the page.
function live(serveArgs, summary) {
  if (!serveArgs) return null;
  const at = serveArgs.indexOf('--kv-cache-dtype');
  const kvArg = at >= 0 ? serveArgs[at + 1] : 'auto';
  const dtype = summary && summary.dtype ? String(summary.dtype).replace('bfloat16', 'bf16').replace('float16', 'fp16').toUpperCase() : null;
  const quant = summary && summary.quantized ? String(summary.quant_method || 'quantized').toUpperCase() : null;
  return {
    weights: quant || dtype || 'unknown',
    kv: kvArg === 'auto' ? (dtype || 'same as the weights') : kvArg.toUpperCase()
  };
}

module.exports = { VARIANTS, modelOf, variant, offered, label, live };

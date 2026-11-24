// Produces one answer: waits its turn, sends the conversation to vLLM, streams
// the text into the generation, and saves the result in the user's storage.
const { randomUUID } = require('crypto');
const storage = require('./storage');
const vllm = require('./vllm');
const gens = require('./generations');
const context = require('./context');
const { overview } = require('./status');
const { getSetting } = require('./settings');
const { recordUsage } = require('./usage');
const tools = require('./tools');

const { HttpError } = storage;
const MAX_TOOL_ROUNDS = 5;
const MAX_TOOL_CALLS = 12;
const TOOL_PROMPT_OVERHEAD = 500;  // what the chat template adds around tool descriptions
const TOOL_RESULT_RESERVE = 5000;  // room kept for tool answers
const DEFAULT_SYSTEM = 'You are a helpful assistant for the members of a research facility. Answer clearly and say when you are not sure. Format answers in Markdown.';

// Who may be answered right now? Throws a clear error otherwise.
async function requireReady(coreApi) {
  const o = await overview(coreApi);
  if (o.state !== 'ready') throw new HttpError(503, o.state, o.message);
  return o;
}

async function modelSettings(pool, keyword) {
  const all = await getSetting(pool, 'model.settings', {}).catch(() => ({}));
  return (all && all[keyword]) || {};
}

const splitInlineThinking = (content) => {
  // Only for a model served without a reasoning parser: "...thinking</think>answer"
  const at = content.indexOf('</think>');
  if (at < 0) return null;
  return { reasoning: content.slice(0, at).replace(/^\s*<think>/, '').trim(), content: content.slice(at + 8).trim() };
};

function friendlyError(err) {
  if (err instanceof HttpError) return err.message;
  if (err.vllmStatus === 400 && /context length|maximum.*tokens|too long/i.test(err.message)) {
    return 'The conversation is too long for the model.';
  }
  if (err.vllmStatus === 400) return 'The model refused this question.';
  return 'The AI could not be reached, or stopped while answering.';
}

// Starts an answer to the last message of a chat. Returns the generation.
function startAnswer(coreApi, { user, root, chatId, think, limits }) {
  const assistantId = randomUUID();
  const askedAt = Date.now();

  async function save(g, record) {
    const message = {
      id: assistantId, role: 'assistant', content: g.content, reasoning: g.reasoning,
      notices: g.notices, ...(g.tools.length && { tools: g.tools }), at: new Date().toISOString(), ...record
    };
    g.result = { status: record.status, error: record.error || null, message };
    try {
      await storage.append(root, chatId, [message]);
    } catch (err) {
      // deleted chat: nothing to save into
      if (err.status !== 404) {
        g.result = { status: 'error', error: 'The answer could not be saved in your storage.', message: { ...message, unsaved: true } };
      }
    }
  }

  async function run(g) {
    let keyword = null;
    let label = null;
    let usage = null;
    let startedAt = Date.now();
    let firstAt = null;
    let thinkEndAt = null;
    let timer = null;
    let timedOut = null;
    const stats = () => ({
      model: label, keyword,
      usage: usage ? { prompt: usage.prompt_tokens, completion: usage.completion_tokens } : null,
      ms: Date.now() - startedAt,
      firstTokenMs: firstAt ? firstAt - startedAt : null,
      queueMs: startedAt - askedAt,
      reasoningMs: g.reasoning ? (thinkEndAt || Date.now()) - (firstAt || startedAt) : null
    });
    const total = setTimeout(() => { timedOut = 'The answer took too long and was stopped.'; g.abort.abort(); }, limits.totalTimeoutS * 1000);
    const arm = (seconds, message) => {
      clearTimeout(timer);
      timer = setTimeout(() => { timedOut = message; g.abort.abort(); }, seconds * 1000);
    };
    let status = 'done';
    let error = null;
    try {
      const o = await requireReady(coreApi);
      startedAt = Date.now();
      keyword = o.keyword;
      label = o.model ? o.model.label : o.keyword;
      g.meta.model = label;
      const caps = o.model ? o.model.capabilities : [];
      const canToggle = caps.includes('thinking');
      const thinking = caps.includes('thinking-r1') || (canToggle && think !== false);
      const maxModelLen = o.vllm.maxModelLen || 32768;
      const maxTokens = Math.min(thinking ? limits.maxTokensThinking : limits.maxTokens, Math.floor(maxModelLen / 2));
      const perModel = await modelSettings(coreApi.pool, keyword);
      const system = perModel.systemPrompt !== undefined ? perModel.systemPrompt : DEFAULT_SYSTEM;

      const history = await storage.readMessages(root, chatId);
      while (history.length && history[history.length - 1].role !== 'user') history.pop();
      if (!history.length) throw new HttpError(400, 'no_question', 'There is no question to answer.');
      // Tools take room too: their descriptions, and what they answer.
      const available = caps.includes('tools') ? await tools.forUser(coreApi, user) : [];
      const toolDefs = available.map(t => ({ type: 'function', function: t.definition }));
      const toolReserve = available.length
        ? await context.countTokens(o.cfg, o.vllm.modelId, JSON.stringify(toolDefs)) + TOOL_PROMPT_OVERHEAD + TOOL_RESULT_RESERVE : 0;
      const built = await context.build(
        { cfg: o.cfg, modelId: o.vllm.modelId, root, chatId, vision: caps.includes('vision'), maxModelLen },
        history, { system, answerReserve: maxTokens + toolReserve });
      built.notices.forEach(n => gens.notice(g, n));
      if (g.abort.signal.aborted) throw new Error('aborted');

      const body = { model: o.vllm.modelId, messages: built.messages, max_tokens: maxTokens };
      if (canToggle) body.chat_template_kwargs = { enable_thinking: thinking };
      for (const k of ['temperature', 'top_p', 'top_k']) if (typeof perModel[k] === 'number') body[k] = perModel[k];

      if (available.length) body.tools = toolDefs;

      // Usually one round. When the model asks for tools, they are run and the
      // model is asked again with their results, a limited number of times.
      let calls = 0;
      const spent = { completion_tokens: 0 };
      const handlers = {
        signal: g.abort.signal,
        onUsage: (u) => {
          usage = { prompt_tokens: u.prompt_tokens, completion_tokens: spent.completion_tokens + u.completion_tokens };
        },
        onDelta: (d) => {
          arm(limits.idleTimeoutS, 'The AI stopped in the middle of the answer.');
          if (!d.reasoning && !d.content) return;
          if (!firstAt) firstAt = Date.now();
          if (d.content && g.reasoning && !thinkEndAt) thinkEndAt = Date.now();
          gens.add(g, 'reasoning', d.reasoning);
          gens.add(g, 'content', d.content);
        }
      };
      for (let round = 0; ; round++) {
        arm(limits.firstTokenTimeoutS, 'The AI did not start answering in time.');
        const r = await vllm.streamChat(o.cfg, body, handlers);
        if (r.finishReason === 'length') status = 'length';
        if (!r.toolCalls.length || status === 'length') break;
        if (!body.tools) break; // a tool call although none were offered: ignore it
        const last = r.usage || { prompt_tokens: built.promptTokens, completion_tokens: 0 };
        spent.completion_tokens += last.completion_tokens;

        const wanted = r.toolCalls.map((c, i) => ({ ...c, id: c.id || `call_${round}_${i}` }));
        body.messages = [...body.messages, {
          role: 'assistant', content: '',
          tool_calls: wanted.map(c => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments || '{}' } }))
        }];
        let room = maxModelLen - last.prompt_tokens - last.completion_tokens - 1200;
        for (const c of wanted) {
          calls += 1;
          const res = calls > MAX_TOOL_CALLS
            ? { ok: false, text: 'Error: too many tool calls for one answer.' }
            : await tools.call(available, c.name, c.arguments, { root, chatId, history });
          let text = res.text;
          const budget = Math.max(200, Math.floor(room * 2)); // characters; about 3 per token
          if (text.length > budget) text = `${text.slice(0, budget)}\n(cut: no more room)`;
          room -= Math.ceil(text.length / 2.5);
          gens.tool(g, { name: res.label || c.name, args: JSON.stringify(res.args || {}).slice(0, 300), ok: res.ok, result: text.slice(0, 600) });
          body.messages.push({ role: 'tool', tool_call_id: c.id, content: text });
        }
        if (g.abort.signal.aborted) throw new Error('aborted');
        body.max_tokens = Math.max(256, Math.min(maxTokens, room));
        // Last round, or hardly any room left: no more tools, just answer.
        if (round + 1 >= MAX_TOOL_ROUNDS || room < 2500) {
          delete body.tools;
        }
      }
      if (!g.content && status === 'done') {
        status = 'error';
        error = 'The AI finished without writing an answer. Try "Answer again".';
      }
      if (!g.reasoning && thinking) {
        const split = splitInlineThinking(g.content);
        if (split) Object.assign(g, split);
      }
    } catch (err) {
      if (timedOut) {
        status = 'error';
        error = timedOut;
      } else if (g.stopReason) {
        status = 'stopped';
        if (g.stopReason === 'switch') error = 'Stopped because the AI model is being changed.';
      } else {
        status = 'error';
        error = friendlyError(err);
      }
    } finally {
      clearTimeout(timer);
      clearTimeout(total);
    }
    await save(g, { status, error, ...stats() });
    await recordUsage(coreApi.pool, { userId: user.id, keyword, status, ...stats() });
  }

  return gens.create({
    userId: user.id, chatId, limits, run,
    meta: { assistantId, think: think !== false, model: null },
    onCancelled: g => save(g, { status: 'stopped', error: null, model: null, keyword: null, usage: null, ms: 0 })
  });
}

module.exports = { startAnswer, requireReady, DEFAULT_SYSTEM };

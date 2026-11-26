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
const skills = require('./skills');
const safety = require('./safety');
const docs = require('./docs');

const { HttpError } = storage;
const MAX_TOOL_ROUNDS = 5;
const MAX_TOOL_CALLS = 12;
const MAX_CALL_CHARS = 2000;
const TOOL_PROMPT_OVERHEAD = 500;  // what the chat template adds around tool descriptions
const TOOL_RESULT_RESERVE = 5000;  // room kept for tool answers
const TOOL_RULE = 'You have tools. To make or change a file you must call the tool in this answer; never say that a file was made or changed unless its tool call succeeded in this answer.';
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

// Ends an answer early with a fixed text (safety, scope): not an error.
class Answered extends Error {
  constructor(text, status, why) {
    super(why || 'answered');
    this.text = text;
    this.status = status;
  }
}

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
      notices: g.notices, ...(g.tools.length && { tools: g.tools }), ...(g.files.length && { files: g.files }), at: new Date().toISOString(), ...record
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
      reasoningMs: g.reasoning ? (thinkEndAt || Date.now()) - (firstAt || startedAt) : null,
      safetyMs: safetyMs.question + safetyMs.scope + safetyMs.answer
    });
    const total = setTimeout(() => { timedOut = 'The answer took too long and was stopped.'; g.abort.abort(); }, limits.totalTimeoutS * 1000);
    const arm = (seconds, message) => {
      clearTimeout(timer);
      timer = setTimeout(() => { timedOut = message; g.abort.abort(); }, seconds * 1000);
    };
    let status = 'done';
    let error = null;
    let blockedBy = null; // set when the guard stops the answer while it is written
    const safetyMs = { question: 0, scope: 0, answer: 0 };
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

      // --- safety and scope (safety.js), before anything reaches the model ---
      const sset = await safety.getSettings(coreApi.pool);
      const level = await safety.levelFor(coreApi, user, sset);
      const pol = safety.policy(sset, level);
      if (pol.scan) g.scan = safety.redactor(o.cfg, sset);
      const question = history[history.length - 1].text || '';
      const note = (stage, result, r) => safety.log(coreApi.pool, {
        answerId: assistantId, userId: user.id, level, stage, result, label: r && r.label, categories: r && r.categories, ms: r ? r.ms : 0
      });
      const guardDown = async (stage, r) => {
        await note(stage, 'error', r);
        if (sset.guardDown === 'refuse') throw new Answered(safety.TEXT.guardDown, 'blocked');
      };
      if (pol.guard && question) {
        const r = await safety.guard(o.cfg, [{ role: 'user', content: question }]);
        safetyMs.question = r.ms;
        if (r.configured && !r.ok) await guardDown('question', r);
        else if (safety.isSelfHarm(r)) { await note('question', 'self_harm', r); throw new Answered(safety.TEXT.selfHarm, 'done'); }
        else if (safety.isUnsafe(r)) { await note('question', 'blocked', r); throw new Answered(safety.TEXT.blocked(r.categories.join(', ')), 'blocked'); }
        else if (r.configured) await note('question', 'pass', r);
      }
      if (pol.scope) {
        const r = await safety.scope(o, history);
        safetyMs.scope = r.ms;
        await note('scope', r.ok ? (r.inScope ? 'pass' : 'out_of_scope') : 'error', r);
        if (!r.inScope) throw new Answered(safety.TEXT.outOfScope, 'refused');
      }
      // The guard also reads the answer: every few thousand characters while it
      // is written (without waiting), and once more at the end.
      let checkedAt = 0;
      let checking = false;
      const answerText = () => `${g.reasoning ? `${g.reasoning.slice(-3000)}\n\n` : ''}${g.content}${g.pending.content || ''}`;
      const checkAnswer = async (stage) => {
        const r = await safety.guard(o.cfg, [{ role: 'user', content: question || '(files only)' }, { role: 'assistant', content: answerText() }]);
        if (r.configured && !r.ok) { await note(stage, 'error', r); return r; }
        if (safety.isUnsafe(r)) {
          blockedBy = r;
          await note(stage, 'blocked', r);
          g.abort.abort();
        } else if (r.configured && stage === 'answer') await note(stage, 'pass', r);
        return r;
      };
      const watchAnswer = () => {
        if (!pol.guard || checking || blockedBy) return;
        const size = g.content.length + g.reasoning.length;
        if (size - checkedAt < safety.ANSWER_CHECK_EVERY) return;
        checkedAt = size;
        checking = true;
        checkAnswer('answer_stream').catch(() => {}).finally(() => { checking = false; });
      };

      // Tools take room too: their descriptions, and what they answer.
      // Skills come with tools: only a model that can use tools can load them.
      const skillSet = caps.includes('tools')
        ? await skills.forAnswer(coreApi.pool, level).catch(() => { console.error('[ai] could not read the skills'); return { prompt: '', tools: [] }; })
        : { prompt: '', tools: [] };
      const available = caps.includes('tools') ? [...await tools.forUser(coreApi, user, level), ...skillSet.tools] : [];
      const toolDefs = available.map(t => ({ type: 'function', function: t.definition }));
      const toolReserve = available.length
        ? await context.countTokens(o.cfg, o.vllm.modelId, JSON.stringify(toolDefs)) + TOOL_PROMPT_OVERHEAD + TOOL_RESULT_RESERVE : 0;
      const docsPrompt = docs.PROMPT(available.filter(t => docs.TOOLS.includes(t)).map(t => t.key));
      const fullSystem = [system, available.length ? TOOL_RULE : '', docsPrompt, skillSet.prompt].filter(Boolean).join('\n\n').trim();
      const built = await context.build(
        { cfg: o.cfg, modelId: o.vllm.modelId, root, chatId, vision: caps.includes('vision'), maxModelLen, tools: available.length > 0 },
        history, { system: fullSystem, answerReserve: maxTokens + toolReserve });
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
          watchAnswer();
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
            : await tools.call(available, c.name, c.arguments, {
              root, chatId, history, limits, created: g.files, pool: coreApi.pool, userId: user.id, answerId: assistantId, keyword,
              coreApi, cfg: o.cfg, level
            });
          // Every tool use, per answer: the tool and what it was used on (a doc
          // or skill name), never the question, the arguments or the result.
          coreApi.pool.query('INSERT INTO ai_tool_use (answer_id, user_id, level, tool, target, ok, keyword) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [assistantId, user.id, level, String(c.name).slice(0, 40), res.target || null, res.ok ? 1 : 0, keyword]).catch(() => {});
          let text = res.text;
          const budget = Math.max(200, Math.floor(room * 2)); // characters; about 3 per token
          if (text.length > budget) text = `${text.slice(0, budget)}\n(cut: no more room)`;
          room -= Math.ceil(text.length / 2.5);
          const argsJson = JSON.stringify(res.args || {});
          gens.tool(g, {
            fn: c.name, call: argsJson.length <= MAX_CALL_CHARS ? argsJson : '{}', // replayed to the model in later questions
            name: res.label || c.name, args: argsJson.slice(0, 300), ok: res.ok, result: text.slice(0, 600)
          });
          body.messages.push({ role: 'tool', tool_call_id: c.id, content: text });
        }
        if (g.abort.signal.aborted) throw new Error('aborted');
        body.max_tokens = Math.max(256, Math.min(maxTokens, room));
        // Last round, or hardly any room left: no more tools, just answer.
        if (round + 1 >= MAX_TOOL_ROUNDS || room < 2500) {
          delete body.tools;
        }
      }
      gens.flush(g);
      if (pol.guard && g.content && !blockedBy) {
        const r = await checkAnswer('answer');
        safetyMs.answer = r.ms;
        if (r.configured && !r.ok && sset.guardDown === 'refuse') blockedBy = { categories: [] };
      }
      if (blockedBy) throw new Error('blocked');
      if (!g.content && status === 'done') {
        status = 'error';
        error = 'The AI finished without writing an answer. Try "Answer again".';
      }
      if (!g.reasoning && thinking) {
        const split = splitInlineThinking(g.content);
        if (split) Object.assign(g, split);
      }
    } catch (err) {
      if (err instanceof Answered) {
        gens.set(g, 'reasoning', '');
        gens.set(g, 'content', err.text);
        status = err.status;
      } else if (blockedBy) {
        gens.set(g, 'reasoning', '');
        gens.set(g, 'content', safety.TEXT.blockedAnswer);
        g.files = [];
        status = 'blocked';
      } else if (timedOut) {
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
      gens.flush(g);
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

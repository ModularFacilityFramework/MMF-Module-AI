// Builds what is sent to the model: system prompt, as much of the conversation
// as fits, and the files. Token counts come from vLLM's own /tokenize, so they
// match the loaded model.
const fsp = require('fs').promises;
const { createHash } = require('crypto');
const storage = require('./storage');
const { HttpError } = storage;
const vllm = require('./vllm');

const MESSAGE_OVERHEAD = 12;  // chat-template tokens around one message
const FIXED_OVERHEAD = 64;
const CACHE_MAX = 4000;
const countCache = new Map(); // `${model}:${hash of text}` -> tokens

async function countTokens(cfg, modelId, text) {
  if (!text) return 0;
  const key = `${modelId}:${createHash('sha1').update(text).digest('base64')}`;
  if (countCache.has(key)) return countCache.get(key);
  const n = await vllm.tokenize(cfg, modelId, text);
  // Without /tokenize, over-estimate (2.5 characters per token) so a question
  // is trimmed rather than refused by vLLM.
  const count = n === null ? Math.ceil(text.length / 2.5) : n;
  if (n !== null) {
    if (countCache.size >= CACHE_MAX) countCache.delete(countCache.keys().next().value);
    countCache.set(key, count);
  }
  return count;
}

// Vision models cut an image into patches of at least 28x28 pixels.
const imageTokens = f => Math.ceil((f.width || 1540) / 28) * Math.ceil((f.height || 1540) / 28) + 16;

const fileBlock = (name, text, note) => `\n\n[Attached file: ${name}]${note ? ` (${note})` : ''}\n"""\n${text}\n"""`;

// One stored message -> { text parts, images, tokens }
async function prepare(ctx, m) {
  if (m.role === 'assistant') {
    const tokens = await countTokens(ctx.cfg, ctx.modelId, m.content || '');
    return { role: 'assistant', text: m.content || '', files: [], images: [], tokens: tokens + MESSAGE_OVERHEAD };
  }
  const files = [];
  const images = [];
  let tokens = await countTokens(ctx.cfg, ctx.modelId, m.text) + MESSAGE_OVERHEAD;
  for (const ref of m.files || []) {
    let meta;
    try {
      meta = await storage.getFileMeta(ctx.root, ctx.chatId, ref.id);
    } catch (err) {
      files.push({ name: ref.name, text: '(this file is no longer available)', tokens: 20 });
      tokens += 20;
      continue;
    }
    if (meta.kind === 'image') {
      if (!ctx.vision) {
        files.push({ name: meta.name, text: '(an image, which this model cannot see)', tokens: 20 });
        tokens += 20;
      } else {
        const t = imageTokens(meta);
        images.push({ path: storage.filePath(ctx.root, ctx.chatId, meta, '.model.jpg'), tokens: t });
        tokens += t;
      }
    } else {
      const text = await fsp.readFile(storage.filePath(ctx.root, ctx.chatId, meta, '.text'), 'utf8')
        .catch(() => '(this file is no longer available)');
      const t = await countTokens(ctx.cfg, ctx.modelId, text) + 30;
      files.push({ name: meta.name, text, tokens: t, note: meta.truncated ? 'only the beginning' : '' });
      tokens += t;
    }
  }
  return { role: 'user', text: m.text, files, images, tokens };
}

async function toApi(p) {
  const text = p.text + p.files.map(f => fileBlock(f.name, f.text, f.note)).join('');
  if (!p.images.length) return { role: p.role, content: text };
  const parts = [];
  for (const img of p.images) {
    const data = await fsp.readFile(img.path);
    parts.push({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${data.toString('base64')}` } });
  }
  parts.push({ type: 'text', text });
  return { role: p.role, content: parts };
}

// Shortens the files of the newest question so that it fits.
async function shrinkFiles(ctx, p, budget) {
  const fileTokens = p.files.reduce((n, f) => n + f.tokens, 0);
  const fixed = p.tokens - fileTokens;
  const room = budget - fixed;
  if (room < 200 * Math.max(1, p.files.length)) return false;
  const shortened = [];
  // Small files keep all their text; the rest share what is left equally.
  let left = room;
  const order = [...p.files].sort((a, b) => a.tokens - b.tokens);
  for (let i = 0; i < order.length; i++) {
    const f = order[i];
    const share = Math.floor(left / (order.length - i));
    if (f.tokens > share) {
      let text = f.text;
      let tokens = f.tokens;
      for (let n = 0; n < 6 && tokens > share; n++) {
        text = text.slice(0, Math.floor(text.length * Math.min(0.97, (share - 40) / tokens)));
        tokens = await countTokens(ctx.cfg, ctx.modelId, text) + 40;
      }
      if (tokens > share) return false;
      const pct = Math.max(1, Math.round(100 * text.length / f.text.length));
      f.text = text;
      f.tokens = tokens;
      f.note = `only the first ${pct}% fits`;
      shortened.push(`${f.name} (first ${pct}%)`);
    }
    left -= f.tokens;
  }
  p.tokens = fixed + p.files.reduce((n, f) => n + f.tokens, 0);
  return shortened;
}

// Returns { messages, notices, promptTokens, dropped }.
async function build(ctx, history, { system, answerReserve }) {
  const budget = ctx.maxModelLen - answerReserve - FIXED_OVERHEAD
    - (system ? await countTokens(ctx.cfg, ctx.modelId, system) + MESSAGE_OVERHEAD : 0);
  const last = await prepare(ctx, history[history.length - 1]);
  const notices = [];

  if (last.tokens > budget) {
    const shortened = last.files.length ? await shrinkFiles(ctx, last, budget) : false;
    if (!shortened) {
      throw new HttpError(413, 'too_long',
        'This question is too long for the model, even without the earlier conversation. Shorten it or attach less.');
    }
    notices.push(`Too long to read completely: ${shortened.join(', ')}.`);
  }

  // Walk back through the conversation in whole turns while it fits.
  let used = last.tokens;
  const kept = [last];
  let turn = [];
  let turnTokens = 0;
  let dropped = 0;
  for (let i = history.length - 2; i >= 0; i--) {
    if (!dropped) {
      const p = await prepare(ctx, history[i]);
      turn.unshift(p);
      turnTokens += p.tokens;
      if (p.role === 'user') {
        let fits = used + turnTokens <= budget;
        if (!fits && p.files.length) {
          // Keep the question and as much of its files as fits, so that a
          // follow-up question can still be about them.
          const before = p.tokens;
          const shortened = await shrinkFiles(ctx, p, budget - used - (turnTokens - before) - MESSAGE_OVERHEAD);
          if (shortened) {
            turnTokens += p.tokens - before;
            notices.push(`Too long to read completely: ${shortened.join(', ')}.`);
            fits = true;
          }
        }
        if (!fits) {
          dropped += turn.length;
        } else {
          // Chat templates expect question, answer, question, ...: a question
          // whose answer failed gets a placeholder.
          if (!turn.some(x => x.role === 'assistant' && x.text)) {
            kept.unshift(turn[0], { role: 'assistant', text: '(This question was not answered.)', files: [], images: [] });
          } else {
            kept.unshift(...turn.filter(x => x.role === 'user' || x.text));
          }
          used += turnTokens + MESSAGE_OVERHEAD;
        }
        turn = [];
        turnTokens = 0;
      }
    } else {
      dropped += 1;
    }
  }
  if (dropped) notices.push('The conversation is longer than the model can read at once, so its oldest part was left out.');

  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  for (const p of kept) messages.push(await toApi(p));
  return { messages, notices, promptTokens: used, dropped };
}

module.exports = { build, countTokens, imageTokens };

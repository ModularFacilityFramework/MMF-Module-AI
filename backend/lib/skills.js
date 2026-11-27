// Skills: written instructions for particular tasks, built like Claude Code
// skills. A skill is a SKILL.md text (frontmatter with name and description,
// then short steps) plus optional reference files. They are kept in this
// module's database and managed on Setup -> Skills.
//
// The model sees only the names and descriptions, in its system prompt. When a
// question matches, it loads the full text with the load_skill tool, and a
// reference file with read_skill_file. So only models that can use tools use
// skills; the others answer without them.
const { HttpError } = require('./storage');
const { LEVELS, norm } = require('./safety');

const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const TAG_RE = /^[a-z0-9_-]{1,32}$/;
const MAX = {
  name: 64,
  description: 1024,
  skillChars: 8000,      // the whole SKILL.md: load_skill returns it in one piece
  fileChars: 50000,      // one reference file, read in parts
  files: 10,
  totalChars: 250000,    // a skill with all its files
  listed: 40,            // skills named in the system prompt
  listedDescription: 300 // characters of each description in the system prompt
};
const PART_CHARS = 8000; // read_skill_file returns this much at a time

const PROMPT_HEAD = 'Skills: written instructions from the facility for particular tasks. '
  + 'When the question matches the description of a skill below, first call load_skill with its name, then follow the steps it gives. '
  + 'Do not load a skill that does not match the question. A skill loaded in an earlier answer may appear shortened in this conversation: '
  + 'load it again when you need its steps.\nAvailable skills:';

const TEMPLATE = `---
name: my-skill
description: What this skill does, and exactly when to use it (for which questions).
---

# My skill

1. First step.
2. Second step.
`;

// "---\nname: x\ndescription: y\n---\nbody" -> { name, description, body }
function parse(content) {
  const text = String(content || '').replace(/\r\n?/g, '\n');
  const m = /^---\n([\s\S]*?)\n---(?:\n|$)([\s\S]*)$/.exec(text);
  if (!m) throw new HttpError(400, 'no_frontmatter', 'SKILL.md must start with a frontmatter block: a line "---", the lines "name: ..." and "description: ...", and a line "---".');
  const fields = {};
  let last = null;
  for (const line of m[1].split('\n')) {
    const kv = /^([A-Za-z_-]+):\s*(.*)$/.exec(line);
    if (kv) {
      last = kv[1].toLowerCase();
      fields[last] = kv[2].trim();
    } else if (last && /^\s+\S/.test(line)) {
      fields[last] = `${fields[last]} ${line.trim()}`.trim(); // folded continuation line
    }
  }
  const unquote = v => (v && /^(["']).*\1$/.test(v) ? v.slice(1, -1) : v || '');
  return { name: unquote(fields.name), description: unquote(fields.description).replace(/^[>|]-?\s*/, ''), body: m[2].trim() };
}

function check({ content, tag, files, audience }) {
  const text = String(content || '').replace(/\r\n?/g, '\n');
  if (text.length > MAX.skillChars) throw new HttpError(400, 'too_long', `SKILL.md is ${text.length} characters; the most is ${MAX.skillChars}. Move details to a reference file.`);
  const p = parse(text);
  if (!NAME_RE.test(p.name) || p.name.length > MAX.name) {
    throw new HttpError(400, 'bad_name', `The name must be lowercase letters, digits and hyphens (for example "buffer-recipe"), at most ${MAX.name} characters.`);
  }
  if (!p.description) throw new HttpError(400, 'no_description', 'The description is missing: it tells the AI when to use the skill.');
  if (p.description.length > MAX.description) throw new HttpError(400, 'bad_description', `The description is longer than ${MAX.description} characters.`);
  if (!p.body) throw new HttpError(400, 'no_body', 'The steps are missing: write them below the frontmatter.');
  const cleanAudience = LEVELS.includes(norm(audience)) ? norm(audience) : 'standard';
  const cleanTag = tag === null || tag === undefined || tag === '' ? null : String(tag).trim().toLowerCase();
  if (cleanTag !== null && !TAG_RE.test(cleanTag)) throw new HttpError(400, 'bad_tag', 'A module tag is lowercase letters, digits, "-" or "_", at most 32 characters.');
  const list = Array.isArray(files) ? files : [];
  if (list.length > MAX.files) throw new HttpError(400, 'too_many_files', `A skill has at most ${MAX.files} reference files.`);
  const seen = new Set();
  let total = text.length;
  const cleanFiles = list.map((f) => {
    const name = String((f && f.name) || '').trim();
    const body = String((f && f.content) || '').replace(/\r\n?/g, '\n');
    if (!FILE_RE.test(name) || name === 'SKILL.md') throw new HttpError(400, 'bad_file_name', `"${name.slice(0, 60)}" is not a usable file name: letters, digits, ".", "-" and "_", starting with a letter or digit.`);
    if (seen.has(name.toLowerCase())) throw new HttpError(400, 'duplicate_file', `There are two files called ${name}.`);
    seen.add(name.toLowerCase());
    if (!body.trim()) throw new HttpError(400, 'empty_file', `${name} is empty.`);
    if (body.length > MAX.fileChars) throw new HttpError(400, 'file_too_long', `${name} is ${body.length} characters; the most is ${MAX.fileChars}.`);
    total += body.length;
    return { name, content: body };
  });
  if (total > MAX.totalChars) throw new HttpError(400, 'skill_too_long', `The skill and its files are longer than ${MAX.totalChars} characters together.`);
  return { ...p, content: text, tag: cleanTag, audience: cleanAudience, files: cleanFiles };
}

const row = r => ({
  id: Number(r.id), name: r.name, description: r.description, tag: r.module_tag || null, audience: norm(r.audience), enabled: Boolean(r.enabled),
  updatedAt: r.updated_at, updatedBy: r.updated_by === null ? null : Number(r.updated_by)
});

async function list(pool) {
  const [skills, files] = await Promise.all([
    pool.query('SELECT id, name, description, module_tag, audience, enabled, updated_at, updated_by FROM ai_skills ORDER BY name'),
    pool.query('SELECT skill_id, name, CHAR_LENGTH(content) AS chars FROM ai_skill_files ORDER BY name')
  ]);
  return skills.map(s => ({ ...row(s), files: files.filter(f => Number(f.skill_id) === Number(s.id)).map(f => ({ name: f.name, chars: Number(f.chars) })) }));
}

async function get(pool, id) {
  const rows = await pool.query('SELECT * FROM ai_skills WHERE id = ?', [id]);
  if (!rows.length) throw new HttpError(404, 'no_skill', 'This skill no longer exists.');
  const files = await pool.query('SELECT name, content FROM ai_skill_files WHERE skill_id = ? ORDER BY name', [id]);
  return { ...row(rows[0]), content: rows[0].content, files: files.map(f => ({ name: f.name, content: f.content })) };
}

async function audit(pool, userId, skill, action) {
  await pool.query('INSERT INTO ai_skill_audit (user_id, skill, action) VALUES (?, ?, ?)', [userId || null, String(skill).slice(0, 64), action]);
}

// Creates (id 0) or replaces a skill with all its files. Returns the id.
async function save(pool, id, body, userId) {
  const s = check(body || {});
  const enabled = !body || body.enabled === undefined ? true : Boolean(body.enabled);
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const clash = await conn.query('SELECT id FROM ai_skills WHERE name = ? AND id <> ?', [s.name, id || 0]);
    if (clash.length) throw new HttpError(409, 'name_taken', `There is already a skill called ${s.name}.`);
    let skillId = id;
    let action = 'create';
    if (id) {
      const old = await conn.query('SELECT name FROM ai_skills WHERE id = ? FOR UPDATE', [id]);
      if (!old.length) throw new HttpError(404, 'no_skill', 'This skill no longer exists.');
      action = old[0].name === s.name ? 'edit' : `rename from ${old[0].name}`.slice(0, 80);
      await conn.query(
        'UPDATE ai_skills SET name = ?, description = ?, content = ?, module_tag = ?, audience = ?, enabled = ?, updated_by = ? WHERE id = ?',
        [s.name, s.description, s.content, s.tag, s.audience, enabled ? 1 : 0, userId || null, id]
      );
      await conn.query('DELETE FROM ai_skill_files WHERE skill_id = ?', [id]);
    } else {
      const r = await conn.query(
        'INSERT INTO ai_skills (name, description, content, module_tag, audience, enabled, created_by, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [s.name, s.description, s.content, s.tag, s.audience, enabled ? 1 : 0, userId || null, userId || null]
      );
      skillId = Number(r.insertId);
    }
    for (const f of s.files) await conn.query('INSERT INTO ai_skill_files (skill_id, name, content) VALUES (?, ?, ?)', [skillId, f.name, f.content]);
    await conn.query('INSERT INTO ai_skill_audit (user_id, skill, action) VALUES (?, ?, ?)', [userId || null, s.name, action]);
    await conn.commit();
    return skillId;
  } catch (err) {
    await conn.rollback().catch(() => {});
    if (err.code === 'ER_DUP_ENTRY') throw new HttpError(409, 'name_taken', `There is already a skill called ${s.name}.`);
    throw err;
  } finally {
    conn.release();
  }
}

async function setEnabled(pool, id, enabled, userId) {
  const rows = await pool.query('SELECT name FROM ai_skills WHERE id = ?', [id]);
  if (!rows.length) throw new HttpError(404, 'no_skill', 'This skill no longer exists.');
  await pool.query('UPDATE ai_skills SET enabled = ?, updated_by = ? WHERE id = ?', [enabled ? 1 : 0, userId || null, id]);
  await audit(pool, userId, rows[0].name, enabled ? 'enable' : 'disable');
}

async function remove(pool, id, userId) {
  const rows = await pool.query('SELECT name FROM ai_skills WHERE id = ?', [id]);
  if (!rows.length) throw new HttpError(404, 'no_skill', 'This skill no longer exists.');
  await pool.query('DELETE FROM ai_skill_files WHERE skill_id = ?', [id]);
  await pool.query('DELETE FROM ai_skills WHERE id = ?', [id]);
  await audit(pool, userId, rows[0].name, 'delete');
}

async function logUse(ctx, skill, file) {
  if (!ctx.pool) return;
  await ctx.pool.query(
    'INSERT INTO ai_skill_log (answer_id, user_id, skill, file_name, keyword) VALUES (?, ?, ?, ?, ?)',
    [ctx.answerId, ctx.userId || null, skill, file || null, ctx.keyword || null]
  ).catch(() => console.error('[ai] could not log a skill use'));
}

// What one answer gets: the text for the system prompt and the two tools,
// with only the skills meant for the asker's level (safety.js). Read once per
// answer, so the list and the tools agree.
async function forAnswer(pool, level = 'standard') {
  // stored values of both the old and the new levels
  const levels = norm(level) === 'advanced' ? ['user', 'standard', 'staff', 'developer', 'advanced'] : ['user', 'standard'];
  const rows = await pool.query(
    `SELECT s.id, s.name, s.description, COUNT(f.id) AS files
       FROM ai_skills s LEFT JOIN ai_skill_files f ON f.skill_id = s.id
      WHERE s.enabled = 1 AND s.audience IN (?) GROUP BY s.id, s.name, s.description ORDER BY s.name LIMIT ${MAX.listed}`,
    [levels.length ? levels : ['user']]
  );
  if (!rows.length) return { prompt: '', tools: [] };
  const names = rows.map(r => r.name);
  const short = d => (d.length > MAX.listedDescription ? `${d.slice(0, MAX.listedDescription - 1)}…` : d);
  const prompt = `${PROMPT_HEAD}\n${rows.map(r => `- ${r.name}: ${short(r.description).replace(/\s+/g, ' ')}`).join('\n')}`;
  const find = (wanted) => {
    const w = String(wanted || '').trim().toLowerCase();
    const r = rows.find(x => x.name === w);
    if (!r) throw new Error(`there is no skill "${String(wanted).slice(0, 60)}"; skills: ${names.join(', ')}`);
    return r;
  };

  const loadSkill = {
    key: 'load_skill',
    name: 'Load skill',
    target: args => String(args.name || '').slice(0, 100),
    definition: {
      name: 'load_skill',
      description: 'Loads the full instructions of one skill from the list in the system prompt. Call it before answering when the question matches the skill\'s description, then follow its steps.',
      parameters: { type: 'object', properties: { name: { type: 'string', enum: names, description: 'The skill name' } }, required: ['name'] }
    },
    run: async (args, ctx) => {
      const r = find(args.name);
      const [skill] = await pool.query('SELECT content, enabled, audience FROM ai_skills WHERE id = ?', [r.id]);
      if (!skill || !skill.enabled || !levels.includes(skill.audience)) throw new Error('this skill has just been switched off or deleted');
      const files = await pool.query('SELECT name, CHAR_LENGTH(content) AS chars FROM ai_skill_files WHERE skill_id = ? ORDER BY name', [r.id]);
      await logUse(ctx, r.name, null);
      const { body } = parse(skill.content);
      const extra = files.length
        ? `\n\nReference files of this skill (read one with read_skill_file when the steps need it): ${files.map(f => `${f.name} (${f.chars} characters)`).join(', ')}.`
        : '';
      return `Skill "${r.name}". Follow these steps:\n\n${body}${extra}`;
    }
  };

  const readSkillFile = {
    key: 'read_skill_file',
    name: 'Read skill file',
    target: args => `${args.skill || ''}/${args.file || ''}`.slice(0, 100),
    definition: {
      name: 'read_skill_file',
      description: 'Reads a reference file of a skill, as listed by load_skill.',
      parameters: {
        type: 'object',
        properties: {
          skill: { type: 'string', enum: names, description: 'The skill name' },
          file: { type: 'string', description: 'The file name' },
          start: { type: 'integer', description: 'Optional position (character number) to read from; default 0.' }
        },
        required: ['skill', 'file']
      }
    },
    run: async (args, ctx) => {
      const r = find(args.skill);
      const files = await pool.query('SELECT name, content FROM ai_skill_files WHERE skill_id = ? ORDER BY name', [r.id]);
      const wanted = String(args.file || '').trim();
      const f = files.find(x => x.name === wanted) || files.find(x => x.name.toLowerCase() === wanted.toLowerCase());
      if (!f) throw new Error(files.length ? `this skill has no file "${wanted.slice(0, 60)}"; files: ${files.map(x => x.name).join(', ')}` : 'this skill has no reference files');
      await logUse(ctx, r.name, f.name);
      const start = Math.min(Math.max(0, Math.floor(Number(args.start) || 0)), f.content.length);
      const part = f.content.slice(start, start + PART_CHARS);
      const end = start + part.length;
      return `${f.name} of skill "${r.name}", characters ${start} to ${end} of ${f.content.length}${end < f.content.length ? ` (continue with start=${end})` : ' (end of file)'}:\n${part}`;
    }
  };

  return { prompt, tools: rows.some(r => Number(r.files) > 0) ? [loadSkill, readSkillFile] : [loadSkill] };
}

module.exports = { MAX, TEMPLATE, parse, check, list, get, save, setEnabled, remove, forAnswer };

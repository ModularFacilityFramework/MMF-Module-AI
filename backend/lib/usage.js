// One row per answer, for the Usage tab. Never any text: only who, which
// model, how many tokens, how long, and how it ended.

async function recordUsage(pool, u) {
  try {
    await pool.query(
      `INSERT INTO ai_usage (user_id, keyword, status, prompt_tokens, completion_tokens, duration_ms, first_token_ms, queue_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [u.userId, u.keyword || null, u.status, u.usage ? u.usage.prompt : null, u.usage ? u.usage.completion : null,
        u.ms, u.firstTokenMs, u.queueMs]
    );
  } catch (err) {
    // statistics must never break an answer
  }
}

module.exports = { recordUsage };

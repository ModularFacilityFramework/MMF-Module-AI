-- This module's own tables. No migrations, ever - this file is the single
-- source of truth for this module's schema, edited directly (same rule as
-- mff-core's own App_backend/install/schema.sql). Every table MUST be
-- prefixed with module.manifest.json's tablePrefix ("ai_"). Never DROP and
-- never change an existing column; only add tables or columns
-- (see docs/MFF-Core_module-database-provisioning.md, "Schema diffing").
--
-- Imported by mff-core into this module's own dedicated database
-- (mff_module_ai) at Install/Update. That database has no setup_users table,
-- so user ids here are plain numbers with no foreign key.

-- Settings changed on the Setup page (limits, quotas, who may switch models,
-- ...). One JSON value per key; defaults live in code.
CREATE TABLE IF NOT EXISTS ai_settings (
  setting_key VARCHAR(100) NOT NULL PRIMARY KEY,
  value_json MEDIUMTEXT NOT NULL,
  updated_by BIGINT NULL,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- One row per answer, for the Usage tab. Never any question or answer text
-- (those exist only in each user's own server storage).
CREATE TABLE IF NOT EXISTS ai_usage (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user_id BIGINT NOT NULL,
  keyword VARCHAR(32) NULL,
  status VARCHAR(16) NOT NULL,
  prompt_tokens INT NULL,
  completion_tokens INT NULL,
  duration_ms INT NULL,
  first_token_ms INT NULL,
  queue_ms INT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  KEY idx_ai_usage_created (created_at),
  KEY idx_ai_usage_user (user_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Every change of the loaded model: who, from what, to what, how it ended.
CREATE TABLE IF NOT EXISTS ai_model_switch_log (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  from_keyword VARCHAR(32) NULL,
  to_keyword VARCHAR(32) NOT NULL,
  user_id BIGINT NULL,
  source VARCHAR(16) NOT NULL,
  status VARCHAR(16) NOT NULL,
  message VARCHAR(255) NULL,
  seconds INT NULL,
  started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  finished_at TIMESTAMP NULL DEFAULT NULL,
  KEY idx_ai_switch_started (started_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- People who have used the chat, for the hourly cleanup and the total storage
-- figure. No names, no content.
CREATE TABLE IF NOT EXISTS ai_storage_users (
  user_id BIGINT NOT NULL PRIMARY KEY,
  used_bytes BIGINT NULL,
  checked_at TIMESTAMP NULL DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Who installed, removed, enabled or disabled which AI tool.
CREATE TABLE IF NOT EXISTS ai_tool_log (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user_id BIGINT NULL,
  tool VARCHAR(40) NOT NULL,
  action VARCHAR(20) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Benchmark: the questions, the runs, what was measured per model, and the
-- answers (benchmark questions only, never anyone's chat).
CREATE TABLE IF NOT EXISTS ai_benchmark_prompts (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  title VARCHAR(100) NOT NULL,
  kind VARCHAR(10) NOT NULL,
  prompt MEDIUMTEXT NOT NULL,
  check_regex VARCHAR(500) NULL,
  enabled TINYINT NOT NULL DEFAULT 1,
  deleted TINYINT NOT NULL DEFAULT 0,
  sort_order INT NOT NULL DEFAULT 0
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS ai_benchmark_runs (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user_id BIGINT NULL,
  models VARCHAR(255) NOT NULL,
  think TINYINT NOT NULL DEFAULT 0,
  status VARCHAR(16) NOT NULL,
  message VARCHAR(255) NULL,
  started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  finished_at TIMESTAMP NULL DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS ai_benchmark_models (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  run_id BIGINT NOT NULL,
  keyword VARCHAR(32) NOT NULL,
  label VARCHAR(100) NOT NULL,
  load_seconds INT NULL,
  gpu_memory_mib INT NULL,
  kv_cache_tokens INT NULL,
  max_concurrency DOUBLE NULL,
  max_model_len INT NULL,
  KEY idx_ai_bench_models_run (run_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS ai_benchmark_results (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  run_id BIGINT NOT NULL,
  keyword VARCHAR(32) NOT NULL,
  prompt_id BIGINT NULL,
  title VARCHAR(100) NOT NULL,
  kind VARCHAR(10) NOT NULL,
  prompt MEDIUMTEXT NOT NULL,
  status VARCHAR(16) NOT NULL,
  answer MEDIUMTEXT NULL,
  reasoning_chars INT NULL,
  first_ms INT NULL,
  total_ms INT NULL,
  prompt_tokens INT NULL,
  tokens INT NULL,
  tokens_per_second DOUBLE NULL,
  auto_pass TINYINT NULL,
  score TINYINT NULL,
  scored_by BIGINT NULL,
  KEY idx_ai_bench_results_run (run_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Skills: written instructions the AI loads for particular tasks (Setup ->
-- Skills). content is the whole SKILL.md (frontmatter + steps); name and
-- description are copied from its frontmatter for listing.
CREATE TABLE IF NOT EXISTS ai_skills (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(64) NOT NULL,
  description VARCHAR(1024) NOT NULL,
  content MEDIUMTEXT NOT NULL,
  module_tag VARCHAR(32) NULL,
  audience VARCHAR(16) NOT NULL DEFAULT 'user',
  enabled TINYINT NOT NULL DEFAULT 1,
  created_by BIGINT NULL,
  updated_by BIGINT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_ai_skills_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS ai_skill_files (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  skill_id BIGINT NOT NULL,
  name VARCHAR(100) NOT NULL,
  content MEDIUMTEXT NOT NULL,
  UNIQUE KEY uq_ai_skill_files_name (skill_id, name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Which skill (or skill file) was loaded for which answer. The answer id is the
-- id of the answer in the person's own chat; no question or answer text here.
CREATE TABLE IF NOT EXISTS ai_skill_log (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  answer_id CHAR(36) NOT NULL,
  user_id BIGINT NULL,
  skill VARCHAR(64) NOT NULL,
  file_name VARCHAR(100) NULL,
  keyword VARCHAR(32) NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  KEY idx_ai_skill_log_answer (answer_id),
  KEY idx_ai_skill_log_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Who created, changed, switched on or off, or deleted which skill.
CREATE TABLE IF NOT EXISTS ai_skill_audit (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user_id BIGINT NULL,
  skill VARCHAR(64) NOT NULL,
  action VARCHAR(80) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Safety and scope checks (safety.js): one row per check, with no question or
-- answer text. stage: question, scope, answer (the final check of an answer,
-- which the asker waits for) or answer_stream (checks while it is written).
-- result: pass, blocked, self_harm, out_of_scope or error.
CREATE TABLE IF NOT EXISTS ai_safety_log (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  answer_id CHAR(36) NOT NULL,
  user_id BIGINT NULL,
  level VARCHAR(16) NOT NULL,
  stage VARCHAR(16) NOT NULL,
  result VARCHAR(16) NOT NULL,
  label VARCHAR(16) NULL,
  categories VARCHAR(200) NULL,
  ms INT NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  KEY idx_ai_safety_log_answer (answer_id),
  KEY idx_ai_safety_log_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Every tool use, per answer: which tool, and what it was used on when that is
-- a shared resource (a doc or skill name). Never the question, the arguments
-- or the result.
CREATE TABLE IF NOT EXISTS ai_tool_use (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  answer_id CHAR(36) NOT NULL,
  user_id BIGINT NULL,
  level VARCHAR(16) NULL,
  tool VARCHAR(40) NOT NULL,
  target VARCHAR(100) NULL,
  ok TINYINT NOT NULL DEFAULT 1,
  keyword VARCHAR(32) NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  KEY idx_ai_tool_use_answer (answer_id),
  KEY idx_ai_tool_use_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

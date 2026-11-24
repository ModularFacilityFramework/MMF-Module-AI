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

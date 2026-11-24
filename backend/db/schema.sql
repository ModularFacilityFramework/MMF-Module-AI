-- This module's own tables. No migrations, ever - this file is the single
-- source of truth for this module's schema, edited directly (same rule as
-- mff-core's own App_backend/install/schema.sql). Every table MUST be
-- prefixed with module.manifest.json's tablePrefix ("example_" by default -
-- rename both together if you rename the module).
--
-- Imported by mff-core's own moduleDatabaseProvisioner.js, against this
-- module's own dedicated database (mff_module_<id>) created for it at
-- Install/Update time - see docs/coreApi.md's database section.

CREATE TABLE IF NOT EXISTS example_things (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  owner_id BIGINT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  KEY idx_owner_id (owner_id)
  -- No FK to setup_users(id) here on purpose: this file is imported into this
  -- module's own dedicated database (see above), which has no setup_users
  -- table at all - that table lives in core's own database.
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Backs PageAccessTab.js / pageAccessRoutes.js: which roles can see which of
-- this module's own tabs. A row's presence means that role has access to
-- that page_key - no row for a page means nobody but staff (who bypass this
-- check entirely via checkRole in pageAccessRoutes.js) can see it.
CREATE TABLE IF NOT EXISTS example_page_access (
  page_key VARCHAR(100) NOT NULL,
  role VARCHAR(50) NOT NULL,
  PRIMARY KEY (page_key, role)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

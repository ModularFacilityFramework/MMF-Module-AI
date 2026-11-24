# MFF-Module-template

Reusable starting point for an [MFF-core](../mff-core) feature module (chemicals inventory, SLURM monitoring, imaging, booking systems, etc.). Clone or copy this repo per new module, then rename it — see `docs/MFF-Module-template_module-manifest.md`.

## Why this exists

MFF-core's own architecture reserves `src/core/<moduleName>/` for modules, but gives no reusable starting point. This template provides one:

- A documented, versioned contract (`coreApi`, see `docs/MFF-Core_module-core-api.md`) — the *only* way a module talks to core, so this repo never imports from an mff-core checkout.
- Installing means `git clone`-ing this repo directly to `App_frontend/src/core/<id>/` inside a real mff-core checkout (see `docs/MFF-Core_module-database-provisioning.md`) — a real checkout, `git pull`ed in place to update, never a copy or symlink of one. That's mff-core's own decision (its Modules admin page, or a plain `git clone`), not something this repo needs any tooling for.

## Quick start

```bash
nvm use
npm install
npm run lint
```

There is no local dev harness and no `npm run dev`: to run and test the module, `git clone` it into a real mff-core checkout's `App_frontend/src/core/<id>/` (see `docs/MFF-Core_module-database-provisioning.md`).

## Structure

```
module.manifest.json    # id, label, version, tablePrefix, mountPath - single source of truth
backend/                 # this module's real Express router + own DB tables
frontend/                 # this module's real React components
docs/                       # symlink to mff-core's own docs/ (a shared space core and every
                            # module link to) - this repo's own docs live there too, prefixed
                            # MFF-Module-template_*.md: module-manifest.md, install.md,
                            # dev-setup.md. coreApi/manifest-schema/UI-guide are core's own
                            # MFF-Core_*.md files in that same shared folder, not duplicated here.
```

## Page state persistence

Every page, tab and sub-tab must keep its state when the user leaves and comes back, or reloads: selected tab, selected year/project/item, filters, search, sort, open/collapsed sections, and unsaved drafts. Use `coreApi.usePageState(key, defaultValue, validate?)` (returns `[value, setValue, reset]`; per user, survives reload and logout) with keys named `<moduleId>.<page>.<what>`; see "`usePageState`" in `docs/MFF-Core_module-core-api.md`. The template shows both patterns: `frontend/components/Dashboard.js` remembers the selected tab, and `frontend/components/PageAccessTab.js` keeps its unsaved edits as a draft and calls `reset()` after saving. Test leave, return and reload before calling a page finished.

## Renaming this into a real module

See `docs/MFF-Module-template_module-manifest.md`.

## Installing into a real mff-core checkout

How installing/updating actually works is core's own mechanism — see `docs/MFF-Core_module-database-provisioning.md`. `docs/MFF-Module-template_install.md` only covers why this repo has no install script of its own.

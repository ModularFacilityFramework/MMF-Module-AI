# MFF-Module-AI

The `ai` module of MFF (display name **AI**): a private chat with the AI model that runs on the facility's own GPU server, and a Setup page to manage it.

- **Chat:** conversations, streamed answers with the thinking shown separately, stop, files and images, search. Everything a person writes or uploads stays in that person's own server storage; nothing of it is in the database, so administrators cannot read it through MFF.
- **Setup** (core page `setup`): Model (what is loaded, switching, per-model settings), Benchmark, Tools, Skills, Limits, Usage, Configuration.
- **Precision of Qwen:** Setup -> Model can reload Qwen as bf16 weights with a bf16 KV cache (the default), bf16 weights with an FP8 KV cache, or Qwen's own FP8 checkpoint with an FP8 KV cache, each at 262,144 tokens of context. Each is its own controller keyword (`qwen`, `qwen-fp8kv`, `qwen-fp8`), all served as `qwen`; the page shows the precision and context that are really loaded.
- **Skills:** written instructions for particular tasks, built like Claude Code skills (a SKILL.md with `name` and `description` frontmatter, then steps, plus optional reference files). Administrators and developers manage them on Setup -> Skills; they are kept in the module's database. A model that can use tools sees every enabled skill's name and description and loads one with the `load_skill` tool (reference files with `read_skill_file`); other models answer without skills. Each load is logged per answer (`ai_skill_log`).

## How it works

The browser talks only to MFF. The backend calls vLLM over HTTP, and switches the model through `ai-ctl` (`tools/gpu6/ai-ctl`), a forced command behind a dedicated SSH key that accepts only `status`, `switch <keyword>` and `info`. All settings come from `coreApi.getModuleConfig()` (`MODULE_AI_*` in core's one `.env`).

```
backend/lib/     storage, context, answer, generations (chat) - switcher, ctl, status, vllm (model) -
                 tools, calculator, skills - benchmark - limits, usage, cleanup - files, officeText (uploads)
backend/routes/  publicRoutes, chatRoutes, setupRoutes
backend/db/      schema.sql - the only source of truth for this module's tables (prefix ai_)
frontend/        Chat tab and Setup tab
tools/gpu6/      ai-ctl, deployed on the GPU server, and a copy of the vLLM controller's source (vllm_controller.cpp)
```

## Development

```bash
nvm exec 20 npm install
nvm exec 20 npm run lint
```

There is no dev server here: the module runs inside a real mff-core checkout. Documentation is in the shared docs repo (`docs/MFF-Module-AI_*.md`).

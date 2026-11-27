# MFF-Module-AI

The `ai` module of MFF (display name **AI**): a private chat with the AI model that runs on the facility's own GPU server, and a Setup page to manage it.

- **Chat:** conversations, streamed answers with the thinking shown separately, stop, files and images, search. Everything a person writes or uploads stays in that person's own server storage; nothing of it is in the database, so administrators cannot read it through MFF.
- **Setup** (core page `setup`): Model (what is loaded, switching, per-model settings), Benchmark, Tools, Skills, Limits, Usage, Configuration.
- **MFF docs tools** (Setup -> Tools): `docs_index`, `search_docs`, `read_doc`, so the AI looks in the MFF docs first for any question about MFF, a module or a procedure. Docs come from `coreApi.docs` when core offers it, else `MODULE_AI_DOCS_DIR`; who may read which doc comes from `INDEX.json` there (else user guides for everyone, the rest for developers). Every tool use is logged per answer (`ai_tool_use`: tool and doc or skill name only).
- **Database (developers only)**: `db_query_mariadb` reads MFF's MariaDB through a dedicated read-only account (`MODULE_AI_MARIADB_RO_*`, created by the user): one SELECT/WITH/SHOW/DESCRIBE/EXPLAIN, in a read-only transaction that is rolled back, 10 s, 200 rows; every query logged (`ai_db_query_log`). Its audience can never be wider than developers.
- **Speech to text**: a microphone button in the chat (the "speech_to_text" entry on Setup -> Tools switches it on, with an audience); the recording goes to Whisper large-v3-turbo on GPU 3 of the AI server (`tools/gpu6/whisper_server.py`, `MODULE_AI_WHISPER_URL`) and the text is added to the question box to check and send.
- **OCR**: scanned PDFs (no text layer) are read with ocrmypdf/Tesseract at upload (first 30 pages), and images get Tesseract text, used by models that cannot see images; both run in the sandbox. Packages: `tools/nusbf/ocr-install.sh`.
- **Code sandbox and gemmi** (Setup -> Tools): `run_python` runs Python (numpy, scipy, pandas, matplotlib, biopython, gemmi, rdkit) in bubblewrap with no network, seeing only the chat files handed in, inside a systemd user scope (2 GB, 64 processes, 2 CPUs, 60 s); files saved to /work/out come back to the chat, charts shown in the answer. `read_structure_file` summarises MTZ, mmCIF, PDB and map files with gemmi in the same sandbox; MTZ uploads are summarised at upload. Runtime: `tools/nusbf/sandbox-install.sh`.
- **MCP servers** (Setup -> Tools): the backend's own small MCP client (Streamable HTTP) turns each tool of a registered MCP server into an ordinary tool: installed, given an audience, read by the guard (arguments and answers) and logged per answer. The facility's servers run on the backend host, 127.0.0.1 only: the official PDBe MCP servers (EMBL-EBI, PDBe API and PDBe Search) and BioMCP (`tools/nusbf/mcp-install.sh`, rollback `mcp-rollback.sh`).
- **Date and time:** every request, for every model, starts with the current date and time (Europe/London) and when the question was sent; the chat shows each message's time.
- **Web tools** (Setup -> Tools): `web_search` through the facility's own SearXNG (`MODULE_AI_SEARXNG_URL`, 127.0.0.1 on the backend host) and `web_read` for one public page (no private addresses, standard ports only, 2 MB, HTML or text; checked again after each redirect). The guard reads search words and pages; the AI cites the URLs it used.
- **Safety and scope** (Setup -> Safety): a guard model (Qwen3Guard-Gen-0.6B, `vllm-guard.service` on the GPU server, `MODULE_AI_GUARD_URL`) reads every question and answer of normal users and facility staff and blocks unsafe ones; a question about self-harm gets a kind answer with where to find help. A scope check (by the loaded model) keeps those users to MFF, the facility, its servers, structural biology and scientific writing, and an output scan hides internal addresses, server names and paths from them. Each tool and skill is for everyone, facility staff or developers. Developers and administrators get no scope check or scan, and the guard only when switched on. Every check is logged without any question or answer text (`ai_safety_log`).
- **Precision of Qwen:** Setup -> Model can reload Qwen as bf16 weights with a bf16 KV cache (the default), bf16 weights with an FP8 KV cache, or Qwen's own FP8 checkpoint with an FP8 KV cache, each at 262,144 tokens of context. Each is its own controller keyword (`qwen`, `qwen-fp8kv`, `qwen-fp8`), all served as `qwen`; the page shows the precision and context that are really loaded.
- **Skills:** written instructions for particular tasks, built like Claude Code skills (a SKILL.md with `name` and `description` frontmatter, then steps, plus optional reference files). Administrators and developers manage them on Setup -> Skills; they are kept in the module's database. A model that can use tools sees every enabled skill's name and description and loads one with the `load_skill` tool (reference files with `read_skill_file`); other models answer without skills. Each load is logged per answer (`ai_skill_log`).

## How it works

The browser talks only to MFF. The backend calls vLLM over HTTP, and switches the model through `ai-ctl` (`tools/gpu6/ai-ctl`), a forced command behind a dedicated SSH key that accepts only `status`, `switch <keyword>` and `info`. All settings come from `coreApi.getModuleConfig()` (`MODULE_AI_*` in core's one `.env`).

```
backend/lib/     storage, context, answer, generations (chat) - switcher, ctl, status, vllm (model) -
                 tools, calculator, skills, safety - benchmark - limits, usage, cleanup - files, officeText (uploads)
backend/routes/  publicRoutes, chatRoutes, setupRoutes
backend/db/      schema.sql - the only source of truth for this module's tables (prefix ai_)
frontend/        Chat tab and Setup tab
tools/nusbf/     install and rollback scripts for SearXNG and the MCP servers on the backend host
tools/gpu6/      ai-ctl, deployed on the GPU server; copies of the vLLM controller's source (vllm_controller.cpp) and of the guard's unit (vllm-guard.service)
```

## Development

```bash
nvm exec 20 npm install
nvm exec 20 npm run lint
```

There is no dev server here: the module runs inside a real mff-core checkout. Documentation is in the shared docs repo (`docs/MFF-Module-AI_*.md`).

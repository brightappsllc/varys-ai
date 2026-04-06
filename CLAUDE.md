# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Session Management

Run `/compact` whenever the context window usage exceeds 40%.

## What This Project Is

Varys-AI is an AI-powered data science assistant implemented as a **JupyterLab 4 extension** (v0.8.0). It has two separate build systems:
- **Frontend**: TypeScript/React compiled with `tsc` and bundled via webpack
- **Backend**: Python 3.9+ Jupyter Server extension (no build step needed)

---

## Commands

### Frontend

```bash
# Development — watch mode
npm run watch

# Production build (run before committing frontend changes)
bash deploy.sh

# Lint
npm run lint
npm run lint:check
```

### Backend

No build step. Python changes are picked up on JupyterLab restart (editable install via `.pth`).

### Running Locally

```bash
source /media/jmlb/datastore-8tb1/.varys/bin/activate   # always use this env
bash deploy.sh                                           # build frontend
jupyter lab                                              # start JupyterLab
```

There is no automated test suite. Testing is done by running JupyterLab manually and exercising the feature.

---

## Deploy & Commit Rules (from `.cursor/rules/deploy-and-commit.mdc`)

After **any** frontend change (TypeScript, CSS, assets):

1. Run `bash deploy.sh`
2. Commit **all** of these together — never a subset:
   - `src/` — TypeScript source
   - `style/` — CSS
   - `lib/` — compiled JS (output of `tsc`)
   - `varys/labextension/static/` — webpack bundle
   - `varys/labextension/package.json` — **critical**: points to the active `remoteEntry*.js` hash

**Why `varys/labextension/package.json` is critical**: JupyterLab reads this file to discover which webpack bundle to load. A stale hash causes `pip install --force-reinstall` to install new bundle files but load the old UI.

**Verify before pushing:**
```bash
git show HEAD:varys/labextension/package.json \
  | python3 -c "import sys,json; d=json.load(sys.stdin); \
    print(d.get('jupyterlab',{}).get('_build',{}).get('load','N/A'))"

ls varys/labextension/static/remoteEntry*.js
```
Both must show the **same hash**.

For **backend-only** (Python) changes: no build needed, just commit and push.

---

## Architecture

### Entry Points

- **Backend**: `varys/app.py` — `DSAssistantExtension` (subclass of `ExtensionApp`)
- **Frontend**: `src/index.ts` — two JupyterLab plugins: main chat plugin + inline completion plugin

### Backend (`varys/`)

| Path | Purpose |
|------|---------|
| `varys/handlers/` | ~25 Tornado async request handlers (`/varys/*` routes) |
| `varys/llm/` | LLM provider adapters (Anthropic, OpenAI, Google, Ollama, Bedrock, Azure, OpenRouter) |
| `varys/agent/` | File Agent agentic loop (tool schema execution: read/write/edit/bash/glob/grep) |
| `varys/context/` | Smart Cell Context — per-cell summaries, relevance scoring, context assembly |
| `varys/memory/` | Long-term preference store (YAML, scoped global/project/notebook) + background inference |
| `varys/skills/` | Skill registry + loader |
| `varys/bundled_skills/` | 17 built-in slash commands (SKILL.md with YAML front matter) |
| `varys/modules/reproducibility_guardian/` | Passive cell execution monitor + data-flow analysis |
| `varys/completion/` | Inline ghost-text completion engine |
| `varys/mcp/` | Model Context Protocol integration |
| `varys/rag/` | RAG knowledge base (optional; behind `[rag]` extra) |
| `varys/magic.py` | `%%ai` IPython cell magic |

### Frontend (`src/`)

| Path | Purpose |
|------|---------|
| `src/sidebar/` | Main chat UI (`SidebarWidget.tsx`) |
| `src/editor/` | Cell insert / modify / delete operations |
| `src/context/` | Notebook reader + kernel variable resolver |
| `src/api/` | HTTP client to backend handlers |
| `src/completion/` | Inline ghost-text completion provider |
| `src/reproducibility/` | Reproducibility Guardian React panel |
| `src/graph/` | DAG visualization panel |
| `src/tags/` | Cell tags & metadata panel |
| `src/ui/` | Shared UI (DiffView, ActionBar) |

### Key Subsystems

**Multi-Provider LLM Routing**: `varys/llm/base.py` defines `BaseLLMProvider`. A provider factory selects the implementation at runtime via environment variables (`DS_CHAT_PROVIDER`, etc.). Chat, inline completion, and background tasks each support independent provider+model configuration.

**File Agent** (`varys/agent/agent_runner.py`): Agentic loop where the LLM calls tools (read/write/edit/bash/glob/grep) until the task completes. Every file change is staged as a diff before persisting. Deletions go to `.varys_deleted/` (never permanent). Audit log written to `.jupyter-assistant/logs/agent_audit.jsonl`. Read-only mode available via `run_read_only()`.

**Skill System**: Each skill is a directory under `varys/bundled_skills/` (or `~/.jupyter-assistant/skills/` for user-defined) containing a `SKILL.md` with YAML front matter (trigger keywords, mode, etc.) and markdown instructions. Triggered via `/command` syntax in the chat.

**Smart Cell Context**: Rather than passing raw cell content, `varys/context/summary_store.py` maintains per-cell summaries with versioning. `varys/context/assembler.py` + `scorer.py` select and assemble relevant context blocks.

**User Configuration**: Stored in `~/.jupyter/varys.env` (key=value). Hot-reloaded on save — no server restart needed. Also configurable via the Settings UI.

### Optional Extras (from `pyproject.toml`)

```
[anthropic], [openai], [ollama], [bedrock], [google], [mcp], [rag], [all]
```

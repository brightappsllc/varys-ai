# Changelog

All notable changes to Varys are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

---

## [0.5.0] — Varys File Agent: Filesystem Agent

### New Features

#### `/file_agent` — Agentic Filesystem Tool
- New `/file_agent <task>` command runs a multi-turn Anthropic agentic loop that can **read, write, and edit project files** (`.py`, `.md`, `.yaml`, `.toml`, `.json`, …) without leaving JupyterLab
- All file changes are **staged in memory** and never written to disk until explicitly accepted
- Per-file **diff cards** in the chat panel show a line-level unified diff (green = added, red = removed); each card is editable before accepting
- **Accept All** / **Reject All** bulk actions for multi-file sessions
- Large files (> 50 KB) load their diff on demand to keep the UI responsive

#### `/file_agent_find` — Read-Only Exploration
- Hardcoded `Read`-only tool set — cannot stage any writes
- Safe for codebase Q&A: "where is the database connection configured?", "which functions use the `requests` library?"

#### `/file_agent_save` — Notebook → Module Export
- Optimised for extracting notebook-developed functions into reusable project source files
- Uses `Read` + `Write` (no `Edit`) so the full file is always shown in the diff before landing on disk

#### Background Project Scan
- On notebook open, a lightweight read-only agent scan builds `repo_scan.json` cached at `.jupyter-assistant/memory/projects/<hash>/`
- Scan result is injected as project context into subsequent `/file_agent` and regular chat requests
- Scan is skipped when the file-tree hash is unchanged (no recomputation cost on repeated opens)

#### Safety & Audit
- **Safe deletion**: files marked for deletion are moved to `.varys_deleted/` — never permanently removed
- **Working-directory enforcement**: three-layer path validation blocks all reads/writes outside the project root
- **Audit log**: every agent session appends one complete JSONL line to `.jupyter-assistant/logs/agent_audit.jsonl` on full resolution, including tool calls, files changed, outcomes, and duration
- **Session TTL**: abandoned sessions are cleaned up after 30 minutes with a partial audit entry

#### UI Warning System
- Backend errors (billing/quota, scan failures) are no longer silent terminal logs
- A **⚠ amber icon** appears in the chat header when warnings are queued; a **dismissible banner** in the chat panel shows the full message
- Frontend polls `GET /varys/warnings` on mount and every 60 seconds

### Configuration

New environment variables (all optional — sane defaults apply):

| Variable | Default | Description |
|---|---|---|
| `VARYS_AGENT_ENABLED` | `false` | Master switch — must be `true` to use `/file_agent` |
| `VARYS_AGENT_MAX_TURNS` | `10` | Max agentic turns per request |
| `VARYS_AGENT_MAX_TOKENS` | `8192` | Max output tokens per API call |
| `VARYS_AGENT_ALLOWED_TOOLS` | `Read,Write,Edit` | Tools available to `/file_agent` |
| `VARYS_AGENT_WORKING_DIR` | _(notebook parent)_ | Override the working directory |
| `VARYS_AGENT_BACKGROUND_SCAN` | `true` | Enable background project scan on notebook open |
| `VARYS_AGENT_DIFF_INLINE_LIMIT` | `50000` | Byte threshold for inline vs. deferred diff rendering |

See `varys/bundled_config/agent.cfg` for the full reference and `documentation/varys-file-agent.md` for the complete feature guide.

---

## [0.3.0] — Long-Term Memory & Smart Cell Context

### New Features

#### Long-Term Memory — Preference Store
- Structured YAML-based preference registry with three scopes: **global** (`~/.jupyter-assistant/memory/global_memory.yaml`), **project**, and **notebook**
- Preferences persist across sessions and JupyterLab restarts; never stored in the notebook repo
- Each entry carries `confidence`, `evidence_count`, `consistent_count`, `source` (explicit / inferred), and `keywords` for relevance matching
- Deterministic confidence formula: evidence floor × consistency ratio × recency decay (90-day half-life) × source weight

#### Long-Term Memory — Inference Pipeline
- Pattern detection runs automatically every 10 new cell versions (configurable)
- **Priority 1 — symbol value consistency**: flags variables set to the same value in ≥ 3 independent cells (e.g. `random_state=42`)
- **Priority 2 — import frequency**: flags library aliases that appear in ≥ 3 distinct import cells (e.g. `import pandas as pd`)
- Detected patterns converted to human-readable preference entries via the Simple Tasks model (or a deterministic template fallback)

#### Long-Term Memory — Injection Pipeline
- `select_preferences()` selects relevant preferences at query time using keyword matching
- When the candidate list exceeds 10 entries and a Simple Tasks model is configured, an LLM re-ranks the candidates before injection
- Formatted memory block (§7.5) replaces the flat `preferences.md` injection in the system prompt
- **Zero-downtime migration**: existing `preferences.md` continues to be injected as a fallback until the new YAML store is populated, then archived to `preferences.md.bak`

#### Explicit preference detection
- Regex-based scanner detects preference statements in user chat messages ("always use X", "remember to Y", "I prefer Z") and stores them immediately in the preference store without any LLM call

#### Simple Tasks Model (`DS_SIMPLE_TASKS_MODEL`)
- New optional model name setting in **Settings → Routing** (alongside Chat and Completion)
- Uses the same provider as the chat model but a lighter/cheaper model for preference selection, generation, and legacy migration
- Leave blank to use keyword-only matching (no extra API calls)
- Replaces the old completion-model role for background inference tasks

#### Smart Cell Context (v0.2.5 backport, now stable)
- Structured, versioned `SummaryStore` replaces the hard 2 000-char per-cell truncation
- Per-cell summaries include: symbols defined/consumed, types, live values (from kernel snapshot), error flags, import-cell detection
- Focal cell receives full-fidelity source and output (untruncated) regardless of length
- `SummaryStore` now carries a `_meta` block tracking `versions_since_inference` and `last_inference_run`

---

### Bug Fixes

- `deploy.sh` now copies `package.json` to both install locations before the hash-update step, preventing `FileNotFoundError` on clean virtual environments

---

### Developer / Ops

- `pyyaml>=6.0` added as a core dependency (was already present transitively via JupyterLab)
- `create_simple_task_provider()` added to `varys/llm/factory.py` — uses the chat provider type with a model-name override

---

## [0.2.0] — New Release

### New Features

#### MCP (Model Context Protocol) support
- Connect any MCP-compatible server (e.g. filesystem, databases, custom APIs) through the Settings → MCP tab
- Python-native **Sequential Thinking** built-in tool — mirrors the official MCP sequential-thinking server schema without requiring Node.js; drives a multi-turn reasoning loop inside the Anthropic provider
- `MCPManager` singleton owns all server connections at startup; tools are injected into every agentic call automatically

#### Stable cell identity system
- Each notebook cell is tagged with a persistent UUID on first interaction
- Cell references survive cell insertion/deletion; no more off-by-one errors when the LLM refers to "cell #N"
- History is translated at send-time so all prior messages use the current cell numbering

#### Tags panel with built-in presets
- New **Tags** tab groups notebook cells by tag
- Ships with curated presets (EDA, modelling, data cleaning, …) that can be applied in one click

#### Skills — persona override
- A skill file can now include a `persona:` key that replaces the global system-prompt persona for that invocation
- Bundled `python_expert` skill included as a reference

#### Thread management
- Duplicate and delete threads from the thread list
- Rename guard: rejects names that collide with an existing thread

#### Per-thread notebook-aware toggle
- Each thread remembers whether the notebook context is included; toggling one thread does not affect others

#### AWS Bedrock improvements
- AWS Profile-based auth (`AWS_PROFILE`) — no hard-coded credentials needed
- Lazy credential refresh: catches `ExpiredTokenException` and retries transparently
- Token usage reported from the Converse API response

#### Inline completion
- Token-limit input in the Routing tab (default 128) lets you tune completion length
- Validation on empty provider / key / model fields prevents silent failures

#### Commands tab
- Settings → Commands lists all built-in and skill commands live, sorted alphabetically

---

### UI / UX Improvements

#### Chat bubbles
- **Cursor-style click-to-edit** on user messages — click any sent bubble to edit and re-send in place
- Chat history is correctly truncated at the edited message before re-submitting to the LLM
- User bubble width increased to **70 %** of the chat canvas; code blocks inside use `pre-wrap` instead of horizontal scroll
- Edit textarea auto-sizes to the original bubble height and is visually transparent (matches the bubble)
- Response bubble toolbar moved to the **top** of the bubble, Cursor-style, with a separator line below

#### Streaming
- Character-based adaptive drip replaces token-flush: 8 / 16 / 32 chars per tick depending on buffer depth, giving smooth, readable output at any network speed
- Chat window **auto-scrolls to bottom** on every streamed chunk (instant, not smooth-scroll)
- Reasoning / thinking panel also auto-scrolls as thinking tokens arrive

#### Notebook context chip
- `@notebook` chip redesigned as a Cursor-style `@-mention` pill in the input area
- Shows `context: ✓` / `context: ×` prefix; click toggles inclusion

#### Push-to-cell button
- Styled like a Run button; visibility is mode-gated (hidden in *Never* mode, always shown otherwise)
- `Response To Cell` dropdown replaces the old cycle button; options: Discuss / Auto / Write

#### Visual diff view
- Header, cell count, and hint text now use design tokens (`--ds-surface`, `--ds-text`, `--ds-text-dim`) so they are readable in both day and night modes
- "0 cells" badge and instructional hint are hidden when there are no pending diffs (e.g. advisory-only responses)

#### Cell output overlay
- Regular outputs labelled `[1]`, `[2]`, … and error tracebacks labelled separately
- Error cells show a red `[N] 🔴` badge in the overlay so failures are instantly visible

#### Model switcher
- Smaller font and reduced padding throughout the popup
- Custom tooltips added to all icon buttons in the interface

#### Night-mode design token system
- All component colours migrated from raw `--jp-*` JupyterLab variables to `--ds-*` design tokens
- Tokens are defined once in `.ds-chat-day` / `.ds-chat-night`; per-component night overrides removed
- Reduces night-mode text brightness by ~15 % for better readability at night

---

### Bug Fixes

- **Token spacing** (`"Greatnews"` style output): `_strip_null` in `task.py` was calling `.strip()` on every streamed token, removing the leading space that encodes word boundaries in LLM tokenisers. Fixed to `.rstrip()`.
- **Cell numbering ambiguity**: all prompts, skills, and parsers standardised to 1-based `#N` references; context sent to the LLM uses 0-based index `N-1` internally
- **Disambiguation card** shown even when `notebookAware` is off — fixed
- **Bedrock profile auth** blocking frontend validation — fixed
- **Null / blank artefacts** appearing in chat bubbles from `json_delta` events — fixed
- Night-mode code blocks: removed spurious line highlights
- Ollama `base_url` fallback when `OLLAMA_URL` is an empty string
- `OverloadedError` import guard for newer Anthropic SDK versions

---

### Developer / Ops

- `deploy.sh` targets both `pyrhenv` and `.varys` virtual environments
- Cursor rule added: deploy-and-commit checklist ensuring `varys/labextension/package.json` is always committed with the matching `remoteEntry` hash
- All LLM providers aligned to the same `SYSTEM_PROMPT_TEMPLATE`; Anthropic and Bedrock providers unified

---

## [0.1.0] — baseline

Initial public release as described in the [Medium article](https://jmlbeaujour.medium.com/varys-an-ai-assistant-that-understands-jupyter-notebooks-eb84a3705a77):

- Chat assistant with live DataFrame auto-detection
- Slash-command skill system (`/eda`, `/plot`, `/review`, `/ds-review`, `/annotate`, `/readme`, …)
- Visual diff view (accept / reject proposed notebook edits)
- Inline ghost-text code completion
- RAG knowledge base (`/ask`)
- Reproducibility guardian (`/ds-review`)
- Multi-provider: Anthropic, OpenAI, Google Gemini, Ollama, AWS Bedrock, Azure OpenAI, OpenRouter
- Pre-built webpack bundle — no Node.js required on the user machine

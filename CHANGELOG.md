# Changelog

All notable changes to Varys are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

---

## [0.8.0] — Notebook-scoped data layout

### New Features

- **Per-notebook UUID data layout** — each notebook's Varys data (chat threads,
  cell-summary store, memory, debug logs) is now stored under a stable UUID
  sub-directory: `<nb_dir>/.jupyter-assistant/<uuid>/`.  The UUID is written once
  into `notebook.metadata.varys_notebook_id` and travels with the file on rename
  or move, so renaming a notebook no longer orphans its data.
  Project-level data (`knowledge/`, `rag/`, `config/`) remains shared at the flat
  `.jupyter-assistant/` level.

- **Automatic migration** — on first use with an existing flat layout, Varys
  silently migrates data into the UUID folder.  If multiple notebooks share a
  folder, each notebook receives a copy of the shared data and Varys logs a
  warning suggesting `varys nb migrate` for cleanup.

- **`POST /varys/nb/move` endpoint** — moves a notebook *and* its UUID-scoped
  data directory atomically.  Use this via the frontend (or directly) to keep
  data co-located when reorganising notebooks.

---

## [0.7.2] — Patch: Changelog panel fix

### Bug Fixes

- **Changelog panel showed "Changelog not available."** on any pip-installed instance
  (`pip install git+…`). The handler was computing the path to `CHANGELOG.md` relative
  to the source-repo root, which resolves correctly in development but points to a
  non-existent `site-packages/CHANGELOG.md` in installed environments.
  Fixed by bundling `CHANGELOG.md` inside the `varys` Python package
  (`varys/CHANGELOG.md`) and updating the path lookup accordingly.
  `deploy.sh` now syncs the repo-root copy into `varys/` on every build.

---

## [0.7.1] — Input UX Overhaul + Smart Context Chips + Thread Bar Redesign

### New Features

#### Unified Input Frame
- The user-query input box is now a **single bordered frame** (Cursor-style) containing the text area on top and a controls bar below, joined by a hairline separator. The textarea renders transparently inside the frame; the focus ring moves to the outer frame.
- **Send / Stop button**: an up-arrow `↑` button appears in the controls bar whenever the user has typed text; clicking it sends the message. The button transforms into a Stop button (⬛) while streaming and disappears once the response completes.
- **Shift+Enter** now inserts a newline on the first press (previously required two presses due to a `rstrip()` stripping the trailing newline in the `onInput` handler).

#### Smart Context Chips
- **Paperclip icon (📎)** replaces the `×`/`+` text signs on the notebook/file context chip — bright when the file is included in context, greyed-out when excluded.
- **Cell reference chips**: typing `cell #N` generates a `📎 cell #N` chip in the context row, confirming the cell is referenced.
- **`@variable` chips**: typing `@varName` (where `varName` is a live kernel variable) generates a `@varName` chip in the context row. Kernel symbols are loaded proactively when the notebook opens, so chips appear without the user needing to trigger the `@` autocomplete first.
- **`@variable` inline highlighting**: confirmed `@varName` tokens in the input turn blue-italic (same style as `cell #N`) — only for valid kernel symbols.
- The `context:` text label is replaced by the `📎` emoji.

#### Thread Bar Redesign
- **Hover-flip pills**: thread pills show only the name by default; on hover, three action icons slide in to the right of the name — ✏️ rename, ⧉ duplicate, 🗑️ delete. The name remains visible and clickable to switch threads.
- **`[+]` button** replaces `[···]`; placed immediately after the last pill; creates a new thread in one click.
- **Inline rename**: clicking the pen icon opens a compact text input directly inside the pill; Enter confirms, Escape cancels.
- **Scrollable strip**: all threads are visible as a hidden-scrollbar row with no popup needed.

#### Version & Release Notifications
- **Update-available badge**: a clickable badge appears in the chat header when a newer Varys version is published on GitHub (checked once per session).
- **In-sidebar changelog panel**: a "What's New" panel shows the diff between the installed version and the latest; critical changes and new features are highlighted.

#### Chat History Persistence
- Error and warning messages (⚠️ recovery prompts, ❌ provider errors, context-too-long notices) are now **persisted across refreshes**. Previously they disappeared on page reload, leaving back-to-back user bubbles with missing context.

#### Code Block Rendering in User Bubbles
- Fenced code blocks in user query bubbles are now rendered as styled code blocks (with language detection), both in newly sent bubbles and in the edit-bubble view.
- `cell #N` references in the edit bubble now display blue-italic styling (was plain text before).

#### File Agent — Time-Based Limit
- The file agent's `max_turns` limit is replaced with a **wall-clock timeout** (`VARYS_AGENT_TIMEOUT_SECS`, default 120 s). The agent runs until time expires rather than being cut off by an arbitrary turn count.

---

### UI / UX Improvements

- **CoT dropdown spacing**: added visual gap between the notebook chip and the Chain-of-Thought dropdown in the context row.
- **Reproducibility Guardian "Analyze" button**: icon enlarged from `⌕` to `🔍` and font bumped from 10 px to 12 px for legibility.
- **Version badge**: matches the "Varys" title text color in both light and dark modes.
- **Send button style**: dark charcoal circle with white up-arrow, matching the reference icon design.

---

### Bug Fixes

- **Word–number concatenation** (`"all26 cells"`, `"the19 code cells"`): `_strip_null` in `task.py` was calling `.rstrip()` on every streamed token, stripping the trailing space that Anthropic encodes as part of a token. Removed the `.rstrip()` call.
- **Reproducibility Guardian cell numbering**: rules and the panel displayed 0-based cell indices to users; corrected to 1-based throughout.
- **Reproducibility Guardian false-positive imports**: `ast.parse` was failing on cells containing IPython magic commands (`%timeit`, `!pip install`, …), causing all subsequent symbol imports in that cell to be flagged as missing. Magic lines are now stripped before parsing.
- **`AgentTaskResult` dataclass `TypeError`**: `turn_count` (non-default) was placed after `timed_out` (default), violating Python's dataclass field ordering rule.
- **CoT dropdown hidden behind input frame**: `overflow: hidden` on `.ds-input-frame` clipped the absolutely-positioned reasoning dropdown. Removed the property (border-radius still applies visually).
- **Cell tag overlay hover bleed**: `.ds-cell-tag-overlay` had `pointer-events: none`, causing mouse events to fall through to JupyterLab's cell hover styles. Fixed by setting `pointer-events: auto` on the overlay and `pointer-events: none` on nested SVGs.
- **Code block rendering**: the opening-fence regex required a newline after ` ``` `, breaking blocks where code starts on the same line (e.g. ` ```fig, ax = … `). Regex updated to `/(```[\s\S]*?```)/g`.

---

### Security / Dependencies

- **Dependency audit**: eliminated 5 third-party dependencies (`filelock`, `python-dotenv`, `pyyaml`, `httpx`, and `chromadb` telemetry calls) by replacing them with stdlib equivalents (`fcntl`/`msvcrt`, a custom `.env` parser, JSON-based config, and Tornado's `AsyncHTTPClient`). Reduces the attack surface and potential for supply-chain compromise.
- CI pipeline additions: `pip-audit` scheduled check and SBOM generation on release.

---

## [0.7.0] — Notebook Dependency Graph + Reproducibility Guardian Overhaul

### New Features

#### Notebook Dependency Graph
- New **DAG panel** accessible from the thread-bar icon and the `varys:open-graph` command palette entry; re-opens correctly after being closed via the tab ×
- Interactive SVG canvas with **pan and zoom**; click any node to highlight its upstream and downstream paths (unrelated nodes dimmed)
- **Node labels** derived from SummaryStore with a unified four-priority cascade: (1) typed defined symbol with type/shape sublabel (e.g. `df · DataFrame · 891 × 12`); (2) untyped defined symbol; (3) plot title extraction from `plt.title()`, `plt.suptitle()`, `fig.suptitle()` — including f-string prefix handling; (4) source truncation. Unexecuted cells append `· not executed` to the sublabel at every priority level
- **Visualization handle suppression**: `plt`, `sns`, `fig`, `ax`, `axes` are filtered from both `defines` and `loads` at build time (stored data unchanged). Eliminates false edges and spurious anomalies sourced from matplotlib/seaborn state handles
- **Four anomaly types** with distinct visual encoding:
  - `SKIP_LINK` — orange edge: the execution-order definer of a symbol differs from the position-order definer
  - `DEAD_SYMBOL` — gray badge on node: a defined symbol is never consumed by any downstream cell
  - `OUT_OF_ORDER` — solid red edge: non-monotonic execution counts on a dependency path
  - `UNEXECUTED_IN_CHAIN` — dashed node border + severity badge: an unexecuted cell sits between two executed cells in a dependency chain
- **Dagre.js** layout engine runs on the main thread with a `requestAnimationFrame` yield so the loading spinner renders before the layout computes
- Empty and whitespace-only cells are excluded; cells use SummaryStore data when executed, AST fallback when not
- Backend: new `POST /varys/graph` endpoint in `varys/handlers/graph.py`; registered in `varys/app.py`

#### Reproducibility Guardian — Full Redesign
- Panel rebuilt from scratch with dedicated **light and dark mode** designs
- Shield badge in the thread bar now shows a small **severity-colored dot** (red = critical, orange = warning, blue = info) instead of the previous numbered oval — remains hidden for non-notebook files and resets when switching notebooks
- **Three new rules:**
  - Rule 9 — *Used but never defined*: flags symbols consumed in a cell that are never imported or assigned in any preceding cell
  - Rule 11 — *Unpinned package versions*: flags `pip install <pkg>` calls without a `==version` pin
  - Rule 12 — *In-place transformation chain*: flags the same variable being reassigned multiple times in sequence without an intermediate use
  - Empty/comment-only code cells flagged at `info` level

---

### Bug Fixes

#### Critical — Notebook Corruption Risk Eliminated
Three `open("w")` write paths that could silently corrupt or zero-out a notebook on a crash, OOM, or disk-full event were replaced with **atomic temp-file + `os.replace()`** writes:

- **`_ensure_notebook_id`** (`varys/handlers/chat_history.py`) — fires on the first chat message for any notebook without a `metadata.id`. The `nbformat.from_dict()` round-trip was also removed: it ran the full nbformat schema normalizer, which could silently drop cells or outputs from older notebooks. Plain `json.dump` on the already-loaded dict is lossless and sufficient to inject `metadata.id`
- **Agent preview write** (`varys/agent/agent_runner.py`) — applies staged file changes to disk for the user to review before accepting
- **Agent revert write** (`varys/handlers/agent_reject.py`) — restores the original file when the user rejects an agent change

#### Agent Provider
- Background repo scan no longer defaults to Anthropic when `VARYS_AGENT_PROVIDER` is not explicitly set. Falls back to `ds_assistant_chat_provider` (the user's configured chat LLM) instead; raises `AgentConfigError` silently if that provider has no agent implementation, skipping the scan rather than making unexpected API calls

#### Reproducibility Guardian
- Badge no longer persists across notebook switches — resets correctly when focus moves to a different notebook

#### UI
- Dependency graph icon is visible in both light and dark mode (inherits `--jp-ui-font-color2` via shared header-button CSS rule)
- Input placeholder and typed-text color corrected for both light and dark JupyterLab themes
- Settings gear button now matches the style of other header icon buttons
- Thought bubble label cleaned up: consistent `"Thought"` casing, no brain emoji, no uppercase transform

---

### Developer / Ops

- `@dagrejs/dagre` added as a bundled dependency for the DAG layout engine
- New modules: `varys/graph/__init__.py`, `varys/graph/builder.py`, `varys/graph/anomaly.py`, `varys/graph/ast_fallback.py`
- New frontend modules: `src/graph/graphTypes.ts`, `src/graph/graphUtils.ts`, `src/graph/useGraphData.ts`, `src/graph/GraphNode.tsx`, `src/graph/GraphEdge.tsx`, `src/graph/GraphPanel.tsx`

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

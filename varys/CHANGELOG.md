# Changelog

All notable changes to Varys are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

---

## [0.8.7] — In Development

### New Features

#### Skill — `/regroup` for grouping cell contents by functionality
- New bundled skill `regroup_by_function` that handles requests like
  "consolidate imports", "extract functions into their own cell",
  "isolate constants", etc.  Previously these went through the general
  planner with full tool access, which produced the wrong plan on weak
  models (e.g. emitting `modify + delete` instead of `modify + modify`,
  destroying source content).
- The skill teaches a single mandatory algorithm — *scan → identify
  target → modify-or-insert target → modify each source* — and forbids
  `delete` and `reorder` operations within its scope.  An empty cell
  after extraction is harmless; the user can clean it up separately.
- Triggered by an explicit `/regroup` slash command or by tight
  keywords (`consolidate imports`, `extract functions`, `isolate
  constants`, `regroup`, etc.) that pair an action verb with a target.
  Generic words like "reorganize" deliberately do NOT trigger this
  skill — they still route to `reorganize_cell` for whole-cell shuffles
  and bow out via the scope check when content modification is needed.

### Bug Fixes

#### Editor — Undo no longer silently loses deleted cells (data-loss fix)
- **Severity: data loss.**  Clicking ↺ on an operation that contained a
  `delete` step did not restore the deleted cell.  The original cell content
  was captured at apply time but never visited by the wholesale-undo path:
  `undoOperation()` iterated `cellIndices`, which only contained insert and
  modify indices — delete indices were stored separately and never reached.
  The user had no way to recover the lost content beyond a manual notebook-
  level Ctrl+Z (which itself doesn't always restore deleted cells in JL).
  `partialAcceptOperation()` (the per-cell accept/reject path) had correct
  delete-revert logic (`insertCell(idx, 'code', original)`); this just ports
  the same logic to the wholesale-undo path used by the ↺ button.
  Implementation:
    - Added `deletedContents?: Map<number, string>` to `PendingOperation`
    - `applyOperations()` populates it during the delete loop
    - `undoOperation()` is now `async` and runs a Pass-2 step after
      modify/insert undo: re-inserts each deleted cell at its original index,
      iterating in ascending order so successive restorations don't trample
      each other's indices
    - The single caller in `SidebarWidget.tsx` is wrapped in a void-IIFE so
      the composite-op chain is awaited sequentially (concurrent inserts
      would race on the notebook's active-cell index)
  Discovered when Varys mis-planned a "reorganize the notebook so all imports
  are in the first cell" prompt as `modify cell #2 + delete cell #3`,
  destroyed cell #2's content, and ↺ did nothing.

#### Skill — `reorganize_cell` no longer captures content-extraction requests
- **"Reorganize the notebook so all imports are in the first cell" used to
  trigger a useless whole-cell shuffle.**  The skill's keyword list and "When
  this skill applies" example included *"put the imports at the top"*, which
  caused the planner to load this skill — but the skill's tool surface is
  hard-wired to a single atomic `reorder` op (deliberately, to prevent
  index-drift data loss when moving cells).  With only `reorder` available,
  the model would shuffle whole cells around without extracting the import
  lines the user actually wanted moved.
  Added a Step 0 scope check at the top of `reorganize_cell/SKILL.md` that
  forces the skill to refuse and return a clarifying `chatResponse` whenever
  the request implies cell-content modification (extracting imports, merging
  code, splitting cells).  The general planner then picks up the request on
  the next turn with full `modify` + `insert` + `reorder` access.
  Also dropped the *"put the imports at the top"* example phrase from the
  skill's "When this skill applies" copy so the model isn't primed to
  associate import-consolidation with pure reorders.

### Behavior Changes

#### "Where should the answer go?" disambiguation card removed
- **Replaced with auto-routing by prompt shape.**  Plain (non-slash) prompts
  in Agent mode previously surfaced a two-button card asking the user to
  pick between chat and notebook for every advisory-shaped message.  The
  card fired inconsistently — same prompt could route differently depending
  on hidden state (cell mode, context chip, mid-stream output) — and
  required an extra click on the common path.
  Now: questions ("what / why / how / explain / ?") auto-route to `/chat`;
  commands ("refactor / move / add") proceed to the notebook agent flow.
  Override on a per-prompt basis with `/chat <prompt>` to force a chat-only
  answer.
- **New setting** in Settings → Context: *"Where to send answers"*.  Four
  options:
    - **Auto** (default) — infer from prompt shape
    - **Always chat** — never modify the notebook unless an explicit slash
      command is used
    - **Always notebook** — always run the agent flow
    - **Ask each time** — restore the legacy disambiguation card
  Persisted in `localStorage` as `ds-assistant-answer-default`.
- **One-time toast notification** fires on first launch after upgrade,
  pointing the user at the new setting.  Tracked via
  `localStorage` key `varys-answer-default-notified-v1`.

---

## [0.8.6] — Stability & UX Polish

### Restored Functionality

#### `%%ai` magic auto-loading
- Re-enabled the kernel-side `%load_ext varys.magic` injection that runs once
  per kernel ready / restart.  The auto-load was previously short-circuited by
  a leftover `if (true) return;` diagnostic in `src/index.ts` from an earlier
  performance investigation; users who wanted the `%%ai` cell magic had to
  type `%load_ext varys.magic` themselves.  Now `%%ai`, `%%ai --model`,
  `%%ai --skill`, and `%%ai --no-context` work out of the box in any new
  notebook kernel.
- Added an opt-out escape hatch for stress harnesses or automated tests:
  set `window.VARYS_DISABLE_MAGIC_AUTOLOAD = true` before page load (e.g. via
  Playwright `addInitScript`) to skip the injection entirely.  Useful when a
  tight first-cell-execution timeout competes with the kernel's brief "busy"
  window during the magic-load.

### Bug Fixes

#### UI — Misleading "Click Undo" copy on run-cell-only operations
- **Chat bubble said "Changes applied. Click Undo below to revert." even when
  no Undo button rendered.**  Re-running cells (e.g. "Re-run all cells that
  depend on `df`") produces no per-cell diff and no undoable state — the
  Undo button correctly does not render — but the streamed response template
  appended the generic "Click Undo" line anyway, pointing at a UI element
  that didn't exist.  The text now suppresses the line entirely when the
  operation contains only `run_cell` steps (no `insert` / `modify` /
  `delete` / `reorder`).

#### UI — Premature "Changes applied" claim before auto-execution finishes
- The "Changes applied" message was appended to the chat bubble *before*
  the auto-execute loop ran the cells.  Result: bubble showed "applied"
  while the notebook still showed `[*]:` running indicators, eroding trust.
  Moved the append to after the auto-execute loop completes.  Also added
  an interrupt-guard so the message is suppressed when the user clicks
  Undo mid-execution (otherwise we'd announce "applied" right after the
  user reverted).

#### UI — Redundant "Apply" button on auto-applied reorders
- **Reorder cells card showed both `✓ Apply` and `↺` buttons even though the
  reorder was already applied to the notebook**.  Reorder operations
  optimistically rearrange the cells before the diff card appears (the user
  can see the new order immediately), so the `✓ Apply` button asking to
  "keep the new order" was redundant — the only meaningful action at that
  point is `↺` to revert.  The same redundancy was previously cleaned up for
  modify/insert flows by gating Apply on `requiresApproval`, but reorder
  ops set `requiresApproval=true` by skill-rule and slipped through.
  `DiffView.tsx` now suppresses the Apply button when `isReorder=true`
  regardless of `requiresApproval`, and the hint text reads "Cells have
  been rearranged in the notebook. Click ↺ to revert."

#### Inline Completion — Null-model crash on notebook close → open
- **`TypeError: Cannot read properties of null (reading 'sharedModel')`**:
  hotfix to the stale-completion workaround landed earlier in this branch
  (`37aafb5`).  The new `_onActiveCellChanged` handler dereferenced
  `this._watchedCell.model.sharedModel.changed` without guarding against the
  previously-watched cell being disposed.  The crash reproduced
  deterministically when a `notebook_ops.close` was followed by
  `file_ops.open_notebook`: the active-cell-changed signal fired with the
  new notebook's cell while `_watchedCell` still held a reference to the
  disposed previous cell, whose `.model` had been cleared to null.
  All four `sharedModel` dereferences in `InlineCompletionProvider.ts`
  now use optional chaining; disposed cells return undefined and are
  skipped (Lumino signals auto-disconnect on dispose, so this is safe).

#### Inline Completion — Stale-completion crash workaround
- **`RangeError: Invalid line number N in K-line document` from JL's
  inline-completer**: when the user edits a cell while a Varys completion
  request is still in flight (200–800ms typical latency — covers any rapid
  backspacing, cell split, or cell delete during that window), the cached
  response could later be rendered against a now-shorter document and crash
  JupyterLab's inline-completer renderer.  Sometimes the corrupt completer
  state then suppressed ghost text for the rest of the session.
  `DSAssistantInlineProvider` now subscribes to the active cell's
  `sharedModel.changed` signal and aborts the in-flight request (via
  `AbortController`) the moment the document mutates, so JL never receives a
  stale suggestion to cache.  Each new completion request also aborts any
  prior one, and a prefix re-validation runs on the fetched response as a
  belt-and-suspenders check.  Does **not** fix the case where JL has already
  cached a suggestion before the edit — that requires an upstream JupyterLab
  PR — but it eliminates the common in-flight path that produced the bulk of
  the crashes.

#### Google Provider
- **`'NoneType' object is not iterable` on filtered/empty Gemini responses**:
  the streaming chat path, the streaming agent path, the operation-plan tool
  path, and the non-streaming `_extract_text()` helper all iterated
  `candidate.content.parts` directly.  Google's SDK returns
  `candidate.content` truthy but with `parts=None` when generation is cut
  short (`finish_reason=SAFETY`, `RECITATION`, or `MAX_TOKENS` with no text
  emitted), so iteration crashed with `TypeError` and the user saw a generic
  "API error" message instead of a graceful empty result.
  Fixed at all four sites with a safe `getattr` chain
  (`getattr(getattr(cand, "content", None), "parts", None) or []`) and a
  `log.debug` of the `finish_reason` for diagnostics.

---

## [0.8.5] — Focal-Cell Context, Notebook ID Stability, Bedrock Fixes

### New Features

#### Focal-Cell Context Cutoff
- **Opt-in context limit**: new toggle in **Settings → Context** — "Limit context
  to active cell" — restricts the cell context sent to the agent to all cells up
  to and including the focused cell, keeping the agent focused on work-in-progress
  rather than downstream cells.
- **Settings toggle** moved into the Context section with an info bubble that
  accurately describes the behaviour ("all cells up to and including the focused
  cell").
- **Always enforced**: the `limit_to_focal` state is now applied regardless of
  the toggle direction (was previously only enforced when switching ON).

#### Notebook ID Stability — No More "File Changed" Dialog
- Varys no longer writes to `.ipynb` files to stamp a notebook ID.  Previously,
  every new notebook triggered a "File Changed on disk" dialog in JupyterLab
  because Varys wrote `metadata.varys_notebook_id` directly into the file.
- **New lookup order** in `get_or_create_notebook_id`:
  1. In-process cache
  2. `metadata.varys_notebook_id` — legacy field (backward compat, read-only)
  3. `metadata.id` — standard nbformat 4.5 field written by JupyterLab 4+; used
     directly with no write, rename-stable because it travels inside the file
  4. Sidecar file `{nb_dir}/.jupyter-assistant/_notebook_ids.json` — for truly
     old notebooks only; avoids any write to the `.ipynb` file
- **Silent save (Option C)**: when a notebook falls back to the sidecar (no
  built-in ID), the frontend triggers a silent `context.save()` via JupyterLab's
  own API.  JupyterLab writes `metadata.id` into the file during the save — no
  dialog, one-time per old notebook, ID becomes rename-stable permanently.
- **UUID migration**: if `metadata.id` is found after a sidecar UUID was already
  assigned (i.e. after the silent save), the per-notebook data directory is
  automatically renamed from the sidecar UUID to `metadata.id` so no data
  (chat threads, summaries, memory) is orphaned on the next server restart.
- **Sidecar cleanup on rename**: `POST /varys/nb/move` now removes the stale
  source sidecar entry after copying it to the destination, keeping
  `_notebook_ids.json` clean.

#### UI — Input Toolbar Redesign
- **Model switcher** moved to its own dedicated row below the input toolbar,
  outside the rounded input frame; cleaner visual separation from the text area.
- Gap between the input frame and model row tightened.

---

### Bug Fixes

#### UI
- **"Reject" button renamed to "Undo"** across all surfaces: `DiffView` (notebook
  cell edits), `FileChangeCard` (file agent changes), `ActionBar`, all hint text
  strings, and inline chat bubble copy.  Consistent with the "Undo" label already
  used in the standalone `ActionBar`.
- **Focal-cell info bubble** text corrected: previously said "so the agent stays
  focused on a single cell"; now accurately reads "all cells up to and including
  the focused cell".

#### Security & Reliability (code-review hardening)
- **Path traversal prevention**: `chat_history`, `task`, and `reproducibility_guardian` handlers now contain notebook paths via `os.path.realpath()` — requests that resolve outside the project root are rejected with HTTP 400.
- **Env-file path restriction**: `settings.py` rejects any env file path that falls outside the user's home directory.
- **Agent handler authentication**: `GET /varys/agent/change/<id>` now requires the `@authenticated` decorator (was missing).
- **SSE stream lock release**: `client.ts` SSE reader now calls `reader.releaseLock()` in a `finally` block; malformed JSON frames are skipped silently instead of breaking the stream.
- **Tool output truncation**: agent runner caps each tool result at 50 000 chars to prevent oversized payloads from reaching the LLM.
- **Turn counter accuracy**: `turn_count` is now incremented before the loop-break check so every API call is counted correctly.
- **Provider error redaction**: raw provider error messages are no longer forwarded to `on_progress` callbacks; a generic string is used instead.
- **Sidecar file concurrency**: `_write_sidecar_id` / `_remove_sidecar_id` in `paths.py` now hold a `threading.Lock()` during their read-modify-write cycle.
- **Chat history concurrency**: POST and DELETE in `chat_history.py` now hold an `asyncio.Lock()` across their load→mutate→save cycle.
- **Bedrock credential refresh**: double-checked locking pattern (`asyncio.Lock()`) prevents redundant refresh calls under concurrent requests.
- **UUID cache invalidation on migration**: `_BUILT_IN_ID_CACHE` is evicted after a successful notebook UUID migration so stale entries don't persist.
- **Atomic preference write**: YAML→JSON migration in `preference_store.py` writes via `mkstemp` + `os.replace()` instead of `Path.write_text()`.
- **Dead `_last_thinking` state removed**: the instance variable was set but never read in `bedrock_provider.py`; removed to eliminate a latent race condition.
- **AWS auth command not logged**: the auth-refresh shell command string is no longer included in log output.
- **Drag-resize listener cleanup**: `SidebarWidget` now removes `mousemove`/`mouseup` event listeners on unmount via a `useEffect` cleanup.

#### AWS Bedrock
- **`ExpiredTokenException` recovery fixed** — two root causes addressed:
  - *SSO profiles* (`AWS_PROFILE`): `_credentials_expired()` was reading
    `~/.aws/credentials` for SSO profiles that live in `~/.aws/config`, so it
    always returned `True` and ran `aws sso login` before every request.  Fixed
    by skipping the file check for profile-based auth (boto3's SSO credential
    provider handles refresh internally).
  - *Explicit session tokens* (`AWS_SESSION_TOKEN` in `varys.env`): after running
    the auth-refresh command, `_make_client()` still reused `self.session_token`
    (the stale value from startup).  Fixed by `_reload_credentials_from_env()`
    which re-reads `AWS_*` keys from `varys.env` after the refresh so the
    rebuilt boto3 client picks up the new values.
- **"input is too long" caught as context-too-long**: AWS Bedrock raises
  `ValidationException: input is too long` when the request exceeds the model's
  context window.  This was not matched by the existing patterns, so users saw a
  raw error string instead of the friendly "Context too large" UI advisory.
  Added Bedrock-specific patterns: `"input is too long"`, `"too many tokens"`,
  `"input length"`.

#### Notebook ID / Data Integrity (code-review fixes)
- `_notebook_has_built_in_id()` now also checks `metadata.varys_id` (legacy
  Varys field) so notebooks stamped by older Varys versions don't spuriously
  trigger a `needsIdStamp` silent save.
- Silent save promise (`context.save()`) now has a `.catch()` handler instead of
  bare `void`.
- Duplicate step-label comment ("3." appearing twice) in `paths.py` fixed.

#### Skills — Prompt Robustness
- **`/ds-review` empty-notebook guard**: the skill could occasionally fabricate
  a methodology review when invoked against a notebook with zero non-empty
  code cells.  Added an explicit Step 0 pre-check at the top of the skill that
  counts non-empty code cells, emits a fixed "notebook is empty" message, and
  stops before any review output can be generated.  The guard declares
  precedence over every other instruction in the skill, so the model cannot
  "fall through" to the review template on an empty fixture.

---

### Developer / Test Infrastructure

- **Varys stress-test framework v1.0** (`varys_tests/`): curriculum-based
  scenario harness that drives a real JupyterLab session, evaluates responses
  with an LLM judge, and writes structured JSON result files.
- **Primitives catalog for external stress testing** (`stress/`): deterministic
  YAML catalog of 65 user-facing operations consumed by the external
  `varys-stress` repo.  Built from six priority-ordered sources (slash-command
  SKILL.md front matter, tsx event handlers, JupyterLab command subset, file
  & notebook ops).  Re-runnable extractor script produces byte-identical
  output per SHA; validates CSS selectors against live source.
- **Self-contained per-fixture scenario folders**: each test scenario ships its
  own fixture notebook, preventing cross-scenario contamination.
- **LLM prompt templates** for generating new test scenarios added to
  `docs/tests/`.
- `limit_to_focal` plumbed through scenario YAML so test runs can exercise the
  focal-cell context feature.

---

## [0.8.0] — Smart Context Engine + Graph Overhaul + UI Polish

### Breaking Changes

- **RAG / Embedding subsystem removed** — `varys/rag/`, `varys/handlers/rag.py`,
  and `varys/bundled_config/rag.cfg` have been deleted. The `/ask` command is no
  longer available. This removes the `chromadb` dependency entirely.
- **Prompt-caching env var unified** — `VARYS_AGENT_PROMPT_CACHING` is removed;
  use `VARYS_PROMPT_CACHING` for all modes (chat, agent, background tasks).

---

### New Features

#### Smart Cell Context & Kernel State Tracking
- **`kernel_state.json`** — new live variable store written after each cell
  execution; tracks every in-scope variable's type, shape, and sampled values,
  updated incrementally.
- **DataFrame column profiles** captured in `symbol_meta`: column names, dtypes,
  and null counts per DataFrame; available to the LLM as structured context.
- **Series metadata**: name + dtype recorded in kernel snapshot.
- **scikit-learn estimator hyperparameters** captured in kernel snapshot for
  fitted models.
- **Wall-clock execution time** tracked per cell; surfaced as `execution_ms` in
  LLM context.
- **`auto_summary` for code cells**: short cells (≤ 2 000 chars) use their source
  directly; longer cells use TextRank + optional LLM fallback to produce a
  concise summary.
- **TextRank summarization for markdown cells**: large markdown cells are
  summarized with TextRank (field renamed `llm_summary` → `auto_summary`).
- **Output collapsing**: repetitive output lines are collapsed to `[N × …]`;
  large outputs are summarized by the LLM before injection into context.
- **Tuple unpacking in `extractAssignedNames`**: `a, b = func()` now correctly
  registers both `a` and `b` as defined symbols.
- **LLM context enriched**: `auto_summary`, `cell_action`, `execution_ms`,
  `symbol_meta`, and cell tags are now surfaced to the LLM in structured context
  blocks; execution count removed (replaced by `execution_ms`).

#### Dependency Graph — Upgraded Node Labels & Sublabels
- **Variable name as hero text**: graph nodes show the primary assigned variable
  name as the largest label.
- **Data source filename** shown in data-loading nodes alongside the variable
  name and type.
- **Self-learning action stem dictionary** (`~/.jupyter/varys_action_stems.json`):
  new method names observed at runtime are appended so node labels improve over
  time without a code change.
- **Unified action/tag vocabulary** — action identifiers now use the same tag
  names as the Tags panel (`library.json` is the single source of truth).
- **Sublabel format improvements**: data-loading nodes use
  `filename · var (Type)`; action nodes show primary method name first (e.g.
  `dropna · df (DataFrame)`); f-string variables and direct args extracted
  correctly.
- **Graph connectivity fixes**: multigraph enabled in dagre for named edges;
  role-coloured nodes; `Cell N` headers; re-import edges handled correctly.

#### Notebook-Scoped Data Layout
- **Per-notebook UUID data layout** — each notebook's Varys data (chat threads,
  cell-summary store, memory, debug logs) is now stored under a stable UUID
  sub-directory: `<nb_dir>/.jupyter-assistant/<uuid>/`. The UUID is written once
  into `notebook.metadata.varys_notebook_id` and travels with the file on rename
  or move, so renaming a notebook no longer orphans its data.
  Project-level data (`knowledge/`, `config/`) remains shared at the flat
  `.jupyter-assistant/` level.
- **Automatic migration** — on first use with an existing flat layout, Varys
  silently migrates data into the UUID folder.
- **`POST /varys/nb/move` endpoint** — moves a notebook and its UUID-scoped data
  directory atomically.

#### Prompt Caching
- **Semantic boundary split for chat mode**: cache break inserted at the natural
  boundary between system prompt and conversation history.
- **Semantic boundary split for Bedrock**: same boundary logic applied to the
  Bedrock Converse API path.
- **Unified `VARYS_PROMPT_CACHING`** controls caching for all modes.
- **Toggle in Model Routing settings**: prompt caching can be enabled/disabled
  from the UI without restarting JupyterLab.

#### SummaryStore Improvements
- **`_cells` index** added to `summary_store.json` for human inspection —
  maps source hash → cell metadata.
- **In-place runtime field patching** on same-source re-runs: only
  `execution_ms`, `error_flag`, and `outputs` are updated; full
  re-summarization is skipped.
- **Empty-source cells skipped** to prevent ghost entries in the store.

#### Settings UI — Multi-Panel Polish
- **Model Providers panel**: cleaner layout, password reveal button, per-field
  descriptions, better row spacing; embedding model fields removed.
- **MCP settings panel**: improved layout and help text.
- **Skills panel**: improved list view and skill detail display.
- **Commands panel**: improved layout and sorting.
- **Tags panel**: collapsible tag sections; UI polish throughout.
- **Model Routing panel**: prompt caching toggle added; background task section
  clarified; Chat/Agent labels updated.

---

### Bug Fixes

#### Graph
- Action sublabel now extracts f-string variables and direct argument names
  instead of the string prefix.
- Data-loading sublabel resolves DataFrame variable name and filename from
  `symbol_values`.
- Operation·result pattern applied consistently across all action sublabel
  types.
- Primary method name shown first in action sublabels (e.g. `dropna · df`).
- `tags` reference corrected in import-cell `detect_actions`; missing
  `symbol_meta` key added.

#### Kernel Snapshot
- `sys.modules` used instead of `import` to avoid cold-import delay
  (≈ 1–2 s on first NumPy/pandas execution).
- 5-second timeout added to kernel snapshot to prevent stalling.
- 150 ms delay added before snapshot to avoid blocking BLAS initialisation.
- Redundant stat calls removed from snapshot path.

#### Context / Summarizer
- `auto_summary` returns full source for short markdown cells (≤ 2 000 chars)
  instead of an empty summary.
- `source_snippet` whitespace stripped in all summarizer paths.

#### UI
- Skill filepath directory label colour corrected in dark mode.
- Only the Reject button shown when code has already been applied
  (`requiresApproval=false`) — Accept hidden to prevent double-apply.
- Code diff block shown before running cells (not after).

#### Bedrock
- `ExpiredTokenException` on streaming calls now triggers automatic token
  refresh and retry.
- Forced `tool_choice` skipped when extended thinking is active (was causing
  API errors).
- `create_operation_plan` tool call forced on Bedrock thinking path to avoid
  empty responses.

#### Miscellaneous
- Cell execution interrupted on Reject when a cell is running mid-execution.
- `Background Task` / `Background Model` naming made consistent across all
  settings fields and info bubbles.
- `Glob` and `Grep` file-agent tools now have a 15-second timeout to prevent
  stalling on large filesystems.
- `bash_guard` returns a structured tool result on BLOCK/WARN (was plain string).
- "What's New" panel shows current-version changes correctly using inclusive
  `?from=` parameter.
- Inline imports moved to module level in `cell_executed.py` for faster
  repeated execution.

---

### Removed

- **RAG / Embedding subsystem** (`varys/rag/`, `varys/handlers/rag.py`,
  `varys/bundled_config/rag.cfg`) — removed to reduce dependency surface and
  maintenance burden.
- **`VARYS_AGENT_PROMPT_CACHING`** environment variable — superseded by
  `VARYS_PROMPT_CACHING`.
- **Execution count** from LLM context summary blocks — replaced by
  `execution_ms`.

---

### Developer / Ops

- New modules: `varys/context/kernel_state.py`, `varys/context/action_stems.py`,
  `varys/handlers/nb_move.py`.
- New documentation: `docs/summary_store.md`.
- `CLAUDE.md` developer guide added to repo root.
- `tests/` directory added to `.gitignore`.

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
- Detected patterns converted to human-readable preference entries via the Background Task model (or a deterministic template fallback)

#### Long-Term Memory — Injection Pipeline
- `select_preferences()` selects relevant preferences at query time using keyword matching
- When the candidate list exceeds 10 entries and a Background Task model is configured, an LLM re-ranks the candidates before injection
- Formatted memory block (§7.5) replaces the flat `preferences.md` injection in the system prompt
- **Zero-downtime migration**: existing `preferences.md` continues to be injected as a fallback until the new YAML store is populated, then archived to `preferences.md.bak`

#### Explicit preference detection
- Regex-based scanner detects preference statements in user chat messages ("always use X", "remember to Y", "I prefer Z") and stores them immediately in the preference store without any LLM call

#### Background Model (`DS_BG_TASK_MODEL`)
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
- `create_bg_task_provider()` (formerly `create_simple_task_provider()`) added to `varys/llm/factory.py` — uses the chat provider type with a model-name override

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

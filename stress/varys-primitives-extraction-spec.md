# Task: Produce `stress/primitives.yaml` for the Varys Stress-Test Framework

## Context

A separate repo (`varys-stress`) runs automated stress-test campaigns against Varys. It generates scenarios by composing atomic user-facing operations ("primitives") and executes them via Playwright against fresh JupyterLab+Varys subprocesses.

The stress-test framework is a **pure external observer**: it never reads Varys internals. It only drives Varys through user-facing actions and watches for crashes, hangs, console errors, backend tracebacks, and kernel deaths.

Your task is to produce the **canonical catalog of those user-facing actions**, pinned to the current Varys SHA, in a single YAML file: `stress/primitives.yaml`.

## Deliverables

1. **`stress/primitives.yaml`** — the primitive catalog (schema below)
2. **`stress/primitives_extractor.py`** — the Python script that generated the YAML, re-runnable on future SHAs
3. **`stress/missing_testids.md`** — checklist of user-facing elements that need a `data-testid` added but currently don't have one (follow-up PR, not this task)
4. **`stress/README.md`** — brief explainer of what these files are, how to regenerate, and how the stress repo consumes them

All four deliverables live under a new `stress/` directory at the Varys repo root.

## Non-Goals

- Do **not** build a test runner, Playwright driver, or CI hook. This task produces a data artifact and the script that generates it — nothing more.
- Do **not** include internal operations (background tasks, bookkeeping calls, implementation details not triggerable from the UI).
- Do **not** enumerate every keyboard shortcut and micro-interaction. Target 40-80 primitives total for the first pass. If you find yourself approaching 150, you are at the wrong level of granularity — stop and revisit.
- Do **not** wire `primitives.yaml` into any Varys code. It is consumed externally.

## What Counts as a Primitive

A primitive is an **atomic user-visible operation with stable preconditions, a stable invocation path, and a stable completion signal.**

Good primitives:
- "Send a prompt to the Varys sidebar" (one invocation, one completion signal — the Send↔Stop button swap)
- "Insert a cell below the currently selected cell" (one JupyterLab command, immediate DOM effect)
- "Invoke the `/eda` slash command with a prompt argument" (distinct slash command, distinct completion)
- "Upload a file via the sidebar attach button"

Not primitives (too fine):
- "Press the down arrow key"
- "Hover over the send button"
- "Focus the chat input textarea"

Not primitives (too coarse):
- "Do an exploratory data analysis workflow" (this is a scenario, composed of many primitives)

Not primitives (internal):
- "Trigger a SummaryStore flush"
- "Call the context assembler"

If in doubt: can a human user cause this operation with one visible interaction? If yes, primitive. If it requires chaining multiple interactions to express, it's a scenario, not a primitive.

## Extraction Sources (in priority order)

Use these sources in order. Prefer authoritative structured sources over code-scanning.

### 1. Varys slash-command registry (authoritative)

Parse the slash-command registry module directly. Do not regex. One primitive per registered command, with id `varys.slash.<command_name>`. The registry tells you argument types, description, and completion semantics.

### 2. Varys SKILL.md files (cross-check)

Each SKILL.md that maps a slash command should correspond to one primitive already emitted from source 1. Use SKILL.md to enrich descriptions and derive reasonable sample parameter values. If a command appears in SKILL.md but not in the registry (or vice versa), that's a bug in Varys — flag it in `missing_testids.md` under a "Registry / SKILL mismatches" heading.

### 3. `SidebarWidget.tsx` (event handlers)

Scan for event handlers (onClick, onSubmit, etc.) attached to user-facing elements. Each distinct handler is a candidate primitive. Examples: new thread, send, stop generation, attach file, switch provider, open settings.

For each handler:
- **If the element has a `data-testid` attribute**: emit the primitive with that selector
- **If it does not**: add a `data-testid` in the same PR and emit the primitive with it. Record the addition in `missing_testids.md` so the follow-up review catches it.

Skip internal handlers (telemetry pings, debug-only buttons, handlers gated behind dev flags).

### 4. JupyterLab command registry subset

Include exactly these JupyterLab commands — no more, no less, unless Varys has replaced one of them:

- `notebook:insert-cell-above`
- `notebook:insert-cell-below`
- `notebook:delete-cell`
- `notebook:duplicate-below`
- `notebook:move-cell-up`
- `notebook:move-cell-down`
- `notebook:merge-cells`
- `notebook:split-cell-at-cursor`
- `notebook:run-cell`
- `notebook:run-cell-and-select-next`
- `notebook:run-all-above`
- `notebook:run-all-below`
- `notebook:clear-cell-output`
- `notebook:change-cell-to-code`
- `notebook:change-cell-to-markdown`
- `notebook:change-cell-to-raw`
- `notebook:interrupt-kernel`
- `notebook:restart-kernel`

If Varys has its own versions of any of these (wrapping or replacing the default), use the Varys version and note it in the primitive description.

### 5. File operations

- `file_ops.create_notebook` — create a new `.ipynb`
- `file_ops.open_notebook` — open an existing notebook by path
- `file_ops.upload_file` — upload a local file to the Jupyter workspace
- `file_ops.delete_file` — delete a file from the workspace

These use the standard JupyterLab file browser, not Varys-specific UI.

### 6. Notebook operations

- `notebook_ops.save`
- `notebook_ops.close`

Stop there for the first pass. Export-to-format, notebook-rename, and other operations can be added in a later iteration if coverage analysis shows they matter.

## Primitive Schema

```yaml
version: 1
varys_sha: <current git SHA>
extracted_at: <ISO8601 timestamp>
primitives:
  - id: <dotted.id>                # e.g., cell.insert_below, varys.send_prompt, varys.slash.eda
    category: <category>            # see list below
    description: <one sentence>
    preconditions:                  # abstract state predicates, names from the list below
      - <predicate>
    postconditions:                 # abstract state transitions, names from the list below
      - <transition>
    invocation:                     # how to actually execute it
      type: <jupyter_command | playwright | api>
      # if jupyter_command:
      command: <command_id>
      # if playwright:
      steps:
        - action: <click | fill | type | press | upload>
          selector: <css_selector>    # use data-testid whenever possible
          content: "{param_name}"     # template slot for a parameter
    completion_signal:              # optional — omit for synchronous/immediate operations
      type: <dom_swap | selector_appears | selector_disappears | text_matches>
      # fields depend on type; see examples below
      timeout_seconds: <number>
    parameters:                     # optional — omit if none
      - name: <param_name>
        type: <string | int | file_path>
        required: <bool>
        example: <sample value for YAML readability>
```

### Canonical Categories

- `cell_structure` — insert, delete, duplicate, move, merge, split, change-type
- `cell_content` — write code, write markdown, clear source
- `cell_execution` — run, run-all-above, run-all-below, interrupt, restart-kernel
- `varys_chat` — send prompt, new thread, stop generation, attach file, switch provider, open/close sidebar
- `varys_commands` — each slash command is its own primitive (`varys.slash.<name>`)
- `file_ops` — create, open, upload, delete
- `notebook_ops` — save, close

### Canonical Preconditions / Postconditions

Use these exact strings. If you need a new one, add it to this list in `README.md` so the stress-test framework's state model can be updated to match.

Preconditions:
- `notebook_open`
- `cell_selected`
- `cell_type_is_code`
- `cell_type_is_markdown`
- `varys_sidebar_open`
- `varys_idle`
- `kernel_running`
- `file_exists:<param>`

Postconditions:
- `cell_count_increased_by_1`
- `cell_count_decreased_by_1`
- `cell_source_set`
- `cell_executed`
- `kernel_restarted`
- `varys_loading_until_response`
- `thread_created`
- `file_attached`
- `provider_switched`

## Examples

### Synchronous JupyterLab command

```yaml
- id: cell.insert_below
  category: cell_structure
  description: Insert a new empty code cell below the currently selected cell.
  preconditions:
    - notebook_open
    - cell_selected
  postconditions:
    - cell_count_increased_by_1
  invocation:
    type: jupyter_command
    command: notebook:insert-cell-below
  parameters: []
```

### Playwright interaction with a parameter

```yaml
- id: cell.write_code
  category: cell_content
  description: Type code into the currently selected cell.
  preconditions:
    - notebook_open
    - cell_selected
    - cell_type_is_code
  postconditions:
    - cell_source_set
  invocation:
    type: playwright
    steps:
      - action: click
        selector: ".jp-Cell.jp-mod-selected .cm-content"
      - action: type
        content: "{code}"
  parameters:
    - name: code
      type: string
      required: true
      example: |
        import pandas as pd
        df = pd.read_csv("data.csv")
```

### Async Varys operation with completion signal

```yaml
- id: varys.send_prompt
  category: varys_chat
  description: Send a prompt to the Varys sidebar and wait for the response.
  preconditions:
    - varys_sidebar_open
    - varys_idle
  postconditions:
    - varys_loading_until_response
  invocation:
    type: playwright
    steps:
      - action: fill
        selector: "[data-testid='varys-chat-input']"
        content: "{prompt}"
      - action: click
        selector: "[data-testid='varys-send-button']"
  completion_signal:
    type: dom_swap
    from_selector: "[data-testid='varys-stop-button']"
    to_selector: "[data-testid='varys-send-button']"
    timeout_seconds: 120
  parameters:
    - name: prompt
      type: string
      required: true
      example: "Summarize the dataframe in the current cell."
```

### Slash command

```yaml
- id: varys.slash.eda
  category: varys_commands
  description: Invoke the /eda slash command to perform exploratory data analysis on a referenced dataframe.
  preconditions:
    - varys_sidebar_open
    - varys_idle
  postconditions:
    - varys_loading_until_response
  invocation:
    type: playwright
    steps:
      - action: fill
        selector: "[data-testid='varys-chat-input']"
        content: "/eda {prompt}"
      - action: click
        selector: "[data-testid='varys-send-button']"
  completion_signal:
    type: dom_swap
    from_selector: "[data-testid='varys-stop-button']"
    to_selector: "[data-testid='varys-send-button']"
    timeout_seconds: 180
  parameters:
    - name: prompt
      type: string
      required: true
      example: "Analyze df"
```

## The Extractor Script

`stress/primitives_extractor.py` must:

1. Take arguments: `--varys-repo <path>` (default: repo root) and `--out <path>` (default: `stress/primitives.yaml`).
2. Run the priority-ordered extraction in deterministic order. No random ordering between runs.
3. Read the current git SHA from the repo and embed it in the YAML header.
4. Print a summary to stdout: counts per category, total count, any warnings (e.g., handler found without `data-testid`).
5. Exit non-zero if any source fails to parse.
6. Be re-runnable: running it twice on the same SHA produces byte-identical output.

Structure the script so each source is a separate function returning a list of primitives. Main composes them, deduplicates by `id`, validates against the schema, writes YAML.

Do **not** call an LLM from this script. Extraction is fully deterministic. If you find operations you cannot extract deterministically, list them in `missing_testids.md` under "Needs manual primitive entry" and hand-write them into `primitives.yaml` as a separate initial commit — clearly flagged so a human reviewer confirms them.

## `missing_testids.md` Structure

```markdown
# Primitive Extraction — Manual Follow-Ups

This file tracks items found during primitive extraction that need human review or a follow-up PR.

## Elements Needing `data-testid`
- [ ] `<ComponentName>` in `<filepath>:<line>` — handler `<onClick_name>` — suggested id `data-testid="<proposed>"`
  - Rationale: <why this is user-facing>

## Registry / SKILL Mismatches
- [ ] Slash command `/foo` appears in `<skill_file>` but not in the slash registry
- [ ] Slash command `/bar` is registered but has no SKILL.md

## Needs Manual Primitive Entry
- [ ] <description of an operation that couldn't be extracted deterministically>

## Coverage Concerns
<any operations you think should be primitives but aren't being extracted from the current sources>
```

## `stress/README.md` Structure

```markdown
# Varys Stress-Test Support Files

This directory contains artifacts consumed by the external `varys-stress` repo.

## Files

- `primitives.yaml` — catalog of user-facing operations at the pinned SHA
- `primitives_extractor.py` — deterministic extractor, re-run when SHA advances
- `missing_testids.md` — follow-up checklist from the last extraction

## Regenerating

```
python stress/primitives_extractor.py --out stress/primitives.yaml
```

Review the diff. If the diff touches only the `varys_sha` / `extracted_at` header, no Varys change was user-visible. If primitives are added/removed, bump the pinned SHA in any active stress-test campaign config.

## Contract with `varys-stress`

Primitives are defined by:
- `id` — stable across SHAs when possible; additions require campaign coverage reset
- `invocation` — selectors and command ids must actually work at the pinned SHA
- `completion_signal` — the runner waits on this before moving to the next step

Changing a primitive's `id` is a breaking change and invalidates coverage history. Prefer adding new primitives to renaming existing ones.
```

## Quality Bar Before Marking Done

- [ ] `primitives.yaml` validates against the schema (write a small validator, run it)
- [ ] Every `data-testid` referenced in the YAML exists in the current Varys build (grep the source to confirm)
- [ ] Every `jupyter_command` id is a real JupyterLab command (cross-check against JupyterLab docs or the running instance)
- [ ] Total primitive count is between 40 and 80
- [ ] Re-running the extractor produces byte-identical output
- [ ] `missing_testids.md` exists (even if empty sections, include the headers)
- [ ] `README.md` covers regeneration and the contract with `varys-stress`

## Out of Scope — Explicitly

- No Playwright, no test runner, no CI
- No integration with `varys-stress` (that repo consumes `primitives.yaml` independently)
- No LLM calls in the extractor
- No bulk `data-testid` addition beyond what extraction directly requires (a broader audit is a separate task)
- No primitive for anything that isn't user-triggerable via the UI

## Clarifying Questions to Raise Before Starting

Ask the user before implementing if any of the following is unclear:

1. Where does the slash-command registry live? (Expect a single module; confirm path.)
2. Are there multiple `SidebarWidget`-like files to scan, or is it the sole entry point for sidebar UI?
3. Is there an existing `stress/` directory or similar that conflicts?
4. Should `data-testid` additions go in this PR, or should they be a separate PR that this one depends on?

Raise these as a single batched question before writing code. Do not guess.

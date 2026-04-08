# Varys Curriculum

This directory contains the test curriculum for the Varys stress-test framework. There are **two ways** to define and run tests:

1. **Built-in tiered DAG** (`tasks.py`, `dag.py`) — fixed Tier 1–4 tasks against the bundled fixtures, with tier gates and lateral failure routing. Run via `tests/test_curriculum.py`.
2. **Scenario files** (`scenarios/*.yaml`) — declarative, ordered, chained task lists you can author by hand or generate from any notebook with `generate.py`. Run via `tests/test_scenarios.py`.

---

## Layout

```
curriculum/
├── README.md               ← this file
├── tasks.py                ← built-in Task dataclass + Tier 1–4 definitions
├── dag.py                  ← CurriculumRunner: tiered runner + scenario runner
├── scenario_loader.py      ← parse YAML → Task objects
├── generate.py             ← LLM-driven scenario generator (CLI)
└── scenarios/              ← one folder per fixture, each with sibling YAMLs
    ├── simple_rename/
    │   ├── simple_rename.ipynb
    │   ├── rename_basics.yaml
    │   └── focal_only_basics.yaml
    └── messy_sales_analysis/
        └── messy_sales_analysis.ipynb
```

Each scenario folder is **self-contained** — the `notebook:` field in a YAML
is resolved relative to that YAML's own directory, so a scenario folder can
be copied/moved/zipped without breaking. Multiple scenario YAMLs can share
the same fixture by living in the same folder.

---

## Running scenarios

### All scenarios

```bash
pytest varys_tests/tests/test_scenarios.py -v -s
```

Each `*.yaml` file in `scenarios/` becomes one parametrized pytest case. Reports land in `varys_tests/results/<timestamp>-<scenario>.json`.

### One scenario

```bash
VARYS_SCENARIO=rename_basics pytest varys_tests/tests/test_scenarios.py -v -s
```

### Headed mode (watch the browser)

```bash
VARYS_TEST_HEADLESS=0 VARYS_SCENARIO=rename_basics \
    pytest varys_tests/tests/test_scenarios.py -v -s
```

---

## Authoring a scenario by hand

1. Pick the fixture folder under `scenarios/<fixture_name>/`. If you're
   adding a brand-new fixture, create a new folder and drop the `.ipynb`
   into it.
2. Drop a YAML file alongside the notebook in that same folder.

Minimum schema:

```yaml
name: my_scenario
description: |
  Free-text rationale for what this scenario tests.
notebook: my_notebook.ipynb         # path RELATIVE to this YAML's folder

# Optional Varys settings — applied via UI clicks after sidebar opens.
mode: agent                         # chat | agent
reasoning: cot                      # off | cot | sequential
limit_to_focal: false               # in agent mode, hide cells past the focal cell

# Optional one-shot setup applied right after the notebook is opened,
# before the first task. Mirrors a real user opening the notebook,
# running everything, and clicking the cell they want to edit.
setup:
  run_all: true
  focus_cell: 2                     # 1-indexed, matches Varys UI cell badges

tasks:
  - id: rename_var
    tier: 1
    target_cell: 2                  # 1-indexed, matches Varys UI cell badges
    prompt: |
      Rename `df_north` to `df_region_north` in the data generation cell
      and update all references.
    timeout_s: 180
    assertions:
      structural:
        - cell_count_between: [4, 8]
        - symbol_present: df_region_north
        - symbol_absent: df_north
        - cell_defining_symbol_nonempty: df_region_north
      execution: false
      judge: true

  - id: fix_syntax
    tier: 1
    prompt: |
      There is a syntax error in one of the code cells. Find it and fix it.
    timeout_s: 180
    assertions:
      structural:
        - cell_count_between: [4, 8]
      execution: true
      judge: true
```

**Key behaviors:**

- **Chained execution** — every task starts from the state the previous
  task left behind. The notebook is _not_ reset between tasks. This lets
  you test multi-turn flows (rename → fix → add header → run).
- **Per-task assertions** — each task has its own structural checks,
  optional kernel execution, and optional LLM judge.
- **Notebook field** — relative to the YAML file's own directory. The
  loader resolves it to an absolute path before passing to the runner,
  so scenario folders are self-contained.
- **`target_cell` and `setup.focus_cell`** — both are **1-indexed** to
  match the Varys UI cell badges (`#1`, `#2`, …). The runner subtracts
  1 internally before calling JupyterLab's 0-indexed `activeCellIndex`.
- **`limit_to_focal`** — when `true` and `mode: agent`, the backend
  assembler hides cells past the focal cell. The driver clicks the
  sidebar "Focus on active cell" pill (🌐 Full ↔ 🔒 Focused) to enforce
  the requested state. Use this only for tasks that don't need to see
  or edit downstream cells; otherwise the agent will (correctly) refuse.

### Available structural assertion factories

Each YAML entry under `assertions.structural` is a single-key mapping. The key names a factory in `harness/notebook_state.py`:

| Factory | Argument | Purpose |
|---|---|---|
| `cell_count_between` | `[min, max]` | Total cell count must be in this range |
| `symbol_present` | `<name>` | A symbol must appear in some cell source |
| `symbol_absent` | `<name>` | A symbol must NOT appear in any cell |
| `cell_defining_symbol_nonempty` | `<name>` | A cell defining `<name> = ...` must exist with a non-trivial RHS |
| `markdown_header_present` | `<text>` | A markdown cell must contain this text (case-insensitive) |
| `symbols_in_order` | `[<sym1>, <sym2>, ...]` | First-occurrence cell index must be strictly increasing |

Need a new assertion type? Add a factory in `notebook_state.py` and a dispatch case in `scenario_loader._build_structural_assertion`.

### Assertion options

```yaml
assertions:
  structural: [...]      # list of factory entries
  execution: true        # run nbconvert on a copy of the post-action notebook
  judge: true            # call the LLM judge with the prompt + diff
```

The task **passes** only if all three layers pass. The judge fails the task if `intent_correct` or `data_safe` is false; `response_quality: poor` is logged as a warning but does not block.

---

## Generating a scenario from a notebook

`generate.py` is an LLM-driven CLI that reads any notebook and proposes an ordered list of tasks tailored to it.

### Requirements

- An Anthropic API key resolvable through the same chain the judge uses:
  1. `ANTHROPIC_JUDGE_API_KEY` env var
  2. `ANTHROPIC_API_KEY` env var
  3. `~/.jupyter/varys.env` (`ANTHROPIC_JUDGE_API_KEY`, `ANTHROPIC_API_KEY`, or `DS_CHAT_API_KEY`)

### Usage

```bash
python -m varys_tests.curriculum.generate /path/to/your_notebook.ipynb \
    --name your_scenario \
    --num-tasks 6 \
    --description "Refactor exercises on your notebook"
```

What it does:

1. Creates `scenarios/<notebook_stem>/` and copies your notebook into it
   (so the scenario folder is self-contained)
2. Sends the notebook source to Claude Sonnet 4.6 with a constrained schema
3. Parses the response and writes `scenarios/<notebook_stem>/<name>.yaml`
4. Prints the command to run it

**Always review the generated YAML before running.** The model can be over-eager with assertions or propose ambiguous prompts. Treat the output as a first draft, not a finished scenario.

### Tips

- **Start with `--num-tasks 4`** to get a focused chain you can iterate on. Bump it later if the scenario covers ground you want to test.
- **Use `--description`** to bias the model — e.g., `--description "Focus on functionalizing duplicated blocks"` will skew it toward Tier 3 refactor tasks.
- The generator uses `claude-sonnet-4-6` for higher-quality scenarios. The judge uses `claude-haiku-4-5` for cheap per-task verdicts. They're independent.

---

## Built-in tiered curriculum (legacy DAG)

If you want the original Tier 1–4 DAG with tier gates instead of scenarios:

```bash
pytest varys_tests/tests/test_curriculum.py -v -s
```

Tasks are defined in `tasks.py`. Tier-gating logic is in `dag.py::CurriculumRunner.run()`. Tier 3 only runs if at least one Tier 2 task passed; Tier 4 only if at least one Tier 3 passed.

Use this when you want a single broad sweep of capabilities. Use scenarios when you want focused, repeatable, chained tests of specific notebooks.

---

## Reports

Every run writes a JSON report to `varys_tests/results/`:

- Built-in DAG: `<timestamp>.json`
- Scenarios: `<timestamp>-<scenario_name>.json`

Reports are flushed **after every task** so partial / aborted runs always leave an inspectable artifact at a known location.

Each task entry includes:

```json
{
  "task_id": "...",
  "tier": 1,
  "status": "pass | fail | timeout | skipped",
  "structural": { "passed": true, "failures": [], "checked": [...] },
  "execution":  { "passed": true, "exit_code": 0, ... },
  "judge":      { "intent_correct": true, "data_safe": true, ... },
  "varys_response": "...",
  "notebook_diff": "...",
  "duration_s": 47.2,
  "warnings": []
}
```

---

## Troubleshooting

**Sidebar doesn't open / chat input is hidden** — the JupyterLab right sidebar tab toggles on click. The driver retries up to 3 times. If it still fails, check the screenshot in `varys_tests/results/playwright/`.

**Send button never appears** — the Send button in the chat UI only renders when `input.trim()` is non-empty AND `isLoading` is false. The driver bypasses this entirely by calling React's `onKeyDown` handler directly via the React fiber and dispatching an `Enter` key event.

**Notebook changes not visible to assertions** — the driver saves via Ctrl+S after focusing the notebook panel. If saves are missing, the chat sidebar likely still has focus. Check the `notebook saved via …` log line.

**Judge always fails with "no API key"** — set `ANTHROPIC_API_KEY` or put it in `~/.jupyter/varys.env`. The judge falls through these in order.

**"No checkpoints" dialog popping up** — should not happen anymore. If it does, the driver is hitting the broken `File > Revert Notebook to Checkpoint` fallback. Confirm `revert_notebook_in_place` in `harness/varys_driver.py` only matches `Reload from Disk` / `Reload` / `Overwrite`.

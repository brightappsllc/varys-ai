# SummaryStore — How It Works

This document explains what `summary_store.json` is, why it exists, how it gets
populated, and what its limitations are. It is written for someone who is new to
the Varys codebase.

---

## What Is the SummaryStore?

Every time you execute a notebook cell, Varys quietly records a structured
summary of that cell and saves it to a JSON file on disk. This file is the
**SummaryStore**.

Its purpose is to give the Varys AI assistant a persistent, queryable memory of
your notebook — what each cell does, what variables it defines, what its output
looked like — so the assistant does not have to re-read the raw source code every
time you ask a question. It also feeds the long-term preference inference pipeline
(see [Inference](#inference-the-meta-counter)).

---

## File Location

```
<notebook-folder>/
└── .jupyter-assistant/
    └── <notebook-uuid>/
        └── context/
            └── summary_store.json
```

The folder name under `.jupyter-assistant/` is the stable UUID that JupyterLab
assigns to the notebook file itself. You will see a different UUID for each
notebook.

**Example path:**
```
~/projects/.jupyter-assistant/21bbfc26-a544-42ba-ac3a-a5c8f1e44f39/context/summary_store.json
```

---

## Top-Level Structure

```json
{
  "_meta":  { ... },
  "_cells": { ... },
  "<cell-uuid>": [ ... ],
  "<cell-uuid>": [ ... ],
  ...
}
```

There are three kinds of top-level key:

| Key | Purpose |
|-----|---------|
| `_meta` | Notebook-level counters (inference trigger) |
| `_cells` | Human-readable index: UUID → first source line |
| `<cell-uuid>` | All version history for that cell |

---

## `_cells` — The Human-Readable Index

Because every cell is identified by an opaque UUID (e.g.
`216ea19e-cd9b-46f4-a405-a2208594a1ed`), the file would be impossible to
navigate by hand without a guide. `_cells` provides that guide.

```json
"_cells": {
  "216ea19e-cd9b-46f4-a405-a2208594a1ed": "import pandas as pd",
  "9c4e7f01-b3a2-4f88-bc10-d7e5a1234567": "df = pd.read_csv('titanic.csv')",
  "a3f19b12-0001-4e7c-9abc-fedcba987654": "~print(df.head())"
}
```

Rules:
- The value is the **first non-blank, non-comment line** of the cell source,
  truncated to 80 characters.
- A `~` prefix means the cell was **deleted** from the notebook. Its data is
  kept (so undo works) but marked inactive.
- Only cells that have been executed at least once appear here.

**How to navigate the file:** Find the UUID you care about in `_cells`, then
look up that UUID in the rest of the file.

---

## `_meta` — Inference Counter

```json
"_meta": {
  "versions_since_inference": 4,
  "last_inference_run": null
}
```

| Field | Meaning |
|-------|---------|
| `versions_since_inference` | How many new cell versions have been written since the last inference run. Resets to 0 after inference fires. |
| `last_inference_run` | UTC timestamp of the last inference run, or `null` if it has never run. |

When `versions_since_inference` reaches **10**, Varys automatically runs the
inference pipeline in the background (see [Inference](#inference-the-meta-counter)
below).

---

## Per-Cell Structure

Each `<cell-uuid>` key maps to a **list of version entries**. The list grows
over time as the cell source changes.

```json
"216ea19e-...": [
  {
    "version":   1,
    "hash":      "a1b2c3d4e5f6a7b8",
    "timestamp": "2026-04-03T10:22:05.123456+00:00",
    "summary":   { ... },
    "deleted":   false
  },
  {
    "version":   2,
    "hash":      "deadbeef12345678",
    "timestamp": "2026-04-03T14:05:31.000000+00:00",
    "summary":   { ... },
    "deleted":   false
  }
]
```

**The active entry is always the last element of the list** (`[-1]`). There is
no need to compare timestamps — the most recent version is always appended to
the end.

### Version entry fields

| Field | Type | Meaning |
|-------|------|---------|
| `version` | int | 1-based counter, incremented each time the source changes |
| `hash` | string | First 16 hex characters of SHA-256(source). Used to detect source changes. |
| `timestamp` | string | **UTC** ISO-8601 timestamp of when this version was written. Always `+00:00`. |
| `summary` | dict | The cell summary (see below) |
| `deleted` | bool | Mirrors the deleted flag on the summary — kept for fast list scanning |

> **Note on timestamps:** All timestamps are UTC. If your system clock shows
> 23:47 local time and the JSON shows 07:17, those can refer to the same moment
> if you are in a UTC+16:30 zone, or they can be unrelated events. The file's
> filesystem modification time (shown by your OS) is local; the JSON timestamps
> are always UTC.

---

## The `summary` Dict

This is the main payload — everything Varys knows about the cell.

```json
"summary": {
  "cell_type":        "code",
  "source_snippet":   "df = pd.read_csv('titanic.csv')",
  "auto_summary":      null,
  "output":           null,
  "symbols_defined":  ["df"],
  "symbols_consumed": [],
  "symbol_values":    {},
  "symbol_types":     {"df": "DataFrame(891, 12)"},
  "execution_count":  3,
  "had_error":        false,
  "error_text":       null,
  "is_mutation_only": false,
  "is_import_cell":   false,
  "truncated":        false,
  "deleted":          false,
  "tags":             [],
  "tags_updated_at":  null
}
```

### Field reference

| Field | Type | Meaning |
|-------|------|---------|
| `cell_type` | string | `"code"`, `"markdown"`, or `"raw"` |
| `source_snippet` | string | First 300 characters of the cell source, stripped of leading/trailing whitespace |
| `auto_summary` | string\|null | TextRank extractive summary for large markdown cells (LLM fallback when text has too few prose sentences). `null` for code cells and short markdown. |
| `output` | string\|null | Plain-text cell output, up to 1 000 characters. `null` if no output. |
| `symbols_defined` | list[str] | Variable/function/class names assigned in this cell |
| `symbols_consumed` | list[str] | Names read from other cells (not defined here, not Python builtins) |
| `symbol_values` | dict | Scalar values of defined symbols: `{"threshold": 0.85}`. Only int, float, bool, str (≤200 chars). DataFrames/arrays excluded. |
| `symbol_types` | dict | Type strings for defined symbols: `{"df": "DataFrame(891, 12)"}`, `{"clf": "LinearRegression"}` |
| `execution_count` | int\|null | The `[N]` counter shown by Jupyter. `null` for unexecuted cells. |
| `had_error` | bool | `true` if the cell raised an exception |
| `error_text` | string\|null | The error message if `had_error` is true |
| `is_mutation_only` | bool | `true` if the cell only mutates existing objects and defines no new names |
| `is_import_cell` | bool | `true` if every non-blank line in the cell is an import statement |
| `truncated` | bool | `true` if the source was longer than 2 000 characters and was trimmed (markdown cells only) |
| `deleted` | bool | `true` if the cell was deleted from the notebook |
| `tags` | list[str] | JupyterLab cell tags, sorted and deduplicated |
| `tags_updated_at` | string\|null | UTC timestamp of the last tag change |

---

## How the Store Gets Populated

### Trigger

Every time a code cell finishes executing in the kernel, the JupyterLab
frontend fires a signal. Varys intercepts this signal and sends a
`POST /varys/cell-executed` request to the Varys server extension in the
background. The server builds a summary and writes it to the store.

### What "executed" means

The frontend sends:
- The full cell source text
- The cell output (plain text)
- The execution count (`[N]`)
- Whether the cell had an error
- A **kernel snapshot** — variable types and values captured by running a
  silent Python introspection snippet immediately after execution

### Two-tier versioning

The store uses **two different strategies** depending on whether the source
changed:

| Situation | What happens |
|-----------|-------------|
| Source changed since last run | A **new version entry** is appended. `version` increments. The inference counter increases by 1. |
| Source identical to last run | **No new version.** Instead, the runtime fields (`execution_count`, `symbol_types`, `symbol_values`) are patched in-place on the existing entry if they changed. |

This design means:
- The version history tracks *what you wrote*, not *how many times you ran it*.
- Running the same cell 100 times creates exactly **one** version entry, but
  its `symbol_types` and `execution_count` always reflect the most recent run.

### The kernel snapshot

When a cell executes successfully, the frontend runs a short silent Python
snippet in the kernel to inspect the variables assigned in that cell:

```python
# Example: for a cell that contains  df = pd.read_csv(...)
# the snippet inspects "df" and returns:
{"df": {"type": "dataframe", "shape": [891, 12]}}
```

This is what populates `symbol_types` and `symbol_values`. The snippet handles:

| Python type | What is stored in `symbol_types` |
|-------------|----------------------------------|
| `pd.DataFrame` | `"DataFrame(rows, cols)"` e.g. `"DataFrame(891, 12)"` |
| `np.ndarray` | `"ndarray(shape)"` e.g. `"ndarray(100, 256)"` |
| sklearn model | Short class name e.g. `"LinearRegression"` |
| `int`, `float`, `bool` | `"int"`, `"float"`, `"bool"` (value stored in `symbol_values`) |
| `str` | `"str"` (value stored in `symbol_values` if ≤200 chars) |
| `list`, `tuple`, `dict` | `"list"`, `"tuple"`, `"dict"` |

If the cell had an error, or if no kernel is available, the snapshot is empty
and `symbol_types` remains `{}`.

---

## Inference — The `_meta` Counter

Every time a **new version** is written (source changed), `_meta.versions_since_inference`
increments. When it reaches **10**, Varys runs the inference pipeline in the
background:

1. **Pattern detection** — scans all current summaries for:
   - Constants used with the same value in ≥ 3 cells (e.g. `THRESHOLD = 0.85`)
   - Import aliases appearing in ≥ 3 import cells (e.g. `pd`, `np`)

2. **LLM preference generation** — converts raw patterns into human-readable
   preference statements using the Background Task model.

3. **PreferenceStore write** — saves the preferences so they are injected into
   future chat prompts automatically.

Runtime-only patches (same source, updated symbol_types) do **not** increment
the inference counter, because the cell content hasn't meaningfully changed.

---

## Limitations

### 1. Source-hash trigger only

The store only creates a new version when the cell source text changes. If you
re-run a cell without editing it, the existing version is patched in place
(runtime fields only). This means:

- The **version history** reflects source edits, not execution count.
- The inference pipeline is not triggered by re-runs.

### 2. Cross-cell mutation blind spot

The kernel snapshot only inspects variables **assigned in the cell that just
ran**. If cell B mutates a variable defined in cell A (e.g.
`df.drop(columns=['age'], inplace=True)` in cell B), the store's record for
cell A still shows the old shape. The only way to update it is to re-run cell A.

This is a fundamental limitation of a source-hash-triggered, per-cell store.
A full kernel comm channel (persistent push from kernel to frontend after every
execution) would fix it, but adds significant infrastructure complexity and is
not currently implemented.

### 3. Unexecuted cells use AST-only data

For cells that have never been run, Varys falls back to static AST analysis to
extract `symbols_defined` and `symbols_consumed`. This is less accurate than
the kernel snapshot:
- Self-referential assignments (`df = df.dropna()`) lose `df` from `symbols_consumed`
  because AST analysis subtracts defined names from consumed names.
- `symbol_types` and `symbol_values` are always empty for unexecuted cells.

### 4. UTC timestamps

All `timestamp` fields are UTC (`+00:00`). Your operating system's file
browser shows file modification times in local time. The two clocks will appear
to disagree if your local timezone is not UTC.

### 5. Ghost entries are ignored, not deleted

Entries for cells deleted from the notebook are flagged with `"deleted": true`
and prefixed with `~` in `_cells`. They are never removed from the file (this
supports undo). A deleted cell's data does not affect the assistant's context.

---

## Quick Reference: Reading the File

```
summary_store.json
│
├── "_meta"        → inference trigger counter (ignore for debugging)
│
├── "_cells"       → START HERE: maps UUID → first source line
│   ├── "abc-..."  → "df = pd.read_csv(...)"
│   └── "def-..."  → "~import pandas as pd"   ← deleted cell
│
├── "abc-..."      → list of versions for that cell
│   └── [-1]       → ACTIVE (most recent) version
│       ├── version      → how many times source changed
│       ├── hash         → SHA-256 of source (first 16 chars)
│       ├── timestamp    → UTC ISO-8601
│       └── summary
│           ├── symbol_types   → {"df": "DataFrame(891,12)"}
│           ├── symbol_values  → {"threshold": 0.85}
│           ├── execution_count → 3
│           └── ...
└── ...
```

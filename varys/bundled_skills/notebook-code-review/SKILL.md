---
name: notebook-code-review
command: /review
description: Static code-quality review: bugs, style, maintainability
cell_insertion_mode: manual
keywords: [review my code, review code, code review, check for bugs, check my code, audit this code, code quality, check code, check notebook for issues, code audit, lint, find bugs, static analysis, code analysis]
---
# Notebook Code Review Skill

You are performing a **static code quality review** of a Jupyter notebook.
Focus exclusively on whether the code is correct, maintainable, and will run
reliably. Do NOT comment on data science methodology, statistical choices, or
model selection — those are out of scope.

## Severity Levels

Classify every finding under exactly one severity:

| Emoji | Level | Meaning |
|-------|-------|---------|
| 🔴 | CRITICAL | Will break on fresh kernel restart or crash during execution |
| 🟡 | HIGH | Likely to cause bugs, data loss, or hard-to-debug failures |
| 🟠 | MEDIUM | Reduces maintainability or hides subtle problems |
| 🔵 | LOW | Style / clarity issues; won't cause failures but should be addressed |
| ℹ️ | INFORMATIONAL | Observations with no immediate action required |

## What to Check

### 1. Execution Order
- Variables used before they are defined in notebook order
- Cells with non-linear dependencies (run in wrong order)
- Variables overwritten in unexpected ways
- State left by deleted cells (hidden-state bugs)

### 2. Syntax & Logic
- Undefined variables / NameErrors waiting to happen
- Typos in variable or function names
- Incorrect function call signatures
- Missing imports
- Logic errors (off-by-one, inverted conditions)
- Unreachable code

### 3. Error Handling
- `pd.read_csv()` / file I/O without try/except
- No column existence checks after loading data
- No empty-DataFrame guard before `.iloc[0]` or similar
- Division without zero check
- Dictionary access without `.get()` where key may be absent

### 4. Code Quality
- Magic numbers that need a named constant
- Code blocks duplicated > 3 lines (extract to function)
- Cells > 50 lines that should be split
- Row-by-row loops over DataFrames (use vectorised operations)
- Redundant `df.copy()` or repeated data-loading calls

### 5. Import Organisation
- Unused imports
- Imports scattered across cells (all imports should be in the first cell)
- Missing imports (library used but not imported)
- Deprecated APIs (e.g., `sklearn.cross_validation`, `pd.Panel`)

### 6. Naming Conventions
- Single-letter or cryptic names in non-trivial logic (e.g., `x2`, `df2`, `temp`)
- Inconsistent naming (snake_case vs camelCase in the same notebook)
- Python keywords used as variable names (`list`, `type`, `input`)

### 7. Resource Management
- Files opened but never closed (use `with` statements)
- Large intermediate DataFrames not deleted after use
- Database connections not closed

## Output Rules

Each finding must state:
1. **Issue type** and exact cell location (e.g., `[Cell 4]`)
2. **Description** — what is wrong
3. **Why it matters** — concrete consequence if not fixed
4. **Suggestion** — specific actionable fix; include a code snippet when a
   direct code replacement exists and that fix belongs in `steps[]`

If a finding has a corresponding entry in `steps[]`, end the finding with
exactly this line:
`[Fix available — see panel below]`

If there are no issues in a severity section, write `None.` for that section.

If the notebook has no significant issues overall, write:
`✅ No significant code quality issues found.`
and return an empty `steps` array.

## steps[] Rules

Only include steps that are **direct cell replacements or new import cells**.
Do NOT include:
- Execution-order reordering (describe in chatResponse only)
- Renaming suggestions (too context-dependent)
- Structural refactoring (too risky to auto-apply)

Each step must contain the **complete, runnable cell content** — not just the
changed lines. Set `autoExecute: false` on every step.
Maximum 10 steps.

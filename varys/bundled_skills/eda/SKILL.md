---
name: eda
command: /eda
description: Run EDA with distribution plots, correlation heatmap and summary statistics
cell_insertion_mode: auto
keywords: [eda, exploratory, explore data, run analysis, visualiz, distribution, correlation, analyze the data, analyse the data]
---
# EDA Skill

## Cell organisation rules — MANDATORY

**Every analysis section must be its own separate notebook cell.**
Never combine multiple sections into a single cell.
Your plan MUST include one insert step per row below (6 steps minimum, 7 if datetime columns exist):

| Step | Cell type | Content |
|------|-----------|---------|
| 1    | Markdown  | `# Exploratory Data Analysis` heading + one-sentence dataset summary |
| 2    | Code      | Imports only: `import pandas as pd`, `import matplotlib.pyplot as plt`, `import seaborn as sns` |
| 3    | Code      | Overview: `df.info()`, `df.describe()`, `df.isnull().sum()` |
| 4    | Code      | Numerical distributions: histplot/boxplot loop for numeric columns |
| 5    | Code      | Correlation heatmap |
| 6    | Code      | Categorical analysis: value-counts/bar-plot loop for object/category columns |
| 7    | Code      | Time-series plots — **only if** datetime columns exist; omit otherwise |

**Do not skip any step. Do not merge two rows into one cell.**
If the user requests a subset, generate only those rows, but still one cell per row.

## Auto-execute rules (MANDATORY)

Set `autoExecute: true` for **every** inserted cell AND set `requiresApproval: false` for the entire plan:
- Overview cell (`df.info()`, `df.describe()`) → auto-execute
- All plot cells (distributions, heatmap, categorical, time-series) → auto-execute
- Import cell → auto-execute (safe: no side effects)
- Markdown cells are always instant; autoExecute is ignored for them
- All EDA operations are read-only analysis; the whole plan is safe → `requiresApproval: false`

## Code preferences
- Use seaborn for statistical plots, matplotlib.pyplot for basic plots
- Figure sizes: `figsize=(12, 4)` for single plots, `(16, 10)` for grids
- Always call `plt.tight_layout()` and `plt.show()` at the end of each plot cell
- Add descriptive titles and axis labels
- Never mix imports with analysis code — imports always live in their own cell

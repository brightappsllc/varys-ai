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
Use this exact sequence of cells:

| # | Cell type | Content |
|---|-----------|---------|
| 1 | Markdown  | `# Exploratory Data Analysis` heading + one-sentence dataset summary |
| 2 | Code      | Imports only (`import pandas as pd`, `import matplotlib.pyplot as plt`, `import seaborn as sns`) |
| 3 | Code      | Overview: `df.info()`, `df.describe()`, missing-value counts |
| 4 | Code      | Numerical distributions: one histplot/boxplot loop for numeric columns |
| 5 | Code      | Correlation heatmap |
| 6 | Code      | Categorical analysis: one value-counts/bar-plot loop for object/category columns |
| 7 | Code      | Time-series plots — **only if** date/datetime columns exist; omit otherwise |

If the user requests a subset (e.g. "just distributions and correlation"), generate only those cells, but still one cell per section.

## Code preferences
- Use seaborn for statistical plots, matplotlib.pyplot for basic plots
- Figure sizes: `figsize=(12, 4)` for single plots, `(16, 10)` for grids
- Always call `plt.tight_layout()` and `plt.show()` at the end of each plot cell
- Add descriptive titles and axis labels
- Never mix imports with analysis code — imports always live in their own cell

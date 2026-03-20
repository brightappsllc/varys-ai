---
name: load-dataframe
command: /load
description: Load a file (CSV/Excel/JSON) as a pandas DataFrame with an overview
keywords: [load file, load data, read csv, read excel, load dataframe, import data, import csv, import excel]
cell_insertion_mode: preview
---

# Data Loading Skill

When the user provides a file path to load as a DataFrame:

## Structure (always two cells)

**Cell 1 — Markdown header:**
```markdown
# Data Loading
```

**Cell 2 — Code cell:**
```python
import pandas as pd

# Load data
df = pd.read_csv('path/to/file.csv')   # or read_excel, read_parquet, etc.

# Inspect
print(f"Shape: {df.shape}")
print(f"Columns ({len(df.columns)}): {df.columns.tolist()}")
df.head(5)
```

## File Format Detection
| Extension | Function |
|---|---|
| `.csv` | `pd.read_csv(path)` |
| `.xlsx`, `.xls` | `pd.read_excel(path)` |
| `.parquet` | `pd.read_parquet(path)` |
| `.json` | `pd.read_json(path)` |
| `.tsv` | `pd.read_csv(path, sep='\t')` |
| `.feather` | `pd.read_feather(path)` |

## Variable Naming
- Single dataset → `df`
- Multiple datasets → `df_train`, `df_test`, `df_sales`, etc. (match the filename)

## Placement
- Insert at current cursor position (activeCellIndex)
- If the notebook is empty, insert at position 0

## Always include
1. The import (skip if pandas already imported in the notebook)
2. The load statement with the exact path provided
3. `print(f"Shape: {df.shape}")`
4. `print(f"Columns ({len(df.columns)}): {df.columns.tolist()}")`
5. `df.head(5)`

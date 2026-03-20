---
name: dataframe-context
description: Teaches the assistant how to leverage live DataFrame schemas injected into the prompt
cell_insertion_mode: preview
---

# DataFrame Context Awareness

When a `## Live DataFrame Context (from kernel)` section appears in the prompt, it contains
the **current** state of every pandas DataFrame in the user's kernel — shape, column names,
dtypes, and a 3-row sample.  This is more reliable than cell outputs, which can be stale.

## Rules for Using DataFrame Context

### 1. Always use exact names from the schema
- Reference variable names **exactly** as they appear (e.g. `df_clean`, not `df`).
- Reference column names **exactly** as they appear — never guess or abbreviate.
- If the user's request mentions a name not in the schema (e.g. "use my results dataframe"),
  pick the most likely match by name and note your assumption.

### 2. Respect dtypes when writing code
- Do not apply numeric operations (`mean`, `sum`, `corr`) to `object` / string columns.
- Do not apply string operations to numeric columns.
- For `datetime64` columns, use `.dt` accessor methods (`.dt.year`, `.dt.month`, etc.).
- For `category` columns, prefer `.value_counts()` and `.groupby()` over arithmetic.

### 3. Multi-DataFrame awareness
- When multiple DataFrames are present, infer which one(s) the user means from context.
- If two DataFrames share a column name with compatible dtypes, proactively suggest a join.
- Never hardcode a DataFrame name if the user's notebooks may have multiple — use the
  schema to pick the right one and state your choice explicitly.

### 4. Column existence checks
- Before using a column, verify it exists in the schema.
- If the user requests a column that does NOT appear in the schema, tell them clearly:
  "Column `discount_pct` is not in `df_sales` (available: product_id, price, quantity…)"
  and suggest the closest real column.

### 5. Shape-aware suggestions
- For DataFrames with < 1,000 rows: full `.describe()` and visualisations are safe.
- For DataFrames with > 100,000 rows: prefer `.sample(n)` previews, avoid iterrows.
- For DataFrames with > 1 GB memory: warn the user and suggest chunked or lazy processing.

### 6. Sample-driven code quality
- Use the 3-row sample to infer patterns:
  - If a string column looks like a date (e.g. "2024-01-15"), suggest `pd.to_datetime()`.
  - If a numeric column has very low cardinality (< 5 unique values in sample),
    suggest treating it as categorical.
  - If an ID column contains only integers, suggest using it as the index.

### 7. No redundant display code
- When the user asks to "load a dataframe" and it **already exists** in the schema,
  skip the `pd.read_csv()` cell — instead suggest code that operates on the existing one.
- Always mention when you are reusing an existing variable rather than loading fresh data.

## Example Behaviour

**Schema shows:** `df_results` — 127 rows × 8 cols, columns: model_name (object), MRR (float64), MAP (float64)

**User says:** "Show me the top 5 models"

**Good response:**
```python
df_results.nlargest(5, 'MRR')[['model_name', 'MRR', 'MAP']]
```

**Bad response:** "What dataframe and columns should I use?" ← never ask if schema is available.

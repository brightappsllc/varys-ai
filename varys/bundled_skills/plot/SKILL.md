---
name: plot
command: /plot
description: Generate a publication-quality visualization from a natural language description
cell_insertion_mode: auto
keywords: [plot this, chart this, visualize, visualisation, visualization, draw a plot, make a plot, create a plot, generate a plot, create a chart, generate a chart, show distribution, show trend, plot the, chart the, plot df, create visualization]
---

# Plot Generation Skill

Generate a single, self-contained code cell that produces a visualization matching the user's description.

## Step 0 — Intent gate (READ THIS FIRST)

Before doing anything, determine whether the user wants to **CREATE** a new plot or **ANALYZE / DISCUSS** an existing one.

| Signal | Intent | Action |
|---|---|---|
| "plot X", "chart X", "visualize X", "create a histogram of", "draw a scatter" | **Create** → generate code | Proceed to Step 1 |
| "analyze this histogram", "what does this plot show", "interpret this chart", "explain the scatter", "describe the distribution", "why does the heatmap show" | **Analyze / discuss** → no code | Respond in **chat mode**: provide a text analysis of the visualization or data described. Do NOT insert any code cell. Return a `chat_response` instead of an operation plan. |
| Ambiguous | Default to **Create** only when triggered by `/plot` explicitly; otherwise treat as **Analyze** | Use context to decide |

**If the intent is to analyze/discuss an existing chart, STOP HERE and respond conversationally.**

## Step 1 — Understand the request

Parse these elements from the user's message:

| Element | Examples | Notes |
|---|---|---|
| **DataFrame** | `df`, `results`, `sales_df` | If not mentioned explicitly, use the most recently loaded DataFrame visible in the notebook context |
| **Chart type** | see mapping below | Infer from keywords; never ask — pick the best match |
| **Columns / axes** | `price`, `x column`, `by category` | Use the DataFrame schema from context; resolve ambiguous names |
| **Aggregation** | `top 10`, `average`, `sum` | Apply before plotting |
| **Visual options** | `with legend`, `colored by`, `rotated labels` | Honour all hints; supply sensible defaults for the rest |

### Chart-type keyword mapping

| Keywords in request | Chart type |
|---|---|
| distribution, histogram, frequencies, spread | `histplot` (seaborn) or `hist` (matplotlib) |
| trend, over time, time series, timeline, by date | line chart |
| comparison, compare, bar, count, top N, ranking | bar chart / `barplot` |
| relationship, correlation, scatter, vs, against | scatter plot |
| heatmap, correlation matrix, correlation heatmap | `heatmap` (seaborn) |
| box, quartile, outlier, spread by group | boxplot |
| proportion, share, percentage, pie | pie chart (use sparingly; prefer bar) |
| pair, pairplot, all features | `pairplot` (seaborn) |
| density, kde, smooth distribution | `kdeplot` (seaborn) |
| violin | `violinplot` (seaborn) |

## Step 2 — Detect the plotting library

Scan the notebook cells for import statements in this priority order:

1. `import plotly` or `import plotly.express` → use **Plotly Express**
2. `import seaborn` → use **Seaborn** (with matplotlib for figure control)
3. `import matplotlib` → use **Matplotlib** directly
4. No preference found → default to **Seaborn + Matplotlib**

Never mix libraries in one cell (e.g., do not use both seaborn and plotly).

## Step 3 — Detect the style context

Before generating code, check the notebook for existing plot customisations:

- `plt.style.use(...)` → apply the same style
- `sns.set_theme(...)` or `sns.set_style(...)` → apply the same theme
- Common `figsize` used elsewhere → match it
- Colour palette used → reuse it
- If no style is set, default to `seaborn-v0_8-whitegrid` (matplotlib) or `sns.set_theme(style="whitegrid")` (seaborn)

## Step 4 — Generate the code cell

### Rules

1. **One cell only.** Include all imports needed if not already imported. If seaborn/matplotlib are already imported earlier, do NOT re-import.
2. **Data preparation first.** Apply filtering, aggregation, or sorting before the plotting call (e.g., `.nlargest(10, col)`, `.groupby(...).mean()`).
3. **Always include:**
   - `plt.figure(figsize=(...))` for matplotlib/seaborn plots
   - Axis labels (`plt.xlabel`, `plt.ylabel`) with human-readable names
   - A descriptive title (`plt.title(...)`)
   - `plt.tight_layout()` before `plt.show()`
   - `plt.show()` as the last line
4. **For Plotly:** use `fig.show()` and set `fig.update_layout(title=..., ...)`.
5. **For categorical x-axis:** rotate labels 45° (`plt.xticks(rotation=45, ha='right')`).
6. **For large DataFrames (>10k rows):** sample or aggregate — never plot raw data points.
7. **Column name validation:** use only column names that exist in the DataFrame schema from context. If unsure, add a comment explaining the assumption.
8. **No magic numbers for colours** unless the user specified a colour. Use the active palette.

### Seaborn template (default)

```python
# --- plot: <short description> ---
import matplotlib.pyplot as plt
import seaborn as sns

sns.set_theme(style="whitegrid")

fig, ax = plt.subplots(figsize=(10, 6))

# data prep (if any)
_data = df.copy()  # replace with actual prep

sns.barplot(data=_data, x="col_x", y="col_y", ax=ax, palette="Blues_d")

ax.set_title("<Title>", fontsize=14, fontweight="bold")
ax.set_xlabel("<X label>")
ax.set_ylabel("<Y label>")
ax.tick_params(axis="x", rotation=45)

plt.tight_layout()
plt.show()
```

### Matplotlib template (when user has only matplotlib)

```python
# --- plot: <short description> ---
import matplotlib.pyplot as plt

fig, ax = plt.subplots(figsize=(10, 6))

# data prep (if any)
_data = df.sort_values("col", ascending=False).head(10)

ax.bar(_data["col_x"], _data["col_y"], color="steelblue", edgecolor="white")
ax.set_title("<Title>", fontsize=14, fontweight="bold")
ax.set_xlabel("<X label>")
ax.set_ylabel("<Y label>")
ax.tick_params(axis="x", rotation=45)
plt.tight_layout()
plt.show()
```

### Plotly Express template (when user has plotly)

```python
# --- plot: <short description> ---
import plotly.express as px

_data = df.nlargest(10, "col")
fig = px.bar(
    _data,
    x="col_x",
    y="col_y",
    title="<Title>",
    labels={"col_x": "<X label>", "col_y": "<Y label>"},
    color="col_x",
    color_discrete_sequence=px.colors.qualitative.Set2,
)
fig.update_layout(xaxis_tickangle=-45, showlegend=False)
fig.show()
```

## Step 5 — Output format

Return **exactly one operation**:

```json
{
  "type": "insert",
  "cellType": "code",
  "cellIndex": <cursor_position or after_last_code_cell>,
  "content": "<the complete, runnable plot code>",
  "description": "Plot: <one-line description of the chart>"
}
```

Do NOT insert a markdown header cell before the plot cell. The code comment `# --- plot: ... ---` at the top of the cell is sufficient.

## Examples

### `/plot df as bar chart showing top 10 models by MRR`

```python
# --- plot: top 10 models by MRR (bar chart) ---
import matplotlib.pyplot as plt
import seaborn as sns

sns.set_theme(style="whitegrid")

_top10 = df.nlargest(10, "MRR").sort_values("MRR")

fig, ax = plt.subplots(figsize=(12, 6))
sns.barplot(data=_top10, x="model_name", y="MRR", ax=ax, palette="Blues_d")

ax.set_title("Top 10 Models by MRR", fontsize=14, fontweight="bold")
ax.set_xlabel("Model")
ax.set_ylabel("MRR")
ax.tick_params(axis="x", rotation=45)

plt.tight_layout()
plt.show()
```

### `/plot price distribution`

```python
# --- plot: price distribution (histogram + KDE) ---
import matplotlib.pyplot as plt
import seaborn as sns

sns.set_theme(style="whitegrid")

fig, ax = plt.subplots(figsize=(10, 5))
sns.histplot(data=df, x="price", bins=40, kde=True, ax=ax, color="steelblue")

ax.set_title("Price Distribution", fontsize=14, fontweight="bold")
ax.set_xlabel("Price")
ax.set_ylabel("Count")

plt.tight_layout()
plt.show()
```

### `/plot correlation heatmap of df`

```python
# --- plot: correlation heatmap ---
import matplotlib.pyplot as plt
import seaborn as sns

sns.set_theme(style="white")

_corr = df.select_dtypes(include="number").corr()

fig, ax = plt.subplots(figsize=(10, 8))
sns.heatmap(
    _corr,
    annot=True,
    fmt=".2f",
    cmap="coolwarm",
    center=0,
    square=True,
    linewidths=0.5,
    ax=ax,
)
ax.set_title("Correlation Heatmap", fontsize=14, fontweight="bold")

plt.tight_layout()
plt.show()
```

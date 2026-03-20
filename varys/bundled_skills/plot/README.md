# Plot Skill — Quick Chart Generation

Generate publication-quality visualizations from a natural language description using the `/plot` command.

---

## Usage

```
/plot <what to visualize>
```

The skill automatically:
- Detects the right **chart type** from your description
- Uses your notebook's **existing library** (Seaborn, Matplotlib, or Plotly)
- Matches your notebook's **plot style and theme**
- Reads your **DataFrame schema** so you don't need to specify column types
- Inserts a clean, runnable code cell at the cursor position

---

## Examples

| Command | What gets generated |
|---|---|
| `/plot df as bar chart showing top 10 models by MRR` | Sorted bar chart with top-10 filter |
| `/plot price distribution` | Histogram with KDE overlay |
| `/plot sales over time by category` | Multi-line time-series chart |
| `/plot correlation heatmap of df` | Annotated seaborn heatmap |
| `/plot age vs salary scatter colored by department` | Scatter with hue |
| `/plot revenue by region as pie` | Pie chart (or donut) |
| `/plot confusion matrix of y_test vs y_pred` | Heatmap-style confusion matrix |
| `/plot pairplot of df features` | Seaborn pairplot |

---

## Chart type auto-detection

| Keywords | Chart |
|---|---|
| `distribution`, `histogram`, `spread`, `frequencies` | Histogram (+KDE) |
| `trend`, `over time`, `time series`, `by date` | Line chart |
| `comparison`, `bar`, `top N`, `ranking`, `count` | Bar chart |
| `relationship`, `scatter`, `vs`, `against` | Scatter plot |
| `heatmap`, `correlation matrix` | Heatmap |
| `box`, `quartile`, `outlier` | Boxplot |
| `violin` | Violin plot |
| `density`, `kde` | KDE plot |
| `proportion`, `share`, `percentage`, `pie` | Pie chart |
| `pairplot`, `all features`, `pair` | Pairplot |

---

## Library preference

The skill scans existing imports and matches your preferred library:

- **Plotly** (`import plotly`) → interactive charts with `fig.show()`
- **Seaborn** (`import seaborn`) → statistical charts with Matplotlib layout
- **Matplotlib only** → pure Matplotlib
- **No imports found** → defaults to Seaborn + Matplotlib

---

## Tips

- **Reference DataFrames by name**: `/plot sales_df top 10 products by revenue`
- **Use `@df` for variable interpolation**: `/plot @df.price distribution`
- **Specify colours**: `/plot MRR by model using blue palette`
- **Specify size**: `/plot df wide figure showing monthly trends`
- **Ask for specific styles**: `/plot correlation heatmap with annotations and diverging colors`

---

## Activation

This skill activates:
1. **Automatically** when your message contains words like *plot*, *chart*, *visualize*, *histogram*, *scatter*, *heatmap*, etc.
2. **Explicitly** with the `/plot` command prefix

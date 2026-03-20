---
name: eda
command: /eda
description: Run EDA with distribution plots, correlation heatmap and summary statistics
cell_insertion_mode: auto
keywords: [eda, exploratory, explore data, run analysis, visualiz, distribution, correlation, analyze the data, analyse the data]
---
# EDA Skill

When creating exploratory data analysis sections:

## Structure
1. Markdown header: "# Exploratory Data Analysis"
2. Overview cell: df.info(), df.describe(), missing values
3. Distribution plots for numerical features (seaborn histplot/boxplot)
4. Correlation heatmap (seaborn heatmap)
5. Categorical analysis (value_counts, bar plots)
6. Time series if date columns present

## Code Preferences
- Use seaborn for statistical plots
- Use matplotlib.pyplot for basic plots
- Set figure size: figsize=(12, 4) for single plots, (16, 10) for grids
- Use plt.tight_layout()
- Include plt.show()
- Add descriptive titles and axis labels

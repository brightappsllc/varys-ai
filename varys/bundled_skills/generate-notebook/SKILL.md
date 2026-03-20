---
name: generate-notebook
command: /generate
description: Full pipeline: load data → EDA → annotate → README (composite)
composite: true
keywords: [generate notebook, analyze file, full analysis, complete analysis, end to end, end-to-end, notebook pipeline, full notebook, analyze dataset, build notebook]
steps: [load-dataframe, eda, notebook-annotation, readme_gen]
step_prompts:
  - "Load the file {file_path} as a pandas DataFrame. Create a '# Data Loading' markdown header cell then a code cell that imports pandas, loads the file, prints df.shape, df.columns.tolist(), and displays df.head(5)."
  - "Run a complete EDA for the DataFrame just loaded. Create a '# Exploratory Data Analysis' markdown header cell, then a comprehensive code cell with: df.info(), df.describe(), missing values analysis, distribution plots for numeric columns, value counts for categorical columns, and a correlation heatmap. Use seaborn and matplotlib. End with a markdown cell summarising the top 3 findings."
  - "Go through every code cell in the notebook and add a short numbered markdown title cell immediately before it (e.g. '## 1. Data Loading', '## 2. Data Overview'). If a title cell already exists before a code cell, update its numbering to be sequential. Keep descriptions to one sentence maximum."
  - "Create a comprehensive README markdown cell at position 0 (the very top of the notebook) with: notebook title (H1), one-paragraph description of the dataset and analysis goals, a table of contents listing all sections found in the notebook, key findings (bullet points), and the data source path. Use emojis for section headers."
---

# Generate Complete Analysis Pipeline

Orchestrates a full end-to-end notebook from raw data to documented analysis:

1. **Data Loading** — loads the specified file as a DataFrame and inspects it
2. **EDA** — exploratory data analysis with visualizations for all columns
3. **Annotation** — numbers and titles every code cell sequentially
4. **README** — creates a polished top-cell summary with table of contents

## Usage
```
generate notebook with /path/to/data.csv
analyze /data/sales.xlsx end to end
full analysis of my_results.parquet
```

## Variable Extraction
The file path is automatically extracted from the user's message.
Supported formats: `.csv`, `.xlsx`, `.xls`, `.parquet`, `.json`, `.tsv`, `.feather`

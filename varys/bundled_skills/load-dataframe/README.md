# Load DataFrame Skill

## What it does

Creates two cells at the cursor position:
1. A markdown header `# Data Loading`
2. A code cell that loads a file as a pandas DataFrame and inspects it

## Triggers

```
load /data/sales.csv as dataframe
read the file data.xlsx
import my_results.parquet
```

## Used as a pipeline step

This skill is the first step in the `generate-notebook` composite pipeline.
When used in a pipeline, the step prompt includes the file path extracted
automatically from the user's original message.

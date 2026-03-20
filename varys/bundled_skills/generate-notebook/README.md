# Generate Notebook — Composite Pipeline Skill

## What it does

Triggers a **4-step automated pipeline** that builds a complete, documented analysis
notebook from a single data file path:

| Step | Skill | What happens |
|---|---|---|
| 1 | `load-dataframe` | Loads your file as a DataFrame, prints shape/columns/head |
| 2 | `eda` | Full EDA with distributions, correlations, and findings summary |
| 3 | `notebook-annotation` | Numbers and titles every code cell |
| 4 | `readme_gen` | Creates a polished README cell at the top |

Each step receives the **updated notebook context** from the previous step, so the
annotation and README accurately reflect what was actually generated.

## How to trigger

```
generate notebook with /data/sales.csv
analyze /path/to/my_data.xlsx end to end
full analysis of results.parquet
```

## UX

- Each step runs automatically (no per-step confirmation)
- Progress is shown in the chat: `Step 1/4: load dataframe… ✓`
- At the end, a **single composite diff panel** shows all changes across all steps
- One **Accept All** or **Undo All** button controls everything

## Adding your own composite skills

Create a new `your-pipeline/SKILL.md` with:

```yaml
---
composite: true
keywords: [your trigger phrase]
steps: [skill-a, skill-b, skill-c]
step_prompts:
  - "Prompt for skill-a step"
  - "Prompt for skill-b step"
  - "Prompt for skill-c step"
---
```

Each entry in `step_prompts` supports `{file_path}` and `{user_message}` variables.

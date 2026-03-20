# Notebook to Module — Composite Pipeline

`/notebook_to_module` is a two-step pipeline that:
1. Analyzes your notebook for reusable code (EDA step)
2. Extracts it into a proper Python module (Varys File Agent step)

## Usage

```
/notebook_to_module
```

No additional arguments needed. The pipeline analyzes the current notebook.

## What gets extracted

- Standalone functions (no `plt.show()`, no `display()`)
- Data processing classes
- Constants and configuration dicts

## Output

A new (or updated) file in `src/`, e.g., `src/preprocessing.py`, shown as a `FileChangeCard` for your review.

## Requirements

- Varys File Agent must be enabled (`VARYS_AGENT_ENABLED=true`)
- `ANTHROPIC_API_KEY` and `ANTHROPIC_CHAT_MODEL` must be set

---
name: Notebook to Module
command: /notebook_to_module
description: Convert reusable notebook functions to a Python module
cell_insertion_mode: composite
composite: true
steps:
  - eda
  - file_agent
tier: 2
---

## Composite Pipeline: Notebook → Python Module

This is a two-step composite pipeline:

1. **EDA step** (`/eda`): Analyze the notebook to identify reusable functions, classes, and data processing logic worth extracting.

2. **Varys File Agent step** (`/file_agent`): Extract the identified code into a well-structured Python module in the `src/` directory, adding proper imports, docstrings, and a public API.

The composite runner executes these steps sequentially. The Varys File Agent step receives the EDA analysis as context.

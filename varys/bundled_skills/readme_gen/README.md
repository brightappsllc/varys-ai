# readme_gen Skill

Generates a standardised README cell at the top of any notebook.

## What it produces

A single markdown cell inserted at position 0 containing:

| Section | Emoji | Description |
|---|---|---|
| Title | 📓 | Inferred from notebook content |
| Quick Info | 🧭 | Table: Purpose / Dataset / Methods / Libraries / Output |
| Objectives | 🎯 | Checkbox-style bullet list |
| Data | 📦 | Table of data sources with format and description |
| Methodology | 🔬 | Numbered steps mirroring the notebook flow |
| Key Results | 📊 | Summary of findings (or placeholder if not run) |
| Requirements | ⚙️ | Code block listing imported packages |
| How to Run | 🚀 | 3-step instructions |

## How to trigger

Mention any of: `readme`, `summary`, `overview`, `document`, `describe the notebook`,
`update the readme`, `write a readme`, `generate readme`.

## Tip

The skill instructs the assistant to **replace** an existing README cell if one is already
at position 0, so running it multiple times will update the README rather than duplicating it.

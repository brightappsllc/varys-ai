---
name: readme-gen
command: /readme
description: Generate or update the top-cell README for this notebook
cell_insertion_mode: auto
keywords: [readme, read me, summary cell, top cell summary, document, overview, describe the notebook, update the readme, write a readme, generate readme, create readme, add readme, notebook summary]
---
# README Generation Skill

You MUST follow this template **exactly** — every section, every emoji, the table format.
Do NOT invent additional sections. Do NOT omit any section. Do NOT change the emoji assignments.

---

## MANDATORY TEMPLATE

The README cell you create must reproduce this structure verbatim (filling in the
`[PLACEHOLDER]` parts from the actual notebook content):

```
# 📓 [Notebook Title — infer from the notebook CODE below, not from any existing README cell]

> [One compelling sentence that describes what this notebook does and why it matters.]

---

## 🧭 Quick Info

| Field | Details |
|---|---|
| **Purpose** | [1–2 sentences on the goal] |
| **Dataset** | [Dataset name / source, or "N/A"] |
| **Methods** | [Comma-separated list: e.g. EDA, Linear Regression, Clustering] |
| **Key Libraries** | [Comma-separated: e.g. pandas, scikit-learn, matplotlib] |
| **Output** | [What the notebook produces: model, report, figures, etc.] |

---

## 🎯 Objectives

- [ ] [Objective 1 — specific, action-oriented]
- [ ] [Objective 2]
- [ ] [Objective 3]
<!-- Add more bullets as needed, minimum 2 -->

---

## 📦 Data

[Describe each data source in 1–2 sentences. If no data loading is visible, write "No external data detected."]

| Source | Format | Description |
|---|---|---|
| [filename or URL] | [CSV / JSON / DB / etc.] | [What the data contains] |

---

## 🔬 Methodology

[Numbered list of the analytical steps taken, inferred from the cells:]

1. [Step 1]
2. [Step 2]
3. [Step 3]
<!-- Mirror the actual notebook flow -->

---

## 📊 Key Results

> [2–4 sentences summarising the most important findings. If the notebook has not been
> run (no outputs), write "Results not yet available — run the notebook to populate this section."]

---

## ⚙️ Requirements

```python
# Core dependencies (inferred from import statements)
[list each imported package on its own line, e.g.]
pandas
numpy
scikit-learn
matplotlib
```

---

## 🚀 How to Run

1. Install dependencies: `pip install -r requirements.txt`
2. Open `[notebook filename]` in JupyterLab.
3. Run all cells: **Kernel → Restart & Run All**.
```

---

## RULES

1. **Insert at position 0** — this cell always goes at the very top of the notebook.
2. **Replace an existing README** — if cell #1 already looks like a README (starts with `#`), use a `modify` step instead of `insert`. **Do NOT copy any text from the existing README** (not the title, not the tagline, not the table rows). Treat the existing cell as stale and infer every field fresh from the actual notebook code and outputs below it.
3. **Never truncate** — fill every `[PLACEHOLDER]` with real content from the notebook. Do not leave placeholders in the output.
4. **Emoji discipline** — use ONLY the emojis listed above for their assigned sections; do not add random emoji elsewhere.
5. **Table rows** — add rows to the Data table only for data sources actually visible in the notebook. If none, replace the table with "No external data detected."
6. **Key Results** — if cells have outputs, summarise what was found. If not, use the fallback text shown above.
7. **autoExecute must be false** for this markdown cell — it does not need execution.

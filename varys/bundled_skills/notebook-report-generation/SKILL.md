---
name: notebook-report-generation
command: /report
description: Generate a downloadable markdown report with embedded visualizations
cell_insertion_mode: chat
keywords: [generate report, create report, make a report, make report, write report, write a report, produce report, build narrative, summarize notebook, document analysis, export report]
---
# Notebook Report Generation Skill

## 1. Purpose and Trigger Phrases

You are generating a **professional narrative report** from a Jupyter notebook.
Activate this skill when the user says anything semantically equivalent to:
- "generate report", "create report", "make a report", "write a report"
- "build narrative", "summarize notebook"
- "document analysis", "produce report", "export to report"

Do NOT use this skill for: creating new cells, modifying code, EDA, or routine assistant tasks.

---

## 2. Narrative Analysis Framework

Scan the notebook and map its contents to these phases. A phase may be absent — note it gracefully.

### Problem Statement
Look in: first 3 markdown cells, cells containing "objective", "goal", "problem", "question".
Extract: study goal, dataset description, business context.

### Data Exploration
Indicators: `df.info()`, `df.describe()`, `df.head()`, `value_counts()`, `shape`, `nunique()`.
Extract: dataset dimensions, column types, missing-value summary, basic statistics.

### Methodology
Indicators: `sklearn`, `train_test_split`, `Pipeline`, `StandardScaler`, `LabelEncoder`, preprocessing functions.
Extract: preprocessing steps, feature engineering choices, model selection rationale.

### Results
Indicators: `accuracy_score`, `classification_report`, `confusion_matrix`, `r2_score`, metric printouts, visualizations.
Extract: exact metric values from OUTPUT sections — never approximate or invent.

### Conclusions
Look in: last 2 markdown cells, cells with "conclusion", "summary", "finding", "recommend".
If absent, synthesize cautiously from the Results phase with appropriate hedging language.

---

## 3. Notebook JSON Parsing Protocol

The notebook context you receive is formatted as:

```
=== NOTEBOOK METADATA ===
...
=== CELL STATISTICS ===
...
=== NOTEBOOK CELLS ===
--- Cell 0 (markdown) ---
SOURCE:
[content]

--- #1 (code) ---
SOURCE:
[code]

OUTPUTS:
Output 0 (execute_result):
  [text or HTML]

Output 1 (display_data):
  [IMAGE: PNG ...]
```

### Output Types and How to Parse Them

| output_type | How to use |
|---|---|
| `stream` | Concatenate all text lines — this is stdout/stderr |
| `execute_result` | Prefer HTML (tables) if present; fallback to text/plain |
| `display_data` | Image — use the provided base64 data for embedding |
| `error` | Record error name + message in the Limitations section |

### Key Rule
Read every OUTPUT section before writing any claims. If a cell has no OUTPUT, note that it was not executed or produced no output.

---

## 4. Image Extraction and Embedding

Images are provided in the `EXTRACTED IMAGES` section of your input, pre-numbered as Figure 1, Figure 2, etc.

### Embedding Syntax
```markdown
![Figure N: [descriptive caption]](data:image/png;base64,[base64_string])

**Figure N:** [1-2 sentence description of what the visualization shows and its significance]
```

### Caption Generation Rules
1. Use variable names from the code cell that generated the plot.
2. Use titles/labels from the code if present (e.g., `plt.title(...)`, `plt.xlabel(...)`).
3. Describe the key pattern, trend, or finding visible in the plot.
4. Number figures sequentially throughout the report (Figure 1, Figure 2, …).

### Important
- Images in the notebook JSON are **already base64 encoded** — embed them as-is, do not re-encode.
- For SVG images, embed using `data:image/svg+xml;base64,[base64]` or as inline SVG.
- For JPEG, use `data:image/jpeg;base64,[base64]`.

---

## 5. Accuracy and Hallucination Prevention

**This is the #1 priority. Accuracy over eloquence, always.**

### Required Verification Protocol
For every numerical claim:
1. Locate the source cell index in the notebook context.
2. Find the value in the OUTPUT section of that cell.
3. Quote the value exactly as it appears.
4. If the output is a table, reference the specific row and column.

### Confidence Levels
- **State directly** (no qualifier): value is present verbatim in OUTPUT.
- **"Analysis indicates"**: value is inferred from multiple outputs.
- **"Code suggests" / "was intended to"**: cell exists but has no output captured.
- **Never write**: invented numbers, made-up percentages, hallucinated model names.

### Handling Missing Outputs
If a cell has no output:
- Write: "Cell [N] was defined but no output was captured, suggesting it may not have been executed."
- Do not invent what the output might have been.

---

## 6. Report Structure Template

Generate exactly this structure. Omit sections only if the notebook contains no relevant content for them (note the omission).

```markdown
# [Notebook Title or Inferred Study Name]

**Generated:** [ISO date]
**Notebook:** [notebook filename]
**Analysis Status:** [Complete / Partial — N cells not executed]

---

## Executive Summary

[3–5 sentences covering: what was studied, key methodology, top 2–3 findings, main conclusion.]

---

## 1. Problem Statement and Objectives

[Extract from markdown cells. If absent, infer from the first code cell's imports/comments.]

---

## 2. Data Overview

[Dataset source, dimensions (rows × columns), time period if applicable.]

### Data Quality
[Missing values, duplicates, data types — from df.info()/df.describe() outputs.]

---

## 3. Exploratory Data Analysis

### 3.1 Descriptive Statistics
[Exact statistics from df.describe() output — mean, std, min, max, quartiles.]

### 3.2 Visual Exploration
[Embed visualizations here. Reference figures by number. Describe patterns.]

---

## 4. Methodology

### 4.1 Data Preprocessing
[List preprocessing steps identified from code: encoding, scaling, imputation, etc.]

### 4.2 Analytical Approach
[Model(s) chosen, hyperparameters set, train/test split ratios — from code and outputs.]

---

## 5. Results

### 5.1 Key Metrics
[Present all metric values verbatim from OUTPUT sections. Use tables where appropriate.]

### 5.2 Key Findings
[Bullet list of findings, each traceable to a specific cell output.]

---

## 6. Conclusions and Recommendations

### Key Takeaways
[3–5 bullets summarizing what was learned.]

### Limitations
[Cells with errors, unexecuted cells, data limitations, scope boundaries.]

### Next Steps
[Logical follow-up actions suggested by the results.]

---

## Appendix

### Analysis Completeness
| Metric | Value |
|--------|-------|
| Total cells | N |
| Executed cells | N |
| Cells with errors | N |
| Visualizations captured | N |

### Reproducibility Notes
[Kernel name, Python version if visible, key library versions if printed in outputs.]
```

---

## 7. Report Quality Checklist

Before finalising, verify each item:

**Content Accuracy**
- [ ] Every numerical claim is present verbatim in a cell OUTPUT section
- [ ] No approximated statistics unless the source output itself approximates
- [ ] All cell references use the correct cell index
- [ ] Image captions accurately describe the visualisation content
- [ ] No hallucinated results or invented conclusions

**Narrative Coherence**
- [ ] Logical story arc: problem → data → method → results → conclusions
- [ ] Smooth transitions between sections
- [ ] Executive Summary accurately reflects the full analysis
- [ ] Appropriate balance of technical depth and accessible language

**Completeness**
- [ ] All phases of the analysis are represented (or explicitly noted as absent)
- [ ] All extracted images are embedded with captions
- [ ] Both positive findings and limitations are reported

**Technical Quality**
- [ ] All images embedded with correct `data:image/[type];base64,...` syntax
- [ ] Markdown syntax is valid (headers, tables, lists)
- [ ] Source code NOT included in the report — only outputs and interpretations
- [ ] Figures numbered sequentially

---

## 8. Edge Cases

| Situation | How to Handle |
|-----------|---------------|
| No markdown cells | Infer purpose from import statements and variable names |
| No conclusions cell | Synthesize from Results, hedge with "Results suggest…" |
| Failed cells (output_type: error) | List in Limitations; do not describe what the cell "would have" produced |
| Multiple separate analyses | Create sub-sections 3a, 3b, etc.; note the distinct workflows |
| Very long notebook (100+ cells) | Summarise repeated similar cells ("10 data cleaning cells applied…") |
| Interactive plots (no static output) | Note "Interactive visualisation — static image not available" |
| Incomplete execution | State clearly in the Analysis Completeness table and Executive Summary |

---

## 9. Output Format Specifications

- **Encoding**: UTF-8
- **Line endings**: Unix (LF only)
- **Images**: Inline base64 — never external URLs
- **Markdown style**: ATX headers (`#`, `##`), GFM tables, fenced code blocks only for shell examples (not analysis code)
- **No code blocks** containing Python analysis code — show results only
- **Filename format**: `{notebook_name}_report_{YYYYMMDD_HHMMSS}.md`

---

## 10. Target Audience and Tone

- **Primary audience**: Technical stakeholders who did not write the notebook + non-technical business readers
- **Language**: Professional, clear, jargon-explained on first use
- **Voice**: Past tense, active ("We trained a Random Forest model…" / "The analysis found…")
- **Confidence**: State facts confidently from outputs; qualify inferences; acknowledge unknowns
- **Length guideline**: ~500 words per 10 notebook cells, capped at ~5,000 words for very large notebooks

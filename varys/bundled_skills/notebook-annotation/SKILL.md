---
name: notebook-annotation
command: /annotate
description: Number and title every code cell with a short markdown description
cell_insertion_mode: preview
keywords: [add title, add a title, add titles, add description, add a description, add descriptions, number section, number the section, number sections, numbered section, annotate, annotate the notebook, annotate cells, add header, add headers, add cell header, describe each cell, document each cell, describe the cells, section number, add numbered, add a title before, title each, title before each, label each cell, add short description, add a short description]
---
# Notebook Annotation Skill

You are annotating a notebook by inserting numbered title + description cells before
code cells. Follow the **two-phase protocol** below without skipping either phase.
Violating the ordering rules will produce an incorrect notebook.

---

## PHASE 1 — Pre-scan (do this mentally before generating any steps)

Before writing a single operation step, scan the notebook context and build a complete
picture:

### 1a. Find existing titled sections
Walk through every cell in order. A cell is already "titled" if it is:
- A MARKDOWN cell that starts with `#`, `##`, or `###` AND contains a number
  (e.g. `## 1.`, `## 2. Data Loading`, `### 1.2 Feature Engineering`).

Record each titled cell as: `{ cell: "#N", index: N-1, number: "N" or "N.M", heading: "..." }`

### 1b. Find code cells that need a title
Walk through every CODE cell. A code cell DOES NOT need a new title if the
immediately preceding cell is already a titled markdown cell.
A code cell DOES need a new title if:
- It has no preceding cell at all, OR
- Its preceding cell is another code cell, OR
- Its preceding cell is a markdown cell that is NOT a numbered title.

Record each cell-needing-title as: `{ cell: "#N", index: N-1, needs_title: true }`

### 1c. Build the sequential numbering plan
Take every cell-needing-title from step 1b, in ascending order.
Assign section numbers sequentially, starting after the highest existing section
number found in step 1a (or starting at 1 if no existing numbers were found).

**WRITE OUT THE PLAN in your reasoning** (not in the output):
```
Existing numbered cells: [list them as #N]
Cells needing titles (ascending): [list them as #N]
Number assignment: #N (index N-1) → "## K. <Short Title>", ...
```

Verify the numbers are strictly sequential (1, 2, 3 … or continuation) before
proceeding to Phase 2. If they are not sequential, fix them before continuing.

---

## PHASE 2 — Generate insert steps

Now generate the `steps` array. **Critical rules:**

### 2a. Process cells in ASCENDING order
Always iterate from #1 to the last cell. Never jump backwards.

### 2b. Track cumulative index shift
Start with `shift = 0`.
Each time you emit an `insert` step, increment `shift` by 1.
The `cellIndex` for an insert before cell #N is: **(N-1) + shift** (at the
moment you insert it — shift is the count of all inserts already emitted above it).

Example with 3 code cells at #2, #4, #6 (original indices 1, 3, 5):
```
Insert title before #2 (index 1):  cellIndex = 1 + 0 = 1,  shift becomes 1
Insert title before #4 (index 3):  cellIndex = 3 + 1 = 4,  shift becomes 2
Insert title before #6 (index 5):  cellIndex = 5 + 2 = 7,  shift becomes 3
```

### 2c. Title cell format
```markdown
## N. Short Descriptive Title
```
- Use `##` for top-level sections (not `#` which is reserved for the notebook title,
  not `###` which is for subsections).
- Title: 3–6 words, action-oriented (e.g. "Load and Inspect Data", "Train Model",
  "Evaluate Results").
- No trailing period after the title.

### 2d. Description cell format (when user asks for a description before each code cell)
If the user asked for a short description cell in addition to the title:
Insert ONE additional markdown cell immediately after the title cell (before the code cell):
```markdown
> Brief 1–2 sentence description of what the following code does and why.
```
Use a blockquote (`>`) for descriptions so they are visually distinct from titles.
Each description insert also increments shift by 1.

### 2e. Skip already-titled cells
If a code cell already has a preceding numbered title (identified in Phase 1a), do
NOT insert another title before it. You may still insert a description cell if one
is missing and the user asked for descriptions.

### 2f. autoExecute
All inserted cells are markdown. Set `autoExecute: false` for every step.

---

## FORMAT EXAMPLE

Notebook before annotation:
```
#1  MARKDOWN  "# My Analysis Notebook"
#2  CODE       import pandas as pd
#3  CODE       df = pd.read_csv('data.csv')
#4  MARKDOWN  "## 1. Data Inspection"
#5  CODE       df.head()
#6  CODE       df.describe()
```

Phase 1 scan:
- Existing numbered cells: #4 (index 3) → "1."
- Code cells needing titles: #2 (index 1, no preceding title), #3 (index 2, preceding is code),
  #6 (index 5, preceded by #5 which is CODE → needs title)
- #5 is preceded by #4 which IS a numbered title → #5 does NOT need title
- Number assignment: #2 → "## 2.", #3 → "## 3.", #6 → "## 4."

Wait — existing number is "1.", new ones should start at 2.

Steps (shift starts at 0):
1. Insert `## 2. Import Libraries`   before #2 (index 1): cellIndex = 1+0=1,  shift→1
2. Insert `## 3. Load Data`          before #3 (index 2): cellIndex = 2+1=3,  shift→2
3. Insert `## 4. Summary Statistics` before #6 (index 5): cellIndex = 5+2=7,  shift→3

Final notebook order: #1 (title), new ##2 header, #2 (import), new ##3 header, #3 (load), #4 (##1 existing), #5 (head), new ##4 header, #6 (describe) ✓

---
name: regroup_by_function
command: /regroup
description: Restructure notebook cell contents by grouping code by functionality — imports together, functions together, constants together — without losing any code.
cell_insertion_mode: preview
keywords:
  - consolidate imports
  - group imports
  - all imports in one cell
  - all imports in the first cell
  - extract imports
  - isolate imports
  - separate imports
  - organize imports
  - group functions together
  - extract functions
  - extract function definitions
  - group all functions
  - isolate functions
  - group constants
  - extract constants
  - regroup
  - regroup by
---
# Regroup-by-Function Skill

You are restructuring cell **contents** so that code of the same kind lives
together in the same cell.  This is *content* surgery — extracting specific
lines from one cell and adding them to another — not whole-cell reordering.

## When this skill applies

The user wants code of a specific kind (imports, function definitions,
constants, configuration, etc.) consolidated into a dedicated cell.  Examples:

- "Move all imports into the first cell"
- "Consolidate the imports"
- "Extract the helper functions into their own cell"
- "Put all the constants together"
- "Isolate the configuration block"

If the user is asking for something else — whole-cell reordering, deleting
content, refactoring code logic — DO NOT use this skill.  Return a brief
`chatResponse` saying so and let the next turn route to the appropriate
flow.

## Mandatory algorithm — follow exactly

1. **Identify the target group.**  Read the user's request and decide what
   pattern of lines is being grouped: import statements?  Function
   definitions?  Constants? Comments labelled "Config"?  If ambiguous,
   STOP and ask the user via `chatResponse` — do not guess.

2. **Scan every cell.**  Walk the cell list (you have it in context with
   `[id:XXXXXXXX]` headers).  For each cell, identify which lines match the
   target group.  Build a list of (cell_id, matched_lines).

3. **Decide the target cell.**

   - If the user named a position ("the first cell", "cell #N"), use it.
   - Otherwise, default to cell #1.
   - If the target cell is empty (whitespace only): you will use a `modify`
     to set its contents to the consolidated lines.
   - If the target cell already has *non-matching* content (i.e. it does NOT
     contain the kind of code being grouped): you will `insert` a new cell
     at the target position so the original content is preserved.  Never
     overwrite a non-empty cell's existing content.
   - If the target cell already contains *some* of the matching code (e.g.
     cell #1 already has a few imports): you will `modify` it to hold the
     full consolidated set, merging without duplicating.

4. **Build the operation plan.**

   - **One `modify` step per source cell** whose content changes — emit it
     with the cell's source after the matching lines have been removed.
     Preserve all other lines, blank lines, and comments exactly as they
     were.
   - **One `modify` or `insert` step for the target cell** — its new
     content is the de-duplicated, ordered union of all matching lines
     collected in step 2 (plus any matching lines it already had).
   - The output is your `steps[]` array.

5. **Set `requiresApproval: true`.**  The user reviews the diff before any
   cell contents change.

## Operation type whitelist

Within this skill, only two operation types are permitted:

| Type | When to use |
|------|-------------|
| `modify` | Cell exists and its source needs to change |
| `insert` | A new cell needs to exist (target slot has unrelated content) |

**`delete` is FORBIDDEN.**  An empty cell after extraction is harmless and
preserves user intent (they can clean up empty cells separately).  A
deleted cell is destructive and the user cannot easily recover it.  If you
catch yourself wanting to delete, you are in the wrong skill — return a
`chatResponse` and stop.

**`reorder` is FORBIDDEN.**  Distribution-by-functionality does not
require shuffling cells.  If the user *also* wants to reorder, that's a
follow-up request handled separately.

## Step ordering inside the plan

Emit modifies in **ascending cell index** order.  If you `insert` at index
N, list it BEFORE any `modify` to a cell at index ≥ N (the insert shifts
later indices, and the modify uses the post-insert index).

## Sanity checks before emitting the plan

Before returning the JSON response, verify:

- [ ] **No code is lost.**  The union of all `modify`-result contents plus
      the target cell's new contents must contain every line from every
      original cell.  Imports moved to cell #1 must still appear *somewhere*
      — just in a different cell.
- [ ] **No cell is deleted.**  `steps[]` contains only `modify` and
      `insert` types.
- [ ] **No reorder.**  No `reorder` step.
- [ ] **No duplication.**  An import line appears in exactly one cell after
      the operation (the target cell).  Don't leave a copy in the source.
- [ ] **Target cell is reachable.**  If you used `insert`, its index is
      valid; if `modify`, the cell exists at that index.

## Output format

```json
{
  "steps": [
    {
      "type":      "modify",
      "cellIndex": 0,
      "cellType":  "code",
      "content":   "import numpy as np\nimport pandas as pd\n",
      "description": "Consolidated imports collected from cells #2, #4"
    },
    {
      "type":      "modify",
      "cellIndex": 2,
      "cellType":  "code",
      "content":   "df = np.array([[1, 2], [3, 4]])\nprint(df)\n",
      "description": "Removed import line — moved to cell #1"
    }
  ],
  "requiresApproval": true,
  "summary":          "Consolidate imports into cell #1"
}
```

## Failure modes — return a chat_response, do NOT emit a bad plan

If any of the following are true, abandon the plan and respond in chat:

- The user's request mixes intents ("consolidate imports AND delete the
  empty cells AND reorder the rest") — ask them to break it into separate
  requests so each can be reviewed individually.
- The notebook has no cells matching the target group — say so and stop.
- Two or more candidate target cells are equally valid — ask the user
  which one to use.
- A cell would become empty after extraction AND the user explicitly asked
  to delete it — refuse, explain that this skill only does content
  redistribution, and suggest they use a separate request to delete the
  empty cell after reviewing.

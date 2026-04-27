---
name: reorganize_cell
description: Move, reorder, or restructure notebook cells into a new sequence
keywords: [reorganize, reorder, move cell, restructure notebook, rearrange, swap sections, move section, move before, move after]
---
# Notebook Reorganization Skill

## When this skill applies
Use this skill when the user asks to move, reorder, swap, or restructure notebook cells —
e.g. "move the heatmap before the distributions", "swap sections 3 and 5",
"move cell #3 above cell #1".

## Step 0 — Scope check (MANDATORY)

Before emitting any operation, ask yourself: **does this request require modifying
the *contents* of any cell?**  Extracting lines from a mixed cell, splitting code,
removing imports from a cell that also holds other code, copying a snippet into a
different cell — all of these are *content* changes, not pure reorders.

This skill emits exactly ONE `reorder` step and CANNOT modify cell contents.

If the user's request requires content modification:

- DO NOT emit a reorder step that only shuffles cells around the unwanted code.
- DO NOT pretend the request was a pure reorder.
- INSTEAD, return a `chatResponse` like:

  > "I can only reorder existing cells, not extract or move code between them.
  >  To accomplish what you asked, I'd need to modify cell contents (extract
  >  the import line into a separate cell, etc.).  Could you confirm — do you
  >  want me to (a) just reorder existing cells, or (b) restructure the
  >  contents (split out imports into their own cell)?"

  …and emit an empty `steps` array.  The general planner will pick up the
  request on the next turn with full `modify` + `insert` + `reorder` tools.

Common phrases that often hide content-modification intent (apply scope check
extra carefully):
- "put all imports in the first cell" — usually means *extract* imports
- "consolidate X into one cell" — usually means *merge* code
- "clean up the notebook structure" — too vague; ask the user to clarify
- "reorganize so X" — depends on what X is; if X requires moving *code lines*
  (not whole cells), refuse and ask

If the request is unambiguously a pure reorder ("move cell #3 to position 1",
"swap cells 2 and 5", "put markdown headers before each code cell — assuming
those headers already exist as separate cells"), proceed to the `reorder`
operation below.

## The ONLY correct approach: `reorder` operation

**Never** simulate a move with insert+delete pairs. Index drift causes content loss.

Instead, emit exactly ONE step of type `"reorder"` containing the full desired cell sequence:

```json
{
  "steps": [
    {
      "type": "reorder",
      "newOrder": ["a3f7b2c1", "d9e4f1a0", "b2c3d4e5", ...],
      "description": "Move correlation heatmap before distribution plots"
    }
  ],
  "requiresApproval": true,
  "summary": "Reorganize notebook: heatmap → distributions → categorical"
}
```

## How to build `newOrder`

1. Read the current cell list from the notebook context. Every cell header shows `[id:XXXXXXXX]`.
2. Decide the desired final sequence of cells.
3. List **every** cell's short ID in the new order — include cells that don't move.
4. Omit nothing: if a cell's ID is missing from `newOrder`, it will stay in its current position.

## Rules
- `requiresApproval` is **always** `true` for reorder (the user must confirm before cells move).
- Do NOT include insert/modify/delete steps in the same plan as a reorder step.
- If the user also wants to edit content (e.g. "move the heatmap AND fix its title"),
  split into two plans: first reorder (requires approval), then modify (separate request).
- Never generate fake or guessed cell IDs — use only the `[id:XXXXXXXX]` values from context.

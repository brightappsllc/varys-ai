---
name: reorganize
keywords: [reorganize, reorder, move cell, restructure notebook, rearrange, swap sections, move section, move before, move after]
---
# Notebook Reorganization Skill

## When this skill applies
Use this skill when the user asks to move, reorder, swap, or restructure notebook cells —
e.g. "move the heatmap before the distributions", "swap sections 3 and 5",
"put the imports at the top".

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

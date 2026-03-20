# notebook-annotation Skill

Inserts numbered title and/or description cells before every code cell in a notebook,
with correct sequential numbering and index-shift tracking.

## What it does

- Scans the notebook to find existing numbered section headings so new numbers
  continue from the right place (not restart from 1).
- Identifies only the code cells that are missing a preceding titled section.
- Inserts `## N. Title` markdown cells with strictly sequential numbering.
- Optionally inserts a one-sentence `> description` blockquote after each title.
- Correctly tracks the +1 index shift each insert causes so all subsequent
  cellIndex values are accurate.

## Trigger phrases

Any of: `add title`, `add description`, `number section`, `annotate`, `add header`,
`describe each cell`, `document each cell`, `section number`, `add numbered`.

## Format

**Title cell:**
```markdown
## N. Short Descriptive Title
```

**Description cell (when requested):**
```markdown
> Brief 1–2 sentence description of what the following code does and why.
```

## Notes

- Existing numbered cells are detected and skipped — running the skill twice
  will not create duplicate headers.
- Numbers always start after the highest existing section number found in the notebook.
- All inserted cells are markdown with `autoExecute: false`.

# Notebook Code Review

Validates **code quality, execution correctness, and programming best
practices** in a notebook. Focuses on whether the code will run correctly and
is maintainable — it does NOT judge data science methodology.

## How to Trigger

Type any of these phrases in the DS Assistant chat:

- "review my code"
- "check for bugs"
- "audit this code"
- "code quality review"
- "check code issues"

## What You Get

A structured report in the chat panel, organised by severity:

| Severity | Meaning |
|----------|---------|
| 🔴 CRITICAL | Will crash on fresh kernel restart |
| 🟡 HIGH | Likely bugs or data loss |
| 🟠 MEDIUM | Maintainability problems |
| 🔵 LOW | Style / clarity improvements |
| ℹ️ INFO | Observations |

Each finding explains the issue, why it matters, and how to fix it.
Findings that have a ready-made code fix include an **Apply Fix** button
so you can selectively apply individual suggestions.

## What It Checks

- Execution order (variables used before definition)
- Undefined variables and missing imports
- Missing error handling (file I/O, data loading)
- Magic numbers, code duplication, inefficient pandas
- Import organisation (unused, scattered, deprecated)
- Unclear variable names
- Unclosed files and resource leaks

## What It Does NOT Check

This skill is intentionally scoped to **code correctness only**:

- ❌ Statistical methodology
- ❌ Train/test split correctness
- ❌ Data leakage
- ❌ Model selection
- ❌ Data science best practices (use the `data-science-review` skill for those)

## Apply Fix Buttons

For findings with a direct code fix:
1. Expand the fix card to preview the suggested code
2. Click **Apply Fix** to insert it at the target cell
3. You can apply fixes selectively — only apply the ones you agree with

Fixes are inserted as individual operations. Each one can be undone
separately using Ctrl+Z if needed.

## Customising the Review

Edit `SKILL.md` in this folder to:
- Adjust severity classifications
- Add project-specific rules (e.g., "always use `pathlib.Path`")
- Exclude certain checks for this project

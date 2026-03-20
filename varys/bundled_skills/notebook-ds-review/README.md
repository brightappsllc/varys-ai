# Notebook Data Science Methodology Review

Validates **data science methodology, statistical soundness, and reproducibility**
in a notebook. Focuses on whether the analytical approach is correct —
it does NOT check code quality or style (that is handled by the
`notebook-code-review` skill).

## How to Trigger

Type any of these phrases in the DS Assistant chat:

- "review my analysis"
- "check my methodology"
- "validate my approach"
- "audit this analysis"
- "data science review"
- "check for data leakage"

## What You Get

A structured methodology report in the chat panel, organised by severity:

| Severity | Meaning |
|----------|---------|
| 🔴 CRITICAL | Will produce wrong results or misleading metrics |
| 🟡 HIGH | Invalidates conclusions or makes results irreproducible |
| 🟠 MEDIUM | Reduces reliability or leaves important gaps |
| 🔵 LOW | Minor best-practice gaps |
| ℹ️ INFO | Observations worth documenting |

Each finding explains the methodology problem, **why it matters** with
educational context, and how to fix it. Findings with a ready-made fix
include an **Apply Fix** or **Add Documentation** button.

## What It Checks

- **Data leakage** — target used in features before split, scalers fitted
  on full data, test data influencing training decisions, time-series future
  leakage
- **Reproducibility** — missing `random_state`, hardcoded paths,
  non-deterministic operations
- **Train/test split problems** — missing stratification, test set too small,
  no validation set
- **Model validation** — no cross-validation, hyperparameters tuned on test
  set, single evaluation without confidence
- **Statistical correctness** — multiple testing without correction,
  class imbalance, overfitting indicators
- **Undocumented assumptions** — unexplained filters, imputation choices,
  outlier removal

## What It Does NOT Check

This skill is intentionally scoped to **methodology only**:

- ❌ Code syntax and style
- ❌ Variable naming
- ❌ Import organisation
- ❌ Cell execution order
- ❌ Code performance

Use the `notebook-code-review` skill for those.

## Apply Fix / Add Documentation Buttons

Two types of fixes appear in the panel:

- **Apply Fix** — corrected code (e.g., adds `random_state`, fixes split
  order, adds stratification). Inserts or replaces the target cell.
- **Add Documentation** — inserts a markdown cell explaining an
  undocumented assumption or methodology choice.

You can apply fixes selectively. Each one is independent.

## Complementary Skills

Run both review skills for a comprehensive notebook QA pass:

1. **notebook-code-review** — "review my code"
2. **notebook-ds-review** — "review my analysis"

Together they cover: execution correctness, code quality, AND
statistical/methodology soundness.

## Customising the Review

Edit `SKILL.md` in this folder to:
- Add project-specific constraints (e.g., "This is a time-series project —
  always check temporal ordering")
- Adjust severity classifications for your team
- Exclude checks that don't apply (e.g., single-class problems don't need
  stratification checks)

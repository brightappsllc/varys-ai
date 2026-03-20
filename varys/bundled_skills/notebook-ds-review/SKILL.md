---
name: notebook-ds-review
command: /ds-review
description: Data-science methodology review: leakage, bias, statistical correctness
cell_insertion_mode: manual
keywords: [review my analysis, review the analysis, analysis review, check my methodology, validate my approach, audit this analysis, data science review, ds review, methodology review, check for data leakage, data leakage, check methodology, validate the analysis, statistical review, ml review]
---
# Notebook Data Science Methodology Review Skill

You are performing a **static data science methodology review** of a Jupyter
notebook. Focus exclusively on whether the analytical approach is statistically
sound, reproducible, and free of common ML/DS antipatterns.

Do NOT comment on code style, variable naming, import organisation, or
execution order — those are out of scope (a separate code review skill
handles them).

## Severity Levels

| Emoji | Level | Meaning |
|-------|-------|---------|
| 🔴 | CRITICAL | Will produce wrong results or misleading metrics in production |
| 🟡 | HIGH | Likely invalidates conclusions or makes results irreproducible |
| 🟠 | MEDIUM | Reduces reliability or leaves important gaps in the analysis |
| 🔵 | LOW | Minor best-practice gaps; won't break things but should be addressed |
| ℹ️ | INFORMATIONAL | Observations worth documenting; no immediate action required |

## What to Check

### 1. Data Leakage
- Target variable used in feature engineering **before** train/test split
  (e.g., mean-encoding, aggregations that include target)
- Transformers/scalers fitted on full dataset before split (fit on training
  only, transform both)
- Test data used to make training or feature-engineering decisions
- Time-series: future information used to predict past events
- Cross-validation: information bleeding across folds (e.g., fitting scaler
  inside the loop on full fold data)

### 2. Reproducibility
- Missing `random_state` on stochastic operations:
  - `train_test_split(random_state=?)`
  - `RandomForestClassifier(random_state=?)` or any sklearn estimator
  - `np.random.seed()` / `np.random.default_rng()`
  - Shuffle operations without a seed
- Hardcoded absolute file paths that won't work on another machine
- Non-deterministic operations without comment explaining why results may vary

### 3. Train/Test Split Problems
- Split occurs **after** feature engineering that involves the target
- No separate validation set for hyperparameter tuning (only train + test)
- Test set too small (< 15–20% of data) for reliable evaluation
- Class imbalance present but `stratify=y` not used in `train_test_split`

### 4. Model Validation Issues
- No cross-validation on training data
- Hyperparameters chosen based on test-set performance (peeks at test set)
- Model selection criterion is test accuracy rather than a held-out or
  cross-validated score
- Single train/test evaluation reported as final result without confidence
  intervals or repeated runs

### 5. Statistical Correctness
- Multiple hypothesis tests without correction (Bonferroni, FDR)
- Distributional assumptions not verified (normality, independence,
  homoscedasticity) before applying a test that requires them
- Conclusions drawn from very small samples (n < 30 without justification)
- Overfitting indicators: training accuracy near 100% with a large gap
  to test accuracy; learning curves not examined
- Class imbalance (> 20% difference between classes) not addressed in
  metrics — accuracy alone is misleading; use F1, ROC-AUC, precision-recall

### 6. Time-Series Specific
- Shuffled train/test split on time-ordered data (must use temporal split)
- Future leakage in lag features or rolling statistics
- Missing autocorrelation or stationarity checks

### 7. Data Quality & Undocumented Assumptions
- Missing values dropped without explanation
- Imputation strategy not documented or not consistent between train and test
- Outliers removed without explanation or investigation
- Filters / business-rule transformations applied without a markdown comment
  explaining the rationale

### 8. Feature Engineering Soundness
- Features that could not exist at prediction time (temporal leakage)
- Aggregations that implicitly encode the target (target leakage)
- Transformations that contradict the domain or business logic

## Output Rules

Each finding must state:
1. **Issue type** and exact cell location (e.g., `[Cell 12]`)
2. **Description** — what the problem is
3. **Why it matters** — educational context: concrete consequence of ignoring it
4. **Suggestion** — specific actionable fix; include a code snippet when a
   direct code replacement exists and that fix belongs in `steps[]`

If a finding has a corresponding entry in `steps[]`, end the finding with
exactly this line:
`[Fix available — see panel below]`

For documentation-only suggestions (markdown explanation cells), also add:
`[Fix available — see panel below]`

If there are no issues in a severity section, write `None.` for that section.

If the notebook has no significant methodology issues, write:
`✅ No significant data science methodology issues found.`
and return an empty `steps` array.

## steps[] Rules

Include steps for two types of fixes:
1. **Code fixes** (`type: "modify"`) — corrected sklearn calls, added
   `random_state`, fixed split order, etc. Must contain the COMPLETE,
   runnable cell content (not just the changed lines).
2. **Documentation cells** (`type: "insert"`, `cellType: "markdown"`) —
   markdown cells explaining an undocumented assumption, adding a methodology
   note, or documenting a rationale.

Do NOT include:
- Subjective "you should use a different algorithm" suggestions
- Architectural refactors spanning many cells
- Suggestions requiring domain knowledge the notebook doesn't provide

Set `autoExecute: false` on every step. Maximum 10 steps.

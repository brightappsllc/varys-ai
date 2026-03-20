---
name: unittest
command: /unittest
description: Generate comprehensive pytest test cases for functions defined in a notebook cell
cell_insertion_mode: preview
keywords: [generate tests, create tests, write tests, add tests, test this function, test this, generate pytest, write pytest, unit test, create unit tests, write unit tests, test cases for]
---

# Unit Test Generation Skill

Generate a rigorous, self-contained pytest test cell for one or more functions found in the specified cell.

## Step 0 — Intent gate

If the user is **asking about testing concepts, asking what tests exist, or discussing test strategy** rather than requesting test generation, respond in chat mode. Do NOT insert code.

Examples of *discuss* intent: "what tests should I write?", "how do I use pytest?", "are these tests good?"
Examples of *generate* intent: "generate tests for this function", "create tests for `compute_mrr`", `/unittest`, right-click → Generate Tests

---

## Step 1 — Locate the function(s)

1. Read the source of the referenced cell (`#N`).
2. Extract **every `def` or `class` definition** in the cell. If there are multiple, generate tests for all of them.
3. Parse for each function:
   - **Signature** — parameter names, type hints, defaults
   - **Docstring** — any stated contracts, examples, or guarantees
   - **Return type** — from hint or inferred from `return` statements
   - **Raises** — explicit `raise` statements
   - **Special patterns** — `if x is None`, division, `.shape`, `.columns`, `np.`, `pd.`

---

## Step 2 — Classify the function type

Choose the appropriate test strategy based on what the function handles:

| Function type | Detection signal | Test strategy |
|---|---|---|
| **Pure scalar** | `str → str`, `int → int`, `float → float` | Direct `assert result == expected` |
| **NumPy / embedding** | `np.array`, `np.dot`, `.shape`, `norm` | `pytest.approx` for floats; `np.testing.assert_array_*` |
| **Pandas DataFrame** | `pd.DataFrame`, `.groupby`, `.merge`, `.dropna` | `pd.testing.assert_frame_equal` / `assert_series_equal` |
| **Classifier / ML model** | `.fit`, `.predict`, `.score`, `sklearn` | Tolerance-based score assertions; fixture for reproducible data |
| **Generator / iterator** | `yield` | `list(result)` before asserting |
| **Side-effect / I/O** | `open`, `to_csv`, `requests` | `pytest.raises` for bad inputs; mock for external deps |

---

## Step 3 — Determine required imports

Scan the original cell's imports and the notebook context:

- Always include `import pytest`
- Add `import numpy as np` if function uses NumPy
- Add `import pandas as pd` if function uses DataFrames
- Add `from sklearn.datasets import make_classification` if generating ML fixture data
- Import the function under test **only** if it is defined elsewhere (for notebook cells, functions are already in scope — add a comment `# function assumed to be in scope from the cell above`)

---

## Step 4 — Generate test categories

### 4a. Happy-path tests (always required — minimum 2)

- Typical, real-world-ish inputs
- Verify documented examples from the docstring first
- Use concrete, readable values (not magic numbers)

```python
def test_<fn>_basic():
    result = <fn>(typical_input)
    assert result == expected_output
```

### 4b. Edge-case tests (always required — minimum 2)

Cover at least:

| Scenario | When to include |
|---|---|
| Empty string `""` | String parameters |
| `None` input | Optional parameters or unguarded usage |
| Zero / empty list `[]` | Numeric or sequence parameters |
| Single element | Any iterable parameter |
| Boundary value | Numeric: 0, 1, −1, max, min |
| Whitespace-only string | Text-processing functions |
| All-NaN column | Pandas functions |
| Empty DataFrame | Pandas functions |
| Zero vector | Embedding / cosine similarity |
| Mismatched dimensions | Array operations |

### 4c. Error / exception tests (when `raise` or unguarded division is present)

```python
def test_<fn>_raises_on_<condition>():
    with pytest.raises(<ExceptionType>):
        <fn>(bad_input)
```

Common patterns to detect and test:
- Division where denominator could be zero → `ZeroDivisionError`
- `df[col]` without column check → `KeyError`
- `text.lower()` on non-string → `AttributeError`
- Index out of range → `IndexError`

### 4d. Data-science–specific tests

**NumPy / Embeddings:**
```python
def test_<fn>_identical_vectors():
    v = np.array([1.0, 2.0, 3.0])
    assert <fn>(v, v) == pytest.approx(1.0, abs=1e-6)

def test_<fn>_orthogonal_vectors():
    v1 = np.array([1.0, 0.0, 0.0])
    v2 = np.array([0.0, 1.0, 0.0])
    assert <fn>(v1, v2) == pytest.approx(0.0, abs=1e-6)

def test_<fn>_output_shape():
    result = <fn>(np.random.rand(10, 128))
    assert result.shape == (10,)
```

**Pandas DataFrames:**
```python
def test_<fn>_returns_dataframe():
    df = pd.DataFrame({"col": [1, 2, 3]})
    result = <fn>(df)
    assert isinstance(result, pd.DataFrame)

def test_<fn>_preserves_row_count():
    df = pd.DataFrame({"col": [1, 2, None, 4]})
    result = <fn>(df)
    assert len(result) == len(df)   # or len(result) == 3 if NaN dropped

def test_<fn>_empty_dataframe():
    result = <fn>(pd.DataFrame(columns=["col"]))
    assert result.empty
```

**Text / NLP:**
```python
def test_<fn>_lowercases():
    assert <fn>("UPPER CASE") == "upper case"

def test_<fn>_strips_punctuation():
    assert <fn>("hello!!!") == "hello"

def test_<fn>_collapses_whitespace():
    assert <fn>("  too   many   spaces  ") == "too many spaces"
```

**ML Models:**
```python
def test_<fn>_learns_training_data():
    from sklearn.datasets import make_classification
    X, y = make_classification(n_samples=200, n_features=10, random_state=42)
    model = <fn>(X, y)
    assert model.score(X, y) > 0.7

def test_<fn>_reproducible():
    from sklearn.datasets import make_classification
    X, y = make_classification(n_samples=100, random_state=42)
    m1 = <fn>(X, y, random_state=42)
    m2 = <fn>(X, y, random_state=42)
    np.testing.assert_array_equal(m1.predict(X), m2.predict(X))
```

---

## Step 5 — Code generation rules

1. **Cell header comment:** `# Tests for <function_name>` followed by a blank line.
2. **Import block** at the top (even if already in notebook — tests must be self-contained to be runnable with `pytest`).
3. **Test function naming:** `test_<function_name>_<scenario_description>` — all lowercase with underscores.
4. **AAA structure** (Arrange / Act / Assert) with blank lines between sections when the test is non-trivial.
5. **Float comparisons:** always use `pytest.approx(value, abs=1e-6)` or `np.testing.assert_allclose`.
6. **DataFrame comparisons:** always use `pd.testing.assert_frame_equal(result, expected)`.
7. **No redundant tests:** do not test Python builtins or third-party library internals.
8. **Minimum count:** at least **4 tests per function** (2 happy path + 2 edge/error). Aim for 5–7.
9. **Close with a `# --- run with: pytest <cell_or_filename> ---` comment** so the user knows how to execute.

---

## Step 6 — Output format

Return **one operation** — a new code cell inserted **immediately after the source cell**:

```json
{
  "type": "insert",
  "cellType": "code",
  "cellIndex": <source_cell_index + 1>,
  "content": "<complete test code>",
  "description": "Unit tests for <function_name(s)>"
}
```

---

## Full example

### Source cell (#4)

```python
def compute_mrr(ranked_lists, relevant_items):
    """Mean Reciprocal Rank over a list of ranked result lists."""
    rr_sum = 0.0
    for ranked, relevant in zip(ranked_lists, relevant_items):
        for rank, item in enumerate(ranked, start=1):
            if item in relevant:
                rr_sum += 1.0 / rank
                break
    return rr_sum / len(ranked_lists) if ranked_lists else 0.0
```

### Generated test cell (inserted at #5)

```python
# Tests for compute_mrr
# function assumed to be in scope from the cell above
import pytest

# ── Happy path ────────────────────────────────────────────────────────────────

def test_compute_mrr_relevant_at_rank1():
    """Relevant item is first → MRR = 1.0"""
    assert compute_mrr([["a", "b", "c"]], [{"a"}]) == pytest.approx(1.0)

def test_compute_mrr_relevant_at_rank3():
    """Relevant item at position 3 → MRR = 1/3"""
    assert compute_mrr([["x", "y", "a"]], [{"a"}]) == pytest.approx(1 / 3, abs=1e-6)

def test_compute_mrr_multiple_queries():
    """Average of MRR over multiple queries"""
    ranked = [["a", "b"], ["x", "a"]]
    relevant = [{"a"}, {"a"}]
    expected = (1.0 + 0.5) / 2
    assert compute_mrr(ranked, relevant) == pytest.approx(expected, abs=1e-6)

# ── Edge cases ────────────────────────────────────────────────────────────────

def test_compute_mrr_no_relevant_found():
    """No relevant item in ranked list → MRR = 0.0"""
    assert compute_mrr([["x", "y", "z"]], [{"a"}]) == pytest.approx(0.0)

def test_compute_mrr_empty_input():
    """Empty ranked_lists → MRR = 0.0 (not a division error)"""
    assert compute_mrr([], []) == pytest.approx(0.0)

def test_compute_mrr_single_item_list():
    """Single item ranked list with match"""
    assert compute_mrr([["a"]], [{"a"}]) == pytest.approx(1.0)

def test_compute_mrr_relevant_not_in_ranked():
    """All queries miss → MRR = 0.0"""
    assert compute_mrr([["b", "c"], ["d", "e"]], [{"a"}, {"a"}]) == pytest.approx(0.0)

# --- run with: pytest test_notebook.py  or  run this cell directly ---
```

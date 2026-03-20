# Unit Test Generation Skill

Generate comprehensive `pytest` test cases for functions defined in your notebook, inserted as a new cell immediately below the source.

---

## Usage

```
/unittest      → tests for the currently active cell
/unittest #4   → tests for cell #4
```

Or right-click any code cell → **🤖 AI Actions → 🧪 Generate tests**

---

## What gets generated

For every `def` (or `class`) found in the cell, the skill produces:

| Category | Minimum | Examples |
|---|---|---|
| Happy path | 2 | Typical inputs, docstring examples |
| Edge cases | 2 | `None`, `""`, `[]`, `0`, empty DataFrame, zero vector |
| Error / exceptions | 1 (when `raise` present) | `ZeroDivisionError`, `KeyError`, `AttributeError` |
| DS-specific | as needed | NaN handling, shape checks, approx float equality |

**Total: 4–7 tests per function** (configurable by asking "more tests" or "add edge cases").

---

## Smart type detection

| Your function uses… | Tests use… |
|---|---|
| `float` return values | `pytest.approx(value, abs=1e-6)` |
| `np.array` | `np.testing.assert_array_equal` / `assert_allclose` |
| `pd.DataFrame` | `pd.testing.assert_frame_equal` |
| `.fit` / `.predict` (sklearn) | Score-based assertions with reproducible fixtures |
| `raise SomeError` | `with pytest.raises(SomeError):` |

---

## Examples

### Text processing

```
/unittest #3   ← cell contains clean_text(text) function
```

Generates:
```python
def test_clean_text_lowercases():
    assert clean_text("HELLO WORLD") == "hello world"

def test_clean_text_strips_punctuation():
    assert clean_text("hello!!!") == "hello"

def test_clean_text_collapses_whitespace():
    assert clean_text("  too   many  spaces  ") == "too many spaces"

def test_clean_text_empty_string():
    assert clean_text("") == ""
```

### Embedding / similarity

```
/unittest #7   ← cell contains compute_similarity(v1, v2)
```

Generates:
```python
def test_compute_similarity_identical():
    v = np.array([1.0, 2.0, 3.0])
    assert compute_similarity(v, v) == pytest.approx(1.0, abs=1e-6)

def test_compute_similarity_orthogonal():
    assert compute_similarity(np.array([1,0,0]), np.array([0,1,0])) == pytest.approx(0.0)

def test_compute_similarity_zero_vector():
    with pytest.raises(ZeroDivisionError):
        compute_similarity(np.array([1,2,3]), np.array([0,0,0]))
```

### DataFrame transformation

```
/unittest           ← active cell contains filter_by_score(df, threshold)
```

Generates:
```python
def test_filter_by_score_keeps_above_threshold():
    df = pd.DataFrame({"score": [0.1, 0.5, 0.9]})
    result = filter_by_score(df, threshold=0.4)
    assert len(result) == 2

def test_filter_by_score_empty_dataframe():
    result = filter_by_score(pd.DataFrame(columns=["score"]), threshold=0.5)
    assert result.empty
```

---

## Running the tests

The generated cell ends with a comment showing how to run:

```bash
# In terminal:
pytest test_notebook.py -v

# Or convert notebook to script first:
jupyter nbconvert --to script notebook.ipynb
pytest test_notebook.py
```

Or simply **run the test cell in JupyterLab** — pytest will execute inline and print results.

---

## Tips

- **Multiple functions in one cell?** — The skill generates tests for all of them in one block.
- **Want more edge cases?** — Follow up: *"add more edge cases to those tests"*
- **Want a separate test file?** — Ask: *"write these tests as a test_notebook.py file"*
- **Already have partial tests?** — Ask: *"add missing edge cases to my existing tests in #8"*

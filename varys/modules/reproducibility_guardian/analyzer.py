"""Orchestrates all reproducibility rules and returns a consolidated issue list."""
from __future__ import annotations

from typing import List

from .rules import (
    Issue,
    check_train_test_split,
    check_sklearn_estimators,
    check_cuda_no_fallback,
    check_hardcoded_path,
    check_execution_order,
    check_numpy_seed,
    check_python_random_seed,
    check_undefined_before_definition,
)


# Per-cell rules: (func, needs_full_cells)
_CELL_RULES = [
    check_train_test_split,
    check_sklearn_estimators,
    check_cuda_no_fallback,
    check_hardcoded_path,
]

# Notebook-level rules (receive the full cells list)
_NOTEBOOK_RULES = [
    check_execution_order,
    check_numpy_seed,
    check_python_random_seed,
    check_undefined_before_definition,
]


def analyze_notebook(cells: List[dict]) -> List[Issue]:
    """
    Run all rules against *cells* and return a deduplicated list of Issues.

    *cells* is the same structure the frontend sends for chat tasks:
        [{index, type, source, executionCount, output, imageOutput}, ...]
    """
    issues: List[Issue] = []

    # Per-cell rules
    for cell in cells:
        for rule_fn in _CELL_RULES:
            found = rule_fn(cell, cells)
            issues.extend(found)

    # Notebook-level rules
    for rule_fn in _NOTEBOOK_RULES:
        found = rule_fn(cells)
        issues.extend(found)

    # Deduplicate: keep the first occurrence of each (rule_id, cell_index) pair
    seen: set = set()
    unique: List[Issue] = []
    for issue in issues:
        key = (issue.rule_id, issue.cell_index)
        if key not in seen:
            seen.add(key)
            unique.append(issue)

    # Sort: critical first, then warning, then info; within severity by cell index
    _ORDER = {'critical': 0, 'warning': 1, 'info': 2}
    unique.sort(key=lambda i: (_ORDER.get(i.severity, 3), i.cell_index))

    return unique

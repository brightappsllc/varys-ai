"""Structural assertions over a notebook .ipynb JSON file.

These run BEFORE the kernel-execution layer because they are cheap and
deterministic. All assertions read cell `source` directly via regex — never
the SummaryStore, which may not have caught up yet.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, List, Optional


# ----------------------------------------------------------------------
# notebook loading
# ----------------------------------------------------------------------
def load_cells(path: str) -> List[dict]:
    with open(path, "r", encoding="utf-8") as f:
        nb = json.load(f)
    return nb.get("cells", [])


def cell_source(cell: dict) -> str:
    src = cell.get("source", "")
    if isinstance(src, list):
        return "".join(src)
    return src


# ----------------------------------------------------------------------
# assertion result
# ----------------------------------------------------------------------
@dataclass
class StructuralResult:
    passed: bool
    failures: List[str] = field(default_factory=list)
    checked: List[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "passed": self.passed,
            "failures": self.failures,
            "checked": self.checked,
        }


# ----------------------------------------------------------------------
# individual assertions — each returns (ok, label)
# ----------------------------------------------------------------------
Assertion = Callable[[List[dict]], "tuple[bool, str]"]


def cell_count_between(min_n: int, max_n: int) -> Assertion:
    def _check(cells: List[dict]) -> "tuple[bool, str]":
        n = len(cells)
        ok = min_n <= n <= max_n
        return ok, f"cell_count in [{min_n},{max_n}] (got {n})"
    return _check


def symbol_present(symbol: str) -> Assertion:
    pat = re.compile(rf"\b{re.escape(symbol)}\b")

    def _check(cells: List[dict]) -> "tuple[bool, str]":
        for c in cells:
            if pat.search(cell_source(c)):
                return True, f"symbol '{symbol}' present"
        return False, f"symbol '{symbol}' missing"
    return _check


def symbol_absent(symbol: str) -> Assertion:
    pat = re.compile(rf"\b{re.escape(symbol)}\b")

    def _check(cells: List[dict]) -> "tuple[bool, str]":
        for c in cells:
            if pat.search(cell_source(c)):
                return False, f"symbol '{symbol}' should be absent but is present"
        return True, f"symbol '{symbol}' absent"
    return _check


def symbols_in_order(symbols: List[str]) -> Assertion:
    """Anchor symbols must appear in the given relative order across cells.

    Each symbol's first occurrence index (cell index) must be strictly
    monotonically increasing.
    """
    def _check(cells: List[dict]) -> "tuple[bool, str]":
        first_idx: List[int] = []
        for sym in symbols:
            pat = re.compile(rf"\b{re.escape(sym)}\b")
            found = -1
            for i, c in enumerate(cells):
                if pat.search(cell_source(c)):
                    found = i
                    break
            if found < 0:
                return False, f"order check: '{sym}' not found"
            first_idx.append(found)
        ok = all(first_idx[i] < first_idx[i + 1] for i in range(len(first_idx) - 1))
        return ok, f"order {symbols} → indices {first_idx}"
    return _check


def markdown_header_present(header_text: str) -> Assertion:
    needle = header_text.strip().lower()

    def _check(cells: List[dict]) -> "tuple[bool, str]":
        for c in cells:
            if c.get("cell_type") != "markdown":
                continue
            if needle in cell_source(c).lower():
                return True, f"markdown header '{header_text}' present"
        return False, f"markdown header '{header_text}' missing"
    return _check


def cell_defining_symbol_nonempty(symbol: str) -> Assertion:
    """Guard against silent data deletion: a cell defining `symbol = ...`
    must exist and be non-trivial (>= 5 chars beyond the assignment)."""
    pat = re.compile(rf"^\s*{re.escape(symbol)}\s*=", re.MULTILINE)

    def _check(cells: List[dict]) -> "tuple[bool, str]":
        for c in cells:
            src = cell_source(c)
            m = pat.search(src)
            if m:
                rhs = src[m.end():].strip()
                if len(rhs) >= 5:
                    return True, f"definition of '{symbol}' present and non-empty"
                return False, f"definition of '{symbol}' is empty/trivial"
        return False, f"no definition of '{symbol}' found"
    return _check


# ----------------------------------------------------------------------
# runner
# ----------------------------------------------------------------------
def run_assertions(notebook_path: str, assertions: List[Assertion]) -> StructuralResult:
    cells = load_cells(notebook_path)
    failures: List[str] = []
    checked: List[str] = []
    for fn in assertions:
        try:
            ok, label = fn(cells)
        except Exception as e:  # noqa: BLE001
            ok, label = False, f"assertion crashed: {e}"
        checked.append(label)
        if not ok:
            failures.append(label)
    return StructuralResult(passed=len(failures) == 0, failures=failures, checked=checked)

"""Task dataclass + tier definitions for the Varys curriculum.

The dataclass is intentionally Layer-1-friendly: nothing here couples to
Playwright. A future backend-only test layer can consume the same Task
objects directly.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable, List, Optional

from varys_tests.harness.notebook_state import (
    cell_count_between,
    cell_defining_symbol_nonempty,
    markdown_header_present,
    symbol_absent,
    symbol_present,
    symbols_in_order,
)


@dataclass
class Task:
    id: str
    tier: int
    prompt: str
    fixture: str
    timeout_s: int
    structural_assertions: List[Callable] = field(default_factory=list)
    run_execution_assert: bool = False
    run_judge_assert: bool = True
    on_pass: List[str] = field(default_factory=list)
    on_fail: List[str] = field(default_factory=list)
    # Optional 1-indexed cell to focus before submitting the prompt (matches
    # the Varys UI cell badges `#1`, `#2`, ...). The dag runner subtracts 1
    # before passing to JupyterLab's 0-indexed activeCellIndex.
    target_cell: Optional[int] = None


# ----------------------------------------------------------------------
# Tier 1 — single cell, atomic
# ----------------------------------------------------------------------
# Generous timeouts. The LLM can do long thinking on complex prompts; the
# total budget here is "wall time from Send to Stop", not "no progress" — a
# slow but progressing stream is fine. Tighten only if false-positives appear.
T1_TIMEOUT = 180
T2_TIMEOUT = 300
T3_TIMEOUT = 600
T4_TIMEOUT = 900

SIMPLE = "simple_rename.ipynb"
MESSY = "messy_sales_analysis.ipynb"


TIER_1: List[Task] = [
    Task(
        id="t1_rename_var",
        tier=1,
        prompt="Rename `df_north` to `df_region_north` in the data generation cell",
        fixture=SIMPLE,
        timeout_s=T1_TIMEOUT,
        structural_assertions=[
            cell_count_between(4, 8),
            symbol_present("df_region_north"),
            symbol_absent("df_north"),
            cell_defining_symbol_nonempty("df_region_north"),
        ],
        run_execution_assert=False,
    ),
    Task(
        id="t1_fix_syntax",
        tier=1,
        prompt="There is a syntax error in cell 3. Fix it.",
        fixture=SIMPLE,
        timeout_s=T1_TIMEOUT,
        structural_assertions=[cell_count_between(4, 8)],
        run_execution_assert=True,  # the only correctness signal here
    ),
    Task(
        id="t1_add_markdown",
        tier=1,
        prompt="Add a markdown cell above the Section 1 header that says 'North Region Analysis'",
        fixture=SIMPLE,
        timeout_s=T1_TIMEOUT,
        structural_assertions=[
            cell_count_between(5, 9),
            markdown_header_present("North Region Analysis"),
            symbols_in_order(["North Region Analysis", "Section 1"]),
        ],
    ),
]


# ----------------------------------------------------------------------
# Tier 2 — multi-cell, no restructuring
# ----------------------------------------------------------------------
TIER_2: List[Task] = [
    Task(
        id="t2_reorder_cells",
        tier=2,
        prompt="Move the rolling average cell above the metrics cell in the North section",
        fixture=MESSY,
        timeout_s=T2_TIMEOUT,
        structural_assertions=[
            cell_count_between(15, 60),
            symbol_present("rolling"),
            symbol_present("metrics"),
        ],
    ),
    Task(
        id="t2_add_prints",
        tier=2,
        prompt="Add a print statement at the top of each of the three metrics cells showing the region name",
        fixture=MESSY,
        timeout_s=T2_TIMEOUT,
        structural_assertions=[
            cell_count_between(15, 60),
            symbol_present("print"),
        ],
        run_execution_assert=True,
    ),
    Task(
        id="t2_delete_comment",
        tier=2,
        prompt="Delete the redundant comment-only cell in the South section",
        fixture=MESSY,
        timeout_s=T2_TIMEOUT,
        structural_assertions=[cell_count_between(14, 60)],
    ),
]


# ----------------------------------------------------------------------
# Tier 3 — refactoring
# ----------------------------------------------------------------------
TIER_3: List[Task] = [
    Task(
        id="t3_functionalize_metrics",
        tier=3,
        prompt=(
            "The metrics computation block is duplicated across North, South, and West "
            "sections. Functionalize it into a `compute_metrics(df)` function defined "
            "once at the top, and call it for each region."
        ),
        fixture=MESSY,
        timeout_s=T3_TIMEOUT,
        structural_assertions=[
            cell_count_between(15, 60),
            symbol_present("compute_metrics"),
            symbol_present("def compute_metrics"),
        ],
        run_execution_assert=True,
    ),
    Task(
        id="t3_functionalize_monthly",
        tier=3,
        prompt=(
            "The monthly aggregation block is duplicated across all three sections. "
            "Functionalize it into `monthly_agg(df)` and replace all three copies with calls."
        ),
        fixture=MESSY,
        timeout_s=T3_TIMEOUT,
        structural_assertions=[
            cell_count_between(15, 60),
            symbol_present("monthly_agg"),
            symbol_present("def monthly_agg"),
        ],
        run_execution_assert=True,
    ),
    Task(
        id="t3_consolidate_plots",
        tier=3,
        prompt="Consolidate the three revenue trend plot cells into a single cell that loops over all regions.",
        fixture=MESSY,
        timeout_s=T3_TIMEOUT,
        structural_assertions=[
            cell_count_between(13, 60),
            symbol_present("for"),
        ],
        run_execution_assert=True,
    ),
]


# ----------------------------------------------------------------------
# Tier 4 — compound
# ----------------------------------------------------------------------
T4_PROMPT = (
    "Functionalize all duplicated blocks across the three region sections, "
    "consolidate them into a loop over regions, fix the summary cell's "
    "hardcoded scalar references, and reorder each section into a canonical "
    "order: stats → metrics → rolling → trend plot → monthly agg → bar chart → histogram."
)

TIER_4: List[Task] = [
    Task(
        id="t4_full_refactor",
        tier=4,
        prompt=T4_PROMPT,
        fixture=MESSY,
        timeout_s=T4_TIMEOUT,
        structural_assertions=[
            cell_count_between(10, 60),
            symbol_present("compute_metrics"),
            symbol_present("monthly_agg"),
        ],
        run_execution_assert=False,
    ),
    Task(
        id="t4_refactor_and_run",
        tier=4,
        prompt=T4_PROMPT,
        fixture=MESSY,
        timeout_s=T4_TIMEOUT,
        structural_assertions=[
            cell_count_between(10, 60),
            symbol_present("compute_metrics"),
            symbol_present("monthly_agg"),
        ],
        run_execution_assert=True,  # mandatory for this variant
    ),
]


ALL_TASKS: List[Task] = TIER_1 + TIER_2 + TIER_3 + TIER_4


def task_by_id(tid: str) -> Task:
    for t in ALL_TASKS:
        if t.id == tid:
            return t
    raise KeyError(tid)

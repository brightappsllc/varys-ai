"""Kernel-native relevance scorer for the no-focal-cell path.

Used to rank cells by importance when there is no explicit focal cell.

STATUS: Complete but DORMANT — cells are ranked but no hard budget cap is
applied yet.  When the budget-policy spec arrives, pruning is a one-liner:
  ranked = score_cells(...)
  keep   = ranked[:budget]          # prune to budget

Signal weights (spec §4):
  HIGH   (10) — @var hit: 10 × (matched / total_defined) — proportional
                to specificity; a 1-symbol cell that matches scores 10,
                an 8-symbol cell with 1 match scores 1.25
  HIGH   ( 8) — cell executed most recently (highest execution_count)
  HIGH   ( 8) — cell produced an error on last run
  MEDIUM ( 4) — symbol defined here consumed by N downstream cells (×N)
  LOW    ( 1) — import cell (low information content for query relevance)
  PENALTY(-2) — symbol no longer alive in kernel (×dead_count)

Normalization — min-max over theoretical bounds:
  SCORE_MAX =  W_AT_REF + W_RECENT_EXEC + W_HAS_ERROR
             + W_FAN_OUT × _FAN_OUT_CAP + W_IMPORT       = +67
  SCORE_MIN =  W_DEAD_SYMBOL × _DEAD_SYM_CAP             = −20
  SCORE_RANGE = 67 − (−20)                               =  87

  normalized = clip(score + 20, 0, 87) / 87  ∈ [0, 1]

  Fan-out and dead-symbol terms are unbounded in theory; scores that
  exceed the caps are clipped to [0, 1] rather than rejected.
  Both ``_score`` (normalised, for pruning) and ``_raw_score`` (float,
  for debugging) are attached to every cell dict.
"""
from __future__ import annotations

import re
from typing import Any, Dict, List, Optional

# ── Weight constants ───────────────────────────────────────────────────────────

W_AT_REF      = 10
W_RECENT_EXEC =  8
W_HAS_ERROR   =  8
W_FAN_OUT     =  4  # per downstream consumer cell
W_IMPORT      =  1
W_DEAD_SYMBOL = -2  # per dead symbol

# ── Normalisation constants ────────────────────────────────────────────────────

# Caps for the two unbounded terms (fan-out, dead symbols).
# Scores beyond these caps are clipped rather than rejected.
_FAN_OUT_CAP  = 10   # max downstream cells credited
_DEAD_SYM_CAP = 10   # max dead symbols penalised

SCORE_MAX   = (W_AT_REF + W_RECENT_EXEC + W_HAS_ERROR
               + W_FAN_OUT * _FAN_OUT_CAP + W_IMPORT)   # = 67
SCORE_MIN   = W_DEAD_SYMBOL * _DEAD_SYM_CAP             # = -20
SCORE_RANGE = SCORE_MAX - SCORE_MIN                      # = 87


def _normalize(raw: float) -> float:
    """Map a raw score to [0, 1] via min-max normalisation.

    Clips out-of-range values so that unusual notebooks (very high fan-out,
    many dead symbols) never produce scores outside [0, 1].
    """
    return max(0.0, min(1.0, (raw - SCORE_MIN) / SCORE_RANGE))


# ── Public API ─────────────────────────────────────────────────────────────────


def score_cells(
    cell_order: List[Dict[str, Any]],
    summaries: Dict[str, Dict[str, Any]],
    user_query: str,
    kernel_live_names: Optional[List[str]] = None,
) -> List[Dict[str, Any]]:
    """Score and rank active cells by relevance to user_query.

    Args:
        cell_order:        Ordered list of cell dicts (keys: cell_id, index, source).
        summaries:         {cell_id: summary} from SummaryStore.get_all_current().
        user_query:        Raw user message text.
        kernel_live_names: Variable names currently alive in the kernel.
                           Pass None to skip the dead-symbol penalty.

    Returns:
        The same cell_order list, each element augmented with:
          ``_score``          — normalised relevance in [0, 1] (used for pruning)
          ``_raw_score``      — un-normalised float (useful for debugging)
          ``_score_breakdown`` — dict with individual feature contributions:
                                  at_ref, recency, error, fan_out, import, dead,
                                  raw (= _raw_score), normalized (= _score)
        Sorted descending by ``_score``.  Cells without a summary entry
        score 0 raw → 0.23 normalised (SCORE_MIN shift moves 0 upward).

    Note:
        Cells always appear in notebook order in the rendered prompt.
        This ranking drives pruning decisions only.
    """
    at_refs = _parse_at_refs(user_query)
    fan_out = _compute_fan_out(cell_order, summaries)

    # Max execution count for proportional recency scoring
    max_ec = max(
        (s.get("execution_count") or 0 for s in summaries.values()),
        default=1,
    ) or 1  # avoid division-by-zero

    live_set = set(kernel_live_names) if kernel_live_names is not None else None
    scored: List[Dict[str, Any]] = []

    for cell in cell_order:
        cell_id = cell.get("cell_id", "")
        summary = summaries.get(cell_id)

        # Per-cell feature contributions — populated below
        bd: Dict[str, float] = {
            "at_ref":  0.0,
            "recency": 0.0,
            "error":   0.0,
            "fan_out": 0.0,
            "import":  0.0,
            "dead":    0.0,
        }

        if summary:
            defined = set(summary.get("symbols_defined", []))
            ec      = summary.get("execution_count") or 0

            # @variable reference — proportional to specificity
            matched = at_refs & defined
            if matched and defined:
                bd["at_ref"] = W_AT_REF * len(matched) / len(defined)

            # Recency: proportional 0 → W_RECENT_EXEC
            bd["recency"] = int(W_RECENT_EXEC * ec / max_ec)

            # Error bonus
            if summary.get("had_error"):
                bd["error"] = W_HAS_ERROR

            # Fan-out bonus (how many downstream cells consume this cell's symbols)
            bd["fan_out"] = W_FAN_OUT * fan_out.get(cell_id, 0)

            # Import cell: low signal
            if summary.get("is_import_cell"):
                bd["import"] = W_IMPORT

            # Dead symbol penalty (only when kernel_live_names is supplied)
            if live_set is not None:
                dead_count = sum(1 for n in defined if n not in live_set)
                bd["dead"] = W_DEAD_SYMBOL * dead_count

        raw = sum(bd.values())
        norm = _normalize(raw)
        bd["raw"]        = raw
        bd["normalized"] = norm

        scored.append({**cell, "_raw_score": raw, "_score": norm, "_score_breakdown": bd})

    # Stable sort descending (notebook order preserved for equal scores)
    scored.sort(key=lambda c: c["_score"], reverse=True)
    return scored


# ── Helpers ────────────────────────────────────────────────────────────────────


def _parse_at_refs(query: str) -> set:
    """Return the set of variable names referenced as @name in the query."""
    return set(re.findall(r"@([A-Za-z_]\w*)", query))


def _compute_fan_out(
    cell_order: List[Dict[str, Any]],
    summaries: Dict[str, Dict[str, Any]],
) -> Dict[str, int]:
    """Count how many downstream cells consume each cell's defined symbols.

    Returns {cell_id: downstream_consumer_count}.
    """
    # Most recent definition wins for each symbol
    last_definition: Dict[str, str] = {}
    fan_out: Dict[str, int] = {}

    for cell in cell_order:
        cell_id  = cell.get("cell_id", "")
        summary  = summaries.get(cell_id, {})
        consumed = set(summary.get("symbols_consumed", []))
        defined  = set(summary.get("symbols_defined", []))

        # Credit the cell that last defined each consumed symbol
        for sym in consumed:
            defining = last_definition.get(sym)
            if defining:
                fan_out[defining] = fan_out.get(defining, 0) + 1

        # Update last_definition for symbols defined here
        for sym in defined:
            last_definition[sym] = cell_id

    return fan_out

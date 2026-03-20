"""Persistent scorer log — writes per-query cell rankings to .jupyter-assistant.

Log location (relative to the notebook's .jupyter-assistant folder):

    <nb_base>/logs/scorer/YYYY-MM-DD.jsonl

Each line is a JSON record for one ``score_cells()`` invocation:

    {
      "ts":        "2026-03-03T12:00:00.123456+00:00",
      "query":     "how do I normalise the data?",
      "threshold": 0.3,
      "kept_count":      3,
      "dismissed_count": 2,
      "floor_triggered": false,
      "cells": [
        {
          "cell_idx":        6,       // 1-based notebook position
          "cell_id":         "abc123",
          "relevance_score": 0.85,    // normalised [0, 1]
          "feature_scores": {
            "at_ref":    0.0,
            "recency":   8.0,
            "error":     0.0,
            "fan_out":   4.0,
            "import":    0.0,
            "dead":      0.0,
            "raw":       12.0,
            "normalized": 0.85
          },
          "kept":           true,
          "floor_override": false
        },
        ...
      ]
    }

Design notes
------------
- **Always-on**: unlike ``debug_logger``, this log is written unconditionally
  whenever the scorer runs and a ``nb_base`` path is provided.  No environment
  variable gate is needed — the file lives with the notebook so the user can
  inspect it directly.
- **Thread-safe**: a per-directory ``threading.Lock`` serialises appends within
  the same process.  Concurrent Jupyter kernels targeting different notebooks
  write to different files so there is no cross-notebook contention.
- **Non-fatal**: every I/O error is caught and logged at WARNING level; the
  scorer (and the LLM response) are never interrupted.
- **Rotation**: one file per calendar day (UTC), so log files stay small and
  are trivial to archive or delete.
"""
from __future__ import annotations

import json
import logging
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

_log = logging.getLogger(__name__)

# Per-directory write locks so concurrent threads targeting the same notebook
# don't interleave partial JSON lines.
_locks: Dict[str, threading.Lock] = {}
_locks_guard = threading.Lock()

_SUBDIR = Path("logs") / "scorer"


def _get_lock(directory: Path) -> threading.Lock:
    key = str(directory)
    with _locks_guard:
        if key not in _locks:
            _locks[key] = threading.Lock()
        return _locks[key]


# ── Public API ─────────────────────────────────────────────────────────────────


def write_scorer_log(
    nb_base: Path,
    query: str,
    ranked_cells: List[Dict[str, Any]],
    kept_ids: set,
    threshold: float,
    floor_triggered: bool,
    cutoff_cell_idx: Optional[int] = None,
) -> None:
    """Append one scoring event to the notebook's scorer log.

    Args:
        nb_base:          Path to the ``.jupyter-assistant`` directory for the
                          notebook (returned by ``utils.paths.nb_base()``).
        query:            Raw user query string.
        ranked_cells:     Output of ``score_cells()`` — cells sorted descending
                          by ``_score``, each augmented with ``_score``,
                          ``_raw_score``, and ``_score_breakdown``.
        kept_ids:         Set of ``cell_id`` values that survived pruning
                          (including floor-override promotions).
        threshold:        The ``SCORER_MIN_SCORE_THRESHOLD`` value used.
        floor_triggered:  Whether the floor-override path was activated.
        cutoff_cell_idx:  1-based index of the active cell (the positional
                          boundary beyond which cells were excluded from scoring).
                          ``None`` when no active cell is known (full notebook scored).

    The log file is created (along with any missing parent directories) on the
    first write of each calendar day.  All errors are swallowed so that a
    read-only filesystem or permission problem never interrupts the user.
    """
    try:
        log_dir = nb_base / _SUBDIR
        lock    = _get_lock(log_dir)

        now    = datetime.now(timezone.utc)
        record = _build_record(query, ranked_cells, kept_ids, threshold,
                               floor_triggered, now, cutoff_cell_idx)

        with lock:
            log_dir.mkdir(parents=True, exist_ok=True)
            day_file = log_dir / f"{now.strftime('%Y-%m-%d')}.jsonl"
            with day_file.open("a", encoding="utf-8") as fh:
                fh.write(json.dumps(record, default=str) + "\n")

    except Exception as exc:
        _log.warning("scorer_log: could not write log — %s", exc)


# ── Internal helpers ───────────────────────────────────────────────────────────


def _build_record(
    query: str,
    ranked_cells: List[Dict[str, Any]],
    kept_ids: set,
    threshold: float,
    floor_triggered: bool,
    ts: datetime,
    cutoff_cell_idx: Optional[int],
) -> Dict[str, Any]:
    """Assemble the JSONL record dict from scorer outputs.

    Cells are emitted in **notebook order** (ascending ``cell_idx``) so the
    log reads like the notebook top-to-bottom rather than by relevance rank.
    A ``cells_in_prompt`` top-level list gives the quick answer to "what did
    the LLM actually see?" without scanning every cell entry.
    """
    cell_entries: List[Dict[str, Any]] = []
    kept_count      = 0
    dismissed_count = 0

    for cell in ranked_cells:
        cell_id  = cell.get("cell_id", "")
        is_kept  = cell_id in kept_ids
        bd       = cell.get("_score_breakdown", {})

        # cell_idx is stored 0-based in cell dicts; expose 1-based for humans.
        raw_idx  = cell.get("index")
        cell_idx = (raw_idx + 1) if isinstance(raw_idx, int) else None

        cell_entries.append({
            "cell_idx":        cell_idx,
            "cell_id":         cell_id,
            "in_prompt":       is_kept,
            "floor_override":  cell.get("_floor_override", False),
            "relevance_score": round(cell.get("_score", 0.0), 6),
            "feature_scores": {
                "at_ref":     round(bd.get("at_ref",    0.0), 4),
                "recency":    round(bd.get("recency",   0.0), 4),
                "error":      round(bd.get("error",     0.0), 4),
                "fan_out":    round(bd.get("fan_out",   0.0), 4),
                "import":     round(bd.get("import",    0.0), 4),
                "dead":       round(bd.get("dead",      0.0), 4),
                "raw":        round(bd.get("raw",       0.0), 4),
                "normalized": round(bd.get("normalized", 0.0), 6),
            },
        })

        if is_kept:
            kept_count += 1
        else:
            dismissed_count += 1

    # Sort by notebook position for human readability
    cell_entries.sort(key=lambda e: e["cell_idx"] if e["cell_idx"] is not None else 0)

    # Quick summary: which cell positions are actually sent to the LLM
    cells_in_prompt = [e["cell_idx"] for e in cell_entries if e["in_prompt"]]

    return {
        "ts":              ts.isoformat(),
        "query":           query,
        "cutoff_cell_idx": cutoff_cell_idx,   # active-cell boundary (1-based), None = full notebook
        "threshold":       threshold,
        "total_cells":     len(cell_entries),
        "kept_count":      kept_count,
        "dismissed_count": dismissed_count,
        "floor_triggered": floor_triggered,
        "cells_in_prompt": cells_in_prompt,   # quick answer: cell positions sent to LLM
        "cells":           cell_entries,      # full per-cell detail in notebook order
    }

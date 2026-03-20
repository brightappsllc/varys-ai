"""Notebook-local structured event logger for Varys feature instrumentation.

All logs are written to the ``.jupyter-assistant`` directory that is
**co-located with the notebook** — the same folder that holds chats, memory,
RAG files and skills.  No global log directory or environment variable is
required.

Log location
------------
  <nb_base>/logs/<feature>/YYYY-MM-DD.jsonl

  e.g.  experiments/.jupyter-assistant/logs/assembler/2026-03-03.jsonl
        experiments/.jupyter-assistant/logs/inference/2026-03-03.jsonl

Each line is one JSON record::

    {
      "ts":      "2026-03-03T12:00:00.123456+00:00",
      "feature": "assembler",
      "event":   "context_built",
      ... <event-specific payload keys> ...
    }

Usage
-----
    from varys.debug_logger import log

    log("assembler", "context_built", {"cells_before": 8, "cells_after": 3},
        nb_base=path_to_dot_jupyter_assistant)

Design
------
- **Always-on**: writing is unconditional when ``nb_base`` is supplied.  No
  ``DEBUG_LOG`` env-var gate is needed — logs live with the notebook so the
  user can inspect or delete them freely.
- **Silent no-op**: when ``nb_base`` is ``None`` the call returns immediately
  with zero I/O.  This preserves backward compatibility for call sites that
  don't yet have notebook context (e.g. startup code).
- **Thread-safe**: a per-directory ``threading.Lock`` serialises appends
  within the same process.  Concurrent kernels targeting different notebooks
  write to different files so there is no cross-notebook contention.
- **Non-fatal**: every I/O error is caught and emitted at WARNING level; the
  caller's execution path is never interrupted.
- **Rotation**: one file per calendar day (UTC).
"""
from __future__ import annotations

import json
import logging
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Optional

_log = logging.getLogger(__name__)

# Per-directory write locks (keyed by absolute directory path string).
_locks: Dict[str, threading.Lock] = {}
_locks_guard = threading.Lock()


def _get_lock(directory: Path) -> threading.Lock:
    key = str(directory)
    with _locks_guard:
        if key not in _locks:
            _locks[key] = threading.Lock()
        return _locks[key]


# ── Public API ─────────────────────────────────────────────────────────────────


def log(
    feature: str,
    event: str,
    payload: Dict[str, Any],
    nb_base: Optional[Path] = None,
) -> None:
    """Write one structured log record to the notebook's .jupyter-assistant folder.

    Args:
        feature:  Logical subsystem name (e.g. ``"assembler"``, ``"inference"``).
                  Determines the output subdirectory:
                  ``<nb_base>/logs/<feature>/YYYY-MM-DD.jsonl``.
        event:    Short event identifier (e.g. ``"context_built"``).
        payload:  Arbitrary JSON-serialisable dict with event-specific data.
                  Non-serialisable values are coerced to strings.
        nb_base:  Path to the notebook's ``.jupyter-assistant`` directory
                  (from ``utils.paths.nb_base()``).  Pass ``None`` to skip
                  logging (silent no-op).
    """
    if nb_base is None:
        return

    try:
        log_dir = nb_base / "logs" / feature
        lock    = _get_lock(log_dir)
        now     = datetime.now(timezone.utc)

        record: Dict[str, Any] = {
            "ts":      now.isoformat(),
            "feature": feature,
            "event":   event,
            **payload,
        }

        with lock:
            log_dir.mkdir(parents=True, exist_ok=True)
            day_file = log_dir / f"{now.strftime('%Y-%m-%d')}.jsonl"
            with day_file.open("a", encoding="utf-8") as fh:
                fh.write(json.dumps(record, default=str) + "\n")

    except Exception as exc:
        _log.warning("debug_logger: could not write log record — %s", exc)

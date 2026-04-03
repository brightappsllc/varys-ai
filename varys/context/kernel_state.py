"""kernel_state.py — live kernel variable state, separate from SummaryStore.

Tracks the *current* value of every variable in the kernel namespace, updated
after each cell execution.  Unlike the SummaryStore (which records per-cell
version history), this file always reflects the most recent known state of
every live variable.

Storage path:
  <nb_base>/context/kernel_state.json

Schema:
  {
    "kernel_id": "abc-123-def-456",
    "variables": {
      "df": {
        "type":             "DataFrame(891, 12)",
        "last_updated_by":  "<cell-uuid>",
        "execution_count":  5,
        "symbol_meta":      {"columns": {...}}
      },
      ...
    }
  }

Invalidation:
  If the incoming kernel_id differs from the stored one, the variables dict
  is wiped.  This detects kernel restarts so stale shapes are never shown.
"""
from __future__ import annotations

import json
import logging
import os
import tempfile
from pathlib import Path
from typing import Any, Dict, Optional

from ..utils.paths import nb_base

log = logging.getLogger(__name__)


def _atomic_write(path: Path, content: str) -> None:
    parent = path.parent
    fd, tmp = tempfile.mkstemp(dir=parent, prefix=".tmp_varys_", suffix=".json")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(content)
        os.replace(tmp, path)
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


class KernelState:
    """Manages kernel_state.json for one notebook."""

    def __init__(self, root_dir: str, notebook_path: str = "") -> None:
        self._path = self._resolve_path(root_dir, notebook_path)

    # ── Path resolution ────────────────────────────────────────────────────────

    @staticmethod
    def _resolve_path(root_dir: str, notebook_path: str) -> Path:
        base = nb_base(root_dir, notebook_path)
        ctx_dir = base / "context"
        ctx_dir.mkdir(parents=True, exist_ok=True)
        return ctx_dir / "kernel_state.json"

    # ── I/O ───────────────────────────────────────────────────────────────────

    def _load(self) -> Dict[str, Any]:
        if not self._path.exists():
            return {"kernel_id": None, "variables": {}}
        try:
            return json.loads(self._path.read_text(encoding="utf-8"))
        except Exception as exc:
            log.warning("KernelState: could not read %s — %s", self._path, exc)
            return {"kernel_id": None, "variables": {}}

    def _save(self, data: Dict[str, Any]) -> None:
        try:
            _atomic_write(self._path, json.dumps(data, indent=2, ensure_ascii=False))
        except Exception as exc:
            log.warning("KernelState: could not save %s — %s", self._path, exc)

    # ── Public API ─────────────────────────────────────────────────────────────

    def update(
        self,
        kernel_id:       str,
        cell_id:         str,
        execution_count: Optional[int],
        symbol_types:    Dict[str, str],
        symbol_values:   Dict[str, Any],
        symbol_meta:     Dict[str, Any],
    ) -> None:
        """Merge new variable state from a single cell execution.

        If *kernel_id* differs from the stored one (restart detected), the
        variables dict is wiped before applying the new entries.
        """
        data = self._load()

        if kernel_id and data.get("kernel_id") != kernel_id:
            # Kernel restarted — discard all previous state.
            log.debug(
                "KernelState: kernel_id changed (%s → %s), wiping state",
                data.get("kernel_id"), kernel_id,
            )
            data = {"kernel_id": kernel_id, "variables": {}}

        variables: Dict[str, Any] = data.get("variables") or {}

        for name, type_str in symbol_types.items():
            entry: Dict[str, Any] = {
                "type":            type_str,
                "last_updated_by": cell_id,
                "execution_count": execution_count,
            }
            meta = symbol_meta.get(name)
            if meta:
                entry["symbol_meta"] = meta
            # Scalar values
            if name in symbol_values:
                entry["value"] = symbol_values[name]
            variables[name] = entry

        data["variables"] = variables
        self._save(data)

    def get_all(self) -> Dict[str, Any]:
        """Return the full variables dict (empty dict on any error)."""
        return self._load().get("variables") or {}

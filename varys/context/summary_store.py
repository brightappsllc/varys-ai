"""Persistent, versioned cell summary store.

Storage path:
  <nb_base>/.jupyter-assistant/context/summary_store.json

JSON schema:
  {
    "_meta": {
      "versions_since_inference": 7,
      "last_inference_run": "2026-03-06T10:15:00"
    },
    "<cell_id>": [
      {
        "version":   1,
        "hash":      "<sha256[:16]>",
        "timestamp": "<ISO-8601>",
        "summary":   {
          "cell_type":        "code | markdown | raw",
          "tags":             ["important", "skip-execution"],
          "tags_updated_at":  "<ISO-8601 | null>",
          ...
        },
        "deleted":   false
      },
      ...
    ]
  }

Key invariants (from spec §2.1):
  - Keyed by stable JupyterLab cell UUID — never by position.
  - Entries are never deleted; a `deleted` flag is set instead (supports undo).
  - The active entry is always the LAST element: cell_id[-1].
  - A new version is appended only when sha256(cell.source) changes.
  - ``_meta`` is a reserved top-level key managed by this class.
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from ..utils.paths import nb_base

log = logging.getLogger(__name__)


def _atomic_write(path: Path, content: str) -> None:
    """Write *content* to *path* atomically via a sibling temp file + os.replace().

    Because os.replace() maps to rename(2) on POSIX the destination is always
    either the old file or the fully-written new file — never empty or partial.
    This prevents the 'Expecting value: line 1 column 1 (char 0)' / truncated-
    JSON errors that occur when the process is killed during a plain write_text().
    """
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


# Module-level mtime cache: absolute_path_str → (mtime, data_dict)
_STORE_CACHE: Dict[str, Tuple[float, Dict]] = {}

_INFERENCE_TRIGGER_N = 10   # default: fire inference every 10 new cell versions


class SummaryStore:
    """Manages .jupyter-assistant/context/summary_store.json for one notebook."""

    def __init__(self, root_dir: str, notebook_path: str = "") -> None:
        self.root_dir = root_dir
        self.notebook_path = notebook_path
        self._store_path: Path = self._resolve_path()

    # ── Path resolution ────────────────────────────────────────────────────

    def _resolve_path(self) -> Path:
        base = nb_base(self.root_dir, self.notebook_path)
        ctx_dir = base / "context"
        ctx_dir.mkdir(parents=True, exist_ok=True)
        return ctx_dir / "summary_store.json"

    # ── I/O with mtime cache ───────────────────────────────────────────────

    def _load(self) -> Dict[str, List[Dict]]:
        """Return the store dict, using a mtime-based in-process cache."""
        key = str(self._store_path)
        if self._store_path.exists():
            try:
                mtime = self._store_path.stat().st_mtime
                cached = _STORE_CACHE.get(key)
                if cached and cached[0] == mtime:
                    return cached[1]
                data: Dict = json.loads(
                    self._store_path.read_text(encoding="utf-8")
                )
                _STORE_CACHE[key] = (mtime, data)
                return data
            except Exception as exc:
                log.warning("SummaryStore: could not load %s — %s", self._store_path, exc)
        return {}

    def _save(self, data: Dict[str, List[Dict]]) -> None:
        try:
            _atomic_write(
                self._store_path,
                json.dumps(data, indent=2, ensure_ascii=False),
            )
            # Invalidate cache so the next _load() re-reads the file.
            _STORE_CACHE.pop(str(self._store_path), None)
        except Exception as exc:
            log.warning("SummaryStore: could not save %s — %s", self._store_path, exc)

    # ── Helpers ────────────────────────────────────────────────────────────

    @staticmethod
    def _hash(source: str) -> str:
        return hashlib.sha256(source.encode()).hexdigest()[:16]

    @staticmethod
    def _now() -> str:
        return datetime.now(timezone.utc).isoformat()

    # ── Public API (spec §2.6) ─────────────────────────────────────────────

    def get_summary(self, cell_id: str) -> Optional[Dict[str, Any]]:
        """Return the active summary for cell_id, or None if never seen."""
        versions = self._load().get(cell_id, [])
        if not versions:
            return None
        return versions[-1].get("summary")

    def get_all_current(self, include_deleted: bool = False) -> Dict[str, Dict]:
        """Return {cell_id: summary} for the latest version of all cells.

        Excludes deleted cells unless include_deleted=True.
        ``_meta`` is excluded from the result.
        """
        result: Dict[str, Dict] = {}
        for cell_id, versions in self._load().items():
            if cell_id == "_meta":
                continue
            if not isinstance(versions, list) or not versions:
                continue
            last = versions[-1]
            if not include_deleted and last.get("deleted", False):
                continue
            summary = last.get("summary")
            if summary is not None:
                result[cell_id] = summary
        return result

    @staticmethod
    def _cell_snippet(source: str) -> str:
        """Return a short human-readable label for a cell.

        Picks the first non-blank, non-comment line and trims it to 80 chars.
        Falls back to the raw first 80 chars when every line is blank/comment.
        """
        for line in source.splitlines():
            stripped = line.strip()
            if stripped and not stripped.startswith("#"):
                return stripped[:80]
        return source[:80].replace("\n", " ")

    def upsert(self, cell_id: str, source: str, summary: Dict[str, Any]) -> bool:
        """Append a new version entry if source hash differs from the latest.

        Increments ``_meta.versions_since_inference`` on every new version written.
        Returns True if a new version was written, False if it was a no-op.
        """
        new_hash = self._hash(source)
        data = self._load()
        versions: List[Dict] = data.get(cell_id, [])

        # Source unchanged — check whether runtime fields need a patch.
        # We never bump the version for runtime-only changes (execution_count,
        # symbol_types, symbol_values) but we do overwrite them in-place so
        # the store always reflects the most-recent kernel state.
        if versions and versions[-1].get("hash") == new_hash:
            stored_summary = versions[-1].get("summary") or {}
            needs_save = False

            # Backfill _cells if this cell was written before the index existed
            cells_index = data.get("_cells") if isinstance(data.get("_cells"), dict) else {}
            if cell_id not in cells_index:
                cells_index[cell_id] = self._cell_snippet(source)
                data["_cells"] = cells_index
                needs_save = True

            # Patch runtime fields when the incoming value is non-empty and
            # differs from what is stored.
            for field in ("execution_count", "symbol_types", "symbol_values", "symbol_meta", "execution_ms"):
                incoming = summary.get(field)
                # Skip None / empty-dict / empty-list — those carry no info
                if not incoming and incoming != 0:
                    continue
                if incoming != stored_summary.get(field):
                    stored_summary[field] = incoming
                    needs_save = True

            if needs_save:
                versions[-1]["summary"] = stored_summary
                data[cell_id] = versions
                self._save(data)
            return False

        entry: Dict[str, Any] = {
            "version":   len(versions) + 1,
            "hash":      new_hash,
            "timestamp": self._now(),
            "summary":   summary,
            "deleted":   False,
        }
        versions.append(entry)
        data[cell_id] = versions

        # Keep _cells index up-to-date for human inspection
        cells_index = data.get("_cells") if isinstance(data.get("_cells"), dict) else {}
        cells_index[cell_id] = self._cell_snippet(source)
        data["_cells"] = cells_index

        # Update inference counter in _meta
        meta = data.get("_meta") if isinstance(data.get("_meta"), dict) else {}
        meta["versions_since_inference"] = meta.get("versions_since_inference", 0) + 1
        meta.setdefault("last_inference_run", None)
        data["_meta"] = meta

        self._save(data)
        return True

    def should_run_inference(self, trigger_n: int = _INFERENCE_TRIGGER_N) -> bool:
        """Return True if the inference counter has reached *trigger_n*."""
        meta = self._load().get("_meta") or {}
        return isinstance(meta, dict) and meta.get("versions_since_inference", 0) >= trigger_n

    def reset_inference_counter(self) -> None:
        """Set ``_meta.versions_since_inference`` to 0 and record timestamp."""
        data = self._load()
        meta = data.get("_meta") if isinstance(data.get("_meta"), dict) else {}
        meta["versions_since_inference"] = 0
        meta["last_inference_run"] = self._now()
        data["_meta"] = meta
        self._save(data)

    def mark_deleted(self, cell_id: str) -> None:
        """Set deleted=True on the latest version entry."""
        data = self._load()
        versions = data.get(cell_id, [])
        if versions:
            versions[-1]["deleted"] = True
            # Prefix the _cells snippet so deleted cells are obvious on inspection
            cells_index = data.get("_cells") if isinstance(data.get("_cells"), dict) else {}
            if cell_id in cells_index and not cells_index[cell_id].startswith("~"):
                cells_index[cell_id] = "~" + cells_index[cell_id]
            data["_cells"] = cells_index
            self._save(data)

    def mark_restored(self, cell_id: str) -> None:
        """Clear deleted flag on the latest version entry."""
        data = self._load()
        versions = data.get(cell_id, [])
        if versions:
            versions[-1]["deleted"] = False
            # Remove the ~ prefix added by mark_deleted
            cells_index = data.get("_cells") if isinstance(data.get("_cells"), dict) else {}
            if cell_id in cells_index and cells_index[cell_id].startswith("~"):
                cells_index[cell_id] = cells_index[cell_id][1:]
            data["_cells"] = cells_index
            self._save(data)

    def patch_tags(self, cell_id: str, tags: List[str]) -> bool:
        """Update ``tags`` in the latest version's summary without creating a new version.

        Tags are cell metadata (``cell.metadata.tags`` in the notebook JSON) —
        they are independent of source content and must NOT trigger a version
        bump or change the source hash.  This method patches the ``summary``
        dict in-place on the current (last) version entry.

        Args:
            cell_id: Stable JupyterLab cell UUID.
            tags:    New complete list of tags for the cell.  Duplicates are
                     removed and the list is sorted for deterministic storage.
                     Pass ``[]`` to clear all tags.

        Returns:
            True  — tags were different from the stored value and the file was saved.
            False — tags were already identical (no-op, no write performed).

        If the cell has no existing entry in the store the call is a no-op
        (returns False) — tags will be captured on the next execution event.
        """
        data = self._load()
        versions: List[Dict] = data.get(cell_id, [])
        if not versions:
            return False

        latest  = versions[-1]
        summary = latest.get("summary")
        if not isinstance(summary, dict):
            return False

        normalised = sorted(set(tags))
        if summary.get("tags") == normalised:
            return False

        summary["tags"]            = normalised
        summary["tags_updated_at"] = self._now()
        self._save(data)
        return True

    def get_version_history(self, cell_id: str) -> List[Dict]:
        """Return all version snapshots for a cell.

        Used by the long-term memory system (future feature).
        """
        return self._load().get(cell_id, [])

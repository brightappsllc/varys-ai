"""Notebook data-directory migration utilities.

Scans ``.jupyter-assistant/`` trees for UUID-scoped data directories that
are no longer associated with their notebook (e.g. after upgrading Varys,
changing the ID scheme, or importing notebooks from another machine).

The scanner reads ``chats/*.json`` files — each chat file stores the
``notebook_path`` it belongs to.  The current UUID for that notebook is
resolved via ``get_or_create_notebook_id()``.  When the two UUIDs differ
the data directory is considered *orphaned* and can be migrated.
"""
from __future__ import annotations

import json
import logging
import shutil
from pathlib import Path
from typing import Any, Dict, List, Optional

from .paths import get_or_create_notebook_id, _UUID_CACHE, _BUILT_IN_ID_CACHE

log = logging.getLogger(__name__)

# Directories that live flat inside .jupyter-assistant/ and are NOT UUID dirs.
_FLAT_DIRS = frozenset({
    "chats", "context", "memory", "logs", "config",
    "knowledge", "rag", "skills", "agent",
})


def _is_uuid_dir(name: str) -> bool:
    """Return True if *name* looks like a UUID or UUID-like hex string."""
    stripped = name.replace("-", "")
    return len(stripped) >= 8 and all(c in "0123456789abcdefABCDEF" for c in stripped)


def _chat_summary(chats_dir: Path) -> tuple[Optional[str], int]:
    """Return (notebook_path, total_message_count) from chats in *chats_dir*."""
    notebook_path: Optional[str] = None
    message_count = 0
    for chat_file in sorted(chats_dir.glob("*.json")):
        try:
            data = json.loads(chat_file.read_text(encoding="utf-8"))
        except Exception:
            continue
        if not notebook_path:
            notebook_path = data.get("notebook_path") or data.get("notebookPath")
        for thread in data.get("threads", []):
            message_count += len(thread.get("messages", []))
    return notebook_path, message_count


def scan_orphans(root_dir: str) -> Dict[str, Any]:
    """Scan *root_dir* for orphaned notebook data directories.

    Returns a dict::

        {
            "orphaned":       [ <OrphanEntry>, ... ],
            "already_linked": <int>,
            "total_scanned":  <int>,
        }

    Each ``OrphanEntry``::

        {
            "uuid":              "<dir-name>",
            "data_dir":          "<abs-path>",
            "notebook_path":     "<relative-path>",   # from chat file
            "message_count":     <int>,
            "current_uuid":      "<uuid>" | null,     # null = notebook missing
            "notebook_missing":  <bool>,
            "needs_migration":   <bool>,
            "conflict":          <bool>,              # target dir already exists
        }
    """
    root = Path(root_dir).resolve()
    orphaned: List[Dict[str, Any]] = []
    already_linked = 0

    # rglob picks up nested repos — stop at each .jupyter-assistant/ it finds.
    for ja_dir in sorted(root.rglob(".jupyter-assistant")):
        if not ja_dir.is_dir():
            continue

        for candidate in sorted(ja_dir.iterdir()):
            if not candidate.is_dir():
                continue
            if candidate.name in _FLAT_DIRS or candidate.name.startswith("."):
                continue
            if not _is_uuid_dir(candidate.name):
                continue

            chats_dir = candidate / "chats"
            if not chats_dir.is_dir():
                continue

            notebook_path, message_count = _chat_summary(chats_dir)
            if not notebook_path:
                continue  # can't determine which notebook this belongs to

            nb_abs = str(root / notebook_path)
            nb_exists = Path(nb_abs).exists()

            if not nb_exists:
                orphaned.append({
                    "uuid":             candidate.name,
                    "data_dir":         str(candidate),
                    "notebook_path":    notebook_path,
                    "message_count":    message_count,
                    "current_uuid":     None,
                    "notebook_missing": True,
                    "needs_migration":  False,
                    "conflict":         False,
                })
                continue

            current_uuid = get_or_create_notebook_id(nb_abs)
            if current_uuid is None:
                continue  # unreadable notebook — skip

            if candidate.name == current_uuid:
                already_linked += 1
                continue  # already correct

            target_dir = ja_dir / current_uuid
            orphaned.append({
                "uuid":             candidate.name,
                "data_dir":         str(candidate),
                "notebook_path":    notebook_path,
                "message_count":    message_count,
                "current_uuid":     current_uuid,
                "notebook_missing": False,
                "needs_migration":  True,
                "conflict":         target_dir.exists(),
            })

    total = already_linked + len(orphaned)
    return {
        "orphaned":       orphaned,
        "already_linked": already_linked,
        "total_scanned":  total,
    }


def apply_migrations(root_dir: str, uuids: Optional[List[str]] = None) -> Dict[str, Any]:
    """Apply pending orphan migrations.

    If *uuids* is given, only migrate those specific UUID dirs; otherwise
    migrate all that ``scan_orphans`` reports as needing migration.

    Returns::

        { "results": [ <ResultEntry>, ... ] }

    Each ``ResultEntry``::

        {
            "uuid":          "<old-uuid>",
            "status":        "migrated" | "conflict" | "missing" | "error" | "skipped",
            "notebook_path": "<relative-path>",
            "new_uuid":      "<new-uuid>",   # on success
            "error":         "<msg>",        # on failure
        }
    """
    root = Path(root_dir).resolve()
    scan = scan_orphans(root_dir)
    results: List[Dict[str, Any]] = []

    for item in scan["orphaned"]:
        if not item["needs_migration"]:
            results.append({
                "uuid":          item["uuid"],
                "status":        "skipped",
                "notebook_path": item["notebook_path"],
                "reason":        "notebook missing or no migration needed",
            })
            continue

        if uuids is not None and item["uuid"] not in uuids:
            continue  # not requested

        if item["conflict"]:
            results.append({
                "uuid":          item["uuid"],
                "status":        "conflict",
                "notebook_path": item["notebook_path"],
                "error":         f"target dir already exists: {item['current_uuid']}",
            })
            continue

        src = Path(item["data_dir"])
        nb_abs = root / item["notebook_path"]
        dst = src.parent / item["current_uuid"]

        if not src.exists():
            results.append({
                "uuid":          item["uuid"],
                "status":        "missing",
                "notebook_path": item["notebook_path"],
                "error":         "source dir no longer exists",
            })
            continue

        try:
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(str(src), str(dst))
            # Update both caches: path→uuid and path→id-provenance.
            # Clearing _BUILT_IN_ID_CACHE forces re-evaluation of whether the
            # ID lives in-file or sidecar, which may have changed after migration.
            _UUID_CACHE[str(nb_abs)] = item["current_uuid"]
            _BUILT_IN_ID_CACHE.pop(str(nb_abs), None)
            log.info(
                "migration: relinked %s → %s (%s)",
                item["uuid"][:8], item["current_uuid"][:8], item["notebook_path"],
            )
            results.append({
                "uuid":          item["uuid"],
                "status":        "migrated",
                "notebook_path": item["notebook_path"],
                "new_uuid":      item["current_uuid"],
            })
        except Exception as exc:
            log.warning("migration: failed %s — %s", item["uuid"][:8], exc)
            results.append({
                "uuid":          item["uuid"],
                "status":        "error",
                "notebook_path": item["notebook_path"],
                "error":         str(exc),
            })

    return {"results": results}

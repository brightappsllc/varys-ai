"""Path utilities for DS Assistant.

All persistent data lives under a `.jupyter-assistant/` folder co-located with
the notebook's directory.  Within that folder, **notebook-specific** data (chat
threads, cell summaries, memory, debug logs) is stored under a per-notebook UUID
sub-directory so that renaming or moving a notebook never orphans its data:

  <nb_dir>/.jupyter-assistant/<notebook_uuid>/context/summary_store.json
  <nb_dir>/.jupyter-assistant/<notebook_uuid>/chats/
  <nb_dir>/.jupyter-assistant/<notebook_uuid>/memory/
  <nb_dir>/.jupyter-assistant/<notebook_uuid>/logs/

**Project-level** data (shared across all notebooks in the same directory) stays
at the flat `.jupyter-assistant/` level:

  <nb_dir>/.jupyter-assistant/config/      ← agent.cfg etc.

The per-notebook UUID is stored in ``notebook.metadata.varys_notebook_id`` for
notebooks that already carry it (backward compat).  For new notebooks the UUID
is persisted in a sidecar file instead of modifying the ``.ipynb`` file, which
would otherwise trigger JupyterLab's "File Changed on disk" dialog:

  <nb_dir>/.jupyter-assistant/_notebook_ids.json  ← {"notebook.ipynb": "<uuid>", ...}

Migration
---------
Existing installations using the old flat layout are detected automatically:

  Old: <nb_dir>/.jupyter-assistant/context/summary_store.json
  New: <nb_dir>/.jupyter-assistant/<uuid>/context/summary_store.json

When a single notebook is present in the folder the migration runs silently.
When multiple notebooks share the folder a warning is logged (the flat data is
copied into every notebook's UUID folder — excess cells are harmlessly ignored
at runtime since they will never be referenced by the current notebook).
"""
from __future__ import annotations

import json
import logging
import os
import shutil
import tempfile
import uuid as _uuid_mod
from pathlib import Path
from typing import Dict, Optional, Set

log = logging.getLogger(__name__)

# ── Module-level caches ────────────────────────────────────────────────────────

# abs_notebook_path → uuid_str
_UUID_CACHE: Dict[str, str] = {}

# abs .jupyter-assistant dirs already checked for migration this session
_MIGRATED_CHECK: Set[str] = set()

# Notebook-scoped subdirs that are moved under the UUID folder
_NB_SCOPED_DIRS = {"context", "chats", "memory", "logs"}

# ── UUID helpers ───────────────────────────────────────────────────────────────

# Sidecar filename that stores generated notebook IDs (avoids writing to .ipynb)
_SIDECAR_NAME = "_notebook_ids.json"


def _sidecar_path(nb_dir: Path) -> Path:
    return nb_dir / ".jupyter-assistant" / _SIDECAR_NAME


def _read_sidecar_id(nb_dir: Path, nb_filename: str) -> Optional[str]:
    """Return the UUID stored in the sidecar for *nb_filename*, or None."""
    p = _sidecar_path(nb_dir)
    if not p.exists():
        return None
    try:
        return json.loads(p.read_text(encoding="utf-8")).get(nb_filename)
    except Exception:
        return None


def _write_sidecar_id(nb_dir: Path, nb_filename: str, uuid_str: str) -> None:
    """Persist *uuid_str* for *nb_filename* in the sidecar (atomic write)."""
    p = _sidecar_path(nb_dir)
    p.parent.mkdir(parents=True, exist_ok=True)
    data: Dict[str, str] = {}
    if p.exists():
        try:
            data = json.loads(p.read_text(encoding="utf-8"))
        except Exception:
            pass
    data[nb_filename] = uuid_str
    _atomic_write_text(p, json.dumps(data, indent=2, ensure_ascii=False) + "\n")


def _remove_sidecar_id(nb_dir: Path, nb_filename: str) -> None:
    """Remove the sidecar entry for *nb_filename* (no-op if absent)."""
    p = _sidecar_path(nb_dir)
    if not p.exists():
        return
    try:
        data: Dict[str, str] = json.loads(p.read_text(encoding="utf-8"))
        if nb_filename not in data:
            return
        del data[nb_filename]
        _atomic_write_text(p, json.dumps(data, indent=2, ensure_ascii=False) + "\n")
    except Exception as exc:
        log.debug("paths: could not remove sidecar entry for %s — %s", nb_filename, exc)


def _migrate_data_dir(nb_dir: Path, old_id: str, new_id: str) -> None:
    """Move the per-notebook data dir from *old_id* to *new_id* (best-effort).

    Called when metadata.id is discovered after a sidecar UUID was already
    used — ensures existing chat threads, summaries, and memory are not orphaned.
    """
    src = nb_dir / ".jupyter-assistant" / old_id
    dst = nb_dir / ".jupyter-assistant" / new_id
    if not src.exists() or dst.exists():
        return
    try:
        shutil.move(str(src), str(dst))
        log.info("paths: migrated data dir %s… → %s…", old_id[:8], new_id[:8])
    except Exception as exc:
        log.warning("paths: could not migrate data dir %s → %s: %s", old_id[:8], new_id[:8], exc)


def _atomic_write_text(path: Path, content: str) -> None:
    """Write *content* to *path* atomically (rename trick)."""
    parent = path.parent
    fd, tmp = tempfile.mkstemp(dir=parent, prefix=".tmp_varys_", suffix=".json")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(content)
        os.replace(tmp, str(path))
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def get_or_create_notebook_id(notebook_abs_path: str) -> Optional[str]:
    """Return the stable UUID for a notebook, creating it if absent.

    Lookup order:
      1. In-process cache (fastest).
      2. ``notebook.metadata.varys_notebook_id`` — present on notebooks stamped
         by an older version of Varys (backward compat, read-only).
      3. ``notebook.metadata.id`` — the standard nbformat 4.5 field written by
         JupyterLab 4+ on every save.  Using it here means modern notebooks
         never need any write at all and the ID is rename-stable because it
         travels inside the file.
      4. Sidecar file ``{nb_dir}/.jupyter-assistant/_notebook_ids.json`` — used
         only for truly old notebooks (pre-nbformat 4.5) that carry neither of
         the above fields.  Avoids writing to the ``.ipynb`` file, which would
         trigger JupyterLab's "File Changed on disk" dialog.

    Returns ``None`` when the notebook file does not exist or cannot be read.
    Callers fall back to the old directory-scoped layout in that case.
    """
    cache_key = str(notebook_abs_path)
    if cache_key in _UUID_CACHE:
        return _UUID_CACHE[cache_key]

    nb_path = Path(notebook_abs_path)
    if not nb_path.exists():
        return None

    try:
        raw = nb_path.read_text(encoding="utf-8")
        data = json.loads(raw)
    except Exception as exc:
        log.debug("paths: could not read notebook %s — %s", nb_path, exc)
        return None

    meta = data.get("metadata", {}) if isinstance(data.get("metadata"), dict) else {}

    # 1. Legacy Varys field — check first so existing data dirs keep their UUID
    existing_id: Optional[str] = meta.get("varys_notebook_id")
    if existing_id and isinstance(existing_id, str):
        _UUID_CACHE[cache_key] = existing_id
        return existing_id

    # 2. Standard nbformat 4.5 field written by JupyterLab 4+ — no write needed,
    #    rename-stable because the ID is embedded in the file itself.
    std_id: Optional[str] = meta.get("id")
    if std_id and isinstance(std_id, str):
        # If a sidecar entry was assigned before metadata.id was written (via the
        # needsIdStamp → silent-save flow), migrate the data directory so existing
        # chat threads, summaries and memory are not orphaned.
        sidecar_id = _read_sidecar_id(nb_path.parent, nb_path.name)
        if sidecar_id and sidecar_id != std_id:
            _migrate_data_dir(nb_path.parent, sidecar_id, std_id)
            _remove_sidecar_id(nb_path.parent, nb_path.name)
        _UUID_CACHE[cache_key] = std_id
        return std_id

    # 3. Sidecar (written by Varys for pre-nbformat-4.5 notebooks to avoid the
    #    "File Changed on disk" dialog that a direct .ipynb write would cause)
    sidecar_id = _read_sidecar_id(nb_path.parent, nb_path.name)
    if sidecar_id and isinstance(sidecar_id, str):
        _UUID_CACHE[cache_key] = sidecar_id
        return sidecar_id

    # 4. Generate a new UUID and write it to the sidecar — NOT to the notebook.
    #    Writing to the notebook triggers JupyterLab's "File Changed on disk"
    #    dialog even when only one instance of the file is open.
    new_id = str(_uuid_mod.uuid4())
    try:
        _write_sidecar_id(nb_path.parent, nb_path.name, new_id)
        log.info("paths: assigned notebook id=%s to %s (sidecar)", new_id, nb_path.name)
    except Exception as exc:
        log.warning("paths: could not write sidecar notebook id for %s — %s", nb_path, exc)
        # Return the generated ID but don't cache (will retry next call).
        return new_id

    _UUID_CACHE[cache_key] = new_id
    return new_id


# ── Migration ──────────────────────────────────────────────────────────────────


def _maybe_migrate(nb_dir: Path, nb_id: str) -> None:
    """Migrate an old flat .jupyter-assistant layout to UUID-scoped if needed.

    Called once per session per ``.jupyter-assistant`` directory.
    """
    ja_dir = nb_dir / ".jupyter-assistant"
    check_key = str(ja_dir)
    if check_key in _MIGRATED_CHECK:
        return
    _MIGRATED_CHECK.add(check_key)

    uuid_base = ja_dir / nb_id
    if uuid_base.exists():
        return  # already in new layout

    # Check if there is any flat data worth migrating.
    has_flat = any((ja_dir / d).exists() for d in _NB_SCOPED_DIRS)
    if not has_flat:
        return

    # Count notebooks in this directory.
    nb_files = list(nb_dir.glob("*.ipynb"))

    if len(nb_files) == 1:
        log.info(
            "paths: migrating flat .jupyter-assistant → UUID layout for %s",
            nb_files[0].name,
        )
    else:
        log.warning(
            "paths: %d notebooks share %s — copying flat data into each UUID "
            "folder.  Run 'varys nb migrate' to clean up duplicates.",
            len(nb_files),
            ja_dir,
        )

    # Copy (not move) so that other notebooks still work during transition.
    uuid_base.mkdir(parents=True, exist_ok=True)
    for sub in _NB_SCOPED_DIRS:
        src = ja_dir / sub
        if src.exists():
            dst = uuid_base / sub
            if not dst.exists():
                try:
                    shutil.copytree(str(src), str(dst))
                except Exception as exc:
                    log.warning("paths: migration copy %s → %s failed: %s", src, dst, exc)


# ── Public API ─────────────────────────────────────────────────────────────────


def nb_base(root_dir: str, notebook_path: str = "") -> Path:
    """Return the notebook-scoped ``.jupyter-assistant/<uuid>`` directory.

    This is where **per-notebook** data lives: chat threads, cell-summary store,
    user-memory, and debug logs.

    When ``notebook_path`` is empty (e.g. at server startup) the old flat
    ``.jupyter-assistant/`` directory is returned for backward compatibility.
    """
    root = Path(root_dir)

    if not notebook_path:
        return root / ".jupyter-assistant"

    nb = Path(notebook_path)
    if nb.is_absolute():
        try:
            nb = nb.relative_to(root)
        except ValueError:
            # Outside root — resolve directly from the notebook's parent.
            nb_abs = str(nb)
            nb_dir = nb.parent
            nb_id  = get_or_create_notebook_id(nb_abs)
            if nb_id is None:
                return nb_dir / ".jupyter-assistant"
            _maybe_migrate(nb_dir, nb_id)
            return nb_dir / ".jupyter-assistant" / nb_id

    nb_abs = str(root / nb)
    nb_dir = (root / nb).parent
    nb_id  = get_or_create_notebook_id(nb_abs)
    if nb_id is None:
        # Can't read notebook — fall back to flat layout.
        return nb_dir / ".jupyter-assistant"
    _maybe_migrate(nb_dir, nb_id)
    return nb_dir / ".jupyter-assistant" / nb_id


def project_base(root_dir: str, notebook_path: str = "") -> Path:
    """Return the **project-scoped** ``.jupyter-assistant`` directory.

    This is shared across all notebooks in the same folder and is where
    project-level data lives: ``knowledge/``, ``rag/``, ``config/``,
    ``skills/``.

    Behaviour is identical to the old ``nb_base()`` (directory-scoped).
    """
    root = Path(root_dir)
    if notebook_path:
        nb = Path(notebook_path)
        if nb.is_absolute():
            try:
                nb = nb.relative_to(root)
            except ValueError:
                return nb.parent / ".jupyter-assistant"
        return (root / nb).parent / ".jupyter-assistant"
    return root / ".jupyter-assistant"


def notebook_dir(nb_base_path: Path) -> Path:
    """Return the notebook's working directory from its ``nb_base`` path.

    Handles both layout variants transparently:

    * New (UUID-scoped): ``<dir>/.jupyter-assistant/<uuid>`` → ``<dir>``
    * Old (flat):        ``<dir>/.jupyter-assistant``         → ``<dir>``
    """
    if nb_base_path.parent.name == ".jupyter-assistant":
        # New layout: go up two levels past .jupyter-assistant/<uuid>
        return nb_base_path.parent.parent
    elif nb_base_path.name == ".jupyter-assistant":
        # Old flat layout
        return nb_base_path.parent
    # Fallback
    return nb_base_path.parent

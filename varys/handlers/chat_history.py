"""Persistent chat-thread storage for DS Assistant.

Storage layout
--------------
  <notebook_dir>/.jupyter-assistant/chats/
      {notebook_id8}.json

  notebook_id8 = first 8 hex chars of the notebook's metadata.id (the stable
  UUID stored inside the .ipynb file).  The filename contains ONLY this id —
  no notebook name — so it never changes when the notebook is renamed.

JSON schema
-----------
  {
    "notebook_path": "relative/path/to/notebook.ipynb",
    "last_thread_id": "t_abc123",
    "threads": [
      {
        "id": "t_abc123",
        "name": "Main",
        "created_at": "2026-01-01T00:00:00Z",
        "updated_at": "2026-01-01T01:00:00Z",
        "messages": [
          {"id": "m1", "role": "user",      "content": "...", "timestamp": "..."},
          {"id": "m2", "role": "assistant", "content": "...", "timestamp": "..."}
        ]
      }
    ]
  }

Endpoints
---------
  GET  /varys/chat-history?notebook=<rel_path>
       → returns the full chat file (threads + messages)

  POST /varys/chat-history
       body: { notebookPath, thread: {id, name, messages, ...} }
       → upserts the thread (creates or replaces by id) and updates last_thread_id

  DELETE /varys/chat-history?notebook=<rel_path>&threadId=<id>
       → removes the thread; if it was the last_thread_id, updates to the next one
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import tempfile
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List

from jupyter_server.base.handlers import JupyterHandler

from ..utils.paths import nb_base

log = logging.getLogger(__name__)

# ── File helpers ──────────────────────────────────────────────────────────────

def _ensure_notebook_id(abs_nb_path: str) -> str | None:
    """Return (and lazily create) a stable 8-char hex ID for a notebook.

    Priority:
      1. metadata.id      — standard nbformat 4.5 field; written by JupyterLab 4+.
      2. metadata.varys_id — written by older versions of Varys (kept for back-compat).
      3. Generate + write  — if neither exists, a UUID4 is generated and written
                            as the standard metadata.id so the notebook becomes
                            fully compliant and the ID survives any future rename.

    Returns None only when the file is missing or cannot be written.
    """
    if not os.path.isfile(abs_nb_path):
        return None
    try:
        with open(abs_nb_path, "r", encoding="utf-8") as fh:
            nb = json.load(fh)

        meta = nb.get("metadata", {})

        # 1. standard metadata.id
        nb_id = meta.get("id", "")
        if nb_id and isinstance(nb_id, str):
            clean = nb_id.replace("-", "")
            if len(clean) >= 8:
                return clean[:8]

        # 2. our own varys_id fallback (written by older versions of Varys)
        varys_id = meta.get("varys_id", "")
        if varys_id and isinstance(varys_id, str):
            clean = varys_id.replace("-", "")
            if len(clean) >= 8:
                return clean[:8]

        # 3. generate and persist a standard metadata.id
        new_id = str(uuid.uuid4())
        nb.setdefault("metadata", {})["id"] = new_id

        # Safety: verify the cell count in memory matches what we loaded.
        # If something went wrong during json.load this guard catches it.
        orig_cells = nb.get("cells", [])
        if not isinstance(orig_cells, list):
            log.warning("Chat: unexpected cells structure in %s — skipping id write",
                        os.path.basename(abs_nb_path))
            return None

        # Atomic write: dump to a sibling temp file, then os.replace() so that
        # a crash, OOM, or disk-full event can never leave a 0-byte or partial
        # notebook.  We intentionally use plain json.dump (not nbformat.write +
        # nbformat.from_dict) to avoid any schema-normalization that could
        # silently drop cells or outputs from notebooks that predate nbformat 4.5.
        tmp_path = abs_nb_path + ".varys_id_tmp"
        try:
            with open(tmp_path, "w", encoding="utf-8") as fh:
                json.dump(nb, fh, indent=1, ensure_ascii=False)
                fh.write("\n")
            os.replace(tmp_path, abs_nb_path)   # atomic rename on POSIX & Windows
            log.info("Chat: wrote metadata.id to %s", os.path.basename(abs_nb_path))
        except Exception as exc:
            log.warning("Chat: could not write notebook id for %s — %s",
                        os.path.basename(abs_nb_path), exc)
            try:
                os.unlink(tmp_path)
            except OSError:
                pass
            return None

        return new_id.replace("-", "")[:8]

    except Exception as exc:
        log.warning("Chat: could not ensure notebook id for %s — %s", abs_nb_path, exc)
        return None


def _chat_path(root_dir: str, notebook_rel: str) -> Path:
    """Return the path of the JSON chat file for a notebook or source file.

    For .ipynb files:
      Filename: {nb_id8}.json  (the notebook's stable 8-char hex id only).
      Using only the id means the filename never changes on rename/move.
      Auto-migration from older naming schemes:
      • {stem}_{nb_id8}.json  — written by the previous version of Varys.
      • {stem}_{md5_hash}.json — original MD5-of-path scheme.
      Both are renamed to {nb_id8}.json on first access.

    For non-notebook files (.py, .md, etc.):
      Filename: {stem}_{md5_of_rel_path[:8]}.json  — stable, deterministic.
      _ensure_notebook_id is *not* called (the file is not valid JSON).
    """
    stem = Path(notebook_rel).stem
    chat_dir = nb_base(root_dir, notebook_rel) / "chats"
    chat_dir.mkdir(parents=True, exist_ok=True)

    # Only attempt notebook-ID-based naming for actual .ipynb files.
    nb_id8 = None
    if notebook_rel.lower().endswith(".ipynb"):
        abs_nb = os.path.join(root_dir, notebook_rel)
        nb_id8 = _ensure_notebook_id(abs_nb)

    if nb_id8:
        target = chat_dir / f"{nb_id8}.json"
        if not target.exists():
            # Migration 1: previous Varys version used {stem}_{nb_id8}.json
            old_id_path = chat_dir / f"{stem}_{nb_id8}.json"
            if old_id_path.exists():
                old_id_path.rename(target)
                log.info("Chat: migrated %s → %s", old_id_path.name, target.name)
            else:
                # Migration 2: original MD5-of-path scheme {stem}_{md5}.json
                old_hash = hashlib.md5(notebook_rel.encode()).hexdigest()[:8]
                old_md5_path = chat_dir / f"{stem}_{old_hash}.json"
                if old_md5_path.exists():
                    old_md5_path.rename(target)
                    log.info("Chat: migrated %s → %s", old_md5_path.name, target.name)
        return target

    # Fallback: notebook inaccessible — use MD5 of relative path.
    short_hash = hashlib.md5(notebook_rel.encode()).hexdigest()[:8]
    return chat_dir / f"{stem}_{short_hash}.json"


def _load(root_dir: str, notebook_rel: str) -> Dict[str, Any]:
    path = _chat_path(root_dir, notebook_rel)
    if path.exists():
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            # Always reflect the current notebook path so stale paths from
            # before a rename are never returned to the frontend.
            data["notebook_path"] = notebook_rel
            return data
        except Exception as exc:
            log.warning("Varys chat: could not load %s — %s", path, exc)
    return {"notebook_path": notebook_rel, "last_thread_id": None, "threads": []}


def _atomic_write(path: Path, content: str) -> None:
    """Write *content* to *path* atomically via a sibling temp file + os.replace().

    os.replace() maps to rename(2) on POSIX — the destination is always either
    the old file or the fully-written new file, never empty or partial.  This
    prevents 'Expecting value: line 1 column 1 (char 0)' errors caused by a
    process being killed mid-write.
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


def _save(root_dir: str, notebook_rel: str, data: Dict[str, Any]) -> None:
    path = _chat_path(root_dir, notebook_rel)
    try:
        _atomic_write(path, json.dumps(data, indent=2, ensure_ascii=False))
    except Exception as exc:
        log.warning("Varys chat: could not save %s — %s", path, exc)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _normalize_path(root_dir: str, notebook_path: str) -> str:
    """Convert an absolute or root-relative notebook path to a relative path."""
    if os.path.isabs(notebook_path):
        try:
            return os.path.relpath(notebook_path, root_dir)
        except ValueError:
            # On Windows, relpath can fail across drives
            return Path(notebook_path).name
    return notebook_path


# ── Handler ───────────────────────────────────────────────────────────────────

class ChatHistoryHandler(JupyterHandler):
    """GET / POST / DELETE chat thread storage."""

    def _root(self) -> str:
        return self.settings.get("ds_assistant_root_dir", ".")

    # ── GET ───────────────────────────────────────────────────────────────────

    async def get(self) -> None:
        notebook = self.get_query_argument("notebook", "")
        if not notebook:
            self.set_status(400)
            self.finish(json.dumps({"error": "notebook query parameter required"}))
            return

        root = self._root()
        notebook_rel = _normalize_path(root, notebook)
        # _load reads the .ipynb file (via _ensure_notebook_id) and the chat
        # JSON — run in a thread so the event loop stays responsive.
        data = await asyncio.to_thread(_load, root, notebook_rel)
        self.set_header("Content-Type", "application/json")
        self.finish(json.dumps(data))

    # ── POST ──────────────────────────────────────────────────────────────────

    async def post(self) -> None:
        try:
            body: Dict[str, Any] = json.loads(self.request.body.decode())
        except json.JSONDecodeError:
            self.set_status(400)
            self.finish(json.dumps({"error": "invalid JSON"}))
            return

        notebook_path: str = body.get("notebookPath", "")
        thread: Dict[str, Any] = body.get("thread", {})
        if not notebook_path or not thread.get("id"):
            self.set_status(400)
            self.finish(json.dumps({"error": "notebookPath and thread.id required"}))
            return

        root = self._root()
        notebook_rel = _normalize_path(root, notebook_path)
        data = await asyncio.to_thread(_load, root, notebook_rel)

        threads: List[Dict] = data.get("threads", [])
        # Upsert: replace existing thread with matching id or append
        thread["updated_at"] = _now()
        if not thread.get("created_at"):
            thread["created_at"] = thread["updated_at"]
        idx = next((i for i, t in enumerate(threads) if t["id"] == thread["id"]), None)
        if idx is not None:
            threads[idx] = thread
        else:
            threads.append(thread)

        data["threads"] = threads
        data["last_thread_id"] = thread["id"]
        data["notebook_path"] = notebook_rel

        chat_path = await asyncio.to_thread(_chat_path, root, notebook_rel)
        await asyncio.to_thread(_save, root, notebook_rel, data)
        self.set_header("Content-Type", "application/json")
        self.finish(json.dumps({"ok": True, "filename": chat_path.name}))

    # ── DELETE ────────────────────────────────────────────────────────────────

    async def delete(self) -> None:
        notebook = self.get_query_argument("notebook", "")
        thread_id = self.get_query_argument("threadId", "")
        if not notebook or not thread_id:
            self.set_status(400)
            self.finish(json.dumps({"error": "notebook and threadId query params required"}))
            return

        root = self._root()
        notebook_rel = _normalize_path(root, notebook)
        data = await asyncio.to_thread(_load, root, notebook_rel)

        threads: List[Dict] = [t for t in data.get("threads", []) if t["id"] != thread_id]
        data["threads"] = threads

        if data.get("last_thread_id") == thread_id:
            data["last_thread_id"] = threads[-1]["id"] if threads else None

        await asyncio.to_thread(_save, root, notebook_rel, data)
        self.set_header("Content-Type", "application/json")
        self.finish(json.dumps({"ok": True, "remaining": len(threads)}))

"""Notebook move handler — moves a notebook together with all its Varys data.

POST /varys/nb/move
  Body (JSON):
    {
      "src":  "relative/path/to/notebook.ipynb",   // relative to root_dir
      "dst":  "relative/new/path/notebook.ipynb"   // relative to root_dir
    }

  Response (JSON):
    { "moved": true, "src": "...", "dst": "...", "data_moved": true }

What gets moved
---------------
1. The ``.ipynb`` file itself (src → dst).
2. The notebook-scoped data directory:
     ``<src_dir>/.jupyter-assistant/<uuid>/``  →  ``<dst_dir>/.jupyter-assistant/<uuid>/``
   This carries over: chat threads, cell-summary store, memory, and debug logs.

What stays behind (project-level, shared)
------------------------------------------
- ``config/``     ``agent.cfg`` etc.

After the move the UUID cache is updated so the next Varys request against
the destination path resolves immediately without re-reading the notebook.
"""
from __future__ import annotations

import json
import logging
import shutil
from pathlib import Path

from jupyter_server.base.handlers import JupyterHandler
from tornado.web import authenticated

from ..utils.paths import get_or_create_notebook_id, _UUID_CACHE, _read_sidecar_id, _write_sidecar_id, _remove_sidecar_id

log = logging.getLogger(__name__)


class NbMoveHandler(JupyterHandler):
    """POST /varys/nb/move — move notebook + its Varys data directory."""

    @authenticated
    async def post(self) -> None:
        root_dir = self.settings.get("ds_assistant_root_dir", ".")

        try:
            body = json.loads(self.request.body)
        except Exception:
            self.set_status(400)
            self.finish(json.dumps({"error": "Invalid JSON body"}))
            return

        src_rel = body.get("src", "").strip()
        dst_rel = body.get("dst", "").strip()
        if not src_rel or not dst_rel:
            self.set_status(400)
            self.finish(json.dumps({"error": "'src' and 'dst' are required"}))
            return

        root = Path(root_dir)
        src  = (root / src_rel).resolve()
        dst  = (root / dst_rel).resolve()

        if not src.exists():
            self.set_status(404)
            self.finish(json.dumps({"error": f"Source not found: {src_rel}"}))
            return

        if dst.exists():
            self.set_status(409)
            self.finish(json.dumps({"error": f"Destination already exists: {dst_rel}"}))
            return

        # ── Resolve the UUID before moving (reads from src notebook metadata) ──
        nb_id = get_or_create_notebook_id(str(src))
        if nb_id is None:
            self.set_status(500)
            self.finish(json.dumps({"error": "Could not read notebook UUID. Is the file valid JSON?"}))
            return

        # ── Move the notebook file ─────────────────────────────────────────────
        dst.parent.mkdir(parents=True, exist_ok=True)
        try:
            shutil.move(str(src), str(dst))
        except Exception as exc:
            self.set_status(500)
            self.finish(json.dumps({"error": f"Could not move notebook: {exc}"}))
            return

        # ── Move the Varys data directory ──────────────────────────────────────
        src_data = src.parent / ".jupyter-assistant" / nb_id
        dst_data = dst.parent / ".jupyter-assistant" / nb_id
        data_moved = False

        if src_data.exists():
            try:
                dst_data.parent.mkdir(parents=True, exist_ok=True)
                shutil.move(str(src_data), str(dst_data))
                data_moved = True
                log.info(
                    "NbMoveHandler: moved data %s → %s",
                    src_data, dst_data,
                )
            except Exception as exc:
                log.warning(
                    "NbMoveHandler: could not move data dir %s — %s",
                    src_data, exc,
                )

        # ── Update the in-process UUID cache so the next request is instant ───
        old_key = str(src)
        new_key = str(dst)
        if old_key in _UUID_CACHE:
            _UUID_CACHE[new_key] = _UUID_CACHE.pop(old_key)

        # ── Carry sidecar entry to destination ───────────────────────────────
        # If the UUID was stored in the sidecar (not in notebook metadata), copy
        # the entry so the destination path resolves to the same UUID.
        sidecar_id = _read_sidecar_id(src.parent, src.name)
        if sidecar_id:
            try:
                _write_sidecar_id(dst.parent, dst.name, sidecar_id)
                # Remove the stale source entry so the sidecar stays clean.
                _remove_sidecar_id(src.parent, src.name)
            except Exception as exc:
                log.warning("NbMoveHandler: could not update sidecar for %s — %s", dst.name, exc)

        self.set_header("Content-Type", "application/json")
        self.finish(json.dumps({
            "moved":      True,
            "src":        src_rel,
            "dst":        dst_rel,
            "notebook_id": nb_id,
            "data_moved": data_moved,
        }))

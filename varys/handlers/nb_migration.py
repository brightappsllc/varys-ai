"""Notebook migration handler — scan and relink orphaned data directories.

GET  /varys/nb/migration
    Scan the root directory for UUID-scoped data dirs that are no longer
    associated with their notebook (mismatch between stored UUID and the
    notebook's current ``metadata.id``).

    Response:
      {
        "orphaned":       [ <OrphanEntry>, ... ],
        "already_linked": <int>,
        "total_scanned":  <int>,
      }

POST /varys/nb/migration
    Apply pending migrations (rename orphaned dirs to the notebook's
    current UUID).  Optionally limit to a specific subset via ``uuids``.

    Body (JSON, all optional):
      { "uuids": ["uuid1", "uuid2"] }   ← omit to migrate all

    Response:
      { "results": [ <ResultEntry>, ... ] }
"""
from __future__ import annotations

import json
import logging

from jupyter_server.base.handlers import JupyterHandler
from tornado.web import authenticated

from ..utils.migration import scan_orphans, apply_migrations

log = logging.getLogger(__name__)


class NbMigrationHandler(JupyterHandler):

    @authenticated
    async def get(self) -> None:
        root_dir = self.settings.get("ds_assistant_root_dir", ".")
        result = scan_orphans(root_dir)
        self.set_header("Content-Type", "application/json")
        self.finish(json.dumps(result))

    @authenticated
    async def post(self) -> None:
        root_dir = self.settings.get("ds_assistant_root_dir", ".")
        try:
            body = json.loads(self.request.body) if self.request.body else {}
        except Exception:
            body = {}

        uuids = body.get("uuids")  # None = migrate all
        if uuids is not None and not isinstance(uuids, list):
            self.set_status(400)
            self.finish(json.dumps({"error": "'uuids' must be an array or omitted"}))
            return

        result = apply_migrations(root_dir, uuids or None)
        self.set_header("Content-Type", "application/json")
        self.finish(json.dumps(result))

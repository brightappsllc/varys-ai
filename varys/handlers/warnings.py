"""GET /varys/warnings — return and clear pending UI warnings."""
from __future__ import annotations

import json

from jupyter_server.base.handlers import JupyterHandler
from tornado.web import authenticated


class WarningsHandler(JupyterHandler):
    """GET /varys/warnings — returns pending warnings and clears the queue."""

    @authenticated
    async def get(self):
        from ..agent.repo_scan_store import get_and_clear_warnings
        warnings = get_and_clear_warnings()
        self.set_header("Content-Type", "application/json")
        self.finish(json.dumps({"warnings": warnings}))

"""GET /varys/usage — LLM token usage query endpoint.

Supports actions: heatmap, totals, models, export.
"""

import json
import logging
from datetime import datetime, timezone
from pathlib import Path

from jupyter_server.base.handlers import JupyterHandler
from tornado.web import authenticated

from ..usage_reader import UsageReader

log = logging.getLogger(__name__)

_JSONL_PATH = Path.home() / ".jupyter" / "usage.jsonl"

_reader = UsageReader()


class UsageHandler(JupyterHandler):
    """Single endpoint for all usage queries."""

    @authenticated
    async def get(self) -> None:
        _reader.refresh()
        action = self.get_query_argument("action", "")

        if action == "heatmap":
            model_key = self.get_query_argument("model", None) or None
            data = _reader.get_heatmap(model_key)
            self.set_header("Content-Type", "application/json")
            self.finish(json.dumps({"data": data}))

        elif action == "totals":
            period    = self.get_query_argument("period", "month")
            model_key = self.get_query_argument("model", None) or None
            data = _reader.get_totals(period, model_key)
            self.set_header("Content-Type", "application/json")
            self.finish(json.dumps({"data": data}))

        elif action == "models":
            data = _reader.get_models()
            self.set_header("Content-Type", "application/json")
            self.finish(json.dumps({"data": data}))

        elif action == "export":
            today    = datetime.now(timezone.utc).date().isoformat()
            filename = f"varys_usage_export_{today}.jsonl"
            self.set_header("Content-Type", "application/x-ndjson")
            self.set_header(
                "Content-Disposition", f'attachment; filename="{filename}"'
            )
            if not _JSONL_PATH.exists():
                self.finish(b"")
                return
            try:
                with _JSONL_PATH.open("rb") as fh:
                    while True:
                        chunk = fh.read(65536)
                        if not chunk:
                            break
                        self.write(chunk)
                self.finish()
            except Exception as exc:
                log.error("Usage export failed: %s", exc)
                self.set_status(500)
                self.finish(json.dumps({"error": str(exc)}))

        else:
            self.set_status(400)
            self.set_header("Content-Type", "application/json")
            self.finish(json.dumps({"error": f"Unknown action: {action!r}"}))

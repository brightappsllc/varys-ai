"""Completion handler — /varys/complete"""
import json
import traceback

from jupyter_server.base.handlers import JupyterHandler
from tornado.web import authenticated

from ..llm.factory import create_provider
from ..utils.config import get_config as _get_cfg

_EMPTY = {"suggestion": "", "lines": []}


class CompleteHandler(JupyterHandler):
    """Handle code completion requests from the frontend."""

    @authenticated
    async def post(self):
        self.set_header("Content-Type", "application/json")

        try:
            body = json.loads(self.request.body)
        except json.JSONDecodeError:
            self.set_status(400)
            self.finish(json.dumps({"error": "Invalid JSON body"}))
            return

        prefix = body.get("prefix", "")
        suffix = body.get("suffix", "")
        language = body.get("language", "python")
        previous_cells = body.get("previousCells", [])

        min_prefix = _get_cfg().getint("context", "min_prefix_length", 2)
        if len(prefix.strip()) < min_prefix:
            self.finish(json.dumps({**_EMPTY, "type": "completion"}))
            return

        try:
            provider = create_provider(self.settings, task="completion")
            result = await provider.complete(
                prefix=prefix,
                suffix=suffix,
                language=language,
                previous_cells=previous_cells,
            )
            self.log.info(
                "Varys complete — prefix=%r  suggestion=%r  cached=%s",
                prefix[-40:], result.get("suggestion", ""), result.get("cached", False)
            )
            self.finish(json.dumps(result))

        except ValueError as exc:
            self.log.warning("Varys completion config error: %s", exc)
            self.finish(json.dumps({**_EMPTY, "type": "completion", "error": str(exc)}))

        except Exception:
            self.log.error(f"Varys completion error:\n{traceback.format_exc()}")
            self.finish(json.dumps({**_EMPTY, "type": "completion"}))

"""Health check handler."""
import json
from jupyter_server.base.handlers import JupyterHandler
from tornado.web import authenticated

from ..llm.factory import get_provider_info


class HealthHandler(JupyterHandler):
    """Health check endpoint — also surfaces per-task provider config."""

    @authenticated
    def get(self):
        """Return health status and per-task provider/model details."""
        self.set_header("Content-Type", "application/json")
        info = get_provider_info(self.settings)
        # Convenience top-level fields for backward compat / sidebar badge
        chat = info.get("chat", {})
        self.finish(json.dumps({
            "status": "ok",
            "extension": "varys",
            # Legacy single-provider fields (reflects chat provider)
            "provider": chat.get("provider", "unknown"),
            "model": chat.get("model", ""),
            # Full per-task breakdown
            "providers": info,
        }))

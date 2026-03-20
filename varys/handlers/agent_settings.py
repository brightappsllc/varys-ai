"""GET/POST /varys/agent-settings — project-local Varys File Agent configuration.

GET  /varys/agent-settings?notebook_path=<path>
     Returns the current values from .jupyter-assistant/local_varys.env.
     VARYS_AGENT_WORKING_DIR is resolved to the notebook's parent directory
     when it is absent or empty, so the UI always shows the actual path in use.

POST /varys/agent-settings
     Body: { "notebook_path": "...", "settings": { "VARYS_AGENT_...": "..." } }
     Writes updates to .jupyter-assistant/local_varys.env.

GET  /varys/agent-settings/tool-support?provider=<name>&model=<name>
     Returns {"supported": bool, "reason": str|null}.
     Used by the Settings → Agent tab to show the tool-calling compatibility
     indicator when the provider or model selection changes.
"""
from __future__ import annotations

import json
import os

from jupyter_server.base.handlers import JupyterHandler
from tornado.web import authenticated


def _resolve_working_dir(notebook_path: str) -> str:
    """Return the absolute parent directory of notebook_path, or '' if unknown."""
    if not notebook_path:
        return ""
    return os.path.dirname(os.path.abspath(notebook_path))


class AgentToolSupportHandler(JupyterHandler):
    """GET /varys/agent-settings/tool-support?provider=<name>&model=<name>"""

    @authenticated
    async def get(self):
        provider = self.get_argument("provider", "").lower().strip()
        model    = self.get_argument("model", "").strip()

        if not provider or not model:
            self.set_status(400)
            self.finish(json.dumps({"error": "provider and model query params are required"}))
            return

        from ..agent.provider_factory import check_tool_support_safe
        result = check_tool_support_safe(provider, model)
        self.set_header("Content-Type", "application/json")
        self.finish(json.dumps(result))


class AgentSettingsHandler(JupyterHandler):
    """Read and write .jupyter-assistant/local_varys.env for a specific project."""

    @authenticated
    async def get(self):
        notebook_path = self.get_argument("notebook_path", "")
        from ..agent.local_config import (
            load_local_agent_config,
            get_local_config_path,
            AGENT_CONFIG_KEYS,
            AGENT_CONFIG_DEFAULTS,
        )
        local = load_local_agent_config(notebook_path)
        config_path = get_local_config_path(notebook_path)
        # Fall back to defaults so the UI always shows meaningful values.
        result: dict = {k: local.get(k) or AGENT_CONFIG_DEFAULTS.get(k, "") for k in AGENT_CONFIG_KEYS}
        # VARYS_AGENT_WORKING_DIR: if still empty, resolve to the notebook's
        # parent directory so the form always shows the actual path in use.
        if not result.get("VARYS_AGENT_WORKING_DIR"):
            result["VARYS_AGENT_WORKING_DIR"] = _resolve_working_dir(notebook_path)
        result["_config_path"] = str(config_path) if config_path else ""
        result["_config_exists"] = bool(config_path and config_path.exists())
        self.set_header("Content-Type", "application/json")
        self.finish(json.dumps(result))

    @authenticated
    async def post(self):
        try:
            body = json.loads(self.request.body)
        except json.JSONDecodeError:
            self.set_status(400)
            self.finish(json.dumps({"error": "Invalid JSON body"}))
            return

        notebook_path = body.get("notebook_path", "")
        settings = body.get("settings", {})

        if not notebook_path:
            self.set_status(400)
            self.finish(json.dumps({"error": "notebook_path is required"}))
            return

        from ..agent.local_config import write_local_agent_config, AGENT_CONFIG_KEYS
        safe = {k: str(v) for k, v in settings.items() if k in AGENT_CONFIG_KEYS}
        try:
            path = write_local_agent_config(notebook_path, safe)
            self.set_header("Content-Type", "application/json")
            self.finish(json.dumps({"status": "ok", "path": str(path)}))
        except Exception as exc:
            self.set_status(500)
            self.finish(json.dumps({"error": str(exc)}))

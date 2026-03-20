"""GET /varys/agent/change/<change_id> — fetch full file change content."""
from __future__ import annotations

import json
import logging

from jupyter_server.base.handlers import JupyterHandler

log = logging.getLogger(__name__)


class AgentChangeHandler(JupyterHandler):
    """GET /varys/agent/change/<change_id>"""

    async def get(self, change_id: str):
        sessions = self.settings.get("agent_sessions", {})

        # Search all sessions for the change_id
        for operation_id, session in sessions.items():
            pending = session.get("pending_changes", {})
            fc = pending.get(change_id)
            if fc is not None:
                self.set_header("Content-Type", "application/json")
                self.finish(json.dumps({
                    "original_content": fc.original_content,
                    "new_content": fc.new_content,
                    "file_path": fc.file_path,
                    "change_type": fc.change_type,
                }))
                return

        self.set_status(404)
        self.set_header("Content-Type", "application/json")
        self.finish(json.dumps({"error": "Unknown change_id"}))

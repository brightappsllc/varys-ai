"""POST /varys/agent — programmatic access to the Varys File Agent.

For %%ai magic and future composite steps. Not called by the main chat UI.
"""
from __future__ import annotations

import json
import logging
import os

from jupyter_server.base.handlers import JupyterHandler
from tornado.web import authenticated

log = logging.getLogger(__name__)


class AgentHandler(JupyterHandler):
    """POST /varys/agent"""

    @authenticated
    async def post(self):
        try:
            body = json.loads(self.request.body)
        except json.JSONDecodeError:
            self.set_status(400)
            self.finish(json.dumps({"error": "Invalid JSON body"}))
            return

        task          = body.get("task", "").strip()
        notebook_path = body.get("notebook_path", "")
        operation_id  = body.get("operation_id", "")

        if not task:
            self.set_status(400)
            self.finish(json.dumps({"error": "task is required"}))
            return

        enabled = str(os.environ.get("VARYS_AGENT_ENABLED", "false")).lower() in ("1", "true", "yes")
        if not enabled:
            self.set_header("Content-Type", "application/json")
            self.finish(json.dumps({"error": "VARYS_AGENT_ENABLED is false. Enable Varys File Agent in Settings."}))
            return

        try:
            from ..agent.utils import validate_agent_config, resolve_working_directory, AgentConfigError, WorkingDirectoryError
            api_key, model = validate_agent_config()
            working_dir = resolve_working_directory(notebook_path, self.settings)
        except Exception as exc:
            self.set_header("Content-Type", "application/json")
            self.finish(json.dumps({"error": str(exc)}))
            return

        import uuid
        if not operation_id:
            operation_id = f"agent_{uuid.uuid4().hex[:8]}"

        # Simple non-streaming execution
        from ..agent.agent_runner import run as _run, AgentCallbacks
        from ..agent.tools import FileChange

        file_changes_out = []
        logs = []

        async def _noop_text(t): logs.append(("text", t))
        async def _noop_thought(t): pass
        async def _noop_progress(t): logs.append(("progress", t))
        async def _noop_fc(fc: FileChange): file_changes_out.append(fc)

        callbacks = AgentCallbacks(
            on_text_chunk=_noop_text,
            on_thought=_noop_thought,
            on_progress=_noop_progress,
            on_file_change=_noop_fc,
        )

        allowed_tools_str = os.environ.get("VARYS_AGENT_ALLOWED_TOOLS", "Read,Write,Edit")
        allowed_tools = [t.strip() for t in allowed_tools_str.split(",") if t.strip()]
        max_turns = int(os.environ.get("VARYS_AGENT_MAX_TURNS", "10"))
        max_tokens = int(os.environ.get("VARYS_AGENT_MAX_TOKENS", "8192"))

        system_prompt = "You are a helpful coding assistant. Work within the project directory."

        result = await _run(
            task=task,
            working_dir=working_dir,
            allowed_tools=allowed_tools,
            system_prompt=system_prompt,
            max_turns=max_turns,
            max_tokens=max_tokens,
            operation_id=operation_id,
            app_settings=self.settings,
            callbacks=callbacks,
            notebook_path=notebook_path,
        )

        self.set_header("Content-Type", "application/json")
        self.finish(json.dumps({
            "operation_id": operation_id,
            "file_changes": [
                {
                    "change_id": fc.change_id,
                    "file_path": fc.file_path,
                    "change_type": fc.change_type,
                }
                for fc in result.file_changes
            ],
            "files_read": result.files_read,
            "incomplete": result.incomplete,
            "turn_count": result.turn_count,
        }))

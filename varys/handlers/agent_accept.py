"""POST /varys/agent/accept — commit a staged file change to disk."""
from __future__ import annotations

import json
import logging
import os
import shutil
from datetime import datetime
from pathlib import Path

from jupyter_server.base.handlers import JupyterHandler
from tornado.web import authenticated

log = logging.getLogger(__name__)


def _write_audit_log(working_dir: str, session: dict, operation_id: str) -> None:
    """Write one complete JSONL audit line for a fully-resolved session."""
    try:
        log_dir = Path(working_dir) / ".jupyter-assistant" / "logs"
        log_dir.mkdir(parents=True, exist_ok=True)
        outcomes = session.get("outcomes", {})
        all_changes = session.get("all_changes", {})
        file_changes = []
        for change_id, outcome in outcomes.items():
            fc = all_changes.get(change_id) or session["pending_changes"].get(change_id)
            if fc:
                file_changes.append({
                    "file_path": fc.file_path if hasattr(fc, "file_path") else fc.get("file_path", ""),
                    "change_type": fc.change_type if hasattr(fc, "change_type") else fc.get("change_type", ""),
                    "outcome": outcome,
                })
            else:
                file_changes.append({"file_path": "unknown", "change_type": "unknown", "outcome": outcome})

        entry = {
            "timestamp": datetime.now().isoformat(),
            "trigger": session.get("trigger", "slash_command"),
            "operation_id": operation_id,
            "task_description": session.get("task_description", ""),
            "working_dir": working_dir,
            "tools_used": session.get("tools_used", []),
            "files_read": session.get("files_read", []),
            "bash_commands": session.get("bash_commands", []),
            "turn_count": session.get("turn_count", 0),
            "duration_seconds": session.get("duration_seconds", 0.0),
            "model": session.get("model", ""),
            "incomplete": session.get("incomplete", False),
            "file_changes": file_changes,
        }
        with open(log_dir / "agent_audit.jsonl", "a", encoding="utf-8") as fh:
            fh.write(json.dumps(entry) + "\n")
    except Exception as exc:
        log.warning("Failed to write audit log: %s", exc)


class AgentAcceptHandler(JupyterHandler):
    """POST /varys/agent/accept"""

    @authenticated
    async def post(self):
        try:
            body = json.loads(self.request.body)
        except json.JSONDecodeError:
            self.set_status(400)
            self.finish(json.dumps({"success": False, "error": "Invalid JSON body"}))
            return

        operation_id      = body.get("operation_id", "")
        change_id         = body.get("change_id", "")
        confirmed_content = body.get("confirmed_content")  # str | None
        confirmed_path    = body.get("confirmed_path", "")

        sessions = self.settings.get("agent_sessions", {})
        session  = sessions.get(operation_id)
        if session is None:
            self.set_header("Content-Type", "application/json")
            self.finish(json.dumps({"success": False, "error": "Unknown session"}))
            return

        pending = session.get("pending_changes", {})
        fc = pending.get(change_id)
        if fc is None:
            self.set_header("Content-Type", "application/json")
            self.finish(json.dumps({"success": False, "error": "Unknown change ID"}))
            return

        working_dir = session.get("working_dir", "")

        # Validate confirmed_path
        if not confirmed_path:
            confirmed_path = fc.file_path
        try:
            resolved_path = os.path.realpath(os.path.join(working_dir, confirmed_path))
        except Exception:
            self.set_header("Content-Type", "application/json")
            self.finish(json.dumps({"success": False, "error": "Invalid path"}))
            return

        real_wd = os.path.realpath(working_dir)
        if not (resolved_path == real_wd or resolved_path.startswith(real_wd + os.sep)):
            self.set_header("Content-Type", "application/json")
            self.finish(json.dumps({"success": False, "error": "Path traversal rejected"}))
            return

        # Determine write content: confirmed_content if not None, else FileChange.new_content
        write_content = confirmed_content if confirmed_content is not None else fc.new_content

        written_path = resolved_path
        try:
            if fc.change_type == "deleted":
                # Apply deletion now (was not done during preview).
                backup_dir = Path(working_dir) / ".varys_deleted"
                backup_dir.mkdir(parents=True, exist_ok=True)
                timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
                filename = os.path.basename(resolved_path)
                backup_path = backup_dir / f"{timestamp}_{filename}"
                if os.path.exists(resolved_path):
                    shutil.move(resolved_path, str(backup_path))
                    written_path = str(backup_path)
                else:
                    written_path = str(backup_path)
            # else: created / modified — already written to disk as preview;
            # no further write is needed.
        except Exception as exc:
            self.set_header("Content-Type", "application/json")
            self.finish(json.dumps({"success": False, "error": str(exc)}))
            return

        # Update session state
        session["outcomes"][change_id] = "accepted"
        del pending[change_id]
        session["resolved_count"] = session.get("resolved_count", 0) + 1

        # Check if session is fully resolved
        if session["resolved_count"] >= session.get("total_count", 0) and session.get("total_count", 0) > 0:
            _write_audit_log(working_dir, session, operation_id)
            del sessions[operation_id]

        self.set_header("Content-Type", "application/json")
        self.finish(json.dumps({"success": True, "written_path": written_path}))

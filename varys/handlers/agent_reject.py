"""POST /varys/agent/reject — reject a previewed file change and revert disk state."""
from __future__ import annotations

import json
import logging
import os
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
        for cid, outcome in outcomes.items():
            fc = all_changes.get(cid) or session["pending_changes"].get(cid)
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


class AgentRejectHandler(JupyterHandler):
    """POST /varys/agent/reject"""

    @authenticated
    async def post(self):
        try:
            body = json.loads(self.request.body)
        except json.JSONDecodeError:
            self.set_status(400)
            self.finish(json.dumps({"success": False, "error": "Invalid JSON body"}))
            return

        operation_id = body.get("operation_id", "")
        change_id    = body.get("change_id", "")

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

        # Revert the preview write so the file returns to its original state.
        working_dir = session.get("working_dir", "")
        abs_path = os.path.realpath(os.path.join(working_dir, fc.file_path))
        reverted_path: str | None = None
        try:
            if fc.change_type == "modified":
                # Restore original content atomically so a crash mid-revert
                # cannot leave the file empty or partial.
                tmp_path = abs_path + ".varys_revert_tmp"
                with open(tmp_path, "w", encoding="utf-8") as fh:
                    fh.write(fc.original_content or "")
                os.replace(tmp_path, abs_path)
                reverted_path = fc.file_path
                log.debug("Reverted modified file: %s", abs_path)
            elif fc.change_type == "created":
                # Delete the preview file — it did not exist before.
                if os.path.exists(abs_path):
                    os.remove(abs_path)
                log.debug("Removed preview-created file: %s", abs_path)
            # "deleted": no preview write was applied; nothing to revert.
        except Exception as exc:
            log.warning("Revert failed for %s: %s", fc.file_path, exc)

        session["outcomes"][change_id] = "rejected"
        del pending[change_id]
        session["resolved_count"] = session.get("resolved_count", 0) + 1

        # Check if session is fully resolved
        if session["resolved_count"] >= session.get("total_count", 0) and session.get("total_count", 0) > 0:
            _write_audit_log(working_dir, session, operation_id)
            del sessions[operation_id]

        self.set_header("Content-Type", "application/json")
        self.finish(json.dumps({"success": True, "reverted_path": reverted_path, "change_type": fc.change_type}))

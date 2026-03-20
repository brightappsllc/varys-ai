"""Repo scan store: caches background project scans.

run_background_scan() calls validate_agent_config() then run_read_only().
Stores result at ~/.jupyter-assistant/memory/projects/<md5>/repo_scan.json.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import tempfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

log = logging.getLogger(__name__)

# ── In-process warning queue ────────────────────────────────────────────────
# Background tasks (repo scan, etc.) push warnings here; the frontend polls
# GET /varys/warnings to retrieve and clear them.
import threading as _threading
import datetime as _datetime

_warnings_lock = _threading.Lock()
_pending_warnings: list[dict] = []


def push_warning(code: str, message: str, level: str = "warning") -> None:
    """Append a warning to the pending queue (thread-safe)."""
    entry = {
        "level": level,
        "code": code,
        "message": message,
        "timestamp": _datetime.datetime.now().isoformat(),
    }
    with _warnings_lock:
        _pending_warnings.append(entry)


def get_and_clear_warnings() -> list[dict]:
    """Return all pending warnings and clear the queue (thread-safe)."""
    with _warnings_lock:
        items = list(_pending_warnings)
        _pending_warnings.clear()
    return items


# Dirs excluded from file tree hash
_EXCLUDED_DIRS = {
    ".git", "__pycache__", "node_modules", ".venv", "venv", "env",
    ".tox", "dist", "build", ".varys_deleted",
}
_EXCLUDED_SUFFIXES = {".egg-info"}

MAX_HASH_DEPTH = 4


def _compute_file_tree_hash(working_dir: str) -> str:
    """Compute MD5 of sorted (relative_path, mtime) tuples, max depth 4.

    Excludes .git, __pycache__, node_modules, .venv, etc.
    Uses os.stat() only — does NOT read file contents.
    """
    entries: list[tuple[str, float]] = []

    def _walk(root: str, depth: int) -> None:
        if depth > MAX_HASH_DEPTH:
            return
        try:
            for name in os.listdir(root):
                if name in _EXCLUDED_DIRS:
                    continue
                if any(name.endswith(s) for s in _EXCLUDED_SUFFIXES):
                    continue
                full = os.path.join(root, name)
                rel  = os.path.relpath(full, working_dir)
                if os.path.isfile(full):
                    try:
                        mtime = os.stat(full).st_mtime
                        entries.append((rel, mtime))
                    except OSError:
                        pass
                elif os.path.isdir(full):
                    _walk(full, depth + 1)
        except PermissionError:
            pass

    _walk(working_dir, 0)
    entries.sort()
    raw = json.dumps(entries, sort_keys=True)
    return hashlib.md5(raw.encode()).hexdigest()


def _scan_store_path(working_dir: str) -> Path:
    """Return the path to repo_scan.json for this working_dir."""
    key = hashlib.md5(working_dir.encode()).hexdigest()
    store_dir = Path.home() / ".jupyter-assistant" / "memory" / "projects" / key
    store_dir.mkdir(parents=True, exist_ok=True)
    return store_dir / "repo_scan.json"


def load_repo_scan(working_dir: str) -> dict | None:
    """Load cached repo_scan.json or return None if absent/invalid."""
    path = _scan_store_path(working_dir)
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None


def is_scan_fresh(working_dir: str, current_hash: str) -> bool:
    """Return True if the cached scan hash matches current_hash."""
    data = load_repo_scan(working_dir)
    if data is None:
        return False
    return data.get("file_tree_hash") == current_hash


async def run_background_scan(
    working_dir: str,
    max_tokens: int = 8192,
    app_settings: dict | None = None,
    known_hash: str | None = None,
) -> None:
    """Run a background repo scan and save result to disk.

    Uses build_agent_provider() if app_settings is provided, otherwise falls
    back to Anthropic. ToolUseNotSupportedError and AgentConfigError are
    caught and result in a silent skip (no error banner shown to the user).

    known_hash: if the caller already computed the file tree hash, pass it here
    to avoid a redundant second walk of the project tree.
    """
    from .agent_runner import run_read_only, SCAN_SYSTEM_PROMPT
    from .provider_base import ToolUseNotSupportedError
    from .provider_factory import AgentConfigError

    max_scan_turns = int(os.environ.get("VARYS_AGENT_SCAN_MAX_TURNS", "5"))

    # For backward compat, if no app_settings, validate Anthropic config first
    if app_settings is None:
        from .utils import validate_agent_config
        from .utils import AgentConfigError as _LegacyConfigError
        try:
            validate_agent_config()
        except _LegacyConfigError as exc:
            log.info("Background scan skipped: %s", exc)
            return

    try:
        result_text = await run_read_only(
            task="Scan this project directory and return the JSON summary.",
            working_dir=working_dir,
            system_prompt=SCAN_SYSTEM_PROMPT,
            max_turns=max_scan_turns,
            max_tokens=max_tokens,
            app_settings=app_settings,
        )
    except (ToolUseNotSupportedError, AgentConfigError) as exc:
        log.info(
            "Background scan skipped (provider/model incompatible): %s", exc
        )
        _write_scan_audit(working_dir, success=False, error=str(exc))
        return
    except Exception as exc:
        err_str = str(exc)
        # Billing / quota errors are expected and not actionable — log at info level
        # but push a UI warning so the user sees it in the sidebar.
        if "credit balance" in err_str or "quota" in err_str.lower() or "429" in err_str:
            log.info("Background scan skipped (billing/quota): %s", exc)
            push_warning(
                code="billing_quota",
                message=(
                    "Anthropic API: credit balance too low. "
                    "Add credits at console.anthropic.com/settings/billing"
                ),
                level="error",
            )
        else:
            log.warning("Background scan run_read_only failed: %s", exc)
            push_warning(
                code="scan_failed",
                message=f"Background project scan failed: {exc}",
                level="warning",
            )
        _write_scan_audit(working_dir, success=False, error=err_str)
        return

    if not result_text.strip():
        log.info("Background scan returned empty text — keeping existing scan.")
        _write_scan_audit(working_dir, success=False, error="empty_result")
        return

    # Parse JSON
    text = result_text.strip()
    # Strip markdown code fence if model wrapped it
    if text.startswith("```"):
        lines = text.split("\n")
        text = "\n".join(
            l for l in lines
            if not l.startswith("```")
        ).strip()

    try:
        data = json.loads(text)
    except json.JSONDecodeError as exc:
        log.info("Background scan: invalid JSON (%s) — keeping existing scan.", exc)
        _write_scan_audit(working_dir, success=False, error=f"json_parse_error: {exc}")
        return

    # Attach file tree hash and save.
    # Reuse the hash computed by the caller (notebook_opened handler) when
    # available to avoid walking the project tree a second time.
    current_hash = known_hash or await asyncio.to_thread(_compute_file_tree_hash, working_dir)
    data["file_tree_hash"] = current_hash

    path = _scan_store_path(working_dir)
    try:
        _content = json.dumps(data, indent=2, ensure_ascii=False)
        fd, _tmp = tempfile.mkstemp(dir=path.parent, prefix=".tmp_varys_", suffix=".json")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as _fh:
                _fh.write(_content)
            os.replace(_tmp, path)
        except Exception:
            try:
                os.unlink(_tmp)
            except OSError:
                pass
            raise
        log.info("Background scan saved to %s", path)
    except Exception as exc:
        log.warning("Background scan: failed to save: %s", exc)
        _write_scan_audit(working_dir, success=False, error=str(exc))
        return

    _write_scan_audit(working_dir, success=True)


def _write_scan_audit(working_dir: str, success: bool, error: str = "") -> None:
    """Write a minimal audit log entry for a background scan."""
    import datetime as _dt
    try:
        from pathlib import Path as _P
        log_dir = _P(working_dir) / ".jupyter-assistant" / "logs"
        log_dir.mkdir(parents=True, exist_ok=True)
        entry = {
            "timestamp": _dt.datetime.now().isoformat(),
            "trigger": "background_scan",
            "operation_id": None,
            "task_description": "Background repo scan",
            "working_dir": working_dir,
            "tools_used": ["Read"],
            "files_read": [],
            "bash_commands": [],
            "turn_count": 0,
            "duration_seconds": 0.0,
            "model": os.environ.get("ANTHROPIC_CHAT_MODEL", ""),
            "incomplete": not success,
            "file_changes": [],
            "error": error if error else None,
        }
        with open(log_dir / "agent_audit.jsonl", "a", encoding="utf-8") as fh:
            fh.write(json.dumps(entry) + "\n")
    except Exception as exc:
        log.debug("Failed to write scan audit: %s", exc)

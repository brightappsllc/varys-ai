"""Filesystem tools for the Varys File Agent loop.

Each tool has two parts:
1. An async execution function (used by agent_runner.py)
2. An Anthropic tool JSON schema dict (used in messages.stream() calls)

All tools validate paths with os.path.realpath() and reject paths outside working_dir.
"""
from __future__ import annotations

import asyncio
import os
import re
import time
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    pass


# ── Dataclass for staged file changes ──────────────────────────────────────

@dataclass
class FileChange:
    """Represents a pending (staged) file change, not yet written to disk."""
    change_id: str          # UUID, assigned post-loop by agent_runner.run()
    file_path: str          # relative to working_dir
    change_type: str        # "created" | "modified" | "deleted"
    original_content: str | None
    new_content: str | None


# ── Path validation ─────────────────────────────────────────────────────────

def _validate_path(file_path: str, working_dir: str) -> str | None:
    """Resolve and validate file_path is within working_dir.

    Returns resolved absolute path on success, or None if invalid.
    """
    if not file_path or not file_path.strip():
        return None
    try:
        resolved = os.path.realpath(os.path.join(working_dir, file_path))
    except Exception:
        return None
    real_wd = os.path.realpath(working_dir)
    if not (resolved == real_wd or resolved.startswith(real_wd + os.sep)):
        return None
    return resolved


# ── Read tool ───────────────────────────────────────────────────────────────

async def execute_read(
    file_path: str,
    working_dir: str,
    file_path_staging: dict,
    files_read: list[str],
) -> str:
    """Read a file: checks staging dict first, then disk.

    Appends relative path to files_read only for disk reads (not staging hits).
    Returns file content string on success, or a structured error string.
    """
    resolved = _validate_path(file_path, working_dir)
    if resolved is None:
        return f"[Error: '{file_path}' is outside the working directory or invalid]"

    # Check staging dict first (read-your-own-writes)
    if resolved in file_path_staging:
        staged = file_path_staging[resolved]
        return staged.new_content or ""

    # Read from disk
    try:
        content = await asyncio.to_thread(_sync_read, resolved)
        rel = os.path.relpath(resolved, working_dir)
        files_read.append(rel)
        return content
    except FileNotFoundError:
        return f"[Error: file '{file_path}' not found]"
    except PermissionError:
        return f"[Error: permission denied reading '{file_path}']"
    except Exception as exc:
        return f"[Error reading '{file_path}': {exc}]"


def _sync_read(path: str) -> str:
    with open(path, encoding="utf-8", errors="replace") as fh:
        return fh.read()


READ_TOOL_SCHEMA = {
    "name": "Read",
    "description": (
        "Read the contents of a file in the project directory. "
        "Returns the file content as a string."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "file_path": {
                "type": "string",
                "description": "Absolute path to the file. Always use the exact absolute path — never shorten to a basename.",
            }
        },
        "required": ["file_path"],
    },
}


# ── Write tool ──────────────────────────────────────────────────────────────

async def execute_write(
    file_path: str,
    content: str,
    working_dir: str,
    file_path_staging: dict,
) -> str:
    """Stage a complete file write. Does NOT touch disk.

    Captures original content from disk if the file exists.
    Stores FileChange in file_path_staging, replacing any previous entry.
    Returns "staged" on success or an error string.
    """
    resolved = _validate_path(file_path, working_dir)
    if resolved is None:
        return f"[Error: '{file_path}' is outside the working directory or invalid]"

    # Determine change_type and capture original
    original_content: str | None = None
    if os.path.isfile(resolved):
        try:
            original_content = await asyncio.to_thread(_sync_read, resolved)
            change_type = "modified"
        except Exception:
            change_type = "modified"
    else:
        change_type = "created"

    file_path_staging[resolved] = FileChange(
        change_id="",   # assigned post-loop
        file_path=os.path.relpath(resolved, working_dir),
        change_type=change_type,
        original_content=original_content,
        new_content=content,
    )
    return "staged"


WRITE_TOOL_SCHEMA = {
    "name": "Write",
    "description": (
        "Write (or overwrite) a file with the given content. "
        "The change is staged and NOT written to disk until the user accepts it. "
        "PREFERRED for: creating new files, adding new functions/classes, or any task "
        "where you have the full desired content. "
        "When the task message already includes the current file content, construct "
        "the new full content and call Write — do NOT call Read first."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "file_path": {
                "type": "string",
                "description": "Absolute path to the file. Always use the exact absolute path provided in the task — never shorten to a basename.",
            },
            "content": {
                "type": "string",
                "description": "The complete new content for the file.",
            },
        },
        "required": ["file_path", "content"],
    },
}


# ── Edit tool ───────────────────────────────────────────────────────────────

async def execute_edit(
    file_path: str,
    old_string: str,
    new_string: str,
    working_dir: str,
    file_path_staging: dict,
) -> str:
    """Apply a string substitution to a file (staging dict first, then disk).

    This internal read does NOT append to files_read.
    Returns the resulting content string, or an error string.
    """
    resolved = _validate_path(file_path, working_dir)
    if resolved is None:
        return f"[Error: '{file_path}' is outside the working directory or invalid]"

    # Read current content (staging first, then disk) — internal, no files_read append
    if resolved in file_path_staging:
        current = file_path_staging[resolved].new_content or ""
        original_for_fc = file_path_staging[resolved].original_content
        was_created = file_path_staging[resolved].change_type == "created"
    else:
        try:
            current = await asyncio.to_thread(_sync_read, resolved)
            original_for_fc = current
            was_created = False
        except FileNotFoundError:
            return f"[Error: file '{file_path}' not found]"
        except Exception as exc:
            return f"[Error reading '{file_path}': {exc}]"

    if old_string not in current:
        return (
            f"[Error: the string to replace was not found in '{file_path}'. "
            "Use Read first to verify the exact content before editing.]"
        )

    updated = current.replace(old_string, new_string, 1)

    file_path_staging[resolved] = FileChange(
        change_id="",
        file_path=os.path.relpath(resolved, working_dir),
        change_type="created" if was_created else "modified",
        original_content=original_for_fc,
        new_content=updated,
    )
    return updated


EDIT_TOOL_SCHEMA = {
    "name": "Edit",
    "description": (
        "Replace the first occurrence of old_string with new_string in a file. "
        "The change is staged. old_string must match the file content exactly "
        "(character-for-character, including indentation and newlines). "
        "If the task message already contains the file content, use that — "
        "do NOT call Read before Edit. "
        "If you need to ADD new content (not replace existing lines), use Write instead."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "file_path": {
                "type": "string",
                "description": "Absolute path to the file. Always use the exact absolute path — never shorten to a basename.",
            },
            "old_string": {
                "type": "string",
                "description": "The exact string to replace (must exist verbatim in the file).",
            },
            "new_string": {
                "type": "string",
                "description": "The replacement string.",
            },
        },
        "required": ["file_path", "old_string", "new_string"],
    },
}


# ── Bash tool ───────────────────────────────────────────────────────────────

async def execute_bash(
    command: str,
    working_dir: str,
    bash_context: "BashContext | None" = None,
) -> tuple[str, "BashRisk | None"]:
    """Run a shell command with cwd=working_dir, 30s timeout.

    Returns (output, risk) where:
      output — combined stdout+stderr truncated to 4000 chars, or an error string.
      risk   — BashRisk from bash_guard (None when guard is disabled / SAFE).

    Raises BlockedCommandError when the guard returns BLOCK.
    """
    from ..bash_guard import analyze_command, RiskLevel, BlockedCommandError, BashContext

    ctx = bash_context if bash_context is not None else BashContext()
    risk = analyze_command(command, ctx)

    if risk.risk_level is RiskLevel.BLOCK:
        raise BlockedCommandError(
            f"Command blocked by Varys safety guard — {risk.reason}: {command!r}"
        )

    # WARN and SAFE both execute; caller attaches warn_reason to BashOutput.
    reported_risk: "BashRisk | None" = risk if risk.risk_level is RiskLevel.WARN else None

    try:
        proc = await asyncio.create_subprocess_shell(
            command,
            cwd=working_dir,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        try:
            stdout_b, stderr_b = await asyncio.wait_for(proc.communicate(), timeout=30.0)
        except asyncio.TimeoutError:
            try:
                proc.kill()
            except Exception:
                pass
            return f"[Error: command timed out after 30 seconds: {command!r}]", reported_risk

        combined = (stdout_b or b"").decode("utf-8", errors="replace") + (stderr_b or b"").decode("utf-8", errors="replace")
        return combined[:4000], reported_risk
    except Exception as exc:
        return f"[Error running command: {exc}]", reported_risk


# Re-export guard types so callers can import from tools if preferred
try:
    from ..bash_guard import BashContext, BashRisk  # noqa: F401
except ImportError:
    pass


BASH_TOOL_SCHEMA = {
    "name": "Bash",
    "description": (
        "Run a shell command in the project directory. "
        "Use sparingly — prefer Read/Write/Edit for file operations. "
        "30-second timeout. Output truncated to 4000 chars."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "command": {
                "type": "string",
                "description": "The shell command to run.",
            }
        },
        "required": ["command"],
    },
}

# ── Glob tool ────────────────────────────────────────────────────────────────

_GLOB_MAX_RESULTS = 300
_GLOB_TIMEOUT_SECS = 15


def _sync_glob(base: str, pattern: str, real_wd: str) -> tuple[list[str], bool]:
    """Return (relative_paths, timed_out) for files matching *pattern* under *base*.

    Iterates the rglob generator lazily so it stops as soon as the deadline or
    result cap is hit — avoids materialising millions of paths up front.
    """
    deadline = time.monotonic() + _GLOB_TIMEOUT_SECS
    base_path = Path(base)
    results: list[str] = []
    timed_out = False
    try:
        for h in base_path.rglob(pattern):
            if time.monotonic() > deadline:
                timed_out = True
                break
            real_h = os.path.realpath(h)
            if real_h == real_wd or real_h.startswith(real_wd + os.sep):
                results.append(os.path.relpath(real_h, real_wd))
            if len(results) >= _GLOB_MAX_RESULTS:
                break
    except Exception:
        pass
    return sorted(results), timed_out


async def execute_glob(
    pattern: str,
    working_dir: str,
    path: str = "",
) -> str:
    """Find files/dirs matching a glob pattern within working_dir.

    Returns newline-separated relative paths (up to 300 results).
    Times out after 15 seconds and returns partial results with a notice.
    """
    real_wd = os.path.realpath(working_dir)
    base = real_wd if not path else os.path.realpath(os.path.join(working_dir, path))
    if not (base == real_wd or base.startswith(real_wd + os.sep)):
        return f"[Error: path '{path}' is outside the working directory]"
    if not os.path.isdir(base):
        return f"[Error: directory '{path}' not found]"

    results, timed_out = await asyncio.to_thread(_sync_glob, base, pattern, real_wd)

    if not results:
        if timed_out:
            return f"[Timed out after {_GLOB_TIMEOUT_SECS}s — no results collected. Try a more specific pattern or path.]"
        return f"No files matching '{pattern}'"
    out = "\n".join(results)
    notes = []
    if len(results) == _GLOB_MAX_RESULTS:
        notes.append(f"capped at {_GLOB_MAX_RESULTS} results")
    if timed_out:
        notes.append(f"timed out after {_GLOB_TIMEOUT_SECS}s — results may be incomplete")
    if notes:
        out += f"\n… ({', '.join(notes)})"
    return out


GLOB_TOOL_SCHEMA = {
    "name": "Glob",
    "description": (
        "Find files or directories whose path matches a glob pattern. "
        "Use this to discover which files exist before deciding what to read. "
        "Supports ** for recursive matching (e.g. '**/*.py', 'src/**/*.ts', '*.json'). "
        "Returns paths relative to the project root, sorted alphabetically."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "pattern": {
                "type": "string",
                "description": (
                    "Glob pattern. Examples: '*.py', '**/*.ts', 'tests/**/*_test.py'. "
                    "** matches any number of path segments."
                ),
            },
            "path": {
                "type": "string",
                "description": (
                    "Optional subdirectory to search in, relative to the project root. "
                    "Defaults to the project root."
                ),
            },
        },
        "required": ["pattern"],
    },
}


# ── Grep tool ─────────────────────────────────────────────────────────────────

_GREP_MAX_MATCHES = 100
_GREP_TIMEOUT_SECS = 15


def _sync_grep(
    pattern: str,
    base: str,
    include: str,
    ignore_case: bool,
    real_wd: str,
) -> str:
    deadline = time.monotonic() + _GREP_TIMEOUT_SECS
    flags = re.IGNORECASE if ignore_case else 0
    try:
        regex = re.compile(pattern, flags)
    except re.error as exc:
        return f"[Error: invalid regex '{pattern}': {exc}]"

    # ── File discovery (lazy iteration to avoid materialising millions of paths) ──
    if os.path.isfile(base):
        files = [base]
    else:
        glob_pat = include if include else "*"
        files = []
        try:
            for p in Path(base).rglob(glob_pat):
                if time.monotonic() > deadline:
                    return (
                        f"[Timed out after {_GREP_TIMEOUT_SECS}s during file discovery — "
                        "try a more specific path or include filter]"
                    )
                if p.is_file():
                    real_p = os.path.realpath(str(p))
                    if real_p == real_wd or real_p.startswith(real_wd + os.sep):
                        files.append(str(p))
        except Exception:
            pass

    # ── Search phase ─────────────────────────────────────────────────────────
    results: list[str] = []
    timed_out = False
    for file_path in sorted(files):
        if time.monotonic() > deadline:
            timed_out = True
            break
        rel = os.path.relpath(file_path, real_wd)
        try:
            with open(file_path, encoding="utf-8", errors="replace") as fh:
                for lineno, line in enumerate(fh, 1):
                    if regex.search(line):
                        results.append(f"{rel}:{lineno}: {line.rstrip()}")
                        if len(results) >= _GREP_MAX_MATCHES:
                            break
        except Exception:
            pass
        if len(results) >= _GREP_MAX_MATCHES:
            break

    if not results:
        if timed_out:
            return f"[Timed out after {_GREP_TIMEOUT_SECS}s — no matches found before timeout. Try a more specific path or include filter.]"
        return f"No matches for '{pattern}'"
    out = "\n".join(results)
    notes = []
    if len(results) == _GREP_MAX_MATCHES:
        notes.append(f"output capped at {_GREP_MAX_MATCHES} matches")
    if timed_out:
        notes.append(f"timed out after {_GREP_TIMEOUT_SECS}s — results may be incomplete")
    if notes:
        out += f"\n… ({', '.join(notes)})"
    return out


async def execute_grep(
    pattern: str,
    working_dir: str,
    path: str = "",
    include: str = "",
    ignore_case: bool = False,
) -> str:
    """Search files for a regex pattern; returns file:line: content lines."""
    real_wd = os.path.realpath(working_dir)
    base = real_wd if not path else os.path.realpath(os.path.join(working_dir, path))
    if not (base == real_wd or base.startswith(real_wd + os.sep)):
        return f"[Error: path '{path}' is outside the working directory]"

    return await asyncio.to_thread(_sync_grep, pattern, base, include, ignore_case, real_wd)


GREP_TOOL_SCHEMA = {
    "name": "Grep",
    "description": (
        "Search for a regex (or plain string) pattern across files and return "
        "matching lines with file path and line number. "
        "Use this to efficiently locate relevant code in a large codebase before "
        "deciding which files to Read — far faster than reading every file. "
        "Results are capped at 100 matches."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "pattern": {
                "type": "string",
                "description": "Regular expression (or literal string) to search for.",
            },
            "path": {
                "type": "string",
                "description": (
                    "Optional file or directory to search in, relative to the project root. "
                    "Defaults to the entire project root."
                ),
            },
            "include": {
                "type": "string",
                "description": (
                    "Optional glob to restrict which files are searched, e.g. '*.py' or '*.ts'. "
                    "Ignored when 'path' points to a single file."
                ),
            },
            "ignore_case": {
                "type": "boolean",
                "description": "If true, the search is case-insensitive. Defaults to false.",
            },
        },
        "required": ["pattern"],
    },
}


# ── Tool registry ────────────────────────────────────────────────────────────

ALL_TOOL_SCHEMAS = {
    "Read":  READ_TOOL_SCHEMA,
    "Write": WRITE_TOOL_SCHEMA,
    "Edit":  EDIT_TOOL_SCHEMA,
    "Bash":  BASH_TOOL_SCHEMA,
    "Glob":  GLOB_TOOL_SCHEMA,
    "Grep":  GREP_TOOL_SCHEMA,
}

# Provider-agnostic ToolDefinition objects derived from the Anthropic-format
# schemas above.  The tool_schemas.py module converts these to the native
# format for each provider (Anthropic, OpenAI, Bedrock, etc.).
from .tool_definition import ToolDefinition  # noqa: E402

ALL_TOOL_DEFINITIONS: dict[str, ToolDefinition] = {
    name: ToolDefinition(
        name=schema["name"],
        description=schema["description"],
        parameters=schema["input_schema"],
    )
    for name, schema in ALL_TOOL_SCHEMAS.items()
}

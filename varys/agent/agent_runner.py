"""Agent runner for the Varys File Agent feature.

Two entry points:
  run()           — full session with file staging and callbacks.
  run_read_only() — lightweight, background scans only.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Awaitable, Callable
from uuid import uuid4

from .tools import (
    FileChange,
    execute_read, execute_write, execute_edit, execute_bash,
    execute_glob, execute_grep,
    ALL_TOOL_DEFINITIONS,
)

log = logging.getLogger(__name__)

# Maximum tool-output size passed back to the LLM per call.  Prevents
# prompt-injection via huge tool results and limits accidental secret exposure.
_MAX_TOOL_OUTPUT_CHARS = 50_000


# ── SCAN_SYSTEM_PROMPT (module-level constant, not a skill file) ──────────────

SCAN_SYSTEM_PROMPT = """\
You are a project-analysis assistant. Your task is to scan this project directory
and produce a JSON summary. Read key files (README, requirements.txt, setup.py,
pyproject.toml, main Python files) to understand the project.

Return ONLY a valid JSON object in this exact schema, with NO surrounding text:

{
  "project_name": "<name>",
  "python_files": [{"path": "src/utils.py", "description": "one-line summary"}],
  "notebook_imports": [{"module": "utils", "symbols": ["fn1", "fn2"]}],
  "key_files": ["README.md", "requirements.txt"],
  "data_dirs": ["data/raw", "data/processed"]
}

Rules:
- python_files: max 20 entries; omit __init__.py, test files.
- notebook_imports: local modules imported by .ipynb notebooks.
- key_files: max 10 entries.
- data_dirs: max 5 entries.
- Return empty arrays if none found.
- No markdown, no prose, no explanation — JSON only.
"""


# ── Dataclasses ───────────────────────────────────────────────────────────────

@dataclass
class AgentCallbacks:
    """Callback hooks for streaming agent events to the SSE pipeline.

    Exactly four fields. No on_done — run() returns AgentTaskResult instead.
    """
    on_text_chunk:  Callable[[str], Awaitable[None]]
    on_thought:     Callable[[str], Awaitable[None]]
    on_progress:    Callable[[str], Awaitable[None]]
    on_file_change: Callable[[FileChange], Awaitable[None]]


@dataclass
class BashOutput:
    command: str
    stdout: str
    stderr: str
    timed_out: bool
    warn_reason: str | None = None   # set when bash_guard returned WARN for this command


@dataclass
class BlockedCommand:
    command: str
    reason: str


@dataclass
class AgentTaskResult:
    file_changes: list[FileChange]
    files_read: list[str]       # deduplicated, disk reads only
    bash_outputs: list[BashOutput]
    incomplete: bool
    turn_count: int
    duration_seconds: float
    model: str
    timed_out: bool = False     # True when the wall-clock timeout fired
    # Cumulative token usage across all turns in this run
    token_usage: dict = field(default_factory=lambda: {"input": 0, "output": 0})
    # Commands intercepted by bash_guard before execution
    blocked_commands: list[BlockedCommand] = field(default_factory=list)
    # Structured error fields (all None for successful runs)
    error: str | None = None
    error_type: str | None = None          # "tool_use_not_supported" | "api_error" | etc.
    error_provider: str | None = None
    error_model: str | None = None
    error_suggestion: str | None = None


# ── Tool label helper ─────────────────────────────────────────────────────────

def tool_label(tool_name: str, inputs: dict) -> str:
    """Human-readable progress label for a tool call."""
    if tool_name == "Read":
        path = inputs.get("file_path", "file")
        return f"Reading {path}…"
    if tool_name in ("Write", "Edit"):
        path = inputs.get("file_path", "file")
        return f"Staging edits to {path}…"
    if tool_name == "Bash":
        return "Running checks…"
    if tool_name == "Glob":
        pattern = inputs.get("pattern", "*")
        return f"Globbing {pattern}…"
    if tool_name == "Grep":
        pattern = inputs.get("pattern", "")
        scope = inputs.get("path", "") or "project"
        return f"Searching for {pattern!r} in {scope}…"
    return f"Calling {tool_name}…"



# ── run() — full session ──────────────────────────────────────────────────────

async def run(
    task: str,
    working_dir: str,
    allowed_tools: list[str],
    system_prompt: str,
    max_turns: int,
    max_tokens: int,
    timeout_secs: float,
    operation_id: str,
    app_settings: dict,
    callbacks: AgentCallbacks,
    notebook_path: str = "",
    command: str = "",
    local_cfg: dict | None = None,
) -> AgentTaskResult:
    """Run a full file-agent session with file staging and callbacks.

    command — the slash command string ("/file_agent", "/file_agent_find", etc.).
              Used to set require_tool_use correctly for reactive detection.
    local_cfg — project-local env overrides (from local_varys.env), used to
                select the provider per-project.
    """
    from .provider_factory import build_agent_provider, AgentConfigError
    from .provider_base import TextDelta, ThoughtDelta, ToolCall as ProviderToolCall
    from .provider_base import TurnEnd, ToolUseNotSupportedError

    # ── Initialise state ─────────────────────────────────────────────────────
    file_path_staging: dict[str, FileChange] = {}
    files_read: list[str] = []
    bash_outputs: list[BashOutput] = []
    blocked_commands: list[BlockedCommand] = []
    incomplete = False
    timed_out  = False
    _provider_error: str | None = None   # set when stop_reason == "error"
    turn_count = 0
    start_time = time.monotonic()
    total_input_tokens = 0
    total_output_tokens = 0

    # Determine whether this is a skill-triggered session.
    # Skill sessions (/powerpoint, /docx, custom skills) skip Pass 2
    # interpreter detection in bash_guard — their Python/bash calls are
    # intentional and pre-audited by the skill author.
    _FILE_AGENT_COMMANDS = {"/file_agent", "/file_agent_find", "/file_agent_save"}
    is_skill_session = bool(command) and command not in _FILE_AGENT_COMMANDS

    from ..bash_guard import BashContext, audit_log as _bash_audit_log
    _bash_ctx = BashContext(is_skill_session=is_skill_session)

    # Derive nb_base for audit logging (best-effort; None silences the logger)
    _nb_base: Path | None = None
    if notebook_path:
        try:
            from ..utils.paths import nb_base as _nb_base_fn
            _nb_base = _nb_base_fn(working_dir, notebook_path)
        except Exception:
            pass

    # Build tool callables
    async def _read(fp: str) -> str:
        return await execute_read(fp, working_dir, file_path_staging, files_read)

    async def _write(fp: str, content: str) -> str:
        return await execute_write(fp, content, working_dir, file_path_staging)

    async def _edit(fp: str, old: str, new: str) -> str:
        return await execute_edit(fp, old, new, working_dir, file_path_staging)

    async def _bash(cmd: str) -> str:
        from ..bash_guard import BlockedCommandError
        try:
            output, risk = await execute_bash(cmd, working_dir, _bash_ctx)
            warn_reason = risk.reason if risk is not None else None
            if risk is not None:
                _bash_audit_log(risk, was_blocked=False, nb_base=_nb_base)
            bash_outputs.append(BashOutput(
                command=cmd,
                stdout=output,
                stderr="",
                timed_out="timed out" in output.lower(),
                warn_reason=warn_reason,
            ))
            # Inject a structured WARN notice so the LLM knows the command ran
            # but was flagged — it can adapt (safer alternative, ask user, etc.)
            if warn_reason:
                notice = json.dumps({
                    "bash_guard": "WARN",
                    "reason": warn_reason,
                    "command": cmd,
                    "hint": "Command executed, but it was flagged as potentially risky. Consider a safer alternative if the intent allows.",
                }, ensure_ascii=False)
                return notice + "\n\n" + output
            return output
        except BlockedCommandError:
            # Re-analyse to get the clean reason/pattern (cheap pure-regex call).
            from ..bash_guard import analyze_command as _analyze
            blocked_risk = _analyze(cmd, _bash_ctx)
            reason = blocked_risk.reason or "unsafe command pattern matched"
            _bash_audit_log(blocked_risk, was_blocked=True, nb_base=_nb_base)
            blocked_commands.append(BlockedCommand(command=cmd, reason=reason))
            # Return a structured denial — the LLM sees this as a tool result,
            # not an execution crash, so it can adapt: try a safer alternative
            # or ask the user for explicit permission.
            return json.dumps({
                "status": "denied",
                "bash_guard": "BLOCK",
                "reason": reason,
                "command": cmd,
                "hint": "Command was not executed. Try a safer alternative, or ask the user for explicit permission to run this command.",
            }, ensure_ascii=False)

    async def _glob(pattern: str, path: str = "") -> str:
        return await execute_glob(pattern, working_dir, path)

    async def _grep(pattern: str, path: str = "", include: str = "", ignore_case: bool = False) -> str:
        return await execute_grep(pattern, working_dir, path, include, ignore_case)

    tool_executors = {
        "Read":  lambda inp: _read(inp["file_path"]),
        "Write": lambda inp: _write(inp["file_path"], inp["content"]),
        "Edit":  lambda inp: _edit(inp["file_path"], inp["old_string"], inp["new_string"]),
        "Bash":  lambda inp: _bash(inp["command"]),
        "Glob":  lambda inp: _glob(inp["pattern"], inp.get("path", "")),
        "Grep":  lambda inp: _grep(inp["pattern"], inp.get("path", ""), inp.get("include", ""), inp.get("ignore_case", False)),
    }

    # Build provider-agnostic tool definitions for the allowed tools
    tool_defs = [ALL_TOOL_DEFINITIONS[t] for t in allowed_tools if t in ALL_TOOL_DEFINITIONS]

    # Create session dict entry
    sessions = app_settings.setdefault("agent_sessions", {})
    sessions[operation_id] = {
        "working_dir": working_dir,
        "notebook_path": notebook_path,
        "pending_changes": {},
        "all_changes": {},
        "outcomes": {},
        "created_at": datetime.now(),
        "resolved_count": 0,
        "total_count": 0,
    }

    # Build the provider — raises AgentConfigError for missing credentials or
    # unsupported provider, ToolUseNotSupportedError for incompatible models.
    try:
        provider = build_agent_provider(app_settings, local_cfg or {})
    except ToolUseNotSupportedError as e:
        return AgentTaskResult(
            file_changes=[], files_read=[], bash_outputs=[],
            incomplete=True, turn_count=0,
            duration_seconds=time.monotonic() - start_time,
            model=e.model,
            error=str(e), error_type="tool_use_not_supported",
            error_provider=e.provider, error_model=e.model,
            error_suggestion=e.suggestion,
        )
    except AgentConfigError as e:
        return AgentTaskResult(
            file_changes=[], files_read=[], bash_outputs=[],
            incomplete=True, turn_count=0,
            duration_seconds=time.monotonic() - start_time,
            model="",
            error=str(e), error_type="agent_config_error",
        )

    messages = provider.make_initial_messages(task)
    require_tool_use = command in ("/file_agent", "/file_agent_save")
    # Derive model name for the result (best-effort; providers set this internally)
    _model_name = getattr(provider, "_model", getattr(provider, "_model_id", ""))

    # ── Multi-turn loop ───────────────────────────────────────────────────────
    try:
        while turn_count < max_turns:
            # Time-limit check — abort before issuing a new LLM call if the
            # wall-clock budget is exhausted.  We never interrupt a call that
            # is already in-flight; we only prevent new ones from starting.
            elapsed = time.monotonic() - start_time
            if elapsed >= timeout_secs:
                timed_out  = True
                incomplete = True
                await callbacks.on_progress(
                    f"Time limit ({timeout_secs:.0f}s) reached — showing partial results."
                )
                break

            accumulated_text = ""
            collected_calls: list[tuple[ProviderToolCall, str]] = []
            continue_loop = False

            async for event in provider.stream_turn(
                messages, tool_defs, system_prompt, max_tokens,
                require_tool_use=require_tool_use,
            ):
                if isinstance(event, TextDelta):
                    accumulated_text += event.text
                    await callbacks.on_text_chunk(event.text)
                    await asyncio.sleep(0)

                elif isinstance(event, ThoughtDelta):
                    await callbacks.on_thought(event.text)
                    await asyncio.sleep(0)

                elif isinstance(event, ProviderToolCall):
                    label = tool_label(event.tool_name, event.tool_input)
                    await callbacks.on_progress(label)
                    await asyncio.sleep(0)

                    if event.tool_name in tool_executors and event.tool_name in allowed_tools:
                        try:
                            result_str = await tool_executors[event.tool_name](event.tool_input)
                        except Exception as exc:
                            result_str = f"[Tool error: {exc}]"
                        # Bash output (including WARN) is recorded inside _bash();
                        # no duplicate append here.
                    else:
                        result_str = f"[Error: tool '{event.tool_name}' is not permitted in this session]"

                    if len(result_str) > _MAX_TOOL_OUTPUT_CHARS:
                        result_str = result_str[:_MAX_TOOL_OUTPUT_CHARS] + "\n[...output truncated]"
                    collected_calls.append((event, result_str))

                elif isinstance(event, TurnEnd):
                    # Accumulate token usage; provider.last_usage holds this turn's counts.
                    lu = getattr(provider, "last_usage", None) or {}
                    total_input_tokens  += lu.get("input",  0)
                    total_output_tokens += lu.get("output", 0)

                    if event.stop_reason == "tool_use":
                        messages.append(
                            provider.build_assistant_history_message(
                                accumulated_text,
                                [tc for tc, _ in collected_calls],
                            )
                        )
                        result_msg = provider.build_tool_result_message(
                            [tc for tc, _ in collected_calls],
                            [r for _, r in collected_calls],
                        )
                        if isinstance(result_msg, list):
                            messages.extend(result_msg)
                        else:
                            messages.append(result_msg)
                        continue_loop = True

                    elif event.stop_reason == "error":
                        log.error("Agent provider error (turn %d): %s", turn_count, event.error_message)
                        await callbacks.on_progress("API error from provider. Stopping.")
                        incomplete = True
                        _provider_error = event.error_message

            turn_count += 1
            if not continue_loop:
                break

        else:
            # Safety backstop: exited via turn_count >= max_turns
            incomplete = True
            await callbacks.on_progress("Turn limit reached — showing partial results.")

    except ToolUseNotSupportedError as e:
        return AgentTaskResult(
            file_changes=[], files_read=[], bash_outputs=[],
            incomplete=True, turn_count=turn_count,
            duration_seconds=time.monotonic() - start_time,
            model=_model_name,
            error=str(e), error_type="tool_use_not_supported",
            error_provider=e.provider, error_model=e.model,
            error_suggestion=e.suggestion,
        )

    except Exception as exc:
        log.error("Unexpected error in agent run(): %s", exc, exc_info=True)
        await callbacks.on_progress(f"Unexpected error: {exc}")

    # ── Post-loop: assign change_ids, fire on_file_change, cleanup ───────────
    file_changes: list[FileChange] = []
    session = sessions.get(operation_id, {})

    for resolved_path, staged_fc in file_path_staging.items():
        change_id = str(uuid4())
        rel_path = os.path.relpath(resolved_path, working_dir)
        fc = FileChange(
            change_id=change_id,
            file_path=rel_path,
            change_type=staged_fc.change_type,
            original_content=staged_fc.original_content,
            new_content=staged_fc.new_content,
        )

        # Preview write: apply created/modified changes to disk NOW so the
        # user sees the actual file content before accepting or declining.
        # Deletions are NOT applied here — they only happen on Accept.
        # Uses an atomic temp-file + os.replace() so that a crash mid-write
        # cannot leave a 0-byte or partial file on disk.
        if staged_fc.change_type in ("created", "modified"):
            try:
                parent = Path(resolved_path).parent
                parent.mkdir(parents=True, exist_ok=True)
                tmp_path = resolved_path + ".varys_preview_tmp"
                with open(tmp_path, "w", encoding="utf-8") as _fh:
                    _fh.write(staged_fc.new_content or "")
                os.replace(tmp_path, resolved_path)
                log.debug("Preview write: %s (%s)", rel_path, staged_fc.change_type)
            except Exception as _exc:
                log.warning("Preview write failed for %s: %s", resolved_path, _exc)
                try:
                    os.unlink(tmp_path)
                except OSError:
                    pass

        if session:
            session["pending_changes"][change_id] = fc
            session["all_changes"][change_id] = fc
        file_changes.append(fc)
        await callbacks.on_file_change(fc)

    total = len(file_path_staging)
    if session:
        session["total_count"] = total

    # Zero-change cleanup
    if total == 0 and operation_id in sessions:
        del sessions[operation_id]

    # Deduplicate files_read preserving order
    seen: dict = dict.fromkeys(files_read)
    deduped_files_read = list(seen.keys())

    return AgentTaskResult(
        file_changes=file_changes,
        files_read=deduped_files_read,
        bash_outputs=bash_outputs,
        blocked_commands=blocked_commands,
        incomplete=incomplete,
        timed_out=timed_out,
        turn_count=turn_count,
        duration_seconds=time.monotonic() - start_time,
        model=_model_name,
        token_usage={"input": total_input_tokens, "output": total_output_tokens},
        # Populated only when a provider API error (e.g. billing, network) stopped the run
        error=_provider_error,
        error_type="provider_api_error" if _provider_error else None,
    )


# ── run_read_only() — background scans only ────────────────────────────────

async def run_read_only(
    task: str,
    working_dir: str,
    system_prompt: str,
    max_turns: int,
    max_tokens: int,
    app_settings: dict | None = None,
) -> str:
    """Lightweight runner for background scans only.

    - No operation_id, no AgentCallbacks.
    - No session dict entry created or modified.
    - No file_path_staging, no post-loop on_file_change.
    - Returns final assistant text string, or "" on any error.
    - Only Read and Glob tools are offered regardless of VARYS_AGENT_ALLOWED_TOOLS.

    app_settings — when provided, uses build_agent_provider() to select the
    configured provider. When None, falls back to Anthropic. ToolUseNotSupportedError
    and AgentConfigError are raised to the caller (repo_scan_store handles them
    silently for background scans).
    """
    from .provider_base import TextDelta, ToolCall as ProviderToolCall, TurnEnd

    no_staging: dict = {}
    no_files_tracked: list = []

    # Read-only scan: only Read + Glob tools
    ro_tool_defs = [
        ALL_TOOL_DEFINITIONS[t]
        for t in ("Read", "Glob")
        if t in ALL_TOOL_DEFINITIONS
    ]
    ro_allowed = {"Read", "Glob"}

    # Select provider
    if app_settings is not None:
        from .provider_factory import build_agent_provider
        provider = build_agent_provider(app_settings, {})
    else:
        # Backward-compatible default: Anthropic
        from .utils import validate_agent_config
        api_key, model = validate_agent_config()
        from .providers.anthropic_provider import AnthropicAgentProvider
        provider = AnthropicAgentProvider(api_key=api_key, model=model)

    messages = provider.make_initial_messages(task)
    final_text = ""
    turn_count = 0

    ro_executors = {
        "Read": lambda inp: execute_read(inp["file_path"], working_dir, no_staging, no_files_tracked),
        "Glob": lambda inp: execute_glob(inp["pattern"], working_dir, inp.get("path", "")),
    }

    try:
        while turn_count < max_turns:
            accumulated_text = ""
            collected_calls: list[tuple[ProviderToolCall, str]] = []
            continue_loop = False

            async for event in provider.stream_turn(
                messages, ro_tool_defs, system_prompt, max_tokens,
                require_tool_use=False,
            ):
                if isinstance(event, TextDelta):
                    accumulated_text += event.text
                    final_text += event.text

                elif isinstance(event, ProviderToolCall):
                    if event.tool_name in ro_allowed:
                        try:
                            result_str = await ro_executors[event.tool_name](event.tool_input)
                        except Exception as exc:
                            result_str = f"[Tool error: {exc}]"
                    else:
                        result_str = "Tool not permitted in read-only mode."
                    if len(result_str) > _MAX_TOOL_OUTPUT_CHARS:
                        result_str = result_str[:_MAX_TOOL_OUTPUT_CHARS] + "\n[...output truncated]"
                    collected_calls.append((event, result_str))

                elif isinstance(event, TurnEnd):
                    if event.stop_reason == "tool_use":
                        messages.append(
                            provider.build_assistant_history_message(
                                accumulated_text,
                                [tc for tc, _ in collected_calls],
                            )
                        )
                        result_msg = provider.build_tool_result_message(
                            [tc for tc, _ in collected_calls],
                            [r for _, r in collected_calls],
                        )
                        if isinstance(result_msg, list):
                            messages.extend(result_msg)
                        else:
                            messages.append(result_msg)
                        continue_loop = True

                    elif event.stop_reason == "error":
                        log.error("run_read_only provider error: %s", event.error_message)
                        return ""

            turn_count += 1
            if not continue_loop:
                break

    except Exception as exc:
        log.error("run_read_only unexpected error: %s", exc, exc_info=True)
        return ""

    return final_text

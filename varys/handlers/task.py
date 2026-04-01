"""Task handler - processes user messages and returns cell operations."""
import asyncio
import json
import logging
import re as _re
import traceback
import uuid
from pathlib import Path
from typing import List, Tuple
from jupyter_server.base.handlers import JupyterHandler
from tornado.web import authenticated

from ..llm.factory import create_provider
from ..llm.context_utils import build_notebook_context
from ..skills.loader import SkillLoader
from ..memory.manager import MemoryManager
from ..memory.preference_store import PreferenceStore
from ..memory.injection import (
    select_preferences as _select_preferences,
    format_preferences_for_prompt as _fmt_prefs,
    detect_explicit_preference as _detect_explicit_pref,
)
from ..utils.config import get_config as _get_cfg
from ..usage_writer import UsageWriter

log = logging.getLogger(__name__)

_usage_writer = UsageWriter()


def _fire_usage(provider, notebook_path: str, context: str) -> None:
    """Fire-and-forget usage write; all errors are logged."""
    try:
        usage = getattr(provider, "last_usage", None)
        if not usage:
            log.debug("_fire_usage: no last_usage on provider %s", type(provider).__name__)
            return
        vendor = getattr(provider, "VENDOR", "unknown")
        # AnthropicProvider stores the model on its inner ClaudeClient
        _inner = getattr(provider, "_chat_client", None)
        model = (
            getattr(_inner, "model", None)
            or getattr(provider, "chat_model", None)
            or "unknown"
        )
        log.info(
            "usage: vendor=%s model=%s in=%s out=%s context=%s",
            vendor, model, usage.get("input", 0), usage.get("output", 0), context,
        )
        asyncio.create_task(
            asyncio.to_thread(
                _usage_writer.write,
                vendor=vendor,
                model=model,
                tokens_in=usage.get("input", 0),
                tokens_out=usage.get("output", 0),
                chat_id=notebook_path or None,
                context=context,
            )
        )
    except Exception as _ue:
        log.warning("Usage write failed: %s", _ue, exc_info=True)


def _strip_null(text: str) -> str:
    """Remove trailing ' null' artefacts that some models emit.

    The regex already eats any surrounding whitespace via \s*…\s*$, so no
    extra strip() call is needed.  Calling rstrip() here was previously shown
    to collapse inter-word spaces when the tokeniser encodes the space as the
    *trailing* character of a token — e.g. Anthropic emits "all " then "26",
    and rstrip() turned that into "all26".
    """
    return _re.sub(r'(\s*\bnull\b)+\s*$', '', text)


# ---------------------------------------------------------------------------
# Vision image fallback — load from .ipynb file
# ---------------------------------------------------------------------------

def _enrich_images_from_nb_file(
    notebook_context: dict,
    notebook_path: str,
    root_dir: str,
) -> dict:
    """Return an enriched copy of notebook_context with image data populated
    from the on-disk .ipynb file.

    The frontend sometimes omits large base64 images from the HTTP payload
    (serialisation overhead / size limits).  The notebook file on disk always
    has the full data because JupyterLab auto-saves after every execution.
    We only need to open the file when a mimeType hint indicates an image is
    present but imageData / imageOutput is missing.
    """
    import json as _nb_json_m
    from pathlib import Path as _NBP

    try:
        nb_file = _NBP(root_dir) / notebook_path
        if not nb_file.is_file():
            return notebook_context

        nb_data  = _nb_json_m.loads(nb_file.read_text(encoding="utf-8"))
        nb_cells = nb_data.get("cells", [])

        # Build a flat map: cell_index -> first image output found
        # {cell_index: (base64_str, mime_type)}
        _cell_img_map: dict = {}
        for ci, nb_cell in enumerate(nb_cells):
            if nb_cell.get("cell_type") != "code":
                continue
            for nb_out in nb_cell.get("outputs", []):
                d = nb_out.get("data", {})
                for m in ("image/png", "image/jpeg", "image/webp"):
                    v = d.get(m)
                    if v:
                        b64 = "".join(v) if isinstance(v, list) else str(v)
                        if ci not in _cell_img_map:
                            _cell_img_map[ci] = (b64, m)
                        break

        if not _cell_img_map:
            return notebook_context

        ctx     = dict(notebook_context)
        changed = False

        # Enrich selectedOutput.imageData
        _sel = ctx.get("selectedOutput") or {}
        if (
            isinstance(_sel, dict)
            and _sel.get("mimeType", "").startswith("image")
            and not _sel.get("imageData")
        ):
            sc_idx = _sel.get("cellIndex", 0)
            so_idx = _sel.get("outputIndex", 0)
            # Use per-output extraction when we have an exact output index
            if sc_idx < len(nb_cells):
                nb_outs = nb_cells[sc_idx].get("outputs", [])
                if so_idx < len(nb_outs):
                    d = nb_outs[so_idx].get("data", {})
                    for m in ("image/png", "image/jpeg", "image/webp"):
                        v = d.get(m)
                        if v:
                            b64 = "".join(v) if isinstance(v, list) else str(v)
                            ctx["selectedOutput"] = {**_sel, "imageData": b64, "mimeType": m}
                            changed = True
                            break
            # Fallback: use the cell-level image map
            if not changed and sc_idx in _cell_img_map:
                b64, m = _cell_img_map[sc_idx]
                ctx["selectedOutput"] = {**_sel, "imageData": b64, "mimeType": m}
                changed = True

        # Enrich cells that are missing imageOutput
        new_cells = list(ctx.get("cells", []))
        for i, cell in enumerate(new_cells):
            c_idx = cell.get("index", i)
            if not cell.get("imageOutput") and c_idx in _cell_img_map:
                b64, m = _cell_img_map[c_idx]
                new_cells[i] = {**cell, "imageOutput": b64, "imageOutputMime": m}
                changed = True

        if changed:
            ctx["cells"] = new_cells
            return ctx

    except Exception as _exc:
        log.debug("Vision image fallback failed: %s", _exc)

    return notebook_context


# ---------------------------------------------------------------------------
# MCP agentic loop helper
# ---------------------------------------------------------------------------

async def _run_mcp_tool_loop(
    aclient,
    system: str,
    messages: list,
    builtin_tools: list,
    mcp_manager,
    on_text_chunk,
    on_thought=None,
    max_rounds: int = 8,
) -> dict:
    """Multi-turn agentic loop: LLM → tool call → result → LLM → …

    Drives the Anthropic messages API directly (not via stream_plan_task) so
    we can handle arbitrary tool calls alongside create_operation_plan.

    Returns the final create_operation_plan response dict (same shape as
    stream_plan_task) once the LLM calls it, or a chatResponse advisory dict
    if the LLM never calls it.
    """
    import anthropic as _anthropic

    external_tools = mcp_manager.get_all_tools() if mcp_manager else []
    all_tools = builtin_tools + external_tools
    msgs = list(messages)

    for _round in range(max_rounds):
        use_thinking = getattr(aclient, "_extended_thinking_enabled", False) and \
                       getattr(aclient, "_supports_extended_thinking", lambda: False)()

        api_kwargs = dict(
            model=aclient.model,
            max_tokens=16_000 if use_thinking else 8_192,
            system=system,
            tools=all_tools,
            tool_choice={"type": "auto"},
            messages=msgs,
        )
        if use_thinking:
            api_kwargs["thinking"] = {"type": "enabled", "budget_tokens": 8_000}

        async with aclient._aclient.messages.stream(**api_kwargs) as stream:
            async for event in stream:
                if event.type != "content_block_delta":
                    continue
                delta = event.delta
                if delta.type == "text_delta":
                    await on_text_chunk(delta.text)
                    await asyncio.sleep(0)
                elif delta.type == "thinking_delta" and on_thought:
                    await on_thought(delta.thinking)
                    await asyncio.sleep(0)
            final_msg = await stream.get_final_message()

        if hasattr(final_msg, "usage") and final_msg.usage:
            # Accumulate across all rounds so callers get the full session total.
            prev = getattr(aclient, "last_usage", None) or {"input": 0, "output": 0}
            aclient.last_usage = {
                "input":  prev.get("input",  0) + getattr(final_msg.usage, "input_tokens",  0),
                "output": prev.get("output", 0) + getattr(final_msg.usage, "output_tokens", 0),
            }

        msgs.append({"role": "assistant", "content": final_msg.content})

        # Check for tool_use blocks
        tool_use_blocks = [b for b in final_msg.content if b.type == "tool_use"]

        if not tool_use_blocks:
            # Detect truncation before giving up — if the model hit max_tokens it
            # never finished the tool call JSON.  Inject a nudge and let the loop
            # retry so the response appears seamless to the user.
            stop_reason = getattr(final_msg, "stop_reason", None)
            if stop_reason == "max_tokens" and _round < max_rounds - 1:
                msgs.append({
                    "role": "user",
                    "content": (
                        "Your previous response was cut off before you could finish the plan. "
                        "Please provide a more concise version of the same plan."
                    ),
                })
                continue

            # Pure text response — surface as advisory
            text = next(
                (b.text for b in final_msg.content if hasattr(b, "text")), ""
            )
            text = _strip_null(text)
            return {
                "steps": [], "requiresApproval": False,
                "clarificationNeeded": None,
                "chatResponse": text or "Done.",
                "cellInsertionMode": "chat",
                "summary": "Advisory response",
            }

        # Process tool calls — external MCP tools first, then check for plan.
        # The LLM may call external tools and create_operation_plan in the same
        # response.  We must execute all external tools before returning the
        # plan so their results are available in the conversation history.
        tool_results = []
        final_plan = None

        for block in tool_use_blocks:
            if block.name == "create_operation_plan":
                data = dict(block.input)
                clarif = data.get("clarificationNeeded")
                if not clarif or (isinstance(clarif, str) and clarif.strip().lower() == "null"):
                    data["clarificationNeeded"] = None
                final_plan = data
                # Don't break — continue so any preceding external tools are executed
            else:
                # External MCP tool — execute and collect result
                try:
                    result_text = await mcp_manager.call_tool(block.name, dict(block.input))
                except Exception as exc:
                    result_text = f"[Tool error: {exc}]"

                tool_results.append({
                    "type": "tool_result",
                    "tool_use_id": block.id,
                    "content": result_text,
                })

        if final_plan is not None:
            return final_plan

        if tool_results:
            msgs.append({"role": "user", "content": tool_results})

    # Exhausted max rounds without a plan
    return {
        "steps": [], "requiresApproval": False, "clarificationNeeded": None,
        "chatResponse": "I reached the maximum number of tool-call rounds without completing a plan.",
        "cellInsertionMode": "chat", "summary": "Max rounds exceeded",
    }


# ---------------------------------------------------------------------------
# Advisory-question detector
# ---------------------------------------------------------------------------
# Words/phrases that strongly suggest the user wants a text answer, not a
# cell operation.  When the default "preview" mode is in effect AND the
# message matches, we upgrade to "chat" mode so the response streams.


# ---------------------------------------------------------------------------
# Chain-of-Thought reasoning suffix — appended to any system prompt when the
# user has selected CoT mode from the reasoning chip (single API call, steps
# appear inline in the response).
# ---------------------------------------------------------------------------

_COT_SYSTEM_SUFFIX = """

## Reasoning Mode: Chain-of-Thought (active)

For every non-trivial request, work through the problem step by step **before**
giving your final answer.  Use this format for each step:

**Step N — [short action title]**
> *Reasoning:* ...
> *Confidence:* high / medium / low
> *Needs revision:* yes / no

If a step needs revision, add a `> *Revision:*` line before continuing.

Separate your final answer with a `---` divider.
Skip the step structure only for simple, one-line factual questions.
"""

# ---------------------------------------------------------------------------
# Advisory (chat-mode) prompt — used when a skill declares
# cell_insertion_mode: chat.  The LLM responds with free-form markdown
# instead of a cell-operation JSON plan.
# ---------------------------------------------------------------------------

_ADVISORY_SYSTEM = """\
You are an expert data scientist and technical advisor embedded in JupyterLab.

Your role right now is **advisory**: provide analysis, explanations, recommendations, \
or a review. Do NOT produce cell operations — the user wants to read your response in \
the chat panel.

Guidelines:
- Use markdown formatting (headers, bullets, tables, code snippets where helpful).
- Reference notebook cells by their label #N (e.g. #3, #16).
  NEVER use "cell[N]", "pos:N", "position N", "cell index N", "idx N", or any
  other variant — #N is the ONLY permitted format for cell references.
- Base every claim on the actual cell outputs provided — do not invent results.
- Be concise but thorough. Aim for quality over length.

{skills_section}

{memory_section}
"""


def _build_advisory_system(skills, memory):
    skills_text = ""
    for s in skills:
        skills_text += f"\n### {s['name']}\n{s['content']}\n"
    if not skills_text:
        skills_text = "No specific skills loaded."

    memory_text = memory.strip() or "No memory/preferences recorded yet."
    return _ADVISORY_SYSTEM.format(
        skills_section=skills_text,
        memory_section=memory_text,
    )


def _build_advisory_user(user_message: str, notebook_context: dict) -> str:
    """Build the user-message block for advisory (chat) mode requests."""
    return build_notebook_context(user_message, notebook_context)


# ---------------------------------------------------------------------------
# Manual (code-review) mode helpers
# ---------------------------------------------------------------------------

_MANUAL_REVIEW_SYSTEM = """\
You are an expert Python code reviewer embedded in JupyterLab.

Your task: perform a static analysis of the notebook and return a structured
code-quality review in STRICT JSON format.

## ⚠️ CRITICAL — Response Format

Return ONLY a single valid JSON object — no prose, no markdown wrapper,
no text before or after the JSON.

{{
  "operationId":       "<operation_id from the user message>",
  "cellInsertionMode": "manual",
  "chatResponse":      "<complete markdown review — see format below>",
  "steps": [
    {{
      "type":        "modify",
      "cellIndex":   <int>,
      "cellType":    "code",
      "content":     "<COMPLETE replacement cell content>",
      "description": "<one-line description of this fix>",
      "autoExecute": false
    }}
  ],
  "requiresApproval": false,
  "summary": "Found N code issues (X critical, Y high, ...)"
}}

## chatResponse Format

Write a complete markdown code review with these exact sections:

```
💻 Code Quality Review
Notebook: <filename>
─────────────────────────────────────────

🔴 CRITICAL ISSUES
<findings or "None.">

🟡 HIGH PRIORITY
<findings or "None.">

🟠 MEDIUM PRIORITY
<findings or "None.">

🔵 LOW PRIORITY
<findings or "None.">

ℹ️ INFORMATIONAL
<findings or "None.">
```

Each finding must include:
- **Issue type** [Cell N]: one-line headline
- Description of what is wrong
- *Why it matters*: concrete consequence
- Suggestion: actionable fix

For any finding that has a corresponding entry in `steps`, end it with
exactly: `[Fix available — see panel below]`

If the notebook has no issues: write `✅ No significant code quality issues found.`

## steps Array Rules

- Include ONLY direct cell replacements (modify) or new import cells (insert).
- Each step must contain the FULL, COMPLETE cell content — not just a diff.
- `autoExecute` must always be `false`.
- Omit execution-order reordering (describe in chatResponse only).
- Omit pure rename suggestions.
- Maximum 10 steps. Return [] if no direct code fixes apply.

{skills_section}

{memory_section}
"""


def _build_manual_review_system(skills, memory):
    skills_text = ""
    for s in skills:
        skills_text += f"\n### {s['name']}\n{s['content']}\n"
    if not skills_text:
        skills_text = "No additional skill configuration."
    memory_text = memory.strip() or "No memory recorded yet."
    return _MANUAL_REVIEW_SYSTEM.format(
        skills_section=skills_text,
        memory_section=memory_text,
    )


def _build_manual_review_user(user_message, notebook_context, operation_id):
    cells    = notebook_context.get("cells", [])
    nb_path  = notebook_context.get("notebookPath", "unknown")
    nb_name  = Path(nb_path).name if nb_path != "unknown" else "notebook"

    lines = [
        f"Notebook: {nb_name}",
        f"Operation ID: {operation_id}",
        f"Total cells: {len(cells)}",
        "",
        "=== NOTEBOOK CELLS ===",
    ]

    for cell in cells:
        idx    = cell.get("index", 0)
        ctype  = cell.get("type", "code")
        source = cell.get("source", "")
        ec     = cell.get("executionCount")

        header = f"[Cell {idx} | {ctype.upper()}"
        if ctype == "code":
            header += f" | exec:{ec}" if ec is not None else " | not run"
        header += "]"

        lines.append(header)
        lines.append(source[:3000].strip() if source.strip() else "(empty)")
        lines.append("")

    lines.append(f"=== USER REQUEST ===")
    lines.append(user_message)
    lines.append("")
    lines.append("Return ONLY a single valid JSON object. No text outside the JSON.")

    return "\n".join(lines)


def _parse_json_from_text(text: str, fallback_op_id: str) -> dict:
    """Extract structured JSON from an LLM response that may have extra text."""
    text = text.strip()

    # 1. Direct JSON
    if text.startswith("{"):
        try:
            return json.loads(text)
        except json.JSONDecodeError:
            pass

    # 2. JSON inside a ```json … ``` or ``` … ``` block
    m = _re.search(r'```(?:json)?\s*(\{[\s\S]*?\})\s*```', text)
    if m:
        try:
            return json.loads(m.group(1))
        except json.JSONDecodeError:
            pass

    # 3. Grab largest { … } in the text
    start = text.find("{")
    end   = text.rfind("}")
    if start != -1 and end > start:
        try:
            return json.loads(text[start:end + 1])
        except json.JSONDecodeError:
            pass

    # 4. Fallback: treat entire response as advisory chat text
    return {
        "operationId":       fallback_op_id,
        "cellInsertionMode": "chat",
        "chatResponse":      text,
        "steps":             [],
        "requiresApproval":  False,
        "summary":           "Advisory response",
    }


# ---------------------------------------------------------------------------
# Handler
# ---------------------------------------------------------------------------

# ── Default system prompt for Varys File Agent (fallback if skill not loaded) ────
_FILE_AGENT_SYSTEM_PROMPT = """\
You are an expert software engineer working within a Jupyter project.
Your task is to help users read, write, and edit project files.
Work within the project directory only. Make minimal, targeted changes.

CRITICAL RULES — you MUST follow these without exception:
1. NEVER describe or explain a change without actually making it via a tool call.
   Saying "I'll remove X" or "The file now contains Y" without calling Edit/Write is wrong.
2. ALWAYS use Edit or Write to apply any code change — never show the edited code as plain text.
3. CHOOSING BETWEEN Write AND Edit:
   • Use Write when: adding new content (new function, new class, new file), or when you
     already have the full desired file content from the task message.
   • Use Edit ONLY when: replacing a specific, clearly-identified existing block of text.
     Edit requires an exact verbatim match of old_string — if unsure, use Write instead.
   • NEVER call Edit speculatively; if old_string might not match exactly, prefer Write.
4. When the task message includes the current file content, that IS the file — skip Read
   and call Write or Edit immediately using that content.
5. STRICT tool-call budget — violations waste turns and must be avoided:
   • MAX 1 Glob call total — only to locate the target file when its path is not given.
   • MAX 1 Read call total — only when the file content was NOT provided in the task.
   • ZERO reads of unrelated files. Write idiomatic code without codebase research.
6. After all edits are applied, write a brief one-sentence summary of what was changed.
7. ALWAYS use the exact absolute path shown in "Target file:" — never shorten to a basename.
   Using "utils.py" instead of "/data/test/utils.py" risks editing the WRONG file.
"""

# Used as preamble when a custom skill with agent_mode: true is invoked.
# Replaces the staging-oriented _FILE_AGENT_SYSTEM_PROMPT with an
# execution-mode variant that instructs the LLM to call tools immediately.
_SKILL_AGENT_SYSTEM_PROMPT = """\
You are Varys, an AI agent running in EXECUTION MODE inside a Jupyter project.
You have been activated by a custom skill command. Your job is to complete the task \
autonomously by calling tools — do not describe or explain what you would do, just do it.

CRITICAL RULES — you MUST follow these without exception:
1. NEVER output code as plain text or inside markdown code blocks.
2. ALWAYS use the Write tool to create any file that needs to be created.
3. ALWAYS use the Bash tool to run any shell command, script, or program.
4. ALWAYS use the Read tool to read files from disk.
5. Complete the FULL task: write files → execute → verify output → report results.
6. If a command fails, read the error, fix the file with Write, and retry with Bash.

All file paths are relative to the project directory.
"""


class TaskHandler(JupyterHandler):
    """Handle AI task requests."""

    @authenticated
    async def post(self):
        """Process a user task request.

        Supports optional streaming for chat/advisory mode:
          - Request body may include ``"stream": true``
          - If the effective cell_insertion_mode is "chat" and streaming is
            requested, the response is sent as Server-Sent Events (SSE):
              data: {"type":"chunk","text":"..."}\n\n   (per token)
              data: {"type":"done","operationId":"...","steps":[],...}\n\n
          - All other modes always return a plain JSON response.
        """
        try:
            body = json.loads(self.request.body)
        except json.JSONDecodeError:
            self.set_status(400)
            self.set_header("Content-Type", "application/json")
            self.finish(json.dumps({"error": "Invalid JSON body"}))
            return

        stream_requested = bool(body.get("stream", False))
        if not stream_requested:
            self.set_header("Content-Type", "application/json")

        message          = body.get("message", "").strip()
        notebook_context = body.get("notebookContext", {})
        operation_id     = body.get("operationId")
        # Chat history: list of {"role": "user"|"assistant", "content": "..."}
        # sent by the frontend (last N turns of the visible conversation).
        chat_history     = body.get("chatHistory", [])
        # Composite pipeline step execution: forces auto mode regardless of skill settings
        force_auto_mode  = bool(body.get("forceAutoMode", False))
        # @variable_name references resolved by VariableResolver in the frontend
        variables        = body.get("variables", [])
        # Active image mode set by /no_figures or /resize(DIM).
        # {"mode": "no_figures"} or {"mode": "resize", "dim": <int>} or None.
        image_mode       = body.get("imageMode") or None

        # ── File context (non-notebook file in focus) ─────────────────────────
        # When the user has a .py / .md / etc. file open instead of a notebook,
        # the frontend sends fileContextPath with the server-relative path.
        # Read the file from disk and inject its content into notebook_context
        # so build_notebook_context() can include it in the LLM prompt.
        # NOTE: root_dir is not yet defined here, so read from settings directly.
        _file_ctx_path: str = (notebook_context.get("fileContextPath") or "").strip()
        if _file_ctx_path:
            import os as _os
            _fc_root = self.settings.get("ds_assistant_root_dir", ".")
            _full_path = _os.path.join(_fc_root, _file_ctx_path)
            try:
                with open(_full_path, "r", encoding="utf-8", errors="replace") as _fh:
                    _file_content = _fh.read()
                notebook_context = dict(notebook_context)
                notebook_context["_file_context"] = {
                    "path": _file_ctx_path,
                    "content": _file_content,
                }
            except Exception as _fe:
                log.warning("Could not read file context %s: %s", _file_ctx_path, _fe)

        # Apply image mode to notebook_context before anything else reads cells.
        # Always work on a mutable copy so we never mutate the original.
        if variables or image_mode:
            notebook_context = dict(notebook_context)
            if "cells" in notebook_context:
                notebook_context["cells"] = [dict(c) for c in notebook_context["cells"]]
        if variables:
            notebook_context["variables"] = variables

        _image_resize_count: int = 0
        _image_resize_warnings: list = []
        if image_mode:
            try:
                from ..image_processing import apply_image_mode as _apply_img
                _image_resize_count, _image_resize_warnings = _apply_img(
                    notebook_context, image_mode
                )
            except Exception as _img_exc:  # noqa: BLE001
                log.warning("image_mode application failed: %s", _img_exc)

        # Slash command typed by the user (e.g. "/eda").  The frontend strips the
        # command prefix from the message before sending, so ``message`` here
        # already contains only the free-text portion of the user input.
        slash_command    = body.get("command", "").strip().lower() or None
        # User-controlled cell-writing mode from the sidebar toggle.
        # 'chat'  = never write cells (user wins over skill defaults)
        # 'agent' = skill/heuristic decides (default)
        # Legacy values 'never'→'chat', 'auto'/'always'/'doc'→'agent' are migrated here.
        _raw_cell_mode   = body.get("cellMode", "agent")
        if _raw_cell_mode in ("never",):
            _raw_cell_mode = "chat"
        elif _raw_cell_mode in ("auto", "always", "doc"):
            _raw_cell_mode = "agent"
        user_cell_mode   = _raw_cell_mode  # 'chat' | 'agent'
        reasoning_mode   = body.get("reasoningMode", "off")   # 'off' | 'cot' | 'sequential'
        cot_enabled      = reasoning_mode == "cot"
        sequential_enabled = reasoning_mode == "sequential"

        # ── Auto-route non-notebook files in Agent mode ───────────────────
        # When a Python / Markdown / etc. file is in context (frontend set
        # _file_context) and the user chose Agent mode but typed no explicit
        # slash command, route to /file_agent (edit) or /file_agent_find
        # (read-only) based on edit intent.  Pure Q&A questions use find-mode
        # so they never consume the write-tool budget or hit the turn limit.
        if (
            not slash_command
            and notebook_context.get("_file_context")
            and user_cell_mode == "agent"
        ):
            _edit_keywords = {
                "fix", "edit", "modify", "change", "update", "add", "remove",
                "delete", "create", "write", "refactor", "rename", "replace",
                "implement", "rewrite", "move", "insert", "append", "convert",
                "format", "clean", "optimize", "improve", "extend", "extract",
                "patch", "correct", "restructure", "reorganize", "migrate",
            }
            _msg_lower = message.lower()
            _has_edit_intent = any(
                _kw in _msg_lower.split() or f"{_kw} " in _msg_lower
                for _kw in _edit_keywords
            )
            slash_command = "/file_agent" if _has_edit_intent else "/file_agent_find"

        # ── Varys File Agent routing ───────────────────────────────────────
        # Intercept /file_agent, /file_agent_find, /file_agent_save before
        # skill routing. All three branches use the agent runner.
        if slash_command in ("/file_agent", "/file_agent_find", "/file_agent_save"):
            op_id = operation_id or f"op_{uuid.uuid4().hex[:8]}"
            # When the user is chatting with a non-notebook file (e.g. utils.py),
            # _file_context holds the path AND the freshly-read content.
            # Embed both in the task message so the agent never needs to call
            # ReadFile — it can jump straight to Edit/Write.
            fa_message = message
            _fa_file_ctx = notebook_context.get("_file_context")
            if _fa_file_ctx:
                import os as _os2
                _fa_root    = self.settings.get("ds_assistant_root_dir", ".")
                _fa_rel     = _fa_file_ctx["path"]           # server-relative path, e.g. test/utils.py
                _fa_abs     = _os2.path.join(_fa_root, _fa_rel)
                # Use the file's parent directory as working_dir so the agent can
                # reference the file by its basename only.  Without this, the agent
                # would receive working_dir=root_dir and might resolve "utils.py"
                # to root_dir/utils.py instead of root_dir/test/utils.py.
                _fa_working_dir = _os2.path.dirname(_fa_abs) or _fa_root
                _fa_basename    = _os2.path.basename(_fa_rel)   # e.g. "utils.py"
                _fa_content = _fa_file_ctx.get("content", "")
                _fa_ext     = _fa_rel.rsplit(".", 1)[-1].lower() if "." in _fa_rel else ""
                _fa_lang    = {
                    "py": "python", "js": "javascript", "ts": "typescript",
                    "tsx": "tsx", "jsx": "jsx", "md": "markdown", "sh": "bash",
                    "yml": "yaml", "yaml": "yaml", "json": "json", "toml": "toml",
                    "r": "r", "sql": "sql", "cpp": "cpp", "c": "c", "java": "java",
                    "rs": "rust", "go": "go", "rb": "ruby",
                }.get(_fa_ext, _fa_ext)
                _fa_fence   = f"```{_fa_lang}" if _fa_lang else "```"
                # Use the absolute path as the sole reference so the LLM
                # cannot confuse this file with another file of the same name.
                fa_message  = (
                    f"Target file: {_fa_abs}\n\n"
                    f"Current content of `{_fa_abs}`:\n"
                    f"{_fa_fence}\n{_fa_content}\n```\n\n"
                    f"Task: {message}"
                )
                # Propagate the resolved working dir so _handle_file_agent can
                # skip resolve_working_directory for this specific case.
                notebook_context = dict(notebook_context)
                notebook_context["_file_agent_working_dir"] = _fa_working_dir
            await self._handle_file_agent(
                slash_command=slash_command,
                message=fa_message,
                operation_id=op_id,
                notebook_context=notebook_context,
                stream_requested=stream_requested,
            )
            return

        # ── Custom skill agent_mode routing ───────────────────────────────
        # If a custom skill declares `agent_mode: true` in its front matter,
        # route it through the file-agent runner instead of the chat flow.
        #
        # The global ds_assistant_skill_loader is created at startup with the
        # JupyterLab server root_dir.  Skills living in a notebook's parent
        # directory (the common case) are NOT visible to the global loader.
        # We therefore check the global loader first, then fall back to a
        # per-request loader that uses the notebook path.
        _skill_meta = None
        if slash_command:
            # 1. Try the global pre-loaded loader (fast path, startup-time root)
            _global_loader = self.settings.get("ds_assistant_skill_loader")
            if _global_loader is not None:
                _skill_meta = _global_loader.get_skill_meta_for_command(slash_command)
            # 2. Fall back to a per-request loader that resolves the skill dir
            #    relative to the active notebook (e.g. /data/.jupyter-assistant/skills/)
            if _skill_meta is None:
                try:
                    _req_root   = self.settings.get("ds_assistant_root_dir", ".")
                    _req_nb     = notebook_context.get("notebookPath", "")
                    _req_loader = SkillLoader(_req_root, _req_nb)
                    _skill_meta = _req_loader.get_skill_meta_for_command(slash_command)
                except Exception as _sl_exc:
                    log.debug("Varys skill routing: per-request loader error: %s", _sl_exc)
            log.info(
                "Varys skill routing: command=%r meta=%r",
                slash_command,
                _skill_meta,
            )
            if _skill_meta and _skill_meta.get("agent_mode"):
                # Parse allowed_tools from skill front matter (list or comma-string)
                _tools_raw = _skill_meta.get("allowed_tools")
                if isinstance(_tools_raw, list):
                    _tools_override = [str(t).strip() for t in _tools_raw if t]
                elif isinstance(_tools_raw, str):
                    _tools_override = [t.strip() for t in _tools_raw.split(",") if t.strip()]
                else:
                    _tools_override = None
                # When the user sends just the command with no body text, use the
                # skill description as the agent task so the runner has context.
                _agent_message = message or str(
                    _skill_meta.get("description", f"Execute {slash_command}")
                )
                # Prepend the resolved notebook path so the agent never needs to
                # glob for it — it is stated explicitly at the top of the task.
                _nb_path = notebook_context.get("notebookPath", "")
                if _nb_path:
                    import os as _os
                    _root = self.settings.get("ds_assistant_root_dir", ".")
                    _abs_nb = _nb_path if _os.path.isabs(_nb_path) else _os.path.join(_root, _nb_path)
                    _agent_message = f"notebook_path: {_abs_nb}\n\n{_agent_message}"
                op_id = operation_id or f"op_{uuid.uuid4().hex[:8]}"
                await self._handle_file_agent(
                    slash_command=slash_command,
                    message=_agent_message,
                    operation_id=op_id,
                    notebook_context=notebook_context,
                    stream_requested=stream_requested,
                    allowed_tools_override=_tools_override,
                    skill_triggered=True,
                )
                return

        if not message:
            self.set_status(400)
            self.finish(json.dumps({"error": "Message is required"}))
            return

        try:
            root_dir      = self.settings.get("ds_assistant_root_dir", ".")
            notebook_path = notebook_context.get("notebookPath", "")

            # ── Smart Cell Context pre-assembly ────────────────────────────────
            # Use the SummaryStore + assembler to build a rich, structured cell
            # context block.  The result is stored as _cell_context_override so
            # build_notebook_context() (called later by every provider) can inject
            # it directly — the old per-cell truncation loop is then bypassed.
            # Non-fatal: any failure falls back to the legacy truncation path.
            try:
                from ..context.summary_store import SummaryStore
                from ..context.assembler    import assemble_context as _assemble
                from ..utils.paths          import nb_base as _nb_base
                _store   = SummaryStore(root_dir, notebook_path)
                _nb_base_path = _nb_base(root_dir, notebook_path)
                _ctx_override = _assemble(
                    user_query             = message,
                    cell_order             = notebook_context.get("cells", []),
                    summary_store          = _store,
                    active_cell_id         = notebook_context.get("activeCellId") or None,
                    focal_cell_full_output = notebook_context.get("focalCellOutput") or None,
                    nb_base                = _nb_base_path,
                    kernel_name            = notebook_context.get("kernelName") or "",
                    agent_mode             = (user_cell_mode == "agent"),
                )
                # Ensure notebook_context is a mutable copy before patching
                notebook_context = dict(notebook_context)
                notebook_context["_cell_context_override"] = _ctx_override
            except Exception as _ctx_exc:
                log.debug("Smart context assembly skipped: %s", _ctx_exc)

            # Use the pre-loaded loader from startup; fall back to a fresh one.
            skill_loader = self.settings.get("ds_assistant_skill_loader")
            if skill_loader is None:
                skill_loader = SkillLoader(root_dir, notebook_path)

            # ── /chat built-in command: force advisory/chat mode for this ──────
            # message only, identical to the sidebar "💬 Chat Only" toggle but
            # per-request.  We set a flag so the get_insertion_mode() call below
            # cannot override it.
            force_chat_mode = slash_command == "/chat"
            if force_chat_mode:
                slash_command = None   # clear so skill routing is skipped below
                skills = skill_loader.load_relevant_skills(message, tier1_only=True)
            # Skill loading: slash command takes priority over keyword detection.
            elif slash_command:
                skills = skill_loader.load_by_command(slash_command)
                log.debug("task: slash command '%s' → %d skill(s)", slash_command,
                          len(skills))
            else:
                skills = skill_loader.load_relevant_skills(message)

            # ── Composite pipeline detection ──────────────────────────────
            # If a composite skill was triggered, return the pipeline plan
            # immediately.  The frontend then orchestrates step-by-step execution.
            composite_name = skill_loader.get_triggered_composite(skills)
            if composite_name:
                composite_steps = skill_loader.get_composite_steps(composite_name, message)
                if composite_steps:
                    op_id = operation_id or f"op_{uuid.uuid4().hex[:8]}"
                    plan = {
                        "type":              "done",
                        "operationId":       op_id,
                        "cellInsertionMode": "composite",
                        "compositeName":     composite_name,
                        "compositePlan":     composite_steps,
                        "steps":             [],
                        "requiresApproval":  False,
                        "clarificationNeeded": None,
                        "summary":           f"Starting pipeline: {composite_name} ({len(composite_steps)} steps)",
                    }
                    if stream_requested:
                        self.set_header("Content-Type", "text/event-stream")
                        self.set_header("Cache-Control", "no-cache")
                        self.set_header("X-Accel-Buffering", "no")
                        self.write(f"data: {json.dumps(plan)}\n\n")
                        self.finish()
                    else:
                        del plan["type"]
                        self.finish(json.dumps(plan))
                    return

            # Determine the effective cell_insertion_mode for this request.
            # /chat command has already locked the mode — do not override it.
            if force_chat_mode:
                cell_insertion_mode = "chat"
            else:
                cell_insertion_mode = skill_loader.get_insertion_mode(skills)

            # Composite step execution forces auto mode so each step's cells
            # are applied immediately (the frontend shows one composite diff at end).
            # /chat command takes priority even over composite pipeline steps.
            if force_auto_mode and not force_chat_mode:
                cell_insertion_mode = "auto"

            # Apply user-controlled cell-writing mode (sidebar toggle).
            # Priority: /chat command > user_cell_mode toggle > skill defaults.
            # force_chat_mode (/chat command) cannot be overridden by any toggle.
            if force_chat_mode:
                skill_wanted_cells = False   # explicit command, no conflict warning
            elif user_cell_mode == "chat":
                # User explicitly chose discussion mode — keep everything in chat.
                # We tag the response so the frontend can show a skill-conflict
                # warning if the skill normally wants cells.
                skill_wanted_cells = cell_insertion_mode not in ("chat",)
                cell_insertion_mode = "chat"
            else:
                # 'agent' — respect existing skill/heuristic logic
                skill_wanted_cells = False

            # ── Long-term memory: load preferences from structured store ───
            pref_store = PreferenceStore(root_dir, notebook_path)

            # Capture explicit preference in user message (fire-and-forget)
            _explicit = _detect_explicit_pref(message)
            if _explicit:
                _scope = "notebook" if notebook_path else "project"
                pref_store.upsert(_explicit, scope=_scope)

            # Trigger background migration from legacy preferences.md if needed
            if pref_store.needs_migration():
                simple_model = self.settings.get("ds_assistant_simple_tasks_provider", "")
                if simple_model:
                    from ..memory.inference import migrate_preferences_llm as _migrate_llm
                    asyncio.create_task(_migrate_llm(pref_store, dict(self.settings)))
                else:
                    pref_store.migrate_sync()

            # Select relevant preferences for this query
            selected_prefs = await _select_preferences(message, pref_store, self.settings)
            memory = _fmt_prefs(selected_prefs)

            # Fallback: if no structured preferences yet, use legacy preferences.md
            if not memory.strip():
                memory_manager = MemoryManager(root_dir, notebook_path)
                memory = memory_manager.load()

            provider = create_provider(self.settings, task="chat")

            # ── Vision warning ────────────────────────────────────────────
            warnings = []
            if not provider.has_vision():
                image_cells = [
                    c for c in notebook_context.get("cells", [])
                    if c.get("imageOutput")
                ]
                if image_cells:
                    labels = []
                    for c in image_cells:
                        idx = c.get("index")
                        labels.append(f"#{idx + 1}" if isinstance(idx, int) else "#?")
                    provider_name = self.settings.get(
                        "ds_assistant_chat_provider", "ollama"
                    ).upper()
                    model_name = self.settings.get(
                        "ds_assistant_ollama_chat_model",
                        self.settings.get("ds_assistant_chat_model", "unknown"),
                    )
                    warnings.append(
                        f"⚠️ {', '.join(labels)} contain plot/image outputs. "
                        f"Your current chat model ({provider_name} / {model_name}) "
                        f"does not support vision. The image content will be ignored. "
                        f"Switch to a vision-capable model to analyse plots."
                    )

            # ── Dispatch based on insertion mode ─────────────────────────
            op_id = operation_id or f"op_{uuid.uuid4().hex[:8]}"

            # Routing note: the frontend now surfaces a disambiguation card
            # for ambiguous plain messages.  By the time the request reaches
            # the backend the user has explicitly chosen /chat or cell mode.

            # For cell-creation tasks, send an immediate SSE progress event
            # so the UI reacts right away instead of appearing frozen.
            if stream_requested and cell_insertion_mode not in ("chat",):
                self.set_header("Content-Type", "text/event-stream")
                self.set_header("Cache-Control", "no-cache")
                self.set_header("X-Accel-Buffering", "no")
                self.write(f"data: {json.dumps({'type': 'progress', 'text': 'Analyzing notebook…'})}\n\n")
                await self.flush()

            if cell_insertion_mode == "chat":
                system = _build_advisory_system(skills, memory)
                if cot_enabled:
                    system += _COT_SYSTEM_SUFFIX
                user   = _build_advisory_user(message, notebook_context)

                if stream_requested:
                    # SSE streaming path — sends tokens as they arrive.
                    self.set_header("Content-Type", "text/event-stream")
                    self.set_header("Cache-Control", "no-cache")
                    self.set_header("X-Accel-Buffering", "no")

                    accumulated: list = []
                    accumulated_thoughts: list = []

                    async def _on_chunk(text: str) -> None:
                        cleaned = _strip_null(text)
                        if not cleaned:
                            return
                        accumulated.append(cleaned)
                        self.write(f"data: {json.dumps({'type': 'chunk', 'text': cleaned})}\n\n")
                        await self.flush()
                        # Yield the event loop so Tornado actually sends this
                        # chunk over the TCP socket before the next token
                        # arrives — without this, all tokens are buffered and
                        # sent together when finish() is called.
                        await asyncio.sleep(0)

                    async def _on_chat_thought(text: str) -> None:
                        accumulated_thoughts.append(text)
                        self.write(f"data: {json.dumps({'type': 'thought', 'text': text})}\n\n")
                        await self.flush()
                        await asyncio.sleep(0)

                    # ── MCP Sequential Thinking loop (chip ON) ────────────────
                    final_user = user
                    if sequential_enabled and getattr(provider, "has_sequential_thinking", lambda: False)():
                        mcp_thoughts = await provider.run_sequential_thinking_loop(
                            user=user,
                            system=system,
                            on_thought=_on_chat_thought,
                            chat_history=chat_history,
                        )
                        if mcp_thoughts:
                            thought_lines = [
                                f"Step {t.get('thoughtNumber', i + 1)}: {t.get('thought', '')}"
                                for i, t in enumerate(mcp_thoughts)
                            ]
                            thought_summary = "\n".join(thought_lines)
                            final_user = (
                                f"{user}\n\n"
                                f"[Sequential reasoning you completed:\n{thought_summary}\n]\n"
                                "Based on this reasoning, provide your final response."
                            )

                    # ── Vision upgrade: attach image blocks for Anthropic ─────
                    # build_notebook_context() only produces text; for vision-
                    # capable providers with image outputs we upgrade final_user
                    # to a content-block list so images are actually sent to the
                    # API instead of being mentioned as "(image attached separately)".
                    _aclient_v = getattr(provider, "_chat_client", None)
                    if (
                        provider.has_vision()
                        and _aclient_v is not None
                        and hasattr(_aclient_v, "_build_content_blocks_from_text")
                    ):
                        _sel = notebook_context.get("selectedOutput") or {}
                        _has_images = (
                            (isinstance(_sel, dict) and bool(_sel.get("imageData")))
                            or any(c.get("imageOutput") for c in notebook_context.get("cells", []))
                        )

                        # Fallback: if the frontend didn't serialise image bytes
                        # (large images are often dropped from the HTTP payload),
                        # read the image data directly from the .ipynb file.
                        # We trigger this whenever a mimeType hint says there is
                        # an image but the actual bytes are absent.
                        if not _has_images and notebook_path and root_dir:
                            _sel_mime = (
                                isinstance(_sel, dict)
                                and _sel.get("mimeType", "").startswith("image")
                            )
                            if _sel_mime:
                                notebook_context = _enrich_images_from_nb_file(
                                    notebook_context, notebook_path, root_dir
                                )
                                _sel = notebook_context.get("selectedOutput") or {}
                                _has_images = (
                                    (isinstance(_sel, dict) and bool(_sel.get("imageData")))
                                    or any(c.get("imageOutput") for c in notebook_context.get("cells", []))
                                )
                                if _has_images:
                                    log.debug(
                                        "Vision: loaded image from notebook file %s",
                                        notebook_path,
                                    )

                        if _has_images:
                            # Preserve any thought-summary text already in final_user
                            _text = final_user if isinstance(final_user, str) else user
                            final_user = _aclient_v._build_content_blocks_from_text(
                                _text, notebook_context
                            )

                    # ── External MCP tool loop (when servers are connected) ────
                    mcp_manager = self.settings.get("ds_mcp_manager")
                    aclient = getattr(provider, "_chat_client", None)

                    def _mcp_system_addon(tools_list):
                        tool_lines = "\n".join(
                            f"  - {t['name'].split('__', 1)[-1]} "
                            f"(server: {t['name'].split('__', 1)[0]}): "
                            f"{t.get('description', '')[:120]}"
                            for t in tools_list
                        )
                        return (
                            "\n\n## External MCP Tools — Available Now\n"
                            "You have access to the following external tools via MCP servers.\n"
                            "When the user asks for data or actions that require external access, "
                            "call the appropriate tool — do NOT say you cannot access the internet.\n\n"
                            f"{tool_lines}\n\n"
                            "Always prefer calling a tool over apologising for lack of access.\n\n"
                            "## IMPORTANT — Cell outputs and figures\n"
                            "Any images or figures from notebook cell outputs are already attached "
                            "to this conversation as vision content blocks. "
                            "You MUST use those embedded image blocks to answer questions about "
                            "plots, charts, or figures. "
                            "Do NOT use the filesystem or any other tool to read the notebook "
                            ".ipynb file in order to retrieve image data — the images are already "
                            "directly visible to you in the conversation."
                        )

                    if mcp_manager and mcp_manager.has_tools() and aclient is not None:
                        # Anthropic direct — full streaming MCP loop with optional thinking
                        from ..llm.client import ClaudeClient as _CC
                        if isinstance(aclient, _CC):
                            external_tools = mcp_manager.get_all_tools()
                            msgs = aclient._prepend_history(chat_history, final_user)
                            chat_result = await _run_mcp_tool_loop(
                                aclient=aclient,
                                system=system + _mcp_system_addon(external_tools),
                                messages=msgs,
                                builtin_tools=[],
                                mcp_manager=mcp_manager,
                                on_text_chunk=_on_chunk,
                                on_thought=_on_chat_thought,
                            )
                            if hasattr(aclient, "last_usage"):
                                provider.last_usage = aclient.last_usage
                            chat_response_text = chat_result.get("chatResponse", "")
                        else:
                            await provider.stream_chat(
                                system=system, user=final_user,
                                on_chunk=_on_chunk, on_thought=_on_chat_thought,
                                chat_history=chat_history,
                            )
                            chat_response_text = _re.sub(
                                r'(\s*\bnull\b)+\s*$', '', "".join(accumulated)
                            ).strip()

                    elif mcp_manager and mcp_manager.has_tools() and \
                            hasattr(provider, "run_converse_mcp_loop"):
                        # Bedrock (or any provider with a Converse-style MCP loop)
                        external_tools = mcp_manager.get_all_tools()
                        await provider.run_converse_mcp_loop(
                            system=system + _mcp_system_addon(external_tools),
                            user=final_user,
                            chat_history=chat_history,
                            mcp_manager=mcp_manager,
                            on_chunk=_on_chunk,
                            on_thought=_on_chat_thought,
                        )
                        chat_response_text = _re.sub(
                            r'(\s*\bnull\b)+\s*$', '', "".join(accumulated)
                        ).strip()

                    else:
                        await provider.stream_chat(
                            system=system,
                            user=final_user,
                            on_chunk=_on_chunk,
                            on_thought=_on_chat_thought,
                            chat_history=chat_history,
                        )
                        chat_response_text = _re.sub(
                            r'(\s*\bnull\b)+\s*$', '', "".join(accumulated)
                        ).strip()

                    done_event: dict = {
                        "type":              "done",
                        "operationId":       op_id,
                        "steps":             [],
                        "requiresApproval":  False,
                        "clarificationNeeded": None,
                        "summary":           "Advisory response",
                        "chatResponse":      chat_response_text,
                        "cellInsertionMode": "chat",
                    }
                    thoughts_text = "".join(accumulated_thoughts).strip()
                    if thoughts_text:
                        done_event["thoughts"] = thoughts_text
                    usage = getattr(provider, "last_usage", None)
                    log.info("TOKEN_DEBUG chat last_usage=%r  provider=%r", usage, type(provider).__name__)
                    if usage:
                        done_event["tokenUsage"] = usage
                    _fire_usage(provider, notebook_path, "chat")
                    if warnings:
                        done_event["warnings"] = warnings
                    self.write(f"data: {json.dumps(done_event)}\n\n")
                    self.finish()
                    return

                # Non-streaming chat path
                # Apply the same vision upgrade as the streaming path so images
                # are included when the provider is vision-capable.
                _user_for_chat = user
                _aclient_v2 = getattr(provider, "_chat_client", None)
                if (
                    provider.has_vision()
                    and _aclient_v2 is not None
                    and hasattr(_aclient_v2, "_build_content_blocks_from_text")
                ):
                    _sel2 = notebook_context.get("selectedOutput") or {}
                    _has_images2 = (
                        (isinstance(_sel2, dict) and bool(_sel2.get("imageData")))
                        or any(c.get("imageOutput") for c in notebook_context.get("cells", []))
                    )
                    if not _has_images2 and notebook_path and root_dir:
                        if isinstance(_sel2, dict) and _sel2.get("mimeType", "").startswith("image"):
                            notebook_context = _enrich_images_from_nb_file(
                                notebook_context, notebook_path, root_dir
                            )
                            _sel2 = notebook_context.get("selectedOutput") or {}
                            _has_images2 = (
                                (isinstance(_sel2, dict) and bool(_sel2.get("imageData")))
                                or any(c.get("imageOutput") for c in notebook_context.get("cells", []))
                            )
                    if _has_images2:
                        _user_for_chat = _aclient_v2._build_content_blocks_from_text(
                            user, notebook_context
                        )
                chat_text = await provider.chat(
                    system=system, user=_user_for_chat, chat_history=chat_history
                )
                response = {
                    "operationId":         op_id,
                    "steps":               [],
                    "requiresApproval":    False,
                    "clarificationNeeded": None,
                    "summary":             "Advisory response",
                    "chatResponse":        chat_text,
                    "cellInsertionMode":   "chat",
                }

            elif cell_insertion_mode == "manual":
                # Manual mode: LLM returns a single JSON blob containing BOTH
                # the formatted advisory text (chatResponse) and an array of
                # individually applicable code-fix steps.
                # We do NOT stream manual mode because the LLM response is raw
                # JSON — streaming it would show ugly tokens in the chat window.
                if stream_requested:
                    self.write(f"data: {json.dumps({'type': 'progress', 'text': 'Reviewing notebook…'})}\n\n")
                    await self.flush()
                system   = _build_manual_review_system(skills, memory)
                user     = _build_manual_review_user(message, notebook_context, op_id)
                raw_text = await provider.chat(system=system, user=user)
                response = _parse_json_from_text(raw_text, op_id)
                # Ensure required fields are always present
                response.setdefault("operationId",        op_id)
                response.setdefault("cellInsertionMode",  "manual")
                response.setdefault("steps",              [])
                response.setdefault("requiresApproval",   False)
                response.setdefault("clarificationNeeded", None)

            else:
                # Standard mode (auto / preview): cell-operation JSON plan.
                if stream_requested:
                    # ── Concurrent progress + plan ────────────────────────────
                    # plan_task and a progress-message loop run concurrently.
                    # The loop sends a new status message every ~2 s so the user
                    # always sees activity during the LLM round-trip.
                    # Any pre-tool explanation text Claude generates also streams
                    # as "chunk" events via _on_plan_chunk.
                    skill_names = [s["name"] for s in skills if s.get("tier") == 2]
                    first_step = (f"Skill: {skill_names[0]}" if skill_names
                                  else "Reading notebook…")

                    _PROGRESS_STEPS = [
                        first_step,
                        "Analyzing structure…",
                        "Generating plan…",
                        "Finalizing…",
                    ]

                    plan_done = asyncio.Event()

                    async def _progress_loop() -> None:
                        for step in _PROGRESS_STEPS:
                            if plan_done.is_set():
                                return
                            self.write(
                                f"data: {json.dumps({'type': 'progress', 'text': step})}\n\n"
                            )
                            await self.flush()
                            # Poll every 100 ms for up to 2 s; exit early if done
                            for _ in range(20):
                                await asyncio.sleep(0.1)
                                if plan_done.is_set():
                                    return

                    async def _on_plan_chunk(text: str) -> None:
                        cleaned = _strip_null(text)
                        if not cleaned:
                            return
                        self.write(
                            f"data: {json.dumps({'type': 'chunk', 'text': cleaned})}\n\n"
                        )
                        await self.flush()
                        await asyncio.sleep(0)

                    async def _on_json_delta(partial: str) -> None:
                        """Stream raw tool-call JSON deltas so the frontend can show
                        a live preview of the cell content being generated."""
                        self.write(
                            f"data: {json.dumps({'type': 'json_delta', 'text': partial})}\n\n"
                        )
                        await self.flush()
                        await asyncio.sleep(0)

                    plan_thoughts: list = []

                    async def _on_plan_thought(text: str) -> None:
                        """Stream API-level thinking blocks to the 🧠 panel."""
                        plan_thoughts.append(text)
                        self.write(
                            f"data: {json.dumps({'type': 'thought', 'text': text})}\n\n"
                        )
                        await self.flush()
                        await asyncio.sleep(0)

                    # ── MCP Sequential Thinking loop for cell-ops (chip ON) ───
                    # Build a text-only context for the thought loop (no images)
                    # so the LLM reasons about what operations are needed before
                    # the heavier full-context final call.
                    final_message = message
                    if sequential_enabled and getattr(provider, "has_sequential_thinking", lambda: False)():
                        thought_user = (
                            build_notebook_context(message, notebook_context)
                            + "\n\nThink through step by step what notebook cell operations are needed to fulfil this request."
                        )
                        try:
                            plan_system = provider.build_system_prompt(
                                skills, memory, reasoning_mode=reasoning_mode
                            )
                        except NotImplementedError:
                            plan_system = ""
                        mcp_plan_thoughts = await provider.run_sequential_thinking_loop(
                            user=thought_user,
                            system=plan_system,
                            on_thought=_on_plan_thought,
                            chat_history=chat_history,
                        )
                        if mcp_plan_thoughts:
                            thought_lines = [
                                f"Step {t.get('thoughtNumber', i + 1)}: {t.get('thought', '')}"
                                for i, t in enumerate(mcp_plan_thoughts)
                            ]
                            thought_summary = "\n".join(thought_lines)
                            final_message = (
                                f"{message}\n\n"
                                f"[Pre-analysis you completed:\n{thought_summary}\n]"
                            )

                    # ── External MCP tool loop for cell-ops ─────────────────
                    mcp_manager = self.settings.get("ds_mcp_manager")
                    aclient_for_loop = getattr(provider, "_chat_client", None)

                    progress_task = asyncio.create_task(_progress_loop())
                    try:
                        from ..llm.client import ClaudeClient as _CC2, OPERATION_PLAN_TOOL as _OPT
                        if (mcp_manager and mcp_manager.has_tools()
                                and isinstance(aclient_for_loop, _CC2)):
                            # Agentic loop: external tools + create_operation_plan
                            from ..llm.client import _build_system_prompt_shared as _bsp
                            plan_system_prompt = _bsp(skills, memory, reasoning_mode=reasoning_mode)
                            if cot_enabled:
                                plan_system_prompt += _COT_SYSTEM_SUFFIX
                            # Inject MCP tool awareness so the LLM uses tools
                            # instead of refusing to access external resources.
                            ext_tools_plan = mcp_manager.get_all_tools()
                            if ext_tools_plan:
                                tool_lines_plan = "\n".join(
                                    f"  - {t['name'].split('__', 1)[-1]} "
                                    f"(server: {t['name'].split('__', 1)[0]}): "
                                    f"{t.get('description', '')[:120]}"
                                    for t in ext_tools_plan
                                )
                                plan_system_prompt += (
                                    "\n\n## External MCP Tools — Available Now\n"
                                    "You have access to the following external tools.\n"
                                    "Call them when you need external data before generating the cell plan.\n\n"
                                    f"{tool_lines_plan}\n\n"
                                    "Always prefer calling a tool over apologising for lack of access."
                                )
                            content_blocks = aclient_for_loop._build_content_blocks(
                                final_message, notebook_context
                            )
                            msgs_for_loop = aclient_for_loop._prepend_history(
                                chat_history, content_blocks
                            )
                            response = await _run_mcp_tool_loop(
                                aclient=aclient_for_loop,
                                system=plan_system_prompt,
                                messages=msgs_for_loop,
                                builtin_tools=[_OPT],
                                mcp_manager=mcp_manager,
                                on_text_chunk=_on_plan_chunk,
                                on_thought=_on_plan_thought,
                            )
                            # Propagate accumulated token counts from the MCP loop.
                            if hasattr(aclient_for_loop, "last_usage"):
                                provider.last_usage = aclient_for_loop.last_usage
                            response.setdefault("operationId", op_id)
                        else:
                            response = await provider.stream_plan_task(
                                user_message=final_message,
                                notebook_context=notebook_context,
                                skills=skills,
                                memory=memory,
                                operation_id=op_id,
                                on_text_chunk=_on_plan_chunk,
                                on_json_delta=_on_json_delta,
                                on_thought=_on_plan_thought,
                                chat_history=chat_history,
                                reasoning_mode=reasoning_mode,
                            )
                    finally:
                        plan_done.set()
                        progress_task.cancel()
                        try:
                            await progress_task
                        except asyncio.CancelledError:
                            pass

                    # Attach collected thinking to the response so the frontend
                    # renders the 🧠 panel for cell operations too.
                    if plan_thoughts:
                        response["thoughts"] = "".join(plan_thoughts).strip()

                    # ── Retry gate ────────────────────────────────────────────
                    # stream_plan_task uses tool_choice:"auto" so the LLM can
                    # stream a prose preamble before calling the tool.  The
                    # downside: it sometimes skips the tool call entirely and
                    # returns steps:[] — even for clear code-generation requests.
                    #
                    # Advisory/chat messages never reach this branch: they are
                    # dispatched to stream_chat() at the cell_insertion_mode=="chat"
                    # check above.  Every request that arrives here is expected to
                    # produce at least one cell-operation step, so we retry
                    # unconditionally when steps are empty and no clarification
                    # was requested.
                    steps_empty = not response.get("steps")
                    # Treat the string "null" the same as JSON null — the LLM
                    # sometimes writes the keyword literally instead of omitting it.
                    _clarif = response.get("clarificationNeeded")
                    clarification_needed = bool(_clarif) and _clarif != "null"

                    if steps_empty and not clarification_needed:
                        # Tell the frontend a retry is in progress
                        self.write(
                            f"data: {json.dumps({'type': 'progress', 'text': 'Generating cell operations…'})}\n\n"
                        )
                        await self.flush()

                        # Forced second pass — tool_choice:"any" guarantees a tool call
                        response = await provider.plan_task(
                            user_message=message,
                            notebook_context=notebook_context,
                            skills=skills,
                            memory=memory,
                            operation_id=op_id,
                            chat_history=chat_history,
                        )
                        # If still empty (truly nothing to do), leave as-is

                else:
                    response = await provider.plan_task(
                        user_message=message,
                        notebook_context=notebook_context,
                        skills=skills,
                        memory=memory,
                        operation_id=op_id,
                        chat_history=chat_history,
                    )
                response["cellInsertionMode"] = cell_insertion_mode
                # Signal to frontend that a skill wanted to create cells but
                # the user's "Chat Only" toggle prevented it.
                if skill_wanted_cells:
                    response["skillWantedCells"] = True

            # Attach token usage so the frontend can track costs per thread.
            usage = getattr(provider, "last_usage", None)
            log.info("TOKEN_DEBUG last_usage=%r  provider=%r", usage, type(provider).__name__)
            if usage:
                response["tokenUsage"] = usage
            _fire_usage(
                provider,
                notebook_path,
                "skill" if _skill_meta else "chat",
            )

            if warnings:
                response["warnings"] = warnings

            # Attach resize feedback so the frontend can show a confirmation notice.
            if _image_resize_count > 0 or _image_resize_warnings:
                response["imageResizeInfo"] = {
                    "count":    _image_resize_count,
                    "warnings": _image_resize_warnings,
                }

            # If we already opened an SSE stream (for the progress event),
            # send the final payload as a "done" event rather than raw JSON.
            content_type = self._headers.get("Content-Type", "")
            if "text/event-stream" in content_type:
                response["type"] = "done"
                self.write(f"data: {json.dumps(response)}\n\n")
                self.finish()
            else:
                self.finish(json.dumps(response))

        except Exception as e:
            self.log.error(f"Varys task error: {traceback.format_exc()}")
            # Check for image dimension errors before sending a generic error response.
            try:
                from ..image_processing import is_image_dimension_error as _is_img_err
                _is_img_dim = _is_img_err(e)
            except Exception:  # noqa: BLE001
                _is_img_dim = False

            if _is_img_dim:
                # Return a structured event so the frontend can render the recovery UI.
                _provider_name = self.settings.get(
                    "ds_assistant_chat_provider", ""
                ).lower()
                self.set_status(200)  # SSE error events must ride on 200
                self.set_header("Content-Type", "text/event-stream")
                self.write(f"data: {json.dumps({'type': 'image_too_large', 'error': str(e), 'provider': _provider_name})}\n\n")
                self.finish()
                return

            # Check for API overload / rate-limit errors.
            _err_lower = str(e).lower()
            _is_overloaded = (
                "overloaded" in _err_lower
                or "overload_error" in _err_lower
                or "529" in _err_lower
            )
            if _is_overloaded:
                _msg = (
                    "⚠️ The API is temporarily overloaded. "
                    "Please wait a few seconds and try again."
                )
                self.set_status(200)
                self.set_header("Content-Type", "text/event-stream")
                self.write(f"data: {json.dumps({'type': 'done', 'operationId': operation_id, 'steps': [], 'requiresApproval': False, 'clarificationNeeded': None, 'cellInsertionMode': 'chat', 'chatResponse': _msg, 'summary': 'API overloaded'})}\n\n")
                self.finish()
                return

            # Check for billing / credit errors.
            _is_billing = (
                "credit balance is too low" in _err_lower
                or "billing" in _err_lower
                or "payment" in _err_lower
                or "your account" in _err_lower and "upgrade" in _err_lower
            )
            if _is_billing:
                _msg = (
                    "💳 Your API credit balance is too low. "
                    "Please add credits in your provider's billing dashboard. "
                    "Note: it can take **5–15 minutes** for new credits to become active."
                )
                self.set_status(200)
                self.set_header("Content-Type", "text/event-stream")
                self.write(f"data: {json.dumps({'type': 'done', 'operationId': operation_id, 'steps': [], 'requiresApproval': False, 'clarificationNeeded': None, 'cellInsertionMode': 'chat', 'chatResponse': _msg, 'summary': 'Billing error'})}\n\n")
                self.finish()
                return

            # Check for prompt-too-long errors (context budget exceeded).
            _is_ctx_long = (
                "prompt is too long" in _err_lower
                or "context length exceeded" in _err_lower
                or "maximum context length" in _err_lower
                or "context_length_exceeded" in _err_lower
                or "reduce the length of the messages" in _err_lower
            )
            if _is_ctx_long:
                _nb_ctx = locals().get("notebook_context") or {}
                _has_images = any(
                    c.get("imageOutput") for c in _nb_ctx.get("cells", [])
                )
                self.set_status(200)
                self.set_header("Content-Type", "text/event-stream")
                self.write(f"data: {json.dumps({'type': 'context_too_long', 'error': str(e), 'has_images': _has_images})}\n\n")
                self.finish()
                return

            self.set_status(500)
            if stream_requested:
                # For SSE responses already started, send error as final event
                self.set_header("Content-Type", "text/event-stream")
                self.write(f"data: {json.dumps({'type': 'error', 'error': str(e)})}\n\n")
                self.finish()
            else:
                self.set_header("Content-Type", "application/json")
                self.finish(json.dumps({"error": str(e)}))

    async def _handle_file_agent(
        self,
        slash_command: str,
        message: str,
        operation_id: str,
        notebook_context: dict,
        stream_requested: bool,
        allowed_tools_override: list | None = None,
        skill_triggered: bool = False,
    ) -> None:
        """Handle /file_agent, /file_agent_find, /file_agent_save commands.

        ``allowed_tools_override`` — when provided (e.g. from a skill's
        ``allowed_tools`` front-matter field), takes precedence over the
        defaults derived from ``slash_command``.

        ``skill_triggered`` — when True (custom skill with agent_mode: true),
        the VARYS_AGENT_ENABLED check is bypassed because the user has already
        opted in by placing agent_mode: true in their own skill file.

        All three branches share common validation (VARYS_AGENT_ENABLED,
        validate_agent_config, resolve_working_directory). After validation,
        each branch constructs AgentCallbacks and awaits agent_runner.run(),
        emitting SSE events from callbacks and a done event from the return value.
        """
        import os
        import json as _json
        import asyncio as _asyncio

        # ── Load project-local config (overrides global os.environ) ──────────
        notebook_path = notebook_context.get("notebookPath", "")
        from ..agent.local_config import load_local_agent_config, get_agent_env
        local_cfg = load_local_agent_config(notebook_path)

        # ── Common validation ─────────────────────────────────────────────────
        enabled = get_agent_env("VARYS_AGENT_ENABLED", local_cfg, "false").lower() in ("1", "true", "yes")
        # Custom skills that declare agent_mode: true are treated as implicit
        # consent — no need for the global file-agent flag.
        if not enabled and not skill_triggered:
            if stream_requested:
                self.set_header("Content-Type", "text/event-stream")
                self.set_header("Cache-Control", "no-cache")
                self.set_header("X-Accel-Buffering", "no")
                self.write(f"data: {_json.dumps({'type': 'done', 'operationId': operation_id, 'steps': [], 'requiresApproval': False, 'clarificationNeeded': None, 'cellInsertionMode': 'chat', 'chatResponse': '⚠ Varys File Agent is disabled. Enable it in Settings → Varys File Agent.', 'summary': 'Disabled'})}\n\n")
                self.finish()
            else:
                self.set_header("Content-Type", "application/json")
                self.finish(_json.dumps({"error": "VARYS_AGENT_ENABLED is false"}))
            return

        try:
            from ..agent.utils import resolve_working_directory
            # When the caller already resolved the working dir (e.g. file-agent routing
            # using the target file's parent directory), use that directly so we don't
            # accidentally fall back to root_dir and cause off-by-one-directory bugs.
            _wd_override = notebook_context.get("_file_agent_working_dir", "")
            if _wd_override and os.path.isdir(_wd_override):
                working_dir = _wd_override
            else:
                working_dir = resolve_working_directory(notebook_path, self.settings, local_cfg)
        except Exception as exc:
            msg = str(exc)
            if stream_requested:
                self.set_header("Content-Type", "text/event-stream")
                self.set_header("Cache-Control", "no-cache")
                self.set_header("X-Accel-Buffering", "no")
                self.write(f"data: {_json.dumps({'type': 'done', 'operationId': operation_id, 'steps': [], 'requiresApproval': False, 'clarificationNeeded': None, 'cellInsertionMode': 'chat', 'chatResponse': f'⚠ Working directory error: {msg}', 'summary': 'Working dir error'})}\n\n")
                self.finish()
            else:
                self.set_header("Content-Type", "application/json")
                self.finish(_json.dumps({"error": msg}))
            return

        max_tokens    = int(os.environ.get("VARYS_AGENT_MAX_TOKENS", "8192"))
        max_turns     = int(get_agent_env("VARYS_AGENT_MAX_TURNS",   local_cfg, "50")  or "50")
        timeout_secs  = float(get_agent_env("VARYS_AGENT_TIMEOUT_SECS", local_cfg, "120") or "120")

        # ── Load system prompt ────────────────────────────────────────────────
        # For custom skills with agent_mode: true, load the skill's own content
        # (keyed to its command) and prepend the execution-mode preamble.
        # For built-in /file_agent commands, fall back to the /file_agent skill
        # or the default preamble.
        system_prompt = _FILE_AGENT_SYSTEM_PROMPT
        try:
            from ..skills.loader import SkillLoader
            root_dir = self.settings.get("ds_assistant_root_dir", ".")
            sl = SkillLoader(root_dir, notebook_path)
            cmd_to_load = slash_command if skill_triggered else "/file_agent"
            skills = sl.load_by_command(cmd_to_load)
            if skills:
                # Concatenate all skill contents (Tier-1 persona + command skill)
                parts = [s.get("content", "").strip() for s in skills
                         if s.get("content", "").strip()]
                combined = "\n\n---\n\n".join(parts)
                if combined:
                    if skill_triggered:
                        # Execution-mode preamble (no staging language) + skill body
                        system_prompt = _SKILL_AGENT_SYSTEM_PROMPT + "\n\n---\n\n" + combined
                        log.info(
                            "Varys skill agent: system_prompt length=%d allowed_tools=%s",
                            len(system_prompt), allowed_tools,
                        )
                    else:
                        system_prompt = combined
        except Exception:
            pass  # fall back to default

        # ── /file_agent help short-circuit ────────────────────────────────────
        if slash_command == "/file_agent" and message.strip().lower() in ("help", "--help", "-h", ""):
            help_text = (
                "**Varys File Agent** (`/file_agent`) — AI file agent\n\n"
                "Read, write, and edit project files without a terminal.\n\n"
                "**Usage:** `/file_agent <your task>`\n\n"
                "**Examples:**\n"
                "- `/file_agent add docstrings to src/utils.py`\n"
                "- `/file_agent create a README for this project`\n"
                "- `/file_agent refactor src/preprocessing.py to use dataclasses`\n\n"
                "**Settings:** Enable per-project via ⚙ in the agent results header, "
                "or create `.jupyter-assistant/local_varys.env` with `VARYS_AGENT_ENABLED=true` in your project directory. "
                "Requires `ANTHROPIC_API_KEY` and `ANTHROPIC_CHAT_MODEL` (set in Settings → Models → Anthropic).\n\n"
                "See the bundled README for full documentation."
            )
            if stream_requested:
                self.set_header("Content-Type", "text/event-stream")
                self.set_header("Cache-Control", "no-cache")
                self.set_header("X-Accel-Buffering", "no")
                self.write(f"data: {_json.dumps({'type': 'done', 'operationId': operation_id, 'steps': [], 'requiresApproval': False, 'clarificationNeeded': None, 'cellInsertionMode': 'chat', 'chatResponse': help_text, 'summary': 'Help'})}\n\n")
                self.finish()
            else:
                self.set_header("Content-Type", "application/json")
                self.finish(_json.dumps({
                    "operationId": operation_id, "steps": [], "requiresApproval": False,
                    "clarificationNeeded": None, "cellInsertionMode": "chat",
                    "chatResponse": help_text, "summary": "Help",
                }))
            return

        # ── Branch-specific tool configuration ────────────────────────────────
        if slash_command == "/file_agent":
            allowed_tools_str = get_agent_env("VARYS_AGENT_ALLOWED_TOOLS", local_cfg, "Read,Write,Edit,Glob,Grep")
            allowed_tools = [t.strip() for t in allowed_tools_str.split(",") if t.strip()]
            trigger = "slash_command"
        elif slash_command == "/file_agent_find":
            allowed_tools = ["Read", "Glob", "Grep"]
            trigger = "find"
        elif slash_command == "/file_agent_save":
            allowed_tools = ["Read", "Write", "Glob", "Grep"]
            trigger = "save"
        else:
            allowed_tools = ["Read", "Write", "Edit", "Glob", "Grep"]
            trigger = "slash_command"

        # Skill-level override (from front-matter `allowed_tools` field) wins.
        if allowed_tools_override:
            allowed_tools = allowed_tools_override

        # ── SSE setup ─────────────────────────────────────────────────────────
        if stream_requested:
            self.set_header("Content-Type", "text/event-stream")
            self.set_header("Cache-Control", "no-cache")
            self.set_header("X-Accel-Buffering", "no")

        async def _emit(event: dict) -> None:
            if stream_requested:
                try:
                    self.write(f"data: {_json.dumps(event)}\n\n")
                    await self.flush()
                    await _asyncio.sleep(0)
                except Exception:
                    pass  # client disconnected — agent still runs to completion

        # Send an immediate heartbeat so the SSE connection stays alive while
        # the agent initialises and the LLM API call starts.  Without this, the
        # client-side SSE reader can time out during the silent initialisation
        # phase (especially for skill-triggered agent_mode requests that go
        # through the regular chat send path which has a shorter idle timeout).
        if stream_requested and skill_triggered:
            await _emit({"type": "progress", "text": "Starting…"})

        # Accumulate streamed text so we can populate chatResponse in the done
        # event — the regular-chat SSE handler replaces the message bubble
        # content with chatResponse when the done event arrives, so we must
        # echo back whatever we streamed via chunk events.
        _accumulated_text: list[str] = []

        # ── Build AgentCallbacks ───────────────────────────────────────────────
        from ..agent.agent_runner import AgentCallbacks
        from ..agent.tools import FileChange

        async def _on_text_chunk(text: str) -> None:
            _accumulated_text.append(text)
            await _emit({"type": "chunk", "text": text})

        async def _on_thought(text: str) -> None:
            await _emit({"type": "thought", "text": text})

        async def _on_progress(text: str) -> None:
            await _emit({"type": "progress", "text": text})

        async def _on_file_change(fc: FileChange) -> None:
            limit = int(os.environ.get("VARYS_AGENT_DIFF_INLINE_LIMIT", "50000"))
            original = fc.original_content or ""
            new      = fc.new_content     or ""
            deferred = len(original) > limit or len(new) > limit
            await _emit({
                "type":             "agent_file_change",
                "change_id":        fc.change_id,
                "file_path":        fc.file_path,
                "change_type":      fc.change_type,
                "original_content": None if deferred else fc.original_content,
                "new_content":      None if deferred else fc.new_content,
                "content_deferred": deferred,
                "total_changes":    0,
            })

        callbacks = AgentCallbacks(
            on_text_chunk=_on_text_chunk,
            on_thought=_on_thought,
            on_progress=_on_progress,
            on_file_change=_on_file_change,
        )

        # ── Run agent ─────────────────────────────────────────────────────────
        from ..agent.agent_runner import run as _agent_run

        try:
            result = await _agent_run(
                task=message,
                working_dir=working_dir,
                allowed_tools=allowed_tools,
                system_prompt=system_prompt,
                max_turns=max_turns,
                max_tokens=max_tokens,
                timeout_secs=timeout_secs,
                operation_id=operation_id,
                app_settings=self.settings,
                callbacks=callbacks,
                notebook_path=notebook_path,
                command=slash_command or "",
                local_cfg=local_cfg,
            )
        except Exception as exc:
            log.error("Varys File Agent error: %s", exc, exc_info=True)
            done_event = {
                "type": "done",
                "operationId": operation_id,
                "steps": [],
                "requiresApproval": False,
                "clarificationNeeded": None,
                "cellInsertionMode": "chat",
                "chatResponse": f"Agent error: {exc}",
                "summary": "Error",
            }
            await _emit(done_event)
            if not stream_requested:
                self.set_header("Content-Type", "application/json")
                del done_event["type"]
                self.finish(_json.dumps(done_event))
            else:
                self.finish()
            return

        # ── Handle tool-use-not-supported error ───────────────────────────────
        if result.error_type == "tool_use_not_supported":
            tool_err_event = {
                "type":       "agent_tool_error",
                "operationId": operation_id,
                "provider":   result.error_provider or "",
                "model":      result.error_model or "",
                "message":    result.error or "",
                "suggestion": result.error_suggestion or "",
            }
            await _emit(tool_err_event)
            if not stream_requested:
                self.set_header("Content-Type", "application/json")
                del tool_err_event["type"]
                self.finish(_json.dumps(tool_err_event))
            else:
                self.finish()
            return

        # ── Handle agent config error (unsupported provider, missing creds) ──
        # Return the error as a readable chat message, NOT as incomplete=True
        # (which would show the misleading "turn limit" banner).
        if result.error_type == "agent_config_error":
            done_event = {
                "type":              "done",
                "operationId":       operation_id,
                "steps":             [],
                "requiresApproval":  False,
                "clarificationNeeded": None,
                "cellInsertionMode": "chat",
                "is_file_agent":     True,
                "chatResponse":      f"⚠ {result.error or 'File Agent is not configured for the current provider.'}",
                "summary":           "Agent config error",
                "file_changes":      [],
                "files_read":        [],
                "incomplete":        False,
                "bash_outputs":      [],
                "blocked_commands":  [],
            }
            await _emit(done_event)
            if not stream_requested:
                self.set_header("Content-Type", "application/json")
                del done_event["type"]
                self.finish(_json.dumps(done_event))
            else:
                self.finish()
            return

        # ── Handle provider API error (billing, quota, network) ──────────────
        # The run() loop captured stop_reason="error" and stored the message.
        # Surface it as a readable chat response so the user knows what happened.
        if result.error_type == "provider_api_error" and result.error:
            err = result.error
            if "credit balance" in err or "billing" in err.lower() or "quota" in err.lower():
                friendly = (
                    f"⚠ Anthropic API: your credit balance is too low.\n\n"
                    f"Add credits at [console.anthropic.com/settings/billing]"
                    f"(https://console.anthropic.com/settings/billing) then retry."
                )
            else:
                friendly = f"⚠ Provider API error: {err}"
            done_event = {
                "type":              "done",
                "operationId":       operation_id,
                "steps":             [],
                "requiresApproval":  False,
                "clarificationNeeded": None,
                "cellInsertionMode": "chat",
                "is_file_agent":     True,
                "chatResponse":      friendly,
                "summary":           "Provider API error",
                "file_changes":      [],
                "files_read":        [],
                "incomplete":        False,
                "bash_outputs":      [],
                "blocked_commands":  [],
            }
            await _emit(done_event)
            if not stream_requested:
                self.set_header("Content-Type", "application/json")
                del done_event["type"]
                self.finish(_json.dumps(done_event))
            else:
                self.finish()
            return

        # ── Enrich session with metadata for audit log ─────────────────────────
        sessions = self.settings.get("agent_sessions", {})
        if operation_id in sessions:
            session = sessions[operation_id]
            session["trigger"]          = trigger
            session["task_description"] = message[:500]
            session["tools_used"]       = allowed_tools
            session["files_read"]       = result.files_read
            session["bash_commands"]    = [
                {"command": b.command, "stdout": b.stdout, "timed_out": b.timed_out,
                 "warn_reason": b.warn_reason}
                for b in result.bash_outputs
            ]
            session["turn_count"]       = result.turn_count
            session["duration_seconds"] = result.duration_seconds
            session["model"]            = result.model
            session["incomplete"]       = result.incomplete

        # ── Emit done SSE ─────────────────────────────────────────────────────
        _full_response = "".join(_accumulated_text).strip()
        done_event = {
            "type":              "done",
            "operationId":       operation_id,
            "steps":             [],
            "requiresApproval":  False,
            "clarificationNeeded": None,
            "cellInsertionMode": "chat",
            # Sentinel so the frontend recognises this as a file-agent response
            # even when the user didn't type /file_agent (auto-routing).
            "is_file_agent":     True,
            "summary":           f"Varys File Agent: {len(result.file_changes)} file(s) changed",
            # Echo the streamed text so the frontend's done-event handler
            # restores the message bubble with the full LLM response instead
            # of overwriting it with an empty string.
            "chatResponse":      _full_response or f"Done — {len(result.file_changes)} file(s) changed.",
            "file_changes": [
                {
                    "change_id":        fc.change_id,
                    # Always send the absolute path so the UI unambiguously
                    # identifies which file was changed — critical when the
                    # workspace contains multiple files with the same name.
                    "file_path":        os.path.normpath(
                                            os.path.join(working_dir, fc.file_path)
                                        ),
                    "change_type":      fc.change_type,
                    "total_changes":    len(result.file_changes),
                    # Include diff content so the card can show a proper inline diff.
                    # Defer very large files (>50 kB combined) to keep the SSE payload small.
                    **({
                        "original_content": None,
                        "new_content":      None,
                        "content_deferred": True,
                    } if len(fc.original_content or "") + len(fc.new_content or "") > 50_000 else {
                        "original_content": fc.original_content,
                        "new_content":      fc.new_content,
                        "content_deferred": False,
                    }),
                }
                for fc in result.file_changes
            ],
            "files_read":    result.files_read,
            "incomplete":    result.incomplete,
            "timed_out":     result.timed_out,
            "bash_outputs": [
                {
                    "command":     b.command,
                    "stdout":      b.stdout,
                    "timed_out":   b.timed_out,
                    "warn_reason": b.warn_reason,
                }
                for b in result.bash_outputs
            ],
            "blocked_commands": [
                {"command": bc.command, "reason": bc.reason}
                for bc in result.blocked_commands
            ],
            "tokenUsage":    result.token_usage,
        }

        await _emit(done_event)
        if not stream_requested:
            self.set_header("Content-Type", "application/json")
            del done_event["type"]
            self.finish(_json.dumps(done_event))
        else:
            self.finish()

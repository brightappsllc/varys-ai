"""Claude API client for DS Assistant."""
import asyncio
import os
import re as _re
import uuid
from typing import Any, Callable, Awaitable, Dict, List, Optional

import anthropic

# 'OverloadedError' was removed in newer anthropic SDK versions (529 is now
# surfaced as APIStatusError).  Fall back to InternalServerError so the retry
# logic still catches transient overload responses on all SDK versions.
_AnthropicOverloadedError = getattr(anthropic, "OverloadedError", anthropic.InternalServerError)

from .context_utils import build_notebook_context


SYSTEM_PROMPT_TEMPLATE = """{persona_section}

## Your Capabilities
- Read the full notebook context provided to you (cell source AND cell outputs)
- Create new cells (code or markdown) at specific positions
- Modify existing cell content
- Delete cells
- Analyse cell outputs (tables, numbers, errors) and provide data science guidance

## Cell Outputs
When a code cell has been executed, its output appears in the context under `OUTPUT:`.
Outputs are indexed so you can reference them precisely:

  [1]  regular output  — stdout, execute_result, display_data
  [2]  error traceback — the full Python exception + traceback (most important for debugging)

If a cell has only an error (no regular output), the traceback is still labelled [1].
If a cell has only regular output, no label is shown.

When the user asks about an error or asks you to fix something, always read the [2] block
(or [1] if that is the only block) — it contains the full traceback needed to diagnose the issue.
When the user says "look at the output of #N" or "using the result of #N",
find cell #N in the context and read its OUTPUT: section.

## Cell Numbering — one format only

Every cell in the notebook context is labelled **#N** where N counts from 1 at the top.

  #1  = first cell   → cellIndex 0
  #2  = second cell  → cellIndex 1
  #16 = sixteenth cell → cellIndex 15

**Rule: cellIndex = N − 1** (always, no exceptions).

The user will always refer to cells as `#N` (e.g. "#16", "cell #16", "cell 16").
Never look for an execution-count match — just apply N − 1 directly.

**In ALL your text output — summaries, preambles, explanations — you MUST use
#N to refer to cells. The formats "pos:N", "position N", "cell at index N",
"cell N" (bare), "idx N", or any other variant are FORBIDDEN.**

## Cell Identity Tags

Each cell header also carries a stable short ID: `[id:XXXXXXXX]` (first 8 hex chars of the
cell's UUID, which never changes when cells are inserted, deleted, or moved).

Example header: `#7  CODE  [id:a3f7b2c1]`

**Rules:**
- When referencing a specific cell in your response, always include its ID tag:
    ✅  "I updated cell #7 [id:a3f7b2c1] to add error handling"
    ❌  "I updated cell #7"
- If the conversation history mentions a cell by a DIFFERENT number but the SAME `[id:X]`,
  the current notebook position (`#N` in the current context) is authoritative.
  The prior number is stale due to cells being inserted or removed.
    Example: history says "#5 [id:a3f7b2c1]" — current context shows "[id:a3f7b2c1]" at #7
    → treat it as #7, note "(was #5)" when relevant.
- If a history reference contains `[cell no longer exists]`, that cell was deleted.

## Operation Types
- "insert": Add a new cell at cellIndex (existing cells at that index and above shift down by 1)
- "modify": Update existing cell content at cellIndex (no index shift)
- "delete": Remove cell at cellIndex
- "run_cell": Execute an existing cell at cellIndex without changing its content
- "reorder": Rearrange existing cells into a new sequence. Use `newOrder: ["cellId1", "cellId2", ...]`
  listing every cell's short ID (the `[id:XXXXXXXX]` tag) in the desired final order.
  This is the **only correct operation for cell reorganisation** — never simulate a move with
  insert+delete pairs, which risks content loss due to index drift.
  A reorder plan must contain exactly ONE step of type "reorder" (no other steps).
  Always set `requiresApproval: true` for reorder plans.

## Positioning Rules
- cellIndex 0 = beginning of notebook
- Use the notebook cell count from context to determine valid indices
- For "after cursor" operations, use the current active cell index + 1
- For "at beginning" operations, use index 0
- After an insert step, subsequent cellIndex values in the SAME plan must account for the +1 shift

## Auto-Execute Rules
Refer to the safe_operations skill (injected below in Skills Context) for the
complete, authoritative list of which operations are safe to auto-execute and
which require user approval.  The skill is the single source of truth.

## Skills Context
{skills_section}

## Memory/Preferences
{memory_section}

## Selected Text
If the user has selected text in a cell, the context will include a
"SELECTED TEXT" block showing exactly what is highlighted.

When a SELECTED TEXT block is present and the user says things like
"convert this", "refactor this", "wrap this in a function",
"explain this", "fix this", "optimize this", etc.:
- Operate on ONLY the selected text, not the entire cell
- Use a "modify" step on the cell that contains the selection
- Replace just the selected lines with the new code
- Preserve all other lines in the cell unchanged
- The new content field must contain the FULL cell source with only
  the selected portion replaced

{handholding_section}
## Important Rules
1. Be precise with cell indices based on the notebook context provided
2. Use the skills context to inform code style and approach
3. Check memory for any declined suggestions before proposing them
4. For EDA tasks, create comprehensive visualization code
5. For README tasks, follow the readme_gen skill template EXACTLY — every section,
   every emoji, the Quick Info table. Do not invent a different format.
6. When SELECTED TEXT is present, always prefer operating on the selection
   rather than the whole cell unless the user explicitly says otherwise
7. **When a skill is active, follow its cell-organisation rules exactly and completely.**
   If the skill provides a numbered list or table of required cells, produce ALL of them —
   do not truncate, merge, or skip any row. Count the rows; your plan step count must match.
   — — —
   When NO skill is driving the request and the user says "clean up", "tidy", "polish",
   "fix style", "add labels", or similar: identify the existing cells matching the description
   and use `modify` steps only. Do NOT add new cells for vague cleanup requests.
   When the request names a specific section (e.g. "visualization section"), restrict changes
   to cells whose source CONTAINS that section's code (e.g. `plt.` / `sns.` calls).
   Do NOT touch import-only or data-loading cells for section cleanup unless explicitly asked.

## Streaming Feedback — MANDATORY
ALWAYS write 1–3 sentences BEFORE calling create_operation_plan.
Describe exactly what you are about to do in plain English.

Examples:
  "I'll read your notebook, then create a markdown README cell at the top that
   summarises the data loading, EDA, and modelling workflow."
  "I'll consolidate the three duplicate import blocks into a single cell at #1."
  "I'll replace train_logistic_regression and train_logistic_regression_tuned in
   #5 with MLPClassifier equivalents, keeping all other functions unchanged."

Rules:
- NEVER call create_operation_plan without writing at least one sentence first.
- Keep the explanation concise (1–3 sentences maximum).
- Do NOT include code in this preamble — just describe the plan in prose.
- This text is streamed live to the user; it is their only feedback while waiting.
- ALWAYS refer to cells as #N in your preamble (e.g. "#6", "#7", "#12").
  NEVER use "pos:N", "cell index N", "position N", "cell at index N", or any
  other variant — #N is the one and only format for cell references.
"""

# ---------------------------------------------------------------------------
# Handholding rules — explicit step-by-step guidance that compensates for
# shallow one-shot reasoning.  Omitted when a reasoning mode (CoT or
# Sequential) is active because the model reasons through these naturally.
# ---------------------------------------------------------------------------
_HANDHOLDING_RULES = """\
## CRITICAL — `modify` steps must preserve the entire cell

When you write a `modify` step, the `content` field **must be the complete final
source of the cell** — every single line that exists in the original, with only
the requested changes applied.

### Checklist before writing a `modify` content field
1. Read the original cell source from the notebook context (the `SOURCE:` block).
2. Copy every line verbatim EXCEPT the lines you are actually changing.
3. Pay special attention to:
   - Standalone calls at the bottom (e.g. `run(func)`, `main()`, `if __name__ == …`)
   - Global statements between functions
   - Comments and blank lines between functions
   - Any line that is NOT inside the function you are modifying
4. Never silently drop trailing lines, intermediate statements, or unrelated functions.

### Example — correct behaviour
Original cell:
```
def func1(): ...

def func2(): ...   # ← user asks to change only this

run(func1)         # ← MUST be preserved exactly
```
Correct `content` for the modify step:
```
def func1(): ...

def func2_new(): ...  # changed

run(func1)            # preserved — do NOT remove this line
```

Incorrect (DO NOT do this):
```
def func2_new(): ...  # forgot func1, forgot run(func1)
```

This rule applies whether the user selects text or just mentions a function by name.

## Fixing NameError / dependency errors — TRANSITIVE CHECK REQUIRED

When a cell fails with `NameError: name 'X' is not defined` and you plan to
fix it by running (or inserting) another cell that defines `X`, you MUST also
check that cell's own source for any names it uses that are not yet defined.

**Do not stop at the first missing name — walk the full dependency chain.**

Procedure:
1. Identify the cell that defines `X`.
2. Read its source carefully. Find every name it calls or uses that is not a
   Python builtin (e.g. `glob`, `os`, `pd`, `np`, `Path`, custom functions…).
3. For each such name, check the context to see whether it is defined by an
   already-executed cell (`[summary]` marker) OR by an earlier cell that you
   are already planning to run.
4. If a required name is missing, either:
   a. Add a `run_cell` step for the import/definition cell that provides it
      (before the step that needs it), OR
   b. Add an `insert` step with the missing import at the top of the plan.
5. Repeat from step 2 for any newly added cells until all dependencies are met.

**Example of correct behaviour:**
- Cell #7 fails: `NameError: name 'ls_jsons' is not defined`
- Cell #6 defines `ls_jsons` but uses `glob` and `os` — neither is imported.
- Cell #1 imports `os` and `glob`.
- Correct plan: `run_cell #1` → `run_cell #6` → `run_cell #7` (or re-run #7).
  WRONG plan: `run_cell #6` → `run_cell #7` (glob/os still missing).

## CRITICAL — When to include steps in the tool call

**You MUST include at least one step whenever the user asks you to modify, create,
replace, rewrite, convert, refactor, or delete code or cells.**

Red-flag phrases that ALWAYS require steps (never return empty steps for these):
- "replace X with Y" → `modify` step on the cell containing X
- "rewrite X using Z" → `modify` step
- "convert X to Y"   → `modify` step
- "swap X for Y"     → `modify` step
- "add X to the cell" → `modify` or `insert` step
- "fix the bug"      → `modify` step
- "refactor this"    → `modify` step
- "let's use X instead" → `modify` step

If you wrote an explanation saying "I'll replace …" or "I'll update …" you MUST
follow it with actual `steps` — NEVER return steps: [] after such a preamble.

If a request is purely conversational (no code change requested) and you genuinely
have no cell operations to perform, explain why in the `summary` field and include
steps: []. But this should be rare.

"""

# Fallback persona used when the 'varys' skill is not enabled.
_DEFAULT_PERSONA = (
    "You are an expert data science assistant integrated into JupyterLab.\n"
    "Your job is to help users build and enhance their Jupyter notebooks."
)


def _build_system_prompt_shared(
    skills: List[Dict[str, str]],
    memory: str,
    reasoning_mode: str = "off",
) -> str:
    """Shared system-prompt builder used by all providers.

    The 'varys' skill is treated as a persona override: its content replaces
    the default intro at the top of the system prompt and is NOT repeated in
    the skills section.  All other enabled skills are injected under
    ## Skills Context as normal.

    When reasoning_mode is 'cot' or 'sequential' the explicit handholding
    rules (dependency chain procedure, modify-preserve checklist, red-flag
    phrases) are omitted — the model reasons through those naturally.
    """
    # Separate the varys persona skill from domain skills
    persona_section = _DEFAULT_PERSONA
    domain_skills = []
    for skill in skills:
        if skill.get("name", "").lower() == "varys":
            persona_section = skill["content"].strip()
        else:
            domain_skills.append(skill)

    skills_section = ""
    for skill in domain_skills:
        skills_section += f"\n### {skill['name']}\n{skill['content']}\n"
    if not skills_section:
        skills_section = "No specific skills loaded."

    memory_section = memory.strip() or "No memory/preferences recorded yet."
    handholding_section = "" if reasoning_mode != "off" else _HANDHOLDING_RULES

    return SYSTEM_PROMPT_TEMPLATE.format(
        persona_section=persona_section,
        skills_section=skills_section,
        memory_section=memory_section,
        handholding_section=handholding_section,
    )


# Tool schema for structured output - Claude fills this in directly,
# so no text-to-JSON parsing is needed.
OPERATION_PLAN_TOOL = {
    "name": "create_operation_plan",
    "description": (
        "Create a plan of notebook cell operations to fulfil the user's request. "
        "Always call this tool with your response."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "steps": {
                "type": "array",
                "description": "Ordered list of cell operations to perform",
                "items": {
                    "type": "object",
                    "properties": {
                        "type": {
                            "type": "string",
                            "enum": ["insert", "modify", "delete", "run_cell", "reorder"],
                            "description": (
                                "Operation type. Use 'run_cell' to execute an existing "
                                "cell without changing its content. Use 'reorder' to "
                                "rearrange cells — provide newOrder instead of cellIndex."
                            )
                        },
                        "cellIndex": {
                            "type": "integer",
                            "description": (
                                "Zero-based cell index. Required for insert/modify/delete/run_cell. "
                                "Not used for 'reorder' (use newOrder instead)."
                            )
                        },
                        "newOrder": {
                            "type": "array",
                            "items": {"type": "string"},
                            "description": (
                                "For 'reorder' only: list of cell short IDs (the [id:XXXXXXXX] "
                                "tag value) in the desired final order. Include every cell."
                            )
                        },
                        "cellType": {
                            "type": "string",
                            "enum": ["code", "markdown"],
                            "description": "Cell type (required for insert)"
                        },
                        "content": {
                            "type": "string",
                            "description": "Cell content (required for insert/modify)"
                        },
                        "autoExecute": {
                            "type": "boolean",
                            "description": "Whether to auto-execute after creating"
                        },
                        "description": {
                            "type": "string",
                            "description": "Human-readable description of this step"
                        }
                    },
                    "required": ["type"]
                }
            },
            "requiresApproval": {
                "type": "boolean",
                "description": (
                    "True if any step requires explicit user approval before executing. "
                    "Set to false when ALL steps are safe read/display/analysis operations "
                    "(plots, df.info(), imports, etc.). Always true for reorder plans."
                )
            },
            "clarificationNeeded": {
                "type": "string",
                "description": "Set to a question if the request is ambiguous, otherwise null"
            },
            "summary": {
                "type": "string",
                "description": "Short summary of what this plan does"
            }
        },
        "required": ["steps", "requiresApproval", "summary"]
    }
}


class ClaudeClient:
    """Client for the Anthropic Claude API."""

    def __init__(
        self,
        api_key: str,
        model: str = "claude-sonnet-4-6",
        extended_thinking: bool = True,
    ):
        self.api_key = api_key
        self.model = model
        # When False, extended thinking is disabled even for supported models.
        # Controlled by the Settings → Anthropic → "Extended thinking" toggle.
        self._extended_thinking_enabled = extended_thinking
        # Single AsyncAnthropic instance — reused across requests to share
        # the underlying connection pool and avoid per-call setup overhead.
        self._aclient: Optional[anthropic.AsyncAnthropic] = (
            anthropic.AsyncAnthropic(api_key=api_key) if api_key else None
        )
        # Token usage tracking — updated after each API call
        self.last_usage: dict = {"input": 0, "output": 0}

    def _set_usage(self, input_tokens: int, output_tokens: int) -> None:
        """Record token usage after an API call."""
        self.last_usage = {"input": int(input_tokens), "output": int(output_tokens)}

    # ------------------------------------------------------------------
    # Prompt caching
    # ------------------------------------------------------------------

    # Boundary between static rules and dynamic content in SYSTEM_PROMPT_TEMPLATE.
    # Everything before this marker (persona + all core rules) is stable across
    # requests and safe to cache.  Skills and memory follow this point and change
    # on every request.
    _CACHE_BOUNDARY = "\n## Skills Context\n"

    @staticmethod
    def _prompt_caching_enabled() -> bool:
        return os.environ.get("VARYS_PROMPT_CACHING", "true").strip().lower() not in (
            "false", "0", "no"
        )

    @staticmethod
    def _log_cache_usage(usage: object, label: str) -> None:
        import logging as _logging
        _log = _logging.getLogger(__name__)
        created = getattr(usage, "cache_creation_input_tokens", 0) or 0
        read    = getattr(usage, "cache_read_input_tokens",    0) or 0
        if created or read:
            _log.debug("Prompt cache (%s): created=%d read=%d", label, created, read)

    def _to_cached_system_blocks(self, system: str) -> list:
        """Split *system* at the Skills Context boundary and return content blocks.

        The static prefix (persona + core rules) is marked cacheable.
        The dynamic suffix (skills + memory + trailing rules) is sent uncached.
        Falls back to a single cached block when the boundary is not found.
        """
        if not self._prompt_caching_enabled():
            return [{"type": "text", "text": system}]

        idx = system.find(self._CACHE_BOUNDARY)
        if idx == -1:
            # Template changed or custom prompt — cache the whole thing.
            return [{"type": "text", "text": system, "cache_control": {"type": "ephemeral"}}]

        return [
            {
                "type": "text",
                "text": system[:idx],
                "cache_control": {"type": "ephemeral"},
            },
            {
                "type": "text",
                "text": system[idx:],
            },
        ]

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _prepend_history(
        chat_history: Optional[List[Dict[str, str]]],
        final_content: Any,
    ) -> List[Dict[str, Any]]:
        """Return a messages list with history turns prepended.

        Anthropic requires strictly alternating user/assistant turns.
        We ensure the first message in the history is 'user'; if not we
        trim until it is. The final message is always the current user turn.
        """
        history = list(chat_history or [])
        # Drop leading assistant turns (Anthropic rejects non-user first)
        while history and history[0].get("role") != "user":
            history = history[1:]
        messages: List[Dict[str, Any]] = [
            {"role": h["role"], "content": h["content"]} for h in history
        ]
        messages.append({"role": "user", "content": final_content})
        return messages

    # ------------------------------------------------------------------

    def _build_content_blocks(
        self,
        user_message: str,
        notebook_context: Dict[str, Any],
    ) -> List[Any]:
        """Build Anthropic content blocks: user text + optional visualization images.

        Handles two image sources:
          1. Per-cell imageOutput — first image in each cell (existing behaviour).
          2. selectedOutput — a specific output the user right-clicked and sent to
             chat (image/png only; table/text outputs are included in the text body).
        """
        user_msg = self._build_user_message(user_message, notebook_context)
        blocks: List[Any] = [{"type": "text", "text": user_msg}]

        # ── 1. Specific selected output (highest priority) ──────────────────
        sel = notebook_context.get("selectedOutput")
        if sel and isinstance(sel, dict):
            mime      = sel.get("mimeType", "")
            img_data  = sel.get("imageData")
            text_data = sel.get("textData")
            label     = sel.get("label", "selected output")

            if img_data and mime.startswith("image"):
                media = "image/jpeg" if "jpeg" in mime else "image/png"
                blocks.append({"type": "text", "text": f"[User selected this specific output: {label}]"})
                blocks.append({"type": "image", "source": {"type": "base64", "media_type": media, "data": img_data}})
            elif text_data:
                blocks.append({"type": "text", "text": f"[User selected this specific output — {label}:\n{text_data}]"})

        # ── 2. Per-cell images (existing behaviour) ─────────────────────────
        for cell in notebook_context.get("cells", []):
            img = cell.get("imageOutput")
            if img:
                cell_idx = cell.get("index")
                label_c = f"#{cell_idx + 1}" if isinstance(cell_idx, int) else "#?"
                raw_mime = cell.get("imageOutputMime") or "image/png"
                media_type = raw_mime if raw_mime in ("image/png", "image/jpeg", "image/webp", "image/gif") else "image/png"
                blocks.append({"type": "text", "text": f"[Visualization output from cell {label_c}:]"})
                blocks.append({"type": "image", "source": {"type": "base64", "media_type": media_type, "data": img}})

        return blocks

    def _build_content_blocks_from_text(
        self,
        user_text: str,
        notebook_context: Dict[str, Any],
    ) -> List[Any]:
        """Build Anthropic content blocks using a pre-formatted text message.

        Unlike _build_content_blocks(), this method accepts an already-built
        text string (e.g., from build_notebook_context()) and appends image
        blocks for selectedOutput and per-cell images.  Used in chat/advisory
        mode so the LLM receives actual image data without the
        'create_operation_plan' instruction that _build_content_blocks() adds.
        """
        blocks: List[Any] = [{"type": "text", "text": user_text}]

        # selectedOutput image (highest priority — user right-clicked a specific output)
        sel = notebook_context.get("selectedOutput")
        if sel and isinstance(sel, dict):
            mime     = sel.get("mimeType", "")
            img_data = sel.get("imageData")
            label    = sel.get("label", "selected output")
            if img_data and mime.startswith("image"):
                media = "image/jpeg" if "jpeg" in mime else "image/png"
                blocks.append({"type": "text", "text": f"[User selected this specific output: {label}]"})
                blocks.append({"type": "image", "source": {"type": "base64", "media_type": media, "data": img_data}})
            elif sel.get("textData"):
                blocks.append({"type": "text", "text": f"[User selected this specific output — {label}:\n{sel['textData']}]"})

        # Per-cell images (existing behaviour — same logic as _build_content_blocks)
        for cell in notebook_context.get("cells", []):
            img = cell.get("imageOutput")
            if img:
                cell_idx  = cell.get("index")
                label_c   = f"#{cell_idx + 1}" if isinstance(cell_idx, int) else "#?"
                raw_mime  = cell.get("imageOutputMime") or "image/png"
                media_type = raw_mime if raw_mime in (
                    "image/png", "image/jpeg", "image/webp", "image/gif"
                ) else "image/png"
                blocks.append({"type": "text", "text": f"[Visualization output from cell {label_c}:]"})
                blocks.append({"type": "image", "source": {"type": "base64", "media_type": media_type, "data": img}})

        return blocks

    async def plan_task(
        self,
        user_message: str,
        notebook_context: Dict[str, Any],
        skills: List[Dict[str, str]],
        memory: str,
        operation_id: Optional[str] = None,
        chat_history: Optional[List[Dict[str, str]]] = None,
    ) -> Dict[str, Any]:
        """Plan a task using Claude API with tool-use for reliable JSON output.

        Retries up to 3 times with exponential backoff on transient errors
        (overloaded / rate-limited / server errors).
        """
        if not self.api_key or not self._aclient:
            return self._fallback_response(user_message, operation_id)

        system_prompt = self._build_system_prompt(skills, memory)
        system_blocks = self._to_cached_system_blocks(system_prompt)
        content_blocks = self._build_content_blocks(user_message, notebook_context)
        messages = self._prepend_history(chat_history, content_blocks)

        max_retries = 3
        base_delay = 2.0  # seconds

        for attempt in range(max_retries):
            try:
                response = await self._aclient.messages.create(
                    model=self.model,
                    max_tokens=8192,
                    system=system_blocks,
                    tools=[OPERATION_PLAN_TOOL],
                    tool_choice={"type": "any"},
                    messages=messages,
                )

                # Record token usage for this call
                if hasattr(response, "usage") and response.usage:
                    self._set_usage(
                        getattr(response.usage, "input_tokens", 0),
                        getattr(response.usage, "output_tokens", 0),
                    )
                    self._log_cache_usage(response.usage, "plan_chat")

                # Extract the tool_use block - guaranteed structured output
                for block in response.content:
                    if block.type == "tool_use" and block.name == "create_operation_plan":
                        data = dict(block.input)
                        data["operationId"] = operation_id or f"op_{uuid.uuid4().hex[:8]}"
                        # Normalise clarificationNeeded: the LLM sometimes sets it
                        # to the *string* "null" instead of JSON null.  Treat both
                        # as absent so the retry gate and frontend behave correctly.
                        clarif = data.get("clarificationNeeded")
                        if not clarif or (isinstance(clarif, str) and clarif.strip().lower() == "null"):
                            data["clarificationNeeded"] = None
                        return data

                # Claude responded with text instead of a tool call
                text = next(
                    (b.text for b in response.content if hasattr(b, "text")),
                    "No response from Claude."
                )
                return {
                    "operationId": operation_id or f"op_{uuid.uuid4().hex[:8]}",
                    "steps": [],
                    "requiresApproval": False,
                    "clarificationNeeded": text,
                    "summary": "No operation plan returned"
                }

            except anthropic.AuthenticationError as e:
                raise RuntimeError(
                    "⛔ Claude API authentication failed. "
                    "Check that ANTHROPIC_API_KEY in your .env file is correct."
                ) from e

            except anthropic.PermissionDeniedError as e:
                raise RuntimeError(
                    "⛔ Claude API access denied. This usually means your Anthropic "
                    "account has run out of credits or this API key lacks permission. "
                    "Visit console.anthropic.com to check your billing status."
                ) from e

            except anthropic.BadRequestError as e:
                raise RuntimeError(f"Bad request to Claude API: {e}") from e

            except (_AnthropicOverloadedError, anthropic.RateLimitError,
                    anthropic.InternalServerError, anthropic.APIConnectionError) as e:
                # Transient errors — retry with exponential backoff
                if attempt < max_retries - 1:
                    delay = base_delay * (2 ** attempt)  # 2s, 4s, 8s
                    await asyncio.sleep(delay)
                    continue
                raise RuntimeError(
                    f"Claude API unavailable after {max_retries} attempts: {e}"
                ) from e

            except Exception as e:
                raise RuntimeError(f"Claude API error: {e}") from e

    # Models that support Anthropic extended thinking (API-level, not prompt-based).
    # Older claude-3-5-* models do NOT support it and will return an API error.
    _EXTENDED_THINKING_MODELS = (
        "claude-3-7",
        "claude-sonnet-4",
        "claude-opus-4",
        "claude-haiku-4",
    )

    def _supports_extended_thinking(self) -> bool:
        """Return True if extended thinking should be used for this request.

        Both conditions must hold:
          1. The user has enabled extended thinking (Settings → Anthropic tab).
          2. The configured model actually supports the API-level thinking param
             (claude-3-7+ / claude-4 family).
        """
        if not self._extended_thinking_enabled:
            return False
        m = self.model.lower()
        return any(pat in m for pat in self._EXTENDED_THINKING_MODELS)

    async def stream_plan_task(
        self,
        user_message: str,
        notebook_context: Dict[str, Any],
        skills: List[Dict[str, str]],
        memory: str,
        operation_id: Optional[str],
        on_text_chunk: Callable[[str], Awaitable[None]],
        on_json_delta: Optional[Callable[[str], Awaitable[None]]] = None,
        on_thought: Optional[Callable[[str], Awaitable[None]]] = None,
        chat_history: Optional[List[Dict[str, str]]] = None,
        reasoning_mode: str = "off",
    ) -> Dict[str, Any]:
        """Stream pre-tool explanation text AND tool-call JSON deltas.

        Uses raw event iteration so we capture both:
          - text_delta      → on_text_chunk (Claude's explanation before the tool call)
          - input_json_delta → on_json_delta (the operation plan JSON being written)
          - thinking_delta  → on_thought   (extended thinking, always-on for supported models)

        Extended thinking is always active when the configured model supports the
        API-level thinking parameter (claude-3-7+, claude-4 family).
        """
        if not self.api_key or not self._aclient:
            return self._fallback_response(user_message, operation_id)

        system_prompt = self._build_system_prompt(skills, memory, reasoning_mode=reasoning_mode)
        system_blocks = self._to_cached_system_blocks(system_prompt)
        content_blocks = self._build_content_blocks(user_message, notebook_context)
        messages = self._prepend_history(chat_history, content_blocks)

        # Extended thinking is always-on for supported models.
        use_thinking = self._supports_extended_thinking()
        # budget_tokens must be < max_tokens; reserve ~8 k for the tool-call JSON.
        _THINKING_BUDGET = 8_000
        _MAX_TOKENS_THINKING = 16_000
        _MAX_TOKENS_DEFAULT = 8_192

        max_retries = 3
        base_delay = 2.0

        for attempt in range(max_retries):
            try:
                api_kwargs: Dict[str, Any] = dict(
                    model=self.model,
                    max_tokens=_MAX_TOKENS_THINKING if use_thinking else _MAX_TOKENS_DEFAULT,
                    system=system_blocks,
                    tools=[OPERATION_PLAN_TOOL],
                    # "auto" lets Claude emit explanation text before the tool call.
                    # "any"/"tool" would conflict with extended thinking.
                    tool_choice={"type": "auto"},
                    messages=messages,
                )
                if use_thinking:
                    api_kwargs["thinking"] = {
                        "type": "enabled",
                        "budget_tokens": _THINKING_BUDGET,
                    }

                async with self._aclient.messages.stream(**api_kwargs) as stream:
                    # Iterate raw events to capture text, tool-JSON, and thinking deltas
                    async for event in stream:
                        if event.type != "content_block_delta":
                            continue
                        delta = event.delta
                        if delta.type == "text_delta":
                            await on_text_chunk(delta.text)
                            await asyncio.sleep(0)
                        elif delta.type == "input_json_delta" and on_json_delta:
                            await on_json_delta(delta.partial_json)
                            await asyncio.sleep(0)
                        elif delta.type == "thinking_delta" and on_thought:
                            await on_thought(delta.thinking)
                            await asyncio.sleep(0)

                    final_msg = await stream.get_final_message()

                # Record token usage from the streaming response
                if hasattr(final_msg, "usage") and final_msg.usage:
                    self._set_usage(
                        getattr(final_msg.usage, "input_tokens", 0),
                        getattr(final_msg.usage, "output_tokens", 0),
                    )
                    self._log_cache_usage(final_msg.usage, "plan_stream_chat")

                for block in final_msg.content:
                    if block.type == "tool_use" and block.name == "create_operation_plan":
                        data = dict(block.input)
                        data["operationId"] = operation_id or f"op_{uuid.uuid4().hex[:8]}"
                        # Normalise clarificationNeeded: the LLM sometimes sets it
                        # to the *string* "null" instead of JSON null.
                        clarif = data.get("clarificationNeeded")
                        if not clarif or (isinstance(clarif, str) and clarif.strip().lower() == "null"):
                            data["clarificationNeeded"] = None
                        return data

                # No tool call emitted.  If the model was cut off by max_tokens,
                # inject a re-plan nudge and retry (reuses the existing retry loop).
                stop_reason = getattr(final_msg, "stop_reason", None)
                if stop_reason == "max_tokens" and attempt < max_retries - 1:
                    partial_text = next(
                        (b.text for b in final_msg.content if hasattr(b, "text")), ""
                    ).strip()
                    messages = list(messages) + [
                        {"role": "assistant", "content": partial_text or "(truncated)"},
                        {
                            "role": "user",
                            "content": (
                                "Your previous plan was cut short. "
                                "Please provide a more concise version of the same plan."
                            ),
                        },
                    ]
                    continue

                # Claude responded with text only — no tool call made.
                # This can happen when the request is conversational. Surface
                # the text as an advisory (chat) response so the frontend renders
                # it as a message rather than a silent no-op.
                text_only = next(
                    (b.text for b in final_msg.content if hasattr(b, "text")), ""
                )
                # Strip stray bare-"null" tokens that the LLM writes when it
                # intends the JSON keyword null (e.g. "clarificationNeeded: null").
                text_only = _re.sub(r'(\s*\bnull\b)+\s*$', '', text_only).strip()
                return {
                    "operationId": operation_id or f"op_{uuid.uuid4().hex[:8]}",
                    "steps": [],
                    "requiresApproval": False,
                    "clarificationNeeded": None,
                    "chatResponse": text_only or "I'm not sure what to do — could you clarify?",
                    "cellInsertionMode": "chat",
                    "summary": "Advisory response",
                }

            except anthropic.AuthenticationError as e:
                raise RuntimeError(
                    "⛔ Claude API authentication failed. "
                    "Check that ANTHROPIC_API_KEY in your .env file is correct."
                ) from e

            except anthropic.PermissionDeniedError as e:
                raise RuntimeError(
                    "⛔ Claude API access denied. This usually means your Anthropic "
                    "account has run out of credits or this API key lacks permission. "
                    "Visit console.anthropic.com to check your billing status."
                ) from e

            except anthropic.BadRequestError as e:
                raise RuntimeError(f"Bad request to Claude API: {e}") from e

            except (_AnthropicOverloadedError, anthropic.RateLimitError,
                    anthropic.InternalServerError, anthropic.APIConnectionError) as e:
                if attempt < max_retries - 1:
                    delay = base_delay * (2 ** attempt)
                    await asyncio.sleep(delay)
                    continue
                raise RuntimeError(
                    f"Claude API unavailable after {max_retries} attempts: {e}"
                ) from e

            except Exception as e:
                raise RuntimeError(f"Claude API streaming error: {e}") from e

    def _build_system_prompt(
        self,
        skills: List[Dict[str, str]],
        memory: str,
        reasoning_mode: str = "off",
    ) -> str:
        """Build the system prompt with skills and memory.

        The 'varys' skill is treated specially: its content completely replaces
        the default persona intro at the top of the system prompt.  All other
        skills are injected under ## Skills Context as usual.
        """
        return _build_system_prompt_shared(skills, memory, reasoning_mode=reasoning_mode)

    def _build_user_message(
        self,
        user_message: str,
        notebook_context: Dict[str, Any],
    ) -> str:
        """Build the user message with notebook context.

        Delegates to the canonical build_notebook_context() so that all
        providers share the same prompt format, variable-reference handling,
        and selected-output sections.  Appends the Anthropic-specific tool-call
        instruction at the end.
        """
        base = build_notebook_context(user_message, notebook_context)
        return base + "\nPlease call the create_operation_plan tool with your response."

    async def stream_chat(
        self,
        system: str,
        user: Any,  # str or List[content blocks] (e.g. from _build_content_blocks_from_text)
        on_chunk: Callable[[str], Awaitable[None]],
        on_thought: Optional[Callable[[str], Awaitable[None]]] = None,
        chat_history: Optional[List[Dict[str, str]]] = None,
    ) -> None:
        """Stream a free-form chat response, calling on_chunk for each token.

        ``user`` may be a plain string or a list of Anthropic content blocks
        (text + image).  _prepend_history() handles both forms transparently,
        so image blocks from _build_content_blocks_from_text() are forwarded
        to the API unchanged.

        Extended thinking is always active for supported models (claude-3-7+,
        claude-4 family). thinking_delta events are routed to on_thought when
        a callback is provided.
        """
        if not self._aclient:
            await on_chunk("No API key configured.")
            return
        messages = self._prepend_history(chat_history, user)

        use_thinking = self._supports_extended_thinking()
        _THINKING_BUDGET = 8_000
        _MAX_TOKENS_THINKING = 16_000
        _MAX_TOKENS_DEFAULT  = 8_192
        _MAX_CONTINUATIONS   = 2  # safety cap on seamless auto-continuation turns

        # Split system prompt into cacheable static block + dynamic block.
        # The static block (persona + core rules) is stable across requests;
        # the dynamic block (skills + memory) changes each turn.
        system_blocks = self._to_cached_system_blocks(system)

        for _turn in range(_MAX_CONTINUATIONS + 1):
            api_kwargs: Dict[str, Any] = dict(
                model=self.model,
                max_tokens=_MAX_TOKENS_THINKING if use_thinking else _MAX_TOKENS_DEFAULT,
                system=system_blocks,
                messages=messages,
            )
            if use_thinking:
                api_kwargs["thinking"] = {
                    "type": "enabled",
                    "budget_tokens": _THINKING_BUDGET,
                }

            _turn_text: List[str] = []  # accumulate text for potential continuation

            async with self._aclient.messages.stream(**api_kwargs) as stream:
                if use_thinking:
                    # Raw event iteration to capture both thinking and text deltas.
                    async for event in stream:
                        if event.type != "content_block_delta":
                            continue
                        delta = event.delta
                        if delta.type == "thinking_delta" and on_thought:
                            await on_thought(delta.thinking)
                            await asyncio.sleep(0)
                        elif delta.type == "text_delta":
                            await on_chunk(delta.text)
                            _turn_text.append(delta.text)
                            await asyncio.sleep(0)
                else:
                    async for text in stream.text_stream:
                        await on_chunk(text)
                        _turn_text.append(text)

                final_chat = await stream.get_final_message()
                if hasattr(final_chat, "usage") and final_chat.usage:
                    self._set_usage(
                        getattr(final_chat.usage, "input_tokens", 0),
                        getattr(final_chat.usage, "output_tokens", 0),
                    )
                    self._log_cache_usage(final_chat.usage, "stream_chat")

            # Auto-continue when the model was stopped by the token limit.
            # We replay the partial text as an assistant turn and ask "Continue."
            # so the response appears seamless to the user.
            stop_reason = getattr(final_chat, "stop_reason", None)
            if stop_reason != "max_tokens" or _turn >= _MAX_CONTINUATIONS:
                break

            partial = "".join(_turn_text)
            messages = list(messages) + [
                {"role": "assistant", "content": partial},
                {"role": "user",      "content": "Continue."},
            ]

    def _fallback_response(
        self,
        user_message: str,
        operation_id: Optional[str] = None
    ) -> Dict[str, Any]:
        """Return a fallback when no API key is set."""
        return {
            "operationId": operation_id or f"op_{uuid.uuid4().hex[:8]}",
            "steps": [],
            "requiresApproval": False,
            "clarificationNeeded": (
                "WARNING: ANTHROPIC_API_KEY is not set. "
                "Please add it to your .env file in the notebook directory."
            ),
            "summary": "API key not configured"
        }

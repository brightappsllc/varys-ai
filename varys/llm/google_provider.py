"""Google Gemini provider — gemini-2.0-flash, gemini-1.5-pro, etc.

Uses the new google-genai SDK (google.genai) which replaced the deprecated
google.generativeai package.  Install with: pip install google-genai
"""
import asyncio
import base64
import json
import logging
import re
import uuid
from typing import Any, Callable, Awaitable, Dict, List, Optional

from .base import BaseLLMProvider
from .client import _build_system_prompt_shared
from .openai_provider import _build_context, _INLINE_SYSTEM
from ..completion.cache import CompletionCache
from ..completion.engine import _build_context_block, _extract_imports

log = logging.getLogger(__name__)

# Used by plan_task (JSON-schema / structured-output mode).
_PLAN_SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "steps": {
            "type": "ARRAY",
            "items": {
                "type": "OBJECT",
                "properties": {
                    "type": {"type": "STRING"},
                    "cellIndex": {"type": "INTEGER"},
                    "cellType": {"type": "STRING"},
                    "content": {"type": "STRING"},
                    "autoExecute": {"type": "BOOLEAN"},
                    "description": {"type": "STRING"},
                },
                "required": ["type", "cellIndex"],
            },
        },
        "requiresApproval": {"type": "BOOLEAN"},
        "clarificationNeeded": {"type": "STRING"},
        "summary": {"type": "STRING"},
    },
    "required": ["steps", "requiresApproval", "summary"],
}

# Used by stream_plan_task (function-calling / streaming mode).
# Identical structure but with lowercase type names which are required by
# FunctionDeclaration.parameters.
_PLAN_TOOL_NAME = "create_operation_plan"
_PLAN_FN_PARAMETERS = {
    "type": "object",
    "properties": {
        "steps": {
            "type": "array",
            "description": "Ordered list of notebook cell operations to perform.",
            "items": {
                "type": "object",
                "properties": {
                    "type":        {"type": "string",  "enum": ["insert", "modify", "delete", "run_cell"]},
                    "cellIndex":   {"type": "integer", "description": "Zero-based cell index."},
                    "cellType":    {"type": "string",  "enum": ["code", "markdown"]},
                    "content":     {"type": "string",  "description": "Cell content (insert/modify only)."},
                    "autoExecute": {"type": "boolean", "description": "Run the cell after inserting/modifying."},
                    "description": {"type": "string",  "description": "Human-readable description of this step."},
                },
                "required": ["type", "cellIndex"],
            },
        },
        "requiresApproval":   {"type": "boolean", "description": "True when the user should review before applying."},
        "clarificationNeeded":{"type": "string",  "description": "Question for the user if the request is ambiguous."},
        "summary":            {"type": "string",  "description": "One-sentence description of what the plan does."},
    },
    "required": ["steps", "requiresApproval", "summary"],
}


def _deep_convert_args(obj: Any) -> Any:
    """Recursively convert proto MapComposite / RepeatedComposite to plain Python.

    google.genai FunctionCall.args may arrive wrapped in proto container types.
    This converts them to plain dict / list so the rest of the pipeline treats
    them as ordinary JSON data.
    """
    if isinstance(obj, dict):
        return {k: _deep_convert_args(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_deep_convert_args(i) for i in obj]
    # MapComposite (dict-like proto container)
    if hasattr(obj, "items") and callable(obj.items) and not isinstance(obj, str):
        return {str(k): _deep_convert_args(v) for k, v in obj.items()}
    # RepeatedComposite (list-like proto container)
    if hasattr(obj, "__iter__") and not isinstance(obj, (str, bytes)):
        return [_deep_convert_args(i) for i in obj]
    return obj


class GoogleProvider(BaseLLMProvider):
    VENDOR = "google"

    """Calls the Google Gemini API via the google-genai SDK."""

    def __init__(
        self,
        api_key: str = "",
        service_account_json: str = "",
        chat_model: str = "gemini-2.0-flash",
        completion_model: str = "gemini-2.0-flash",
        enable_thinking: bool = False,
        thinking_budget: int = 8192,
    ) -> None:
        super().__init__()
        self.api_key = api_key
        self.service_account_json = service_account_json
        self.chat_model = chat_model
        self.completion_model = completion_model
        self.enable_thinking = enable_thinking
        self.thinking_budget = thinking_budget
        self._cache = CompletionCache()

    def _client(self):
        """Return a configured google.genai Client.

        Auth priority:
          1. Service-account JSON path (organization credentials) — if set and
             the file exists, credentials are loaded via google.oauth2.service_account.
          2. API key — direct Gemini API access for individual developers.

        Raises RuntimeError with a clear message if google-genai is not installed
        or if neither auth method is properly configured.
        """
        try:
            from google import genai
        except (ImportError, ModuleNotFoundError):
            raise RuntimeError(
                "google-genai not installed. Run: pip install google-genai"
            )

        sa_path = (self.service_account_json or "").strip()
        if sa_path:
            import os
            if not os.path.isfile(sa_path):
                raise RuntimeError(
                    f"Google service-account JSON not found: {sa_path!r}. "
                    "Check the path in Settings → Google → Service account JSON."
                )
            try:
                from google.oauth2 import service_account
                credentials = service_account.Credentials.from_service_account_file(
                    sa_path,
                    scopes=["https://www.googleapis.com/auth/generative-language"],
                )
                return genai.Client(credentials=credentials)
            except Exception as exc:
                raise RuntimeError(
                    f"Failed to load Google service-account credentials from {sa_path!r}: {exc}"
                ) from exc

        if not self.api_key:
            raise RuntimeError(
                "Google credentials not configured. "
                "Provide an API key or a service-account JSON path in Settings → Google."
            )
        return genai.Client(api_key=self.api_key)

    def _types(self):
        """Return the google.genai.types module."""
        try:
            from google.genai import types
            return types
        except (ImportError, ModuleNotFoundError):
            raise RuntimeError(
                "google-genai not installed. Run: pip install google-genai"
            )

    def _build_system(self, skills: List[Dict[str, str]], memory: str, reasoning_mode: str = "off") -> str:
        return _build_system_prompt_shared(skills, memory, reasoning_mode=reasoning_mode)

    def _record_usage(self, resp: Any) -> None:
        """Extract token counts from a GenerateContentResponse and call _set_usage."""
        meta = getattr(resp, "usage_metadata", None)
        if meta is None:
            return
        self._set_usage(
            getattr(meta, "prompt_token_count", 0) or 0,
            getattr(meta, "candidates_token_count", 0) or 0,
        )

    def _thinking_config(self, types: Any) -> Optional[Any]:
        """Return a ThinkingConfig when thinking is enabled.

        thinkingBudget=-1  → dynamic thinking (model decides how much to use)
        thinkingBudget=N   → fixed budget in tokens
        Returns None when thinking is off.

        No model-name allowlist: the API is the ground truth.  If the model
        doesn't support thinking the API returns an error and stream_chat
        retries automatically without the config.
        """
        if not self.enable_thinking:
            return None
        budget = self.thinking_budget if self.thinking_budget > 0 else -1
        try:
            return types.ThinkingConfig(thinking_budget=budget, include_thoughts=True)
        except Exception:
            return None

    def _build_contents(
        self,
        user_msg: str,
        notebook_context: Dict[str, Any],
        types: Any,
    ) -> List[Any]:
        """Build a contents list, appending image parts when vision is available."""
        parts: List[Any] = [types.Part.from_text(text=user_msg)]
        if self.has_vision():
            for cell in notebook_context.get("cells", []):
                img = cell.get("imageOutput")
                if img:
                    idx = cell.get("index")
                    label = f"#{idx + 1}" if isinstance(idx, int) else "#?"
                    raw_mime = cell.get("imageOutputMime") or "image/png"
                    mime = raw_mime if raw_mime in (
                        "image/png", "image/jpeg", "image/webp", "image/gif"
                    ) else "image/png"
                    parts.append(types.Part.from_text(text=f"[Plot from cell {label}:]"))
                    parts.append(types.Part.from_bytes(
                        data=base64.b64decode(img),
                        mime_type=mime,
                    ))
        return parts

    # ── plan_task ─────────────────────────────────────────────────────────────

    async def plan_task(
        self,
        user_message: str,
        notebook_context: Dict[str, Any],
        skills: List[Dict[str, str]],
        memory: str,
        operation_id: Optional[str] = None,
        chat_history: Optional[List[Dict[str, str]]] = None,
        reasoning_mode: str = "off",
    ) -> Dict[str, Any]:
        op_id    = operation_id or f"op_{uuid.uuid4().hex[:8]}"
        system   = self._build_system(skills, memory, reasoning_mode=reasoning_mode)
        user_msg = _build_context(user_message, notebook_context)
        client   = self._client()
        types    = self._types()

        contents = self._build_contents(user_msg, notebook_context, types)
        config = types.GenerateContentConfig(
            system_instruction=system,
            response_mime_type="application/json",
            response_schema=_PLAN_SCHEMA,
            temperature=0.2,
            max_output_tokens=4096,
        )
        try:
            resp = await client.aio.models.generate_content(
                model=self.chat_model,
                contents=contents,
                config=config,
            )
            self._record_usage(resp)
            data = json.loads(resp.text)
            data.setdefault("operationId", op_id)
            data.setdefault("clarificationNeeded", None)
            return data
        except Exception as e:
            log.error("Google plan_task error: %s", e)
            raise RuntimeError(f"Google Gemini error: {e}") from e

    # ── complete ──────────────────────────────────────────────────────────────

    async def complete(
        self,
        prefix: str,
        suffix: str,
        language: str,
        previous_cells: List[Dict[str, Any]],
    ) -> Dict[str, Any]:
        imports   = _extract_imports(previous_cells)
        cache_key = CompletionCache.make_key(prefix, language, "google-completion", imports)
        cached    = self._cache.get(cache_key)
        if cached:
            return {"suggestion": cached, "type": "completion", "lines": cached.splitlines(), "cached": True}

        context = _build_context_block(previous_cells)
        prompt  = (f"{context}\n\n{prefix}" if context else prefix)
        client  = self._client()
        types   = self._types()

        config = types.GenerateContentConfig(
            system_instruction=_INLINE_SYSTEM,
            temperature=0.1,
            max_output_tokens=256,
        )
        try:
            resp = await client.aio.models.generate_content(
                model=self.completion_model,
                contents=f"Complete:\n{prompt}",
                config=config,
            )
            self._record_usage(resp)
            raw        = resp.text or ""
            suggestion = re.sub(r"^```[a-z]*\n?", "", raw.strip(), flags=re.MULTILINE)
            suggestion = re.sub(r"\n?```$", "", suggestion, flags=re.MULTILINE).strip()
            if suggestion:
                self._cache.set(cache_key, suggestion)
            return {"suggestion": suggestion, "type": "completion", "lines": suggestion.splitlines(), "cached": False}
        except Exception as e:
            log.warning("Google complete error: %s", e)
            return {"suggestion": "", "type": "completion", "lines": [], "cached": False}

    # ── stream_chat ───────────────────────────────────────────────────────────

    async def stream_chat(
        self,
        system: str,
        user: str,
        on_chunk: Callable[[str], Awaitable[None]],
        on_thought: Optional[Callable[[str], Awaitable[None]]] = None,
        chat_history: Optional[List[Dict[str, str]]] = None,
    ) -> None:
        """True token-by-token streaming via generate_content_stream.

        Replaces the base-class default (which buffers the full response in
        chat() then fires a single on_chunk) so Gemini renders progressively,
        matching the Anthropic / OpenAI streaming experience.
        """
        client = self._client()
        types  = self._types()

        thinking_cfg = self._thinking_config(types)
        config = types.GenerateContentConfig(
            system_instruction=system,
            temperature=0.3,
            max_output_tokens=8192,
            **({"thinking_config": thinking_cfg} if thinking_cfg is not None else {}),
        )

        contents: List[Any] = []
        if chat_history:
            history = list(chat_history)
            while history and history[0].get("role") != "user":
                history = history[1:]
            for turn in history:
                role = "user" if turn["role"] == "user" else "model"
                contents.append(types.Content(
                    role=role,
                    parts=[types.Part.from_text(text=turn["content"])],
                ))
        contents.append(types.Content(
            role="user",
            parts=[types.Part.from_text(text=user)],
        ))

        log.info(
            "Google stream_chat: model=%s thinking=%s",
            self.chat_model, thinking_cfg is not None,
        )

        async def _run_stream(cfg: Any) -> None:
            """Execute one streaming call; raises on error."""
            last_chunk = None
            async for chunk in await client.aio.models.generate_content_stream(
                model=self.chat_model,
                contents=contents,
                config=cfg,
            ):
                last_chunk = chunk
                # Each chunk may carry multiple parts: thought=True parts are
                # reasoning content; the rest are regular response text.
                if chunk.candidates:
                    cand = chunk.candidates[0]
                    # content.parts can be None when the response is filtered
                    # (SAFETY/RECITATION) or empty-truncated (MAX_TOKENS).
                    parts = getattr(getattr(cand, "content", None), "parts", None) or []
                    if not parts:
                        fr = getattr(cand, "finish_reason", None)
                        if fr:
                            log.debug("GoogleProvider: empty parts (finish_reason=%s)", fr)
                    for part in parts:
                        if not part.text:
                            continue
                        if getattr(part, "thought", False):
                            if on_thought:
                                # Google sends thought content as one large block
                                # rather than token-by-token.  Simulate smooth
                                # streaming by emitting word-by-word so the
                                # thinking bubble animates progressively.
                                words = part.text.split(" ")
                                for i, word in enumerate(words):
                                    frag = word if i == len(words) - 1 else word + " "
                                    if frag:
                                        await on_thought(frag)
                                        await asyncio.sleep(0)
                        else:
                            await on_chunk(part.text)
                elif chunk.text:
                    await on_chunk(chunk.text)
            if last_chunk is not None:
                self._record_usage(last_chunk)

        try:
            await _run_stream(config)
        except Exception as e:
            err_str = str(e).lower()
            # If the API rejects the ThinkingConfig (model doesn't support it),
            # retry transparently without thinking rather than surfacing a crash.
            if thinking_cfg is not None and (
                "thinking" in err_str or "thinkingbudget" in err_str
                or "invalid" in err_str or "unsupported" in err_str
            ):
                log.warning(
                    "Google model %s rejected ThinkingConfig (%s). "
                    "Retrying without thinking.",
                    self.chat_model, e,
                )
                fallback_config = types.GenerateContentConfig(
                    system_instruction=system,
                    temperature=0.3,
                    max_output_tokens=8192,
                )
                try:
                    await _run_stream(fallback_config)
                except Exception as e2:
                    log.error("Google stream_chat fallback error: %s", e2)
                    raise RuntimeError(f"Google Gemini stream error: {e2}") from e2
            else:
                log.error("Google stream_chat error: %s", e)
                raise RuntimeError(f"Google Gemini stream error: {e}") from e

    # ── stream_plan_task ──────────────────────────────────────────────────────

    async def stream_plan_task(
        self,
        user_message: str,
        notebook_context: Dict[str, Any],
        skills: List[Dict[str, str]],
        memory: str,
        operation_id: Optional[str] = None,
        on_text_chunk: Optional[Callable[[str], Awaitable[None]]] = None,
        on_json_delta: Optional[Callable[[str], Awaitable[None]]] = None,
        on_thought: Optional[Callable[[str], Awaitable[None]]] = None,
        chat_history: Optional[List[Dict[str, str]]] = None,
        reasoning_mode: str = "off",
    ) -> Dict[str, Any]:
        """Streaming agent plan with thinking + text preamble + function call.

        Uses generate_content_stream with a FunctionDeclaration so the model:
          1. Streams its reasoning trace → thought bubble in the UI.
          2. Streams a text preamble    → progressive text in the chat window.
          3. Calls create_operation_plan → structured plan returned to the caller.

        This matches the Anthropic experience (thought → text → plan) rather than
        the old blocking JSON-schema approach that returned everything at once.

        Falls back to the synchronous JSON-schema plan_task if the function-call
        streaming fails (e.g. the model doesn't support tool calling).
        """
        op_id    = operation_id or f"op_{uuid.uuid4().hex[:8]}"
        system   = self._build_system(skills, memory, reasoning_mode=reasoning_mode)
        user_msg = _build_context(user_message, notebook_context)
        client   = self._client()
        types    = self._types()

        thinking_cfg = self._thinking_config(types)

        # ── Primary path: streaming + function calling ────────────────────────
        try:
            plan_fn = types.FunctionDeclaration(
                name=_PLAN_TOOL_NAME,
                description=(
                    "Create the notebook operation plan. "
                    "First write a brief explanation of what you will do, "
                    "then call this function exactly once with the complete plan."
                ),
                parameters=_PLAN_FN_PARAMETERS,
            )
            config = types.GenerateContentConfig(
                system_instruction=system,
                tools=[types.Tool(function_declarations=[plan_fn])],
                temperature=0.2,
                max_output_tokens=8192,
                **({"thinking_config": thinking_cfg} if thinking_cfg is not None else {}),
            )
            contents = self._build_contents(user_msg, notebook_context, types)

            collected_args: Optional[Dict[str, Any]] = None
            last_chunk = None

            async for chunk in await client.aio.models.generate_content_stream(
                model=self.chat_model, contents=contents, config=config,
            ):
                last_chunk = chunk
                if not chunk.candidates:
                    continue
                cand = chunk.candidates[0]
                # content.parts can be None when the response is filtered
                # (SAFETY/RECITATION) or empty-truncated (MAX_TOKENS).
                parts = getattr(getattr(cand, "content", None), "parts", None) or []
                if not parts:
                    fr = getattr(cand, "finish_reason", None)
                    if fr:
                        log.debug("GoogleProvider plan: empty parts (finish_reason=%s)", fr)
                    continue
                for part in parts:
                    # Function call — collect the plan arguments.
                    fc = getattr(part, "function_call", None)
                    if fc and getattr(fc, "name", None) == _PLAN_TOOL_NAME:
                        raw = getattr(fc, "args", {})
                        collected_args = _deep_convert_args(raw)
                    elif part.text:
                        if getattr(part, "thought", False):
                            if on_thought:
                                await on_thought(part.text)
                        else:
                            if on_text_chunk:
                                await on_text_chunk(part.text)

            # Record token usage from the final chunk.
            if last_chunk:
                self._record_usage(last_chunk)

            if collected_args and isinstance(collected_args.get("steps"), list):
                collected_args.setdefault("operationId", op_id)
                collected_args.setdefault("clarificationNeeded", None)
                collected_args.setdefault("requiresApproval", False)
                collected_args.setdefault("summary", "")
                log.debug(
                    "Google stream_plan_task: got %d step(s) via function call",
                    len(collected_args["steps"]),
                )
                return collected_args

            log.warning(
                "Google stream_plan_task: model did not call '%s' (args=%s). "
                "Falling back to JSON-schema plan_task.",
                _PLAN_TOOL_NAME,
                list(collected_args) if collected_args else None,
            )

        except Exception as exc:
            log.warning(
                "Google stream_plan_task: streaming with function calling failed "
                "(%s). Falling back to JSON-schema plan_task.", exc,
            )

        # ── Fallback: synchronous JSON-schema plan + word-by-word summary ─────
        # Keeps the UI from going completely blank while the plan is generated.
        plan = await self.plan_task(
            user_message=user_message,
            notebook_context=notebook_context,
            skills=skills,
            memory=memory,
            operation_id=op_id,
            chat_history=chat_history,
            reasoning_mode=reasoning_mode,
        )
        summary = plan.get("summary", "")
        if summary and on_text_chunk:
            words = summary.split(" ")
            for i, word in enumerate(words):
                chunk = word if i == 0 else f" {word}"
                if chunk:
                    await on_text_chunk(chunk)
                    await asyncio.sleep(0)
        return plan

    # ── health_check ──────────────────────────────────────────────────────────

    async def health_check(self) -> bool:
        try:
            client = self._client()
            types  = self._types()
            await client.aio.models.generate_content(
                model=self.chat_model,
                contents="hi",
                config=types.GenerateContentConfig(max_output_tokens=1),
            )
            return True
        except Exception:
            return False

    # ── chat ──────────────────────────────────────────────────────────────────

    async def chat(
        self,
        system: str,
        user: str,
        chat_history: Optional[List[Dict[str, str]]] = None,
        temperature: Optional[float] = None,
    ) -> str:
        client = self._client()
        types  = self._types()

        thinking_cfg = self._thinking_config(types)
        config = types.GenerateContentConfig(
            system_instruction=system,
            temperature=0.3,
            max_output_tokens=8192,
            **({"thinking_config": thinking_cfg} if thinking_cfg is not None else {}),
        )

        # Build history as a list of Content objects and append the current turn.
        contents: List[Any] = []
        if chat_history:
            history = list(chat_history)
            while history and history[0].get("role") != "user":
                history = history[1:]
            for turn in history:
                role = "user" if turn["role"] == "user" else "model"
                contents.append(types.Content(
                    role=role,
                    parts=[types.Part.from_text(text=turn["content"])],
                ))
        contents.append(types.Content(
            role="user",
            parts=[types.Part.from_text(text=user)],
        ))

        def _extract_text(resp: Any) -> str:
            self._record_usage(resp)
            if resp.candidates:
                cand = resp.candidates[0]
                # content.parts can be None when the response is filtered
                # (SAFETY/RECITATION) or empty-truncated (MAX_TOKENS).
                parts = getattr(getattr(cand, "content", None), "parts", None) or []
                if not parts:
                    fr = getattr(cand, "finish_reason", None)
                    if fr:
                        log.debug("GoogleProvider _extract_text: empty parts (finish_reason=%s)", fr)
                text_parts = [
                    p.text for p in parts
                    if p.text and not getattr(p, "thought", False)
                ]
                if text_parts:
                    return "".join(text_parts)
            return resp.text or ""

        try:
            resp = await client.aio.models.generate_content(
                model=self.chat_model, contents=contents, config=config,
            )
            return _extract_text(resp)
        except Exception as e:
            err_str = str(e).lower()
            if thinking_cfg is not None and (
                "thinking" in err_str or "thinkingbudget" in err_str
                or "invalid" in err_str or "unsupported" in err_str
            ):
                log.warning(
                    "Google model %s rejected ThinkingConfig (%s). Retrying without thinking.",
                    self.chat_model, e,
                )
                fallback_config = types.GenerateContentConfig(
                    system_instruction=system,
                    temperature=0.3,
                    max_output_tokens=8192,
                )
                try:
                    resp = await client.aio.models.generate_content(
                        model=self.chat_model, contents=contents, config=fallback_config,
                    )
                    return _extract_text(resp)
                except Exception as e2:
                    log.error("Google chat fallback error: %s", e2)
                    raise RuntimeError(f"Google Gemini error: {e2}") from e2
            log.error("Google chat error: %s", e)
            raise RuntimeError(f"Google Gemini error: {e}") from e

    def has_vision(self) -> bool:
        """All Gemini 1.5+ and 2.0 models support vision."""
        return "gemini" in self.chat_model.lower()

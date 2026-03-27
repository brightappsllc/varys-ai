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


class GoogleProvider(BaseLLMProvider):
    VENDOR = "google"

    """Calls the Google Gemini API via the google-genai SDK."""

    # Models known to support the thinkingBudget parameter (Gemini 2.5+).
    # Checked via substring match against the model name.
    _THINKING_MODEL_PREFIXES = ("gemini-2.5",)

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

    def _supports_thinking(self) -> bool:
        """True when the configured chat model supports thinkingBudget."""
        m = self.chat_model.lower()
        return any(m.startswith(p) or p in m for p in self._THINKING_MODEL_PREFIXES)

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
        """Return a ThinkingConfig when thinking is enabled and the model supports it.

        thinkingBudget=-1  → dynamic thinking (model decides how much to use)
        thinkingBudget=N   → fixed budget in tokens
        Returns None when thinking is off or unsupported (no param is sent).
        """
        if not (self.enable_thinking and self._supports_thinking()):
            return None
        budget = self.thinking_budget if self.thinking_budget > 0 else -1
        try:
            return types.ThinkingConfig(thinking_budget=budget)
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
            "Google stream_chat: model=%s enable_thinking=%s supports_thinking=%s",
            self.chat_model, self.enable_thinking, self._supports_thinking(),
        )

        try:
            last_chunk = None
            async for chunk in await client.aio.models.generate_content_stream(
                model=self.chat_model,
                contents=contents,
                config=config,
            ):
                last_chunk = chunk
                # Each chunk may carry multiple parts: thought=True parts are
                # reasoning content; the rest are regular response text.
                if chunk.candidates:
                    for part in chunk.candidates[0].content.parts:
                        if not part.text:
                            continue
                        if getattr(part, "thought", False):
                            if on_thought:
                                await on_thought(part.text)
                        else:
                            await on_chunk(part.text)
                elif chunk.text:
                    # Fallback for chunks without candidate detail
                    await on_chunk(chunk.text)
            if last_chunk is not None:
                self._record_usage(last_chunk)
        except Exception as e:
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
        """Run plan_task then stream the summary so the UI gets at least one
        chunk event before the done event — ensuring ensureStreamStarted fires
        and the DiffView renders correctly.
        """
        op_id = operation_id or f"op_{uuid.uuid4().hex[:8]}"
        plan  = await self.plan_task(
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
            for i, word in enumerate(summary.split(" ")):
                chunk = word if i == len(summary.split(" ")) - 1 else word + " "
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

        try:
            resp = await client.aio.models.generate_content(
                model=self.chat_model,
                contents=contents,
                config=config,
            )
            self._record_usage(resp)
            # Extract only the non-thought text parts.
            if resp.candidates:
                text_parts = [
                    p.text for p in resp.candidates[0].content.parts
                    if p.text and not getattr(p, "thought", False)
                ]
                return "".join(text_parts)
            return resp.text or ""
        except Exception as e:
            log.error("Google chat error: %s", e)
            raise RuntimeError(f"Google Gemini error: {e}") from e

    def has_vision(self) -> bool:
        """All Gemini 1.5+ and 2.0 models support vision."""
        return "gemini" in self.chat_model.lower()

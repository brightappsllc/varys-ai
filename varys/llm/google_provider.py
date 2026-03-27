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

    def __init__(
        self,
        api_key: str,
        chat_model: str = "gemini-2.0-flash",
        completion_model: str = "gemini-2.0-flash",
    ) -> None:
        super().__init__()
        self.api_key = api_key
        self.chat_model = chat_model
        self.completion_model = completion_model
        self._cache = CompletionCache()

    def _client(self):
        """Return a configured google.genai Client, with a friendly error if not installed."""
        try:
            from google import genai
            return genai.Client(api_key=self.api_key)
        except (ImportError, ModuleNotFoundError):
            raise RuntimeError(
                "google-genai not installed. Run: pip install google-genai"
            )

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
            raw        = resp.text or ""
            suggestion = re.sub(r"^```[a-z]*\n?", "", raw.strip(), flags=re.MULTILINE)
            suggestion = re.sub(r"\n?```$", "", suggestion, flags=re.MULTILINE).strip()
            if suggestion:
                self._cache.set(cache_key, suggestion)
            return {"suggestion": suggestion, "type": "completion", "lines": suggestion.splitlines(), "cached": False}
        except Exception as e:
            log.warning("Google complete error: %s", e)
            return {"suggestion": "", "type": "completion", "lines": [], "cached": False}

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

        config = types.GenerateContentConfig(
            system_instruction=system,
            temperature=0.3,
            max_output_tokens=8192,
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
            return resp.text or ""
        except Exception as e:
            log.error("Google chat error: %s", e)
            raise RuntimeError(f"Google Gemini error: {e}") from e

    def has_vision(self) -> bool:
        """All Gemini 1.5+ and 2.0 models support vision."""
        return "gemini" in self.chat_model.lower()

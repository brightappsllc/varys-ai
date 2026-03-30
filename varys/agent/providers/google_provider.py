"""Google Gemini provider for the Varys File Agent.

Uses the google-genai SDK (google.genai) — the same SDK already used by the
Varys chat layer.  Gemini models support function calling, so the full
multi-turn /file_agent loop works just like Anthropic or OpenAI.

Message history is stored as native google.genai types.Content objects so
the SDK receives exactly what it expects with no dict↔object conversion.
"""
from __future__ import annotations

import logging
from typing import AsyncIterator
from uuid import uuid4

from ..provider_base import (
    AgentProvider,
    AgentTurnEvent,
    TextDelta,
    ToolCall,
    TurnEnd,
)
from ..tool_definition import ToolDefinition

log = logging.getLogger(__name__)


def _deep_convert_args(obj):
    """Recursively convert proto MapComposite / RepeatedComposite to plain Python.

    google.genai FunctionCall.args may arrive wrapped in proto container types.
    """
    if isinstance(obj, dict):
        return {k: _deep_convert_args(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_deep_convert_args(i) for i in obj]
    if hasattr(obj, "items") and callable(obj.items) and not isinstance(obj, str):
        return {str(k): _deep_convert_args(v) for k, v in obj.items()}
    if hasattr(obj, "__iter__") and not isinstance(obj, (str, bytes)):
        return [_deep_convert_args(i) for i in obj]
    return obj


class GoogleAgentProvider(AgentProvider):
    """Google Gemini provider for the Varys File Agent.

    Credentials resolution (same priority order as the chat GoogleProvider):
      1. GOOGLE_SERVICE_ACCOUNT_JSON (service-account path) if non-empty and file exists
      2. GOOGLE_API_KEY (direct API key)

    Design note — thought_signature preservation
    ─────────────────────────────────────────────
    When thinking-capable models (gemini-2.5-*) produce function calls, each
    function_call Part carries an opaque thought_signature field that Gemini
    requires in the next turn's history.  Reconstructing the Part via
    Part.from_function_call(name, args) silently drops this field, causing a
    400 INVALID_ARGUMENT on turn 2+.

    To avoid this, stream_turn() stores the raw Part objects it receives from
    the SDK in self._last_model_parts.  build_assistant_history_message() then
    wraps them in a Content directly instead of reconstructing from scratch.
    """

    def __init__(
        self,
        api_key: str = "",
        service_account_json: str = "",
        model: str = "gemini-2.0-flash",
    ) -> None:
        self._api_key = api_key
        self._service_account_json = service_account_json
        self._model = model
        self.last_usage: dict = {"input": 0, "output": 0}
        # Set by stream_turn(); consumed by build_assistant_history_message().
        # Holds the raw Part objects (text + function_call with thought_signature).
        self._last_model_parts: list | None = None

    # ── SDK helpers ──────────────────────────────────────────────────────────

    def _client(self):
        try:
            from google import genai
        except (ImportError, ModuleNotFoundError):
            raise RuntimeError(
                "google-genai not installed. Run: pip install google-genai"
            )

        sa_path = (self._service_account_json or "").strip()
        if sa_path:
            import os
            if not os.path.isfile(sa_path):
                raise RuntimeError(
                    f"Google service-account JSON not found: {sa_path!r}. "
                    "Check Settings → Google → Service account JSON."
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
                    f"Failed to load Google service-account credentials: {exc}"
                ) from exc

        if not self._api_key:
            raise RuntimeError(
                "Google credentials not configured. "
                "Set GOOGLE_API_KEY (or GOOGLE_SERVICE_ACCOUNT_JSON) "
                "in your varys.env file."
            )
        return genai.Client(api_key=self._api_key)

    def _types(self):
        try:
            from google.genai import types
            return types
        except (ImportError, ModuleNotFoundError):
            raise RuntimeError(
                "google-genai not installed. Run: pip install google-genai"
            )

    # ── Tool schema conversion ────────────────────────────────────────────────

    def _to_function_declarations(self, tool_defs: list[ToolDefinition]) -> list:
        """Convert ToolDefinition objects to types.FunctionDeclaration objects."""
        types = self._types()
        return [
            types.FunctionDeclaration(
                name=d.name,
                description=d.description,
                parameters=d.parameters,
            )
            for d in tool_defs
        ]

    # ── AgentProvider interface ───────────────────────────────────────────────

    def make_initial_messages(self, task: str) -> list:
        """Return a single user Content with the task text."""
        types = self._types()
        return [types.Content(role="user", parts=[types.Part.from_text(text=task)])]

    async def stream_turn(
        self,
        messages: list,
        tool_definitions: list[ToolDefinition],
        system_prompt: str,
        max_tokens: int,
        require_tool_use: bool = False,
    ) -> AsyncIterator[AgentTurnEvent]:
        """Stream one turn.  messages is a list of types.Content objects."""
        client = self._client()
        types  = self._types()

        fn_declarations = self._to_function_declarations(tool_definitions) if tool_definitions else []
        config_kwargs: dict = {
            "system_instruction": system_prompt,
            "temperature": 0.2,
            "max_output_tokens": max_tokens,
        }
        if fn_declarations:
            config_kwargs["tools"] = [types.Tool(function_declarations=fn_declarations)]

        config = types.GenerateContentConfig(**config_kwargs)

        collected_tool_calls: list[ToolCall] = []
        # Accumulate raw SDK Part objects so build_assistant_history_message()
        # can return them verbatim, preserving any thought_signature fields.
        raw_fc_parts: list = []
        text_buffer: str = ""
        self.last_usage = {"input": 0, "output": 0}

        try:
            async for chunk in await client.aio.models.generate_content_stream(
                model=self._model,
                contents=messages,
                config=config,
            ):
                meta = getattr(chunk, "usage_metadata", None)
                if meta:
                    self.last_usage = {
                        "input":  getattr(meta, "prompt_token_count",     0) or 0,
                        "output": getattr(meta, "candidates_token_count", 0) or 0,
                    }

                if not chunk.candidates:
                    continue
                candidate = chunk.candidates[0]
                if not (hasattr(candidate, "content") and candidate.content):
                    continue

                for part in candidate.content.parts:
                    fc = getattr(part, "function_call", None)
                    if fc and getattr(fc, "name", None):
                        # Keep the raw Part object — it carries thought_signature
                        # which must be sent back verbatim in the next history turn.
                        raw_fc_parts.append(part)
                        raw_args = _deep_convert_args(getattr(fc, "args", {}))
                        # Gemini may prefix function names with "default_api:" or
                        # "default_api." in some SDK versions; strip to bare name.
                        raw_name: str = fc.name
                        if ":" in raw_name:
                            raw_name = raw_name.split(":")[-1]
                        elif "." in raw_name:
                            raw_name = raw_name.rsplit(".", 1)[-1]
                        collected_tool_calls.append(ToolCall(
                            call_id=str(uuid4()),
                            tool_name=raw_name,
                            tool_input=raw_args,
                        ))
                    elif part.text and not getattr(part, "thought", False):
                        text_buffer += part.text
                        yield TextDelta(text=part.text)
                    # Thought (reasoning) parts are skipped — the thought_signature
                    # on function_call parts is the only reference needed in history.

        except Exception as exc:
            log.error("GoogleAgentProvider API error: %s", exc)
            yield TurnEnd(stop_reason="error", error_message=str(exc))
            return

        # Build the parts list for the history Content (used by
        # build_assistant_history_message below).  Text first, then function calls.
        assembled_parts: list = []
        if text_buffer:
            assembled_parts.append(types.Part.from_text(text=text_buffer))
        assembled_parts.extend(raw_fc_parts)
        self._last_model_parts = assembled_parts if assembled_parts else None

        if collected_tool_calls:
            for tc in collected_tool_calls:
                yield tc
            yield TurnEnd(stop_reason="tool_use")
        else:
            # Do NOT raise ToolUseNotSupportedError here — Gemini commonly
            # produces a text-only summarisation turn AFTER the tool call
            # ("I've added the function.").  Raising on that final turn would
            # discard all staged file changes from earlier turns, matching
            # the Anthropic provider which ignores require_tool_use entirely.
            yield TurnEnd(stop_reason="end_turn")

    def build_assistant_history_message(
        self,
        text_content: str,
        tool_calls: list[ToolCall],
    ) -> object:
        """Return a model-role Content for the conversation history.

        Uses the raw Part objects stored by stream_turn() so that any
        thought_signature fields on function-call parts are preserved verbatim.
        Falls back to reconstruction when no stored parts are available.
        """
        types = self._types()

        if self._last_model_parts is not None:
            parts = self._last_model_parts
            self._last_model_parts = None
            return types.Content(role="model", parts=parts)

        # Fallback: reconstruct from parsed data (no thought_signature — only
        # reached if build_assistant_history_message is called without a prior
        # stream_turn, which should not happen in normal agent-runner flow).
        parts = []
        if text_content:
            parts.append(types.Part.from_text(text=text_content))
        for tc in tool_calls:
            try:
                parts.append(types.Part.from_function_call(
                    name=tc.tool_name,
                    args=tc.tool_input,
                ))
            except AttributeError:
                parts.append(types.Part(
                    function_call=types.FunctionCall(
                        name=tc.tool_name,
                        args=tc.tool_input,
                    )
                ))
        return types.Content(role="model", parts=parts)

    def build_tool_result_message(
        self,
        tool_calls: list[ToolCall],
        results: list[str],
    ) -> object:
        """Return a single user-role Content with one FunctionResponse part per call.

        Gemini requires all tool results for a given turn to be in one Content.
        """
        types = self._types()
        parts = [
            types.Part.from_function_response(
                name=tc.tool_name,
                response={"result": result},
            )
            for tc, result in zip(tool_calls, results)
        ]
        return types.Content(role="user", parts=parts)

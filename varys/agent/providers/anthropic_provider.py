"""Anthropic provider for the Varys File Agent.

Uses the AsyncAnthropic client with optional prompt caching.
Prompt caching is built lazily on the first stream_turn() call and reused
across all turns within the same session (same provider instance).
"""
from __future__ import annotations

import logging
import os
from typing import AsyncIterator

from ..provider_base import (
    AgentProvider,
    AgentTurnEvent,
    TextDelta,
    ThoughtDelta,
    ToolCall,
    TurnEnd,
)
from ..tool_definition import ToolDefinition
from ..tool_schemas import to_anthropic_tools

log = logging.getLogger(__name__)


def _log_cache_usage(usage: object, turn: int) -> None:
    """Log Anthropic prompt-cache hit/miss counts at DEBUG level."""
    created = getattr(usage, "cache_creation_input_tokens", 0) or 0
    read    = getattr(usage, "cache_read_input_tokens", 0) or 0
    normal  = getattr(usage, "input_tokens", 0) or 0
    if created or read:
        log.debug(
            "Anthropic cache turn=%d: created=%d read=%d normal=%d",
            turn, created, read, normal,
        )


class AnthropicAgentProvider(AgentProvider):
    """Anthropic Claude provider.

    Supports extended thinking (ThoughtDelta) and ephemeral prompt caching.
    Cache blocks are built once on first stream_turn() call and reused for
    all subsequent turns in the session, guaranteeing cache hits on turns 2+.
    """

    def __init__(self, api_key: str, model: str) -> None:
        self._api_key = api_key
        self._model = model
        # VARYS_AGENT_PROMPT_CACHING takes precedence; falls back to the shared
        # VARYS_PROMPT_CACHING switch so one variable can control everything.
        _raw = os.environ.get(
            "VARYS_AGENT_PROMPT_CACHING",
            os.environ.get("VARYS_PROMPT_CACHING", "true"),
        )
        self._prompt_caching = _raw.strip().lower() not in ("false", "0", "no")
        # Lazily built on first stream_turn() call; reused every subsequent call
        self._cached_system: list[dict] | None = None
        self._cached_tools: list[dict] | None = None
        self._turn_count = 0
        self.last_usage: dict = {"input": 0, "output": 0}

    def _build_cached_blocks(
        self,
        system_prompt: str,
        tool_defs: list[ToolDefinition],
    ) -> None:
        """Build prompt-caching blocks once and store them for reuse."""
        anthropic_tools = to_anthropic_tools(tool_defs)
        if self._prompt_caching:
            self._cached_system = [
                {
                    "type": "text",
                    "text": system_prompt,
                    "cache_control": {"type": "ephemeral"},
                }
            ]
            if anthropic_tools:
                self._cached_tools = [dict(t) for t in anthropic_tools]
                self._cached_tools[-1] = {
                    **self._cached_tools[-1],
                    "cache_control": {"type": "ephemeral"},
                }
            else:
                self._cached_tools = []
        else:
            self._cached_system = [{"type": "text", "text": system_prompt}]
            self._cached_tools = anthropic_tools

    async def stream_turn(  # type: ignore[override]
        self,
        messages: list[dict],
        tool_definitions: list[ToolDefinition],
        system_prompt: str,
        max_tokens: int,
        require_tool_use: bool = False,
    ) -> AsyncIterator[AgentTurnEvent]:
        import anthropic as _anthropic

        if self._cached_system is None:
            self._build_cached_blocks(system_prompt, tool_definitions)

        aclient = _anthropic.AsyncAnthropic(api_key=self._api_key)

        try:
            async with aclient.messages.stream(
                model=self._model,
                max_tokens=max_tokens,
                system=self._cached_system,
                tools=self._cached_tools,
                messages=messages,
            ) as stream:
                async for event in stream:
                    if event.type == "content_block_delta":
                        delta = event.delta
                        if delta.type == "text_delta":
                            yield TextDelta(text=delta.text)
                        elif delta.type == "thinking_delta":
                            yield ThoughtDelta(text=delta.thinking)

                final_msg = await stream.get_final_message()
                _log_cache_usage(final_msg.usage, self._turn_count)
                self._turn_count += 1

                # Expose token counts so agent_runner can accumulate them.
                _u = final_msg.usage
                self.last_usage = {
                    "input": (
                        (getattr(_u, "cache_creation_input_tokens", 0) or 0)
                        + (getattr(_u, "cache_read_input_tokens",    0) or 0)
                        + (getattr(_u, "input_tokens",               0) or 0)
                    ),
                    "output": getattr(_u, "output_tokens", 0) or 0,
                }

                # Collect tool calls from final message
                tool_calls: list[ToolCall] = []
                for block in final_msg.content:
                    if block.type == "tool_use":
                        tool_calls.append(ToolCall(
                            call_id=block.id,
                            tool_name=block.name,
                            tool_input=dict(block.input),
                        ))

                stop_reason = final_msg.stop_reason
                if stop_reason == "tool_use":
                    for tc in tool_calls:
                        yield tc
                    yield TurnEnd(stop_reason="tool_use")
                else:
                    yield TurnEnd(stop_reason="end_turn")

        except _anthropic.APIError as api_err:
            log.error("AnthropicAgentProvider API error: %s", api_err)
            yield TurnEnd(stop_reason="error", error_message=str(api_err))

    def build_assistant_history_message(
        self,
        text_content: str,
        tool_calls: list[ToolCall],
    ) -> dict:
        content: list[dict] = []
        if text_content:
            content.append({"type": "text", "text": text_content})
        for tc in tool_calls:
            content.append({
                "type": "tool_use",
                "id": tc.call_id,
                "name": tc.tool_name,
                "input": tc.tool_input,
            })
        return {"role": "assistant", "content": content}

    def build_tool_result_message(
        self,
        tool_calls: list[ToolCall],
        results: list[str],
    ) -> dict:
        return {
            "role": "user",
            "content": [
                {
                    "type": "tool_result",
                    "tool_use_id": tc.call_id,
                    "content": result,
                }
                for tc, result in zip(tool_calls, results)
            ],
        }

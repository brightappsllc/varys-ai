"""OpenAI provider for the Varys File Agent.

Shared by AzureOpenAIAgentProvider and OllamaAgentProvider via subclassing.
"""
from __future__ import annotations

import json
import logging
from typing import AsyncIterator
from uuid import uuid4

from ..provider_base import (
    AgentProvider,
    AgentTurnEvent,
    TextDelta,
    ToolCall,
    TurnEnd,
    ToolUseNotSupportedError,
)
from ..tool_definition import ToolDefinition
from ..tool_schemas import to_openai_tools, parse_tool_input

log = logging.getLogger(__name__)


class OpenAIAgentProvider(AgentProvider):
    """OpenAI-compatible provider (also used as base for Azure and Ollama).

    The client is injected so that Azure and Ollama subclasses can supply
    their own AsyncOpenAI-compatible client.
    """

    def __init__(self, client: object, model: str) -> None:
        self._client = client
        self._model = model

    async def stream_turn(  # type: ignore[override]
        self,
        messages: list[dict],
        tool_definitions: list[ToolDefinition],
        system_prompt: str,
        max_tokens: int,
        require_tool_use: bool = False,
    ) -> AsyncIterator[AgentTurnEvent]:
        # Build system message — insert at front of messages copy
        full_messages = [{"role": "system", "content": system_prompt}] + list(messages)
        openai_tools = to_openai_tools(tool_definitions) if tool_definitions else []

        # Accumulate tool call deltas keyed by index
        accumulated_tools: dict[int, dict] = {}  # index → {id, name, arguments}
        text_content = ""
        finish_reason = None
        self.last_usage: dict = {"input": 0, "output": 0}

        try:
            kwargs = {
                "model": self._model,
                "messages": full_messages,
                "max_tokens": max_tokens,
                "stream": True,
                # Request per-stream usage so we can report token counts.
                "stream_options": {"include_usage": True},
            }
            if openai_tools:
                kwargs["tools"] = openai_tools

            async for chunk in await self._client.chat.completions.create(**kwargs):  # type: ignore[attr-defined]
                # Final chunk carries usage when stream_options.include_usage=True
                if chunk.usage:
                    self.last_usage = {
                        "input":  getattr(chunk.usage, "prompt_tokens",     0) or 0,
                        "output": getattr(chunk.usage, "completion_tokens", 0) or 0,
                    }
                choice = chunk.choices[0] if chunk.choices else None
                if choice is None:
                    continue

                delta = choice.delta
                if delta.content:
                    text_content += delta.content
                    yield TextDelta(text=delta.content)

                if delta.tool_calls:
                    for tc_delta in delta.tool_calls:
                        idx = tc_delta.index
                        if idx not in accumulated_tools:
                            accumulated_tools[idx] = {
                                "id": tc_delta.id or "",
                                "name": tc_delta.function.name or "" if tc_delta.function else "",
                                "arguments": "",
                            }
                        else:
                            if tc_delta.id:
                                accumulated_tools[idx]["id"] = tc_delta.id
                            if tc_delta.function:
                                if tc_delta.function.name:
                                    accumulated_tools[idx]["name"] += tc_delta.function.name
                                if tc_delta.function.arguments:
                                    accumulated_tools[idx]["arguments"] += tc_delta.function.arguments

                if choice.finish_reason:
                    finish_reason = choice.finish_reason

        except Exception as exc:
            log.error("OpenAIAgentProvider API error: %s", exc)
            yield TurnEnd(stop_reason="error", error_message=str(exc))
            return

        # Emit accumulated tool calls
        tool_calls: list[ToolCall] = []
        for idx in sorted(accumulated_tools.keys()):
            entry = accumulated_tools[idx]
            try:
                parsed_input = parse_tool_input(entry["arguments"] or "{}")
            except Exception:
                parsed_input = {}
            tc = ToolCall(
                call_id=entry["id"] or str(uuid4()),
                tool_name=entry["name"],
                tool_input=parsed_input,
            )
            tool_calls.append(tc)

        if finish_reason == "tool_calls" or tool_calls:
            for tc in tool_calls:
                yield tc
            yield TurnEnd(stop_reason="tool_use")
        elif finish_reason == "stop":
            if require_tool_use and not tool_calls:
                raise ToolUseNotSupportedError(
                    provider=self._get_provider_name(),
                    model=self._model,
                    reason="Model returned a plain-text response instead of tool calls.",
                    suggestion=self._get_suggestion(),
                )
            yield TurnEnd(stop_reason="end_turn")
        else:
            yield TurnEnd(stop_reason="end_turn")

    def _get_provider_name(self) -> str:
        return "openai"

    def _get_suggestion(self) -> str:
        return (
            "Embedding, audio, and image models do not support tool calling. "
            "Use gpt-4o, gpt-4o-mini, or gpt-4.1 instead."
        )

    def build_assistant_history_message(
        self,
        text_content: str,
        tool_calls: list[ToolCall],
    ) -> dict:
        msg: dict = {"role": "assistant"}
        if text_content:
            msg["content"] = text_content
        if tool_calls:
            msg["tool_calls"] = [
                {
                    "id": tc.call_id,
                    "type": "function",
                    "function": {
                        "name": tc.tool_name,
                        "arguments": json.dumps(tc.tool_input),
                    },
                }
                for tc in tool_calls
            ]
        return msg

    def build_tool_result_message(
        self,
        tool_calls: list[ToolCall],
        results: list[str],
    ) -> list[dict]:
        return [
            {
                "role": "tool",
                "tool_call_id": tc.call_id,
                "content": result,
            }
            for tc, result in zip(tool_calls, results)
        ]

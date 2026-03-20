"""Ollama provider for the Varys File Agent.

Subclasses OpenAIAgentProvider using the OpenAI-compatible Ollama endpoint.
Adds synthetic call_id generation for Ollama models that omit tool call IDs.
"""
from __future__ import annotations

from typing import AsyncIterator
from uuid import uuid4

from ..provider_base import AgentTurnEvent, ToolCall
from ..tool_definition import ToolDefinition
from .openai_provider import OpenAIAgentProvider


class OllamaAgentProvider(OpenAIAgentProvider):
    """Ollama local model provider.

    Uses the OpenAI-compatible Ollama API at base_url/v1.
    Some Ollama models omit the id field on tool calls; this provider
    generates a synthetic uuid4() in that case.
    """

    def __init__(self, base_url: str, model: str) -> None:
        import openai
        client = openai.AsyncOpenAI(
            base_url=base_url,
            api_key="ollama",  # required non-empty string; value ignored by Ollama
        )
        super().__init__(client=client, model=model)
        self._ollama_model = model

    async def stream_turn(  # type: ignore[override]
        self,
        messages: list[dict],
        tool_definitions: list[ToolDefinition],
        system_prompt: str,
        max_tokens: int,
        require_tool_use: bool = False,
    ) -> AsyncIterator[AgentTurnEvent]:
        async for event in super().stream_turn(
            messages, tool_definitions, system_prompt, max_tokens, require_tool_use
        ):
            if isinstance(event, ToolCall) and not event.call_id:
                event = ToolCall(
                    call_id=str(uuid4()),
                    tool_name=event.tool_name,
                    tool_input=event.tool_input,
                )
            yield event

    def _get_provider_name(self) -> str:
        return "ollama"

    def _get_suggestion(self) -> str:
        return (
            "Switch to a tool-capable model in Ollama settings. "
            "Models that support tool calling include: "
            "qwen2.5-coder, llama3.1, llama3.2, mistral-nemo, mistral."
        )

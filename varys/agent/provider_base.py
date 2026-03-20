"""Abstract base class for Varys File Agent LLM providers.

All five providers (Anthropic, OpenAI, Azure, Bedrock, Ollama) implement
AgentProvider. The agentic loop in agent_runner.run() only uses this
interface — provider-specific SDK calls are hidden behind it.
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import AsyncIterator, Literal

from .tool_definition import ToolDefinition


# ── Turn events ──────────────────────────────────────────────────────────────

@dataclass
class TextDelta:
    """Streamed text fragment from the assistant."""
    text: str


@dataclass
class ThoughtDelta:
    """Extended-thinking fragment (Anthropic only, ignored by other providers)."""
    text: str


@dataclass
class ToolCall:
    """A complete tool call parsed from the LLM response."""
    call_id: str       # synthetic uuid4() if provider omits it (Ollama edge case)
    tool_name: str
    tool_input: dict   # always a parsed dict, never a JSON string


@dataclass
class TurnEnd:
    """Signals the end of one API call."""
    stop_reason: Literal["end_turn", "tool_use", "max_tokens", "error"]
    error_message: str | None = None


AgentTurnEvent = TextDelta | ThoughtDelta | ToolCall | TurnEnd


# ── Error ─────────────────────────────────────────────────────────────────────

class ToolUseNotSupportedError(Exception):
    """Raised when the selected model does not support tool calling.

    May be raised proactively (before any API call) by build_agent_provider()
    for known-incompatible models, or reactively inside stream_turn() when
    require_tool_use=True and the first response contains no tool calls.
    """
    def __init__(
        self,
        provider: str,
        model: str,
        reason: str,
        suggestion: str,
    ):
        self.provider = provider
        self.model = model
        self.reason = reason
        self.suggestion = suggestion
        super().__init__(f"Model '{model}' on '{provider}' does not support tool calling.")


# ── Abstract provider ─────────────────────────────────────────────────────────

class AgentProvider(ABC):
    """Abstract interface for one LLM provider used by the file agent.

    The three abstract methods correspond to the three protocol steps in every
    agentic turn:
      1. stream_turn()                   — call the LLM, yield events
      2. build_assistant_history_message — build the assistant turn for history
      3. build_tool_result_message       — build the tool results for history
    """

    @abstractmethod
    async def stream_turn(
        self,
        messages: list[dict],
        tool_definitions: list[ToolDefinition],
        system_prompt: str,
        max_tokens: int,
        require_tool_use: bool = False,
    ) -> AsyncIterator[AgentTurnEvent]:
        """Stream one turn of the agentic loop.

        Yields TextDelta / ThoughtDelta during streaming, then ToolCall events
        (if any), then TurnEnd.

        require_tool_use=True causes ToolUseNotSupportedError to be raised
        if the turn completes with no tool calls. Used for /file_agent and
        /file_agent_save, NOT for /file_agent_find.

        Does NOT append to messages — caller manages history.
        """
        ...

    @abstractmethod
    def build_assistant_history_message(
        self,
        text_content: str,
        tool_calls: list[ToolCall],
    ) -> dict:
        """Return the assistant turn dict to append to messages.

        Reconstructed from accumulated events — no raw SDK response needed.
        """
        ...

    @abstractmethod
    def build_tool_result_message(
        self,
        tool_calls: list[ToolCall],
        results: list[str],
    ) -> dict | list[dict]:
        """Return the tool result message(s) to append to messages.

        Anthropic and Bedrock: returns a single dict.
        OpenAI, Azure, Ollama: returns list[dict] (one per tool call).

        Caller:
            result = provider.build_tool_result_message(...)
            if isinstance(result, list):
                messages.extend(result)
            else:
                messages.append(result)
        """
        ...

    def make_initial_messages(self, task: str) -> list[dict]:
        """Return the initial messages list for this provider's format.

        Default (Anthropic, OpenAI, Azure, Ollama):
            [{"role": "user", "content": task}]
        Overridden by BedrockAgentProvider.
        """
        return [{"role": "user", "content": task}]

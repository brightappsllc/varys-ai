"""Anthropic Claude provider — wraps ClaudeClient and CompletionEngine."""
import asyncio
from typing import Any, Callable, Awaitable, Dict, List, Optional

from .base import BaseLLMProvider
from .client import ClaudeClient
from ..completion.engine import CompletionEngine

try:
    from ..builtin_tools.mcp_sequential_thinking import SEQUENTIAL_THINKING_TOOL, MAX_THOUGHTS
except ImportError:
    SEQUENTIAL_THINKING_TOOL = None  # type: ignore
    MAX_THOUGHTS = 25


class AnthropicProvider(BaseLLMProvider):
    VENDOR = "anthropic"

    """
    Delegates to the existing ClaudeClient (tool-use structured output)
    for task planning, and to CompletionEngine (Haiku/Sonnet) for inline
    completions.

    MCP Sequential Thinking is implemented natively here: the thought loop
    calls the LLM repeatedly with the sequential_thinking tool until
    nextThoughtNeeded=False, collecting all thoughts.  The caller then
    injects the thought summary into the final user message before the
    actual answer call.
    """

    def __init__(
        self,
        api_key: str,
        chat_model: str = "claude-sonnet-4-6",
        completion_model: str = "claude-haiku-4-5-20251001",
        extended_thinking: bool = True,
    ) -> None:
        super().__init__()
        self._chat_client = ClaudeClient(
            api_key=api_key,
            model=chat_model,
            extended_thinking=extended_thinking,
        )
        self._completion_engine = CompletionEngine(
            api_key=api_key,
            completion_model=completion_model,
        )

    # ------------------------------------------------------------------
    # MCP Sequential Thinking
    # ------------------------------------------------------------------

    def has_sequential_thinking(self) -> bool:
        """Return True — Anthropic provider supports MCP sequential thinking."""
        return True

    async def run_sequential_thinking_loop(
        self,
        user: str,
        system: str,
        on_thought: Callable[[str], Awaitable[None]],
        chat_history: Optional[List[Dict[str, str]]] = None,
    ) -> List[Dict[str, Any]]:
        """Run MCP sequential thinking loop and return collected thought dicts.

        Sends the LLM a sequence of API calls, each providing the
        sequential_thinking tool.  The LLM calls the tool repeatedly (revising
        and branching freely) until it sets nextThoughtNeeded=False.

        Each thought is streamed live to the caller via on_thought so the 🧠
        panel updates in real-time.  Returns the full list of thought dicts
        (each matching the tool's input schema) so the caller can inject a
        formatted summary into the final answer call.

        Safety: capped at MAX_THOUGHTS iterations regardless of LLM decisions.
        """
        if not self._chat_client._aclient or SEQUENTIAL_THINKING_TOOL is None:
            return []

        messages = self._chat_client._prepend_history(chat_history, user)
        thoughts: List[Dict[str, Any]] = []
        total_input = 0
        total_output = 0

        for _guard in range(MAX_THOUGHTS):
            response = await self._chat_client._aclient.messages.create(
                model=self._chat_client.model,
                max_tokens=4_096,
                system=system,
                tools=[SEQUENTIAL_THINKING_TOOL],
                tool_choice={"type": "auto"},
                messages=messages,
            )

            if hasattr(response, "usage") and response.usage:
                total_input  += getattr(response.usage, "input_tokens",  0)
                total_output += getattr(response.usage, "output_tokens", 0)

            # Add assistant turn to history
            messages.append({"role": "assistant", "content": response.content})

            made_tool_call = False
            done = False

            for block in response.content:
                if block.type == "tool_use" and block.name == "sequential_thinking":
                    made_tool_call = True
                    thought_data = dict(block.input)
                    thoughts.append(thought_data)

                    thought_text = thought_data.get("thought", "")
                    if thought_text:
                        await on_thought(thought_text)
                        await asyncio.sleep(0)

                    # Acknowledge the tool call so the conversation continues
                    messages.append({
                        "role": "user",
                        "content": [{
                            "type": "tool_result",
                            "tool_use_id": block.id,
                            "content": "Thought recorded.",
                        }],
                    })

                    if not thought_data.get("nextThoughtNeeded", True):
                        done = True
                    break  # process one tool call per turn

            if not made_tool_call or done:
                break

        # Propagate accumulated thinking-phase tokens; the final answer call
        # will add its own tokens on top via stream_chat / stream_plan_task.
        self._set_usage(total_input, total_output)
        self._chat_client._set_usage(total_input, total_output)
        return thoughts

    # ------------------------------------------------------------------
    # Standard provider methods
    # ------------------------------------------------------------------

    async def plan_task(
        self,
        user_message: str,
        notebook_context: Dict[str, Any],
        skills: List[Dict[str, str]],
        memory: str,
        operation_id: Optional[str] = None,
        chat_history: Optional[List[Dict[str, str]]] = None,
    ) -> Dict[str, Any]:
        result = await self._chat_client.plan_task(
            user_message=user_message,
            notebook_context=notebook_context,
            skills=skills,
            memory=memory,
            operation_id=operation_id,
            chat_history=chat_history,
        )
        self.last_usage = self._chat_client.last_usage
        return result

    async def complete(
        self,
        prefix: str,
        suffix: str,
        language: str,
        previous_cells: List[Dict[str, Any]],
    ) -> Dict[str, Any]:
        return await self._completion_engine.complete(
            prefix=prefix,
            suffix=suffix,
            language=language,
            previous_cells=previous_cells,
        )

    async def chat(
        self,
        system: str,
        user: Any,  # str or List[content blocks] (e.g. from _build_content_blocks_from_text)
        chat_history: Optional[List[Dict[str, str]]] = None,
    ) -> str:
        if not self._chat_client._aclient:
            return "No API key configured."
        messages = self._chat_client._prepend_history(chat_history, user)
        resp = await self._chat_client._aclient.messages.create(
            model=self._chat_client.model,
            max_tokens=8192,
            system=system,
            messages=messages,
        )
        if hasattr(resp, "usage") and resp.usage:
            self._set_usage(
                getattr(resp.usage, "input_tokens", 0),
                getattr(resp.usage, "output_tokens", 0),
            )
        text_block = next((b for b in resp.content if hasattr(b, "text")), None)
        return text_block.text if text_block else ""

    async def stream_chat(
        self,
        system: str,
        user: Any,  # str or List[content blocks] (e.g. from _build_content_blocks_from_text)
        on_chunk: Callable[[str], Awaitable[None]],
        on_thought: Optional[Callable[[str], Awaitable[None]]] = None,
        chat_history: Optional[List[Dict[str, str]]] = None,
    ) -> None:
        await self._chat_client.stream_chat(
            system=system,
            user=user,
            on_chunk=on_chunk,
            on_thought=on_thought,
            chat_history=chat_history,
        )
        self.last_usage = self._chat_client.last_usage

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
        result = await self._chat_client.stream_plan_task(
            user_message=user_message,
            notebook_context=notebook_context,
            skills=skills,
            memory=memory,
            operation_id=operation_id,
            on_text_chunk=on_text_chunk,
            on_json_delta=on_json_delta,
            on_thought=on_thought,
            chat_history=chat_history,
            reasoning_mode=reasoning_mode,
        )
        self.last_usage = self._chat_client.last_usage
        return result

    async def health_check(self) -> bool:
        try:
            if not self._chat_client._aclient:
                return False
            await self._chat_client._aclient.models.list()
            return True
        except Exception:
            return False

    def build_system_prompt(
        self,
        skills: List[Dict[str, str]],
        memory: str,
        reasoning_mode: str = "off",
    ) -> str:
        """Return the full system prompt for cell-op planning (used by the thought loop)."""
        return self._chat_client._build_system_prompt(skills, memory, reasoning_mode=reasoning_mode)

    def has_vision(self) -> bool:
        """All Claude 3+ models support vision."""
        return True

"""Abstract base class for all LLM providers."""
import asyncio
import json
import re
from abc import ABC, abstractmethod
from typing import Any, Callable, Awaitable, Dict, List, Optional

# ── Sequential thinking ───────────────────────────────────────────────────────
# System-prompt suffix injected when the generic (non-tool-calling) sequential
# thinking loop is used.  Tells the model to output one JSON thought per turn.
_SEQUENTIAL_THINKING_SYSTEM_SUFFIX = """

## Sequential Reasoning Protocol
You are in a step-by-step reasoning session.
For EACH thought, output ONLY a single JSON object — no extra text, no markdown fences:
{
  "thought": "your current reasoning step",
  "nextThoughtNeeded": true,
  "thoughtNumber": 1,
  "totalThoughts": 5
}
Rules:
- Output ONLY the JSON object.
- Adjust totalThoughts freely as your understanding deepens.
- Set nextThoughtNeeded to false only when your reasoning is fully complete.
- Each thought should build on, question, or revise previous insights."""


def _extract_json_thought(text: str) -> "Dict[str, Any] | None":
    """Robustly parse a thought JSON object from an LLM response.

    Handles bare JSON, markdown-fenced JSON, and JSON embedded in prose.
    Falls back to treating the whole response as a plain text thought.
    """
    text = text.strip()
    # Strip markdown code fence if present
    text = re.sub(r"^```(?:json)?\s*", "", text, flags=re.IGNORECASE)
    text = re.sub(r"\s*```$", "", text).strip()

    # Attempt 1 — direct parse
    try:
        obj = json.loads(text)
        if isinstance(obj, dict) and "thought" in obj:
            return obj
    except (json.JSONDecodeError, ValueError):
        pass

    # Attempt 2 — extract innermost {...} that contains "thought"
    match = re.search(r'\{[^{}]*"thought"[^{}]*\}', text, re.DOTALL)
    if match:
        try:
            obj = json.loads(match.group())
            if isinstance(obj, dict) and "thought" in obj:
                return obj
        except (json.JSONDecodeError, ValueError):
            pass

    # Attempt 3 — regex-scrape individual fields
    thought_m = re.search(r'"thought"\s*:\s*"((?:[^"\\]|\\.)*)"', text)
    if thought_m:
        next_needed = not bool(re.search(r'"nextThoughtNeeded"\s*:\s*false', text, re.IGNORECASE))
        return {
            "thought": thought_m.group(1),
            "nextThoughtNeeded": next_needed,
            "thoughtNumber": 1,
            "totalThoughts": 3,
        }

    # Attempt 4 — treat the whole response as a plain-text thought
    if text and len(text) > 10:
        return {
            "thought": text[:3000],
            "nextThoughtNeeded": False,
            "thoughtNumber": 1,
            "totalThoughts": 1,
        }
    return None


class BaseLLMProvider(ABC):
    """
    Interface every LLM provider (Anthropic, Ollama, …) must implement.

    The two core methods map to the two request types the extension makes:
      - plan_task   — chat assistant: interpret user message, return cell ops
      - complete    — inline completion: suggest code at cursor position

    After each plan_task / stream_plan_task / chat / stream_chat call the
    provider should populate ``last_usage`` so callers can forward token
    counts to the frontend.  Providers that cannot report usage leave it as
    the zero dict.
    """

    def __init__(self) -> None:
        # { "input": int, "output": int } — updated after every LLM call
        self.last_usage: Dict[str, int] = {"input": 0, "output": 0}

    def _set_usage(self, input_tokens: int, output_tokens: int) -> None:
        """Helper: record token usage after an API call."""
        self.last_usage = {"input": int(input_tokens), "output": int(output_tokens)}

    @abstractmethod
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
        """
        Analyse the user request and return an operation plan.

        Returns a dict matching the TaskResponse schema:
          {operationId, steps, requiresApproval, clarificationNeeded, summary}
        """

    @abstractmethod
    async def complete(
        self,
        prefix: str,
        suffix: str,
        language: str,
        previous_cells: List[Dict[str, Any]],
    ) -> Dict[str, Any]:
        """
        Return a code completion.

        Returns a dict matching the CompletionResult schema:
          {suggestion, type, lines, cached}
        """

    @abstractmethod
    async def health_check(self) -> bool:
        """Return True if the provider is reachable and ready."""

    @abstractmethod
    async def chat(
        self,
        system: str,
        user: Any,  # str or List[content blocks] for vision-capable providers
        chat_history: Optional[List[Dict[str, str]]] = None,
    ) -> str:
        """Free-form chat: send a system + user message and return raw text.

        Unlike plan_task (which enforces a JSON schema for cell operations),
        this method returns unstructured text — used for report generation
        and other open-ended tasks.

        ``user`` may be a plain string or a list of Anthropic content blocks
        (text + image blocks) for providers that support vision inputs.
        """

    async def stream_chat(
        self,
        system: str,
        user: Any,  # str or List[content blocks] for vision-capable providers
        on_chunk: Callable[[str], Awaitable[None]],
        on_thought: Optional[Callable[[str], Awaitable[None]]] = None,
        chat_history: Optional[List[Dict[str, str]]] = None,
    ) -> None:
        """Stream a chat response, calling on_chunk for each text token.

        ``user`` may be a plain string or a list of Anthropic content blocks
        (text + image blocks) — see ClaudeClient._build_content_blocks_from_text().

        Default implementation buffers the full response via chat() and calls
        on_chunk once. Override in subclasses that support native streaming.
        """
        text = await self.chat(system=system, user=user, chat_history=chat_history)
        if text:
            await on_chunk(text)

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
        """Like plan_task but streams pre-tool text AND tool-call JSON deltas.

        - on_text_chunk: called with each text token Claude emits before the tool call.
        - on_json_delta: called with each raw partial-JSON string as Claude writes the
          tool-call arguments (the cell operation plan JSON).  Providers that do not
          support tool-call streaming can leave this as None.

        Default implementation: call plan_task normally (no streaming).
        Override in subclasses that support native streaming tool-use.
        """
        return await self.plan_task(
            user_message=user_message,
            notebook_context=notebook_context,
            skills=skills,
            memory=memory,
            operation_id=operation_id,
            chat_history=chat_history,
            reasoning_mode=reasoning_mode,
        )

    def has_vision(self) -> bool:
        """Return True if this provider/model can process image inputs.

        Override in subclasses that support vision.  Default is False so
        that new providers are conservative by default.
        """
        return False

    def has_sequential_thinking(self) -> bool:
        """Return True — all providers support sequential thinking.

        The base class provides a generic multi-turn chat()-based loop.
        Subclasses (Anthropic, OpenAI) override with native tool-calling.
        """
        return True

    async def run_sequential_thinking_loop(
        self,
        user: str,
        system: str,
        on_thought: Callable[[str], Awaitable[None]],
        chat_history: Optional[List[Dict[str, str]]] = None,
    ) -> List[Dict[str, Any]]:
        """Generic sequential thinking loop using multi-turn chat().

        Works for every provider that implements chat().  Anthropic and
        OpenAI override this with native tool-calling for better reliability.

        Injects _SEQUENTIAL_THINKING_SYSTEM_SUFFIX into the system prompt,
        then loops until the model sets nextThoughtNeeded=false or MAX_THOUGHTS
        is reached.  Each turn's response is parsed with _extract_json_thought().
        """
        from ..builtin_tools.mcp_sequential_thinking import MAX_THOUGHTS

        thinking_system = system + _SEQUENTIAL_THINKING_SYSTEM_SUFFIX
        thoughts: List[Dict[str, Any]] = []
        total_input = 0
        total_output = 0

        history: List[Dict[str, str]] = list(chat_history or [])
        current_user = user

        for step in range(MAX_THOUGHTS):
            response = await self.chat(
                system=thinking_system,
                user=current_user,
                chat_history=history,
            )
            total_input  += self.last_usage.get("input",  0)
            total_output += self.last_usage.get("output", 0)

            if not response:
                break

            thought_data = _extract_json_thought(response)
            if not thought_data:
                break

            thought_data.setdefault("thoughtNumber",  step + 1)
            thought_data.setdefault("totalThoughts",  MAX_THOUGHTS)
            thoughts.append(thought_data)

            thought_text = thought_data.get("thought", "")
            if thought_text:
                await on_thought(thought_text)
                await asyncio.sleep(0)

            if not thought_data.get("nextThoughtNeeded", False):
                break

            history.append({"role": "user",      "content": current_user})
            history.append({"role": "assistant",  "content": response})
            current_user = "Continue your reasoning."

        self._set_usage(total_input, total_output)
        return thoughts

    def build_system_prompt(
        self,
        skills: "List[Dict[str, str]]",
        memory: str,
        reasoning_mode: str = "off",
    ) -> str:
        """Return the system prompt used for cell-op planning.

        Default raises NotImplementedError so callers can detect absence.
        Override in providers that expose their internal prompt builder.
        """
        raise NotImplementedError(
            f"{type(self).__name__} does not implement build_system_prompt()"
        )


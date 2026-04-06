"""OpenAI provider — GPT-4o, GPT-4o-mini, o1, etc."""
import asyncio
import json
import logging
import re
import uuid
from typing import Any, Callable, Awaitable, Dict, List, Optional

from .base import BaseLLMProvider
from .client import _build_system_prompt_shared
from .context_utils import build_notebook_context, CELL_CONTENT_LIMIT  # noqa: F401 – re-exported
from ..completion.cache import CompletionCache
from ..completion.engine import _build_context_block, _extract_imports

# Backward-compat alias: bedrock_provider and google_provider import this name.
_build_context = build_notebook_context

log = logging.getLogger(__name__)

# Shared tool schema for structured task planning (same shape as Anthropic)
_PLAN_TOOL = {
    "type": "function",
    "function": {
        "name": "create_operation_plan",
        "description": "Create a plan of notebook cell operations.",
        "parameters": {
            "type": "object",
            "properties": {
                "steps": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "type": {"type": "string", "enum": ["insert", "modify", "delete", "run_cell"]},
                            "cellIndex": {"type": "integer"},
                            "cellType": {"type": "string", "enum": ["code", "markdown"]},
                            "content": {"type": "string"},
                            "autoExecute": {"type": "boolean"},
                            "description": {"type": "string"},
                        },
                        "required": ["type", "cellIndex"],
                    },
                },
                "requiresApproval": {"type": "boolean"},
                "clarificationNeeded": {"type": "string"},
                "summary": {"type": "string"},
            },
            "required": ["steps", "requiresApproval", "summary"],
        },
    },
}


_INLINE_SYSTEM = (
    "Python code completion. Output ONLY the continuation text. "
    "No explanation, no markdown, no repeating existing code."
)

# OpenAI function-calling schema for the sequential thinking loop.
# Mirrors the Anthropic tool schema so the LLM sees the same interface.
_SEQUENTIAL_THINKING_TOOL = {
    "type": "function",
    "function": {
        "name": "sequential_thinking",
        "description": (
            "Think through the problem step by step. "
            "Call this tool repeatedly, setting nextThoughtNeeded=false only when reasoning is complete."
        ),
        "parameters": {
            "type": "object",
            "required": ["thought", "nextThoughtNeeded", "thoughtNumber", "totalThoughts"],
            "properties": {
                "thought":           {"type": "string",  "description": "Your current reasoning step"},
                "nextThoughtNeeded": {"type": "boolean", "description": "True if more thinking is needed"},
                "thoughtNumber":     {"type": "integer", "minimum": 1},
                "totalThoughts":     {"type": "integer", "minimum": 1},
                "isRevision":        {"type": "boolean"},
                "revisesThought":    {"type": "integer"},
                "branchFromThought": {"type": "integer"},
                "branchId":          {"type": "string"},
                "needsMoreThoughts": {"type": "boolean"},
            },
        },
    },
}



class OpenAIProvider(BaseLLMProvider):
    VENDOR = "openai"

    """Calls the OpenAI API (or any OpenAI-compatible endpoint)."""

    def __init__(
        self,
        api_key: str,
        chat_model: str = "gpt-4o",
        completion_model: str = "gpt-4o-mini",
        base_url: Optional[str] = None,
        api_version: Optional[str] = None,
    ) -> None:
        super().__init__()
        self.api_key = api_key
        self.chat_model = chat_model
        self.completion_model = completion_model
        self.base_url = base_url
        self.api_version = api_version
        self._cache = CompletionCache()
        self._aclient = self._make_async_client()

    def _make_async_client(self):
        try:
            from openai import AsyncOpenAI
        except ImportError:
            raise RuntimeError("openai package not installed. Run: pip install openai")
        kwargs: Dict[str, Any] = {"api_key": self.api_key}
        if self.base_url:
            kwargs["base_url"] = self.base_url
        return AsyncOpenAI(**kwargs)

    # ------------------------------------------------------------------
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
        op_id = operation_id or f"op_{uuid.uuid4().hex[:8]}"
        system = _build_system_prompt_shared(skills, memory, reasoning_mode=reasoning_mode)
        user_msg = _build_context(user_message, notebook_context)

        content: List[Any] = [{"type": "text", "text": user_msg}]
        if self.has_vision():
            for cell in notebook_context.get("cells", []):
                img = cell.get("imageOutput")
                if img:
                    idx = cell.get("index")
                    label = f"#{idx + 1}" if isinstance(idx, int) else "#?"
                    raw_mime = cell.get("imageOutputMime") or "image/png"
                    mime = raw_mime if raw_mime in ("image/png", "image/jpeg", "image/webp", "image/gif") else "image/png"
                    content.append({"type": "text", "text": f"[Plot from cell {label}:]"})
                    content.append({
                        "type": "image_url",
                        "image_url": {"url": f"data:{mime};base64,{img}"},
                    })

        messages = self._build_messages(content, chat_history)

        try:
            resp = await self._aclient.chat.completions.create(
                model=self.chat_model,
                messages=[{"role": "system", "content": system}] + messages,
                tools=[_PLAN_TOOL],
                tool_choice={"type": "function", "function": {"name": "create_operation_plan"}},
                max_tokens=4096,
            )
            if resp.usage:
                self._set_usage(resp.usage.prompt_tokens, resp.usage.completion_tokens)
            for choice in resp.choices:
                for tc in (choice.message.tool_calls or []):
                    if tc.function.name == "create_operation_plan":
                        data = json.loads(tc.function.arguments)
                        data.setdefault("operationId", op_id)
                        data.setdefault("clarificationNeeded", None)
                        return data
            raise RuntimeError("No tool call returned by OpenAI")
        except Exception as e:
            log.error("OpenAI plan_task error: %s", e)
            raise RuntimeError(f"OpenAI error: {e}") from e

    async def complete(
        self,
        prefix: str,
        suffix: str,
        language: str,
        previous_cells: List[Dict[str, Any]],
    ) -> Dict[str, Any]:
        imports = _extract_imports(previous_cells)
        cache_key = CompletionCache.make_key(prefix, language, "openai-completion", imports)
        cached = self._cache.get(cache_key)
        if cached:
            return {"suggestion": cached, "type": "completion", "lines": cached.splitlines(), "cached": True}

        context = _build_context_block(previous_cells)
        prompt = f"{context}\n\n{prefix}" if context else prefix

        try:
            resp = await self._aclient.chat.completions.create(
                model=self.completion_model,
                messages=[
                    {"role": "system", "content": _INLINE_SYSTEM},
                    {"role": "user", "content": f"Complete:\n{prompt}"},
                ],
                max_tokens=256,
                temperature=0.1,
            )
            raw = resp.choices[0].message.content or ""
            suggestion = re.sub(r"^```[a-z]*\n?", "", raw.strip(), flags=re.MULTILINE)
            suggestion = re.sub(r"\n?```$", "", suggestion, flags=re.MULTILINE).strip()
            if suggestion:
                self._cache.set(cache_key, suggestion)
            return {"suggestion": suggestion, "type": "completion", "lines": suggestion.splitlines(), "cached": False}
        except Exception as e:
            log.warning("OpenAI complete error: %s", e)
            return {"suggestion": "", "type": "completion", "lines": [], "cached": False}

    async def chat(
        self,
        system: str,
        user: str,
        chat_history: Optional[List[Dict[str, str]]] = None,
        temperature: Optional[float] = None,
    ) -> str:
        messages = self._build_messages(user, chat_history)
        resp = await self._aclient.chat.completions.create(
            model=self.chat_model,
            messages=[{"role": "system", "content": system}] + messages,
            max_tokens=8192,
            temperature=temperature if temperature is not None else 0.3,
        )
        if resp.usage:
            self._set_usage(resp.usage.prompt_tokens, resp.usage.completion_tokens)
        return resp.choices[0].message.content or ""

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
        """Stream plan_task with tool-call JSON deltas via on_json_delta."""
        op_id = operation_id or f"op_{uuid.uuid4().hex[:8]}"
        system = _build_system_prompt_shared(skills, memory, reasoning_mode=reasoning_mode)

        content: List[Any] = [{"type": "text", "text": _build_context(user_message, notebook_context)}]
        if self.has_vision():
            for cell in notebook_context.get("cells", []):
                img = cell.get("imageOutput")
                if img:
                    idx = cell.get("index")
                    label = f"#{idx + 1}" if isinstance(idx, int) else "#?"
                    raw_mime = cell.get("imageOutputMime") or "image/png"
                    mime = raw_mime if raw_mime in ("image/png", "image/jpeg", "image/webp", "image/gif") else "image/png"
                    content.append({"type": "text", "text": f"[Plot from cell {label}:]"})
                    content.append({"type": "image_url", "image_url": {"url": f"data:{mime};base64,{img}"}})

        messages = self._build_messages(content, chat_history)
        accumulated_args = ""

        try:
            async with self._aclient.chat.completions.stream(
                model=self.chat_model,
                messages=[{"role": "system", "content": system}] + messages,
                tools=[_PLAN_TOOL],
                tool_choice={"type": "function", "function": {"name": "create_operation_plan"}},
                max_tokens=4096,
            ) as stream:
                async for chunk in stream:
                    if not chunk.choices:
                        continue
                    delta = chunk.choices[0].delta
                    # Pre-tool text (if model emits any)
                    if delta.content:
                        await on_text_chunk(delta.content)
                        await asyncio.sleep(0)
                    # Tool-call JSON delta
                    if delta.tool_calls:
                        for tc in delta.tool_calls:
                            if tc.function and tc.function.arguments:
                                partial = tc.function.arguments
                                accumulated_args += partial
                                if on_json_delta:
                                    await on_json_delta(partial)
                                    await asyncio.sleep(0)

                # get_final_completion must be called inside the async with block
                final_comp = await stream.get_final_completion()
                if final_comp.usage:
                    self._set_usage(
                        final_comp.usage.prompt_tokens,
                        final_comp.usage.completion_tokens,
                    )
            data = json.loads(accumulated_args) if accumulated_args else {}
            data.setdefault("operationId", op_id)
            data.setdefault("clarificationNeeded", None)
            return data
        except Exception as e:
            log.error("OpenAI stream_plan_task error: %s", e)
            raise RuntimeError(f"OpenAI streaming error: {e}") from e

    async def stream_chat(
        self,
        system: str,
        user: str,
        on_chunk: Callable[[str], Awaitable[None]],
        on_thought: Optional[Callable[[str], Awaitable[None]]] = None,
        chat_history: Optional[List[Dict[str, str]]] = None,
    ) -> None:
        _MAX_CONTINUATIONS = 2
        messages = self._build_messages(user, chat_history)

        for _turn in range(_MAX_CONTINUATIONS + 1):
            _turn_text: list[str] = []

            async with self._aclient.chat.completions.stream(
                model=self.chat_model,
                messages=[{"role": "system", "content": system}] + messages,
                max_tokens=8192,
                temperature=0.3,
            ) as stream:
                async for event in stream:
                    if event.choices and event.choices[0].delta.content:
                        chunk = event.choices[0].delta.content
                        await on_chunk(chunk)
                        _turn_text.append(chunk)
                final_chat_comp = await stream.get_final_completion()
                if final_chat_comp.usage:
                    self._set_usage(
                        final_chat_comp.usage.prompt_tokens,
                        final_chat_comp.usage.completion_tokens,
                    )

            # OpenAI signals truncation via finish_reason == "length"
            finish_reason = (
                final_chat_comp.choices[0].finish_reason
                if final_chat_comp.choices
                else None
            )
            if finish_reason != "length" or _turn >= _MAX_CONTINUATIONS:
                break

            partial = "".join(_turn_text)
            messages = list(messages) + [
                {"role": "assistant", "content": partial},
                {"role": "user",      "content": "Continue."},
            ]

    def _build_messages(
        self,
        user: str,
        chat_history: Optional[List[Dict[str, str]]] = None,
    ) -> List[Dict[str, Any]]:
        """Build a messages list with history prepended (drops leading assistant turns)."""
        history = list(chat_history or [])
        while history and history[0].get("role") != "user":
            history = history[1:]
        messages: List[Dict[str, Any]] = [{"role": h["role"], "content": h["content"]} for h in history]
        messages.append({"role": "user", "content": user})
        return messages

    async def run_sequential_thinking_loop(
        self,
        user: str,
        system: str,
        on_thought: Callable[[str], Awaitable[None]],
        chat_history: Optional[List[Dict[str, str]]] = None,
    ) -> List[Dict[str, Any]]:
        """Sequential thinking via OpenAI function calling.

        Uses the sequential_thinking tool schema so the model outputs
        structured thoughts rather than raw JSON text.
        """
        from ..builtin_tools.mcp_sequential_thinking import MAX_THOUGHTS

        messages = self._build_messages(user, chat_history)
        full_messages: List[Dict[str, Any]] = [{"role": "system", "content": system}] + messages
        thoughts: List[Dict[str, Any]] = []
        total_input = 0
        total_output = 0

        for _guard in range(MAX_THOUGHTS):
            resp = await self._aclient.chat.completions.create(
                model=self.chat_model,
                messages=full_messages,
                tools=[_SEQUENTIAL_THINKING_TOOL],
                tool_choice={"type": "function", "function": {"name": "sequential_thinking"}},
                max_tokens=2048,
            )
            if resp.usage:
                total_input  += resp.usage.prompt_tokens
                total_output += resp.usage.completion_tokens

            msg = resp.choices[0].message
            # Append assistant turn (dict form avoids SDK object serialisation issues)
            full_messages.append({
                "role": "assistant",
                "content": msg.content,
                "tool_calls": [
                    {
                        "id": tc.id,
                        "type": "function",
                        "function": {"name": tc.function.name, "arguments": tc.function.arguments},
                    }
                    for tc in (msg.tool_calls or [])
                ] or None,
            })

            made_tool_call = False
            done = False
            for tc in (msg.tool_calls or []):
                if tc.function.name == "sequential_thinking":
                    made_tool_call = True
                    try:
                        thought_data: Dict[str, Any] = json.loads(tc.function.arguments)
                    except (json.JSONDecodeError, ValueError):
                        break

                    thoughts.append(thought_data)

                    thought_text = thought_data.get("thought", "")
                    if thought_text:
                        await on_thought(thought_text)
                        await asyncio.sleep(0)

                    # Acknowledge so the conversation can continue
                    full_messages.append({
                        "role":         "tool",
                        "tool_call_id": tc.id,
                        "content":      "Thought recorded. Continue if nextThoughtNeeded is true.",
                    })

                    if not thought_data.get("nextThoughtNeeded", True):
                        done = True
                    break  # one tool call per turn

            if not made_tool_call or done:
                break

        self._set_usage(total_input, total_output)
        return thoughts

    async def health_check(self) -> bool:
        try:
            await self._aclient.models.list()
            return True
        except Exception:
            return False

    def has_vision(self) -> bool:
        name = self.chat_model.lower()
        # o1/o1-mini/o1-preview are text-only; do not include "o1" here
        return "gpt-4o" in name or "gpt-4-vision" in name

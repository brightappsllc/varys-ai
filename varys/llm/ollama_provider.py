"""Ollama provider — local model inference via the Ollama HTTP API.

Uses Tornado's AsyncHTTPClient (already a dependency via jupyter-server) for
all HTTP calls, eliminating the httpx dependency entirely.
"""
import asyncio
import json
import logging
import os
import re
import uuid
from typing import Any, Callable, Awaitable, Dict, List, Optional

log = logging.getLogger(__name__)

from .base import BaseLLMProvider
from .context_utils import build_notebook_context
from ..completion.cache import CompletionCache
from ..completion.engine import _build_context_block, _extract_imports
from ..utils.config import get_config as _get_cfg

# ---------------------------------------------------------------------------
# Timeouts and keep_alive — overridable via .jupyter-assistant/config/llm.cfg
# [ollama] timeout_chat / timeout_completion / keep_alive
# ---------------------------------------------------------------------------

def _timeout(key: str, default: int) -> int:
    return _get_cfg().getint("ollama", key, default)

def _keep_alive() -> str:
    return _get_cfg().get("ollama", "keep_alive", "30m")

TIMEOUT_CHAT       = _timeout("timeout_chat",       120)
TIMEOUT_COMPLETION = _timeout("timeout_completion",  30)

# ---------------------------------------------------------------------------
# System prompts
# ---------------------------------------------------------------------------

_TASK_SYSTEM = """You are an expert data science assistant integrated into JupyterLab.
Your job is to help users build and enhance their Jupyter notebooks.

## Cell Outputs
Each executed code cell may have an OUTPUT: section showing its result (table, numbers, error).
When the user says "look at the output of #N" or "using the result of #N",
find cell #N in the context and read its OUTPUT: section.


## Cell Numbering — one format only

Every cell in the notebook context is labelled **#N** where N counts from 1 at the top.

  #1  = first cell    → cellIndex 0
  #2  = second cell   → cellIndex 1
  #16 = sixteenth cell → cellIndex 15

**Rule: cellIndex = N − 1** (always, no exceptions).

The user will always refer to cells as `#N` (e.g. "#16", "cell #16", "cell 16").
Never look for an execution-count match — just apply N − 1 directly.

## Operation Types
- "insert"  : add new cell at cellIndex (shifts existing down)
- "modify"  : replace content of cell at cellIndex
- "delete"  : remove cell at cellIndex
- "run_cell": execute existing cell at cellIndex without changing it

## Positioning Rules
- cellIndex 0 = beginning of notebook
- For "after cursor" → active cell index + 1
- For "at beginning" → index 0
- After insert, later indices in the SAME plan must account for the +1 shift

## Auto-Execute Rules
Refer to the safe_operations skill (injected in the system prompt) for the
complete list of which operations are safe to auto-execute and which require
user approval.  The skill is the single source of truth for these rules.

## Selected Text
If a "SELECTED TEXT" block is present, operate on ONLY that text.
Replace just those lines in the cell; preserve everything else unchanged.

## Skills Context
{skills_section}

## Memory / Preferences
{memory_section}

## Response Format — STRICT JSON
You MUST respond with ONLY valid JSON. No explanation. No markdown fences.
Use this exact structure:
{{
  "steps": [
    {{
      "type": "insert",
      "cellIndex": 0,
      "cellType": "markdown",
      "content": "# Header",
      "autoExecute": false,
      "description": "Creating header cell"
    }}
  ],
  "requiresApproval": false,
  "clarificationNeeded": null,
  "summary": "Created header cell"
}}
"""

class OllamaProvider(BaseLLMProvider):
    VENDOR = "ollama"

    """
    Calls a local Ollama server for all LLM operations.

    Uses:
      POST /api/chat  (with format:"json")  — task planning
      POST /api/generate                    — inline/multiline completion
    """

    def __init__(
        self,
        base_url: str = "http://localhost:11434",
        chat_model: str = "qwen2.5-coder:7b-instruct",
        completion_model: str = "qwen2.5-coder:7b-instruct",
    ) -> None:
        super().__init__()
        self.base_url = base_url.rstrip("/")
        self.chat_model = chat_model
        self.completion_model = completion_model
        self._cache = CompletionCache()

    # ------------------------------------------------------------------
    # HTTP helpers (Tornado AsyncHTTPClient — no httpx dependency)
    # ------------------------------------------------------------------

    async def _post(self, path: str, payload: dict, timeout: int) -> dict:
        """POST JSON to the Ollama server and return the parsed response dict."""
        from tornado.httpclient import AsyncHTTPClient, HTTPRequest
        client = AsyncHTTPClient()
        body = json.dumps(payload).encode()
        req = HTTPRequest(
            f"{self.base_url}{path}",
            method="POST",
            body=body,
            headers={"Content-Type": "application/json"},
            request_timeout=timeout,
            connect_timeout=10,
        )
        resp = await client.fetch(req)
        return json.loads(resp.body)

    async def _get(self, path: str, timeout: int = 10) -> dict:
        """GET from the Ollama server and return the parsed response dict."""
        from tornado.httpclient import AsyncHTTPClient, HTTPRequest
        client = AsyncHTTPClient()
        req = HTTPRequest(
            f"{self.base_url}{path}",
            method="GET",
            request_timeout=timeout,
            connect_timeout=5,
        )
        resp = await client.fetch(req)
        return json.loads(resp.body)

    # ------------------------------------------------------------------
    # BaseLLMProvider interface
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
        system_prompt = self._build_system_prompt(skills, memory)
        user_msg = self._build_user_message(user_message, notebook_context)

        history = list(chat_history or [])
        while history and history[0].get("role") != "user":
            history = history[1:]
        messages = [{"role": "system", "content": system_prompt}]
        messages += [{"role": h["role"], "content": h["content"]} for h in history]
        messages.append({"role": "user", "content": user_msg})

        payload = {
            "model": self.chat_model,
            "messages": messages,
            "stream": False,
            "format": "json",
            "keep_alive": _keep_alive(),   # keep model in GPU memory between requests
            "options": {"temperature": 0.2, "num_predict": 2048},
        }

        try:
            raw_plan = await self._post("/api/chat", payload, TIMEOUT_CHAT)
            content = raw_plan.get("message", {}).get("content", "")
            self._set_usage(
                raw_plan.get("prompt_eval_count", 0),
                raw_plan.get("eval_count", 0),
            )
            return self._parse_plan(content, op_id)

        except ConnectionRefusedError:
            raise RuntimeError(
                "Cannot reach Ollama server. "
                f"Is 'ollama serve' running at {self.base_url}?"
            )
        except TimeoutError:
            raise RuntimeError(
                f"Ollama request timed out after {TIMEOUT_CHAT}s. "
                "Try a smaller model or increase DS_OLLAMA_TIMEOUT."
            )
        except Exception as e:
            raise RuntimeError(f"Ollama error: {e}") from e

    async def complete(
        self,
        prefix: str,
        suffix: str,
        language: str,
        previous_cells: List[Dict[str, Any]],
    ) -> Dict[str, Any]:
        imports_snapshot = _extract_imports(previous_cells)
        cache_key = CompletionCache.make_key(
            prefix, language, "ollama-completion", imports_snapshot
        )
        cached = self._cache.get(cache_key)
        if cached is not None:
            log.debug("Ollama complete — cache HIT  prefix=%r  suggestion=%r", prefix[-40:], cached)
            return {"suggestion": cached, "type": "completion",
                    "lines": cached.splitlines(), "cached": True}

        context_block = _build_context_block(previous_cells)
        model = self.completion_model
        num_predict = int(os.environ.get("COMPLETION_MAX_TOKENS") or 128)
        timeout = TIMEOUT_COMPLETION
        stop_tokens = ["```", "\n\n\n"]

        log.info("Ollama complete → model=%s  url=%s  prefix=%r", model, self.base_url, prefix[-60:])

        # Raw continuation mode: prompt ends with the prefix, model continues
        # naturally. Works better than chat/instruct format for code completion.
        raw_prompt = f"{context_block}\n\n{prefix}" if context_block else prefix

        payload = {
            "model": model,
            "prompt": raw_prompt,
            "stream": False,
            "raw": True,          # bypass chat template — pure text continuation
            "keep_alive": _keep_alive(),
            "options": {
                "temperature": 0.1,
                "num_predict": num_predict,
                "stop": stop_tokens,
            },
        }

        suggestion = ""
        try:
            raw = await self._post("/api/generate", payload, timeout)
            suggestion = raw.get("response", "").strip()
            log.info(
                "Ollama complete ← model=%s  suggestion=%r  "
                "eval_count=%s  eval_duration_ms=%s",
                raw.get("model", model),
                suggestion,
                raw.get("eval_count", "?"),
                round(raw.get("eval_duration", 0) / 1e6),
            )
        except TimeoutError:
            log.warning("Ollama complete TIMEOUT after %ss  model=%s", timeout, model)
        except Exception as exc:
            log.warning("Ollama complete ERROR: %s", exc)

        suggestion = self._clean(suggestion)

        if suggestion:
            self._cache.set(cache_key, suggestion)

        return {
            "suggestion": suggestion,
            "type": "completion",
            "lines": suggestion.splitlines(),
            "cached": False,
        }

    def _build_ollama_messages(
        self,
        system: str,
        user: str,
        chat_history: Optional[List[Dict[str, str]]] = None,
    ) -> List[Dict[str, str]]:
        history = list(chat_history or [])
        while history and history[0].get("role") != "user":
            history = history[1:]
        messages = [{"role": "system", "content": system}]
        messages += [{"role": h["role"], "content": h["content"]} for h in history]
        messages.append({"role": "user", "content": user})
        return messages

    async def chat(
        self,
        system: str,
        user: str,
        chat_history: Optional[List[Dict[str, str]]] = None,
        temperature: Optional[float] = None,
    ) -> str:
        payload = {
            "model": self.chat_model,
            "messages": self._build_ollama_messages(system, user, chat_history),
            "stream": False,
            "keep_alive": _keep_alive(),
            "options": {"temperature": 0.3, "num_predict": 8192},
        }
        raw_chat = await self._post("/api/chat", payload, TIMEOUT_CHAT)
        self._set_usage(
            raw_chat.get("prompt_eval_count", 0),
            raw_chat.get("eval_count", 0),
        )
        return raw_chat.get("message", {}).get("content", "")

    async def stream_chat(
        self,
        system: str,
        user: str,
        on_chunk: Callable[[str], Awaitable[None]],
        on_thought: Optional[Callable[[str], Awaitable[None]]] = None,
        chat_history: Optional[List[Dict[str, str]]] = None,
    ) -> None:
        """Stream a chat response token by token via Tornado AsyncHTTPClient."""
        from tornado.httpclient import AsyncHTTPClient, HTTPRequest

        payload = {
            "model": self.chat_model,
            "messages": self._build_ollama_messages(system, user, chat_history),
            "stream": True,
            "keep_alive": _keep_alive(),
            "options": {"temperature": 0.3, "num_predict": 8192},
        }

        loop = asyncio.get_event_loop()
        line_queue: asyncio.Queue = asyncio.Queue()
        _buf = bytearray()

        def _streaming_callback(chunk: bytes) -> None:
            _buf.extend(chunk)
            while b"\n" in _buf:
                idx = _buf.index(b"\n")
                raw_line = bytes(_buf[:idx]).decode("utf-8", errors="replace")
                del _buf[:idx + 1]
                loop.call_soon_threadsafe(line_queue.put_nowait, raw_line)

        client = AsyncHTTPClient()
        req = HTTPRequest(
            f"{self.base_url}/api/chat",
            method="POST",
            body=json.dumps(payload).encode(),
            headers={"Content-Type": "application/json"},
            request_timeout=TIMEOUT_CHAT,
            streaming_callback=_streaming_callback,
        )

        async def _fetch() -> None:
            try:
                await client.fetch(req, raise_error=False)
            finally:
                loop.call_soon_threadsafe(line_queue.put_nowait, None)  # sentinel

        fetch_task = asyncio.create_task(_fetch())
        try:
            while True:
                line = await line_queue.get()
                if line is None:
                    break
                if not line.strip():
                    continue
                try:
                    data = json.loads(line)
                    chunk = data.get("message", {}).get("content", "")
                    if chunk:
                        await on_chunk(chunk)
                    if data.get("done"):
                        self._set_usage(
                            data.get("prompt_eval_count", 0),
                            data.get("eval_count", 0),
                        )
                        break
                except json.JSONDecodeError:
                    continue
        finally:
            await fetch_task

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
        import asyncio
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
            words = summary.split(" ")
            for i, word in enumerate(words):
                # Leading-space encoding: safe from _strip_null's .rstrip()
                chunk = word if i == 0 else f" {word}"
                if chunk:
                    await on_text_chunk(chunk)
                    await asyncio.sleep(0)
        return plan

    async def health_check(self) -> bool:
        try:
            await self._get("/api/tags", timeout=5)
            return True
        except Exception:
            return False

    def has_vision(self) -> bool:
        """Return True if the configured chat model supports image inputs.

        Known vision-capable Ollama model families (as of 2026):
          llava, bakllava, llama3.2-vision, minicpm-v, moondream,
          phi3-vision, qwen2-vl, cogvlm
        """
        _VISION_KEYWORDS = (
            "llava", "bakllava", "vision", "minicpm-v",
            "moondream", "cogvlm", "qwen2-vl",
        )
        name = self.chat_model.lower()
        return any(kw in name for kw in _VISION_KEYWORDS)

    # ------------------------------------------------------------------
    # Helpers — shared with AnthropicProvider prompt logic
    # ------------------------------------------------------------------

    def _build_system_prompt(
        self, skills: List[Dict[str, str]], memory: str
    ) -> str:
        """Build Ollama-specific system prompt using strict-JSON instructions."""
        domain_skills = [s for s in skills if s.get("name", "").lower() != "varys"]
        skills_section = ""
        for skill in domain_skills:
            skills_section += f"\n### {skill['name']}\n{skill['content']}\n"
        if not skills_section:
            skills_section = "No specific skills loaded."
        memory_section = memory.strip() or "No memory/preferences recorded yet."
        return _TASK_SYSTEM.format(
            skills_section=skills_section,
            memory_section=memory_section,
        )

    def _build_user_message(
        self, user_message: str, notebook_context: Dict[str, Any]
    ) -> str:
        return build_notebook_context(user_message, notebook_context)

    def _parse_plan(self, content: str, op_id: str) -> Dict[str, Any]:
        """Parse the JSON operation plan from the model response."""
        # Ollama with format:"json" should give clean JSON,
        # but apply repair just in case
        for candidate in [content, self._repair_json(content)]:
            try:
                data = json.loads(candidate)
                data.setdefault("operationId", op_id)
                data.setdefault("steps", [])
                data.setdefault("requiresApproval", False)
                data.setdefault("clarificationNeeded", None)
                data.setdefault("summary", "")
                return data
            except json.JSONDecodeError:
                continue

        return {
            "operationId": op_id,
            "steps": [],
            "requiresApproval": False,
            "clarificationNeeded": "Could not parse the model response. Try again.",
            "summary": "Parse error",
        }

    @staticmethod
    def _repair_json(text: str) -> str:
        """Escape bare control characters inside JSON string values."""
        result, in_string, escape_next = [], False, False
        for ch in text:
            if escape_next:
                result.append(ch); escape_next = False
            elif ch == "\\": result.append(ch); escape_next = True
            elif ch == '"': result.append(ch); in_string = not in_string
            elif in_string and ch == "\n": result.append("\\n")
            elif in_string and ch == "\r": result.append("\\r")
            elif in_string and ch == "\t": result.append("\\t")
            else: result.append(ch)
        return "".join(result)

    @staticmethod
    def _clean(text: str) -> str:
        text = re.sub(r"^```[a-z]*\n?", "", text, flags=re.MULTILINE)
        text = re.sub(r"\n?```$", "", text, flags=re.MULTILINE)
        text = text.strip()
        # Discard prose responses from general models (e.g. "Here is how to...")
        # A valid code completion should not start with a capital letter followed
        # by a space and more lowercase words (typical sentence pattern).
        if re.match(r'^[A-Z][a-z]+ [a-z]', text):
            return ""
        return text


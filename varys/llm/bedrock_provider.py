"""AWS Bedrock provider — Claude, Llama, Mistral models via Bedrock Converse API."""
import asyncio
import base64
import configparser
import json
import logging
import re
import subprocess
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable, Awaitable, Dict, List, Optional

from .base import BaseLLMProvider
from .client import _build_system_prompt_shared
from .openai_provider import _build_context, _INLINE_SYSTEM
from ..completion.cache import CompletionCache
from ..completion.engine import _build_context_block, _extract_imports

log = logging.getLogger(__name__)

_TOOL_CONFIG = {
    "tools": [
        {
            "toolSpec": {
                "name": "create_operation_plan",
                "description": "Create a plan of notebook cell operations.",
                "inputSchema": {
                    "json": {
                        "type": "object",
                        "properties": {
                            "steps": {
                                "type": "array",
                                "items": {
                                    "type": "object",
                                    "properties": {
                                        "type": {"type": "string"},
                                        "cellIndex": {"type": "integer"},
                                        "cellType": {"type": "string"},
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
                    }
                },
            }
        }
    ],
    "toolChoice": {"tool": {"name": "create_operation_plan"}},
}



class BedrockProvider(BaseLLMProvider):
    VENDOR = "bedrock"

    """Calls AWS Bedrock via the Converse API (boto3)."""

    # Refresh this many minutes before the token actually expires to avoid
    # making a real API call with a token that expires mid-flight.
    _EXPIRY_BUFFER_MINUTES = 5

    def __init__(
        self,
        access_key_id: str,
        secret_access_key: str,
        region: str = "us-east-1",
        chat_model: str = "anthropic.claude-3-5-sonnet-20241022-v2:0",
        completion_model: str = "anthropic.claude-3-haiku-20240307-v1:0",
        session_token: str = "",
        aws_profile: str = "",
        aws_auth_refresh: str = "",
        enable_thinking: bool = False,
        thinking_budget: int = 8000,
        max_tokens: Optional[int] = None,
    ) -> None:
        super().__init__()
        self.access_key_id = access_key_id
        self.secret_access_key = secret_access_key
        self.session_token = session_token
        self.aws_profile = aws_profile
        self.aws_auth_refresh = aws_auth_refresh
        self.region = region
        self.chat_model = chat_model
        self.completion_model = completion_model
        self.enable_thinking = bool(enable_thinking)
        self.thinking_budget = max(1024, int(thinking_budget or 8000))
        # User-configured override; None means "use the model-aware default".
        self._max_tokens_override: Optional[int] = int(max_tokens) if max_tokens else None
        # Set by chat() when thinking is enabled; consumed by stream_chat().
        self._last_thinking: str = ""
        self._cache = CompletionCache()
        self._boto_client = self._make_client()

    def _make_client(self):
        try:
            import boto3
        except ImportError:
            raise RuntimeError("boto3 not installed. Run: pip install boto3")

        # Profile-based auth: use a named profile from ~/.aws/credentials.
        # Takes priority over explicit key/secret so the user only needs to
        # set AWS_PROFILE (or fill in the profile field in settings).
        if self.aws_profile:
            session = boto3.Session(
                profile_name=self.aws_profile,
                region_name=self.region,
            )
            return session.client("bedrock-runtime")

        # Explicit key auth (or fall through to boto3 default credential chain:
        # env vars → ~/.aws/credentials default profile → IAM role).
        kwargs: Dict[str, Any] = {
            "service_name": "bedrock-runtime",
            "region_name": self.region,
            "aws_access_key_id": self.access_key_id or None,
            "aws_secret_access_key": self.secret_access_key or None,
        }
        if self.session_token:
            kwargs["aws_session_token"] = self.session_token
        return boto3.client(**kwargs)

    def _credentials_expired(self) -> bool:
        """Return True if the profile's temporary credentials are expired (or missing).

        Reads ``~/.aws/credentials`` and checks the ``aws_expiration`` field
        written by tools like aws-azure-login.  If no expiration field is
        present the credentials are assumed to be long-lived (IAM user keys)
        and this method always returns False.
        """
        creds_path = Path.home() / ".aws" / "credentials"
        if not creds_path.exists():
            return True

        cfg = configparser.ConfigParser()
        cfg.read(creds_path)

        profile = self.aws_profile or "default"
        if profile not in cfg:
            return True

        # aws-azure-login writes 'aws_expiration'; some other tools write
        # 'aws_session_expiration' — check both.
        expiry_raw = (
            cfg[profile].get("aws_expiration")
            or cfg[profile].get("aws_session_expiration")
        )
        if not expiry_raw:
            return False  # static / IAM-role credentials — never expire here

        try:
            expiry_dt = datetime.fromisoformat(expiry_raw.strip().replace("Z", "+00:00"))
            cutoff = datetime.now(timezone.utc) + timedelta(minutes=self._EXPIRY_BUFFER_MINUTES)
            return cutoff >= expiry_dt
        except (ValueError, TypeError):
            return True  # unparseable → assume expired to be safe

    def _run_auth_refresh(self) -> None:
        """Run the auth-refresh command synchronously and rebuild the boto3 client."""
        log.info("Bedrock: credentials expired, running auth refresh: %s", self.aws_auth_refresh)
        try:
            subprocess.run(
                self.aws_auth_refresh,
                shell=True,
                check=True,
                timeout=120,
            )
        except subprocess.CalledProcessError as e:
            raise RuntimeError(f"AWS auth refresh command failed: {e}") from e
        except subprocess.TimeoutExpired as e:
            raise RuntimeError("AWS auth refresh command timed out after 120 s") from e
        # Rebuild the boto3 client so it picks up the freshly written credentials.
        self._boto_client = self._make_client()
        log.info("Bedrock: credentials refreshed successfully")

    async def _ensure_credentials(self) -> None:
        """Refresh credentials lazily — only when expired and a refresh command is set."""
        if self.aws_auth_refresh and self._credentials_expired():
            await asyncio.get_running_loop().run_in_executor(None, self._run_auth_refresh)

    @staticmethod
    def _is_expired_token(exc: Exception) -> bool:
        """Return True if exc is a botocore ExpiredTokenException."""
        try:
            from botocore.exceptions import ClientError
            return (
                isinstance(exc, ClientError)
                and exc.response.get("Error", {}).get("Code") == "ExpiredTokenException"
            )
        except ImportError:
            return False

    async def _call_with_auto_refresh(self, fn):
        """Run fn() in a thread executor, refreshing credentials once on ExpiredTokenException."""
        loop = asyncio.get_running_loop()
        try:
            return await loop.run_in_executor(None, fn)
        except Exception as e:
            if self.aws_auth_refresh and self._is_expired_token(e):
                log.warning("Bedrock: token expired during API call — refreshing credentials and retrying")
                await loop.run_in_executor(None, self._run_auth_refresh)
                return await loop.run_in_executor(None, fn)
            raise

    def _max_chat_tokens(self) -> int:
        """Return the effective max-output-token limit for the active chat model.

        Priority:
          1. User-configured BEDROCK_MAX_TOKENS (explicit override)
          2. Model-aware default:
             - Claude Haiku 4.5 on Bedrock (Converse API): 4 096 tokens
             - All other Claude models: 8 192 tokens
        """
        if self._max_tokens_override:
            return self._max_tokens_override
        name = self.chat_model.lower()
        if "haiku-4-5" in name or "haiku_4_5" in name:
            return 4096
        return 8192

    def _supports_thinking(self) -> bool:
        """True when the active chat model is an Anthropic Claude Sonnet or Opus model."""
        name = self.chat_model.lower()
        return (
            "claude-sonnet" in name
            or "claude-opus" in name
            or "claude-3-7" in name
        )

    def _converse_messages_to_anthropic(
        self, messages: List[Dict[str, Any]]
    ) -> List[Dict[str, Any]]:
        """Convert Converse-API message format to Anthropic Messages-API format."""
        result = []
        for msg in messages:
            content = msg.get("content", [])
            if isinstance(content, str):
                result.append({"role": msg["role"], "content": content})
                continue
            parts: List[Dict[str, Any]] = []
            for block in content:
                if "text" in block:
                    parts.append({"type": "text", "text": block["text"]})
                elif "image" in block:
                    img = block["image"]
                    src = img.get("source", {})
                    if "bytes" in src:
                        data = base64.b64encode(src["bytes"]).decode()
                        fmt = img.get("format", "png")
                        mime = f"image/{'jpeg' if fmt == 'jpeg' else fmt}"
                        parts.append({
                            "type": "image",
                            "source": {"type": "base64", "media_type": mime, "data": data},
                        })
            result.append({"role": msg["role"], "content": parts})
        return result

    def _invoke_model_raw(
        self,
        system: str,
        messages: List[Dict[str, Any]],
        tools: Optional[List[Dict[str, Any]]] = None,
    ) -> Dict[str, Any]:
        """Call invoke_model using the Anthropic Messages API with thinking enabled.

        This is the low-level primitive used by both _invoke_with_thinking() and
        _run_thinking_mcp_loop().  Messages must already be in Anthropic format
        (not Bedrock Converse format).

        Returns the raw decoded JSON response dict from Bedrock.
        """
        max_tokens = self.thinking_budget + 8192
        body: Dict[str, Any] = {
            "anthropic_version": "bedrock-2023-05-31",
            "max_tokens": max_tokens,
            "thinking": {"type": "enabled", "budget_tokens": self.thinking_budget},
            "system": system,
            "messages": messages,
        }
        if tools:
            body["tools"] = tools
            body["tool_choice"] = {"type": "auto"}

        resp = self._boto_client.invoke_model(
            modelId=self.chat_model,
            body=json.dumps(body),
            contentType="application/json",
            accept="application/json",
        )
        result = json.loads(resp["body"].read())
        usage = result.get("usage", {})
        self._set_usage(usage.get("input_tokens", 0), usage.get("output_tokens", 0))
        return result

    def _invoke_with_thinking(
        self, system: str, messages: List[Dict[str, Any]]
    ) -> tuple:
        """Call invoke_model with thinking enabled (no tools).

        Returns (thinking_text, response_text).
        """
        anthropic_messages = self._converse_messages_to_anthropic(messages)
        result = self._invoke_model_raw(system, anthropic_messages)

        content_blocks = result.get("content", [])
        block_types = [b.get("type", "?") for b in content_blocks]
        log.info("Bedrock invoke_model response block types: %s", block_types)

        thinking_parts: List[str] = []
        text_parts: List[str] = []
        for block in content_blocks:
            btype = block.get("type", "")
            if btype == "thinking":
                t = block.get("thinking", "")
                log.info("Bedrock thinking block len=%d", len(t))
                thinking_parts.append(t)
            elif btype == "text":
                text_parts.append(block.get("text", ""))

        return "\n".join(thinking_parts), "\n".join(text_parts)

    async def _run_thinking_mcp_loop(
        self,
        system: str,
        messages: List[Dict[str, Any]],
        mcp_tools: List[Dict[str, Any]],
        mcp_manager,
        on_chunk,
        on_thought=None,
        max_rounds: int = 8,
    ) -> str:
        """invoke_model multi-turn loop: thinking + MCP tool use.

        Uses the Anthropic Messages API (via invoke_model) which supports both
        extended thinking and tool use in the same request — unlike the Converse
        API which supports tools but not the thinking parameter.

        Thinking blocks are preserved across turns (with their signatures) as
        required by the Anthropic multi-turn thinking spec.

        Args:
            messages: Already in Anthropic Messages API format (not Converse format).
            mcp_tools: Tools in Anthropic format (as returned by mcp_manager.get_all_tools()).
        """
        msgs = list(messages)
        full_response = ""

        for _round in range(max_rounds):
            log.info("Bedrock thinking MCP round %d", _round)
            try:
                _thinking, _text, full_blocks, tool_use_blocks = \
                    await self._stream_invoke_model(
                        system=system,
                        messages=msgs,
                        on_chunk=on_chunk,
                        on_thought=on_thought,
                        tools=mcp_tools,
                    )
            except Exception as e:
                log.error("Bedrock thinking MCP loop error (round %d): %s", _round, e)
                raise RuntimeError(f"AWS Bedrock error: {e}") from e

            log.info(
                "Bedrock thinking MCP round %d done: thinking_len=%d text_len=%d tools=%d",
                _round, len(_thinking), len(_text), len(tool_use_blocks),
            )
            full_response = _text

            if not tool_use_blocks:
                break  # Final round — response already streamed.

            # Preserve full assistant response (incl. thinking + signatures) in history
            # so the next round has context.
            msgs.append({"role": "assistant", "content": full_blocks})

            # Execute tools and collect results.
            tool_results: List[Dict[str, Any]] = []
            for block in tool_use_blocks:
                name = block["name"]
                inp = block.get("input", {})
                use_id = block["id"]
                log.info("Bedrock thinking MCP: calling tool %s", name)
                try:
                    result_text = await mcp_manager.call_tool(name, inp)
                except Exception as exc:
                    result_text = f"[Tool error: {exc}]"
                    log.warning("Bedrock thinking MCP tool %s error: %s", name, exc)

                tool_results.append({
                    "type": "tool_result",
                    "tool_use_id": use_id,
                    "content": str(result_text),
                })

            msgs.append({"role": "user", "content": tool_results})

        return full_response

    def _build_system(self, skills: List[Dict[str, str]], memory: str, reasoning_mode: str = "off") -> str:
        return _build_system_prompt_shared(skills, memory, reasoning_mode=reasoning_mode)

    # ── Operation-plan tool in Anthropic Messages API format ─────────────────
    # Used by stream_plan_task when thinking is enabled (invoke_model path).
    _PLAN_TOOL_ANTHROPIC: Dict[str, Any] = {
        "name": "create_operation_plan",
        "description": "Create a plan of notebook cell operations to fulfil the user's request.",
        "input_schema": {
            "type": "object",
            "properties": {
                "steps": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "type":        {"type": "string"},
                            "cellIndex":   {"type": "integer"},
                            "cellType":    {"type": "string"},
                            "content":     {"type": "string"},
                            "autoExecute": {"type": "boolean"},
                            "description": {"type": "string"},
                        },
                        "required": ["type", "cellIndex"],
                    },
                },
                "requiresApproval":   {"type": "boolean"},
                "clarificationNeeded":{"type": "string"},
                "summary":            {"type": "string"},
            },
            "required": ["steps", "requiresApproval", "summary"],
        },
    }

    async def stream_plan_task(
        self,
        user_message: str,
        notebook_context: Dict[str, Any],
        skills: List[Dict[str, str]],
        memory: str,
        operation_id: Optional[str] = None,
        on_text_chunk=None,
        on_json_delta=None,
        on_thought=None,
        chat_history: Optional[List[Dict[str, str]]] = None,
        reasoning_mode: str = "off",
    ) -> Dict[str, Any]:
        """Stream the plan task for Bedrock.

        When thinking is enabled AND the model supports it, uses invoke_model
        (Anthropic Messages API) so thinking blocks are returned and forwarded
        via on_thought, and preamble text via on_text_chunk.

        When thinking is disabled, falls back to the synchronous converse path
        (plan_task).
        """
        await self._ensure_credentials()
        op_id = operation_id or f"op_{uuid.uuid4().hex[:8]}"

        # Always use thinking for supported models (matches Anthropic behaviour
        # where extended thinking is always on for plan_task on capable models).
        if self._supports_thinking():
            system = self._build_system(skills, memory, reasoning_mode=reasoning_mode)
            user_msg = _build_context(user_message, notebook_context)

            history = list(chat_history or [])
            while history and history[0].get("role") != "user":
                history = history[1:]
            converse_msgs = [
                {"role": h["role"], "content": [{"text": h["content"]}]} for h in history
            ]
            converse_msgs.append({"role": "user", "content": [{"text": user_msg}]})
            anthropic_msgs = self._converse_messages_to_anthropic(converse_msgs)

            log.info("Bedrock stream_plan_task: using invoke_model with thinking for %s", self.chat_model)

            try:
                def _call(msgs=anthropic_msgs):
                    return self._invoke_model_raw(system, msgs, tools=[self._PLAN_TOOL_ANTHROPIC])

                result = await self._call_with_auto_refresh(_call)
            except Exception as e:
                log.error("Bedrock stream_plan_task (thinking) error: %s", e)
                raise RuntimeError(f"AWS Bedrock error: {e}") from e

            content_blocks = result.get("content", [])
            log.info(
                "Bedrock stream_plan_task blocks: %s",
                [b.get("type", "?") for b in content_blocks],
            )

            # Emit thinking and preamble text so the UI renders thinking bubble + text.
            thinking_parts: List[str] = []
            text_parts: List[str] = []
            plan_data: Optional[Dict[str, Any]] = None

            for block in content_blocks:
                btype = block.get("type", "")
                if btype == "thinking":
                    t = block.get("thinking", "")
                    if t:
                        thinking_parts.append(t)
                elif btype == "text":
                    t = block.get("text", "")
                    if t:
                        text_parts.append(t)
                elif btype == "tool_use" and block.get("name") == "create_operation_plan":
                    plan_data = dict(block.get("input", {}))

            thinking_text = "\n\n".join(thinking_parts)
            if thinking_text and on_thought:
                await on_thought(thinking_text)

            preamble = "".join(text_parts).strip()
            if preamble and on_text_chunk:
                words = preamble.split(" ")
                for i, word in enumerate(words):
                    chunk = word if i == len(words) - 1 else word + " "
                    if chunk:
                        await on_text_chunk(chunk)
                        await asyncio.sleep(0)

            if plan_data is None:
                raise RuntimeError("Bedrock invoke_model did not return a create_operation_plan tool call")

            plan_data.setdefault("operationId", op_id)
            plan_data.setdefault("clarificationNeeded", None)
            return plan_data

        # Non-thinking model path: run plan_task synchronously, then stream the
        # summary as text so the frontend receives at least one chunk event.
        # This ensures ensureStreamStarted() is triggered naturally from the
        # SSE onChunk handler — giving a proper stream start/stop cycle.
        plan = await self.plan_task(
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
                chunk = word if i == len(words) - 1 else word + " "
                if chunk:
                    await on_text_chunk(chunk)
                    await asyncio.sleep(0)
        return plan

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
        await self._ensure_credentials()
        op_id = operation_id or f"op_{uuid.uuid4().hex[:8]}"
        system = self._build_system(skills, memory, reasoning_mode=reasoning_mode)
        user_msg = _build_context(user_message, notebook_context)

        content: List[Dict[str, Any]] = [{"text": user_msg}]
        if self.has_vision():
            for cell in notebook_context.get("cells", []):
                img = cell.get("imageOutput")
                if img:
                    idx = cell.get("index")
                    label = f"#{idx + 1}" if isinstance(idx, int) else "#?"
                    raw_mime = cell.get("imageOutputMime") or "image/png"
                    fmt = "jpeg" if "jpeg" in raw_mime else ("webp" if "webp" in raw_mime else ("gif" if "gif" in raw_mime else "png"))
                    content.append({"text": f"[Plot from cell {label}:]"})
                    content.append({
                        "image": {
                            "format": fmt,
                            "source": {"bytes": base64.b64decode(img)},
                        }
                    })

        # Build messages list with history
        history = list(chat_history or [])
        while history and history[0].get("role") != "user":
            history = history[1:]
        messages = [{"role": h["role"], "content": [{"text": h["content"]}]} for h in history]
        messages.append({"role": "user", "content": content})

        def _call():
            resp = self._boto_client.converse(
                modelId=self.chat_model,
                system=[{"text": system}],
                messages=messages,
                toolConfig=_TOOL_CONFIG,
                inferenceConfig={"maxTokens": self._max_tokens_override or 4096, "temperature": 0.2},
            )
            u = resp.get("usage", {})
            self._set_usage(u.get("inputTokens", 0), u.get("outputTokens", 0))
            for block in resp.get("output", {}).get("message", {}).get("content", []):
                if "toolUse" in block and block["toolUse"]["name"] == "create_operation_plan":
                    data = block["toolUse"]["input"]
                    data.setdefault("operationId", op_id)
                    data.setdefault("clarificationNeeded", None)
                    return data
            raise RuntimeError("No tool use block in Bedrock response")

        try:
            return await self._call_with_auto_refresh(_call)
        except Exception as e:
            log.error("Bedrock plan_task error: %s", e)
            raise RuntimeError(f"AWS Bedrock error: {e}") from e

    async def complete(
        self,
        prefix: str,
        suffix: str,
        language: str,
        previous_cells: List[Dict[str, Any]],
    ) -> Dict[str, Any]:
        await self._ensure_credentials()
        imports = _extract_imports(previous_cells)
        cache_key = CompletionCache.make_key(prefix, language, "bedrock-completion", imports)
        cached = self._cache.get(cache_key)
        if cached:
            return {"suggestion": cached, "type": "completion", "lines": cached.splitlines(), "cached": True}

        context = _build_context_block(previous_cells)
        prompt = (f"{context}\n\n{prefix}" if context else prefix)

        def _call():
            resp = self._boto_client.converse(
                modelId=self.completion_model,
                system=[{"text": _INLINE_SYSTEM}],
                messages=[{"role": "user", "content": [{"text": f"Complete:\n{prompt}"}]}],
                inferenceConfig={"maxTokens": 256, "temperature": 0.1},
            )
            u = resp.get("usage", {})
            self._set_usage(u.get("inputTokens", 0), u.get("outputTokens", 0))
            for block in resp.get("output", {}).get("message", {}).get("content", []):
                if "text" in block:
                    return block["text"]
            return ""

        try:
            raw = await self._call_with_auto_refresh(_call)
            suggestion = re.sub(r"^```[a-z]*\n?", "", raw.strip(), flags=re.MULTILINE)
            suggestion = re.sub(r"\n?```$", "", suggestion, flags=re.MULTILINE).strip()
            if suggestion:
                self._cache.set(cache_key, suggestion)
            return {"suggestion": suggestion, "type": "completion", "lines": suggestion.splitlines(), "cached": False}
        except Exception as e:
            log.warning("Bedrock complete error: %s", e)
            return {"suggestion": "", "type": "completion", "lines": [], "cached": False}

    async def health_check(self) -> bool:
        def _check():
            try:
                import boto3
                if self.aws_profile:
                    session = boto3.Session(profile_name=self.aws_profile, region_name=self.region)
                    client = session.client("bedrock")
                else:
                    client = boto3.client(
                        "bedrock",
                        region_name=self.region,
                        aws_access_key_id=self.access_key_id or None,
                        aws_secret_access_key=self.secret_access_key or None,
                    )
                client.list_foundation_models(byOutputModality="TEXT")
                return True
            except Exception:
                return False
        return await asyncio.get_running_loop().run_in_executor(None, _check)

    async def chat(
        self,
        system: str,
        user: str,
        chat_history: Optional[List[Dict[str, str]]] = None,
    ) -> str:
        await self._ensure_credentials()
        history = list(chat_history or [])
        while history and history[0].get("role") != "user":
            history = history[1:]
        messages = [{"role": h["role"], "content": [{"text": h["content"]}]} for h in history]
        messages.append({"role": "user", "content": [{"text": user}]})

        # Extended thinking path: uses invoke_model directly (Anthropic Messages API)
        # because the Converse API does not support the thinking parameter.
        log.info(
            "Bedrock chat: enable_thinking=%s supports_thinking=%s model=%s",
            self.enable_thinking, self._supports_thinking(), self.chat_model,
        )
        if self.enable_thinking and self._supports_thinking():
            log.info("Bedrock: extended thinking enabled (budget=%d tokens)", self.thinking_budget)
            try:
                _thinking, _text = await self._call_with_auto_refresh(
                    lambda: self._invoke_with_thinking(system, messages)
                )
                log.info(
                    "Bedrock: thinking returned thinking_len=%d text_len=%d",
                    len(_thinking), len(_text),
                )
                # Store thinking for stream_chat() to forward to on_thought callback.
                self._last_thinking = _thinking
                return _text
            except Exception as e:
                log.error("Bedrock chat (thinking) error: %s", e)
                raise RuntimeError(f"AWS Bedrock error: {e}") from e

        self._last_thinking = ""

        def _call():
            resp = self._boto_client.converse(
                modelId=self.chat_model,
                system=[{"text": system}],
                messages=messages,
                inferenceConfig={"maxTokens": self._max_chat_tokens(), "temperature": 0.3},
            )
            u = resp.get("usage", {})
            self._set_usage(u.get("inputTokens", 0), u.get("outputTokens", 0))
            for block in resp.get("output", {}).get("message", {}).get("content", []):
                if "text" in block:
                    return block["text"]
            return ""
        try:
            return await self._call_with_auto_refresh(_call)
        except Exception as e:
            log.error("Bedrock chat error: %s", e)
            raise RuntimeError(f"AWS Bedrock error: {e}") from e

    # ── Streaming helpers ─────────────────────────────────────────────────────

    async def _stream_invoke_model(
        self,
        system: str,
        messages: List[Dict[str, Any]],
        on_chunk,
        on_thought=None,
        tools: Optional[List[Dict[str, Any]]] = None,
    ) -> tuple:
        """Stream via invoke_model_with_response_stream (Anthropic Messages API).

        Handles all streaming event types:
          - thinking_delta  → streamed to on_thought token by token
          - text_delta      → streamed to on_chunk token by token
          - input_json_delta / signature_delta → accumulated for tool-use recovery
          - content_block_start/stop → used to reconstruct full content blocks

        Returns:
            (thinking_text, response_text, full_content_blocks, tool_use_blocks)
            where full_content_blocks includes thinking signatures (needed for
            multi-turn MCP history) and tool_use_blocks lists any tool calls.
        """
        loop = asyncio.get_running_loop()
        queue: asyncio.Queue = asyncio.Queue()

        max_tokens = self.thinking_budget + 8192
        body: Dict[str, Any] = {
            "anthropic_version": "bedrock-2023-05-31",
            "max_tokens": max_tokens,
            "thinking": {"type": "enabled", "budget_tokens": self.thinking_budget},
            "system": system,
            "messages": messages,
        }
        if tools:
            body["tools"] = tools
            body["tool_choice"] = {"type": "auto"}

        def _run() -> None:
            seen_types: list = []
            try:
                resp = self._boto_client.invoke_model_with_response_stream(
                    modelId=self.chat_model,
                    body=json.dumps(body),
                    contentType="application/json",
                    accept="application/json",
                )
                for raw_event in resp["body"]:
                    # Surface any stream-level errors (throttling, validation, etc.)
                    for err_key in ("internalServerException", "modelStreamErrorException",
                                    "validationException", "throttlingException",
                                    "modelTimeoutException"):
                        if err_key in raw_event:
                            msg = raw_event[err_key].get("message", err_key)
                            loop.call_soon_threadsafe(
                                queue.put_nowait, {"_error": f"{err_key}: {msg}"}
                            )
                            return
                    chunk_bytes = raw_event.get("chunk", {}).get("bytes")
                    if chunk_bytes:
                        try:
                            evt = json.loads(chunk_bytes)
                            etype = evt.get("type", "?")
                            # Compact type log: record first occurrence of each type
                            if etype not in seen_types:
                                seen_types.append(etype)
                            # For delta events log the delta sub-type too
                            if etype == "content_block_delta":
                                dtype = evt.get("delta", {}).get("type", "?")
                                label = f"delta:{dtype}"
                                if label not in seen_types:
                                    seen_types.append(label)
                            loop.call_soon_threadsafe(queue.put_nowait, evt)
                        except Exception as parse_exc:
                            log.warning(
                                "Bedrock stream: failed to parse chunk (%s bytes): %s",
                                len(chunk_bytes), parse_exc,
                            )
            except Exception as exc:
                loop.call_soon_threadsafe(queue.put_nowait, {"_error": str(exc)})
            finally:
                log.info(
                    "Bedrock invoke_model_with_response_stream done. Event types seen: %s",
                    seen_types,
                )
                loop.call_soon_threadsafe(queue.put_nowait, None)  # sentinel

        executor_future = loop.run_in_executor(None, _run)

        # Per-block state keyed by stream index.
        # Each entry: {"type", "id", "name", "_thinking", "_text", "_json", "_sig"}
        blocks: Dict[int, Dict[str, Any]] = {}
        current_idx: int = -1

        thinking_text = ""
        response_text = ""
        input_tokens = output_tokens = 0

        while True:
            evt = await queue.get()
            if evt is None:
                break
            if "_error" in evt:
                raise RuntimeError(f"AWS Bedrock stream error: {evt['_error']}")

            etype = evt.get("type", "")

            if etype == "content_block_start":
                idx = evt.get("index", 0)
                cb = evt.get("content_block", {})
                blocks[idx] = {
                    "type":     cb.get("type", "text"),
                    "id":       cb.get("id", ""),
                    "name":     cb.get("name", ""),
                    "_thinking": "",
                    "_text":    "",
                    "_json":    "",
                    "_sig":     "",
                }
                current_idx = idx

            elif etype == "content_block_delta":
                idx = evt.get("index", current_idx)
                delta = evt.get("delta", {})
                dtype = delta.get("type", "")

                if dtype == "thinking_delta":
                    t = delta.get("thinking", "")
                    if t:
                        thinking_text += t
                        if idx in blocks:
                            blocks[idx]["_thinking"] += t
                        if on_thought:
                            await on_thought(t)

                elif dtype == "text_delta":
                    t = delta.get("text", "")
                    if t:
                        response_text += t
                        if idx in blocks:
                            blocks[idx]["_text"] += t
                        await on_chunk(t)

                elif dtype == "input_json_delta":
                    partial = delta.get("partial_json", "")
                    if idx in blocks:
                        blocks[idx]["_json"] += partial

                elif dtype == "signature_delta":
                    sig = delta.get("signature", "")
                    if idx in blocks:
                        blocks[idx]["_sig"] += sig

            elif etype == "content_block_stop":
                idx = evt.get("index", current_idx)
                if idx in blocks:
                    b = blocks[idx]
                    if b["type"] == "tool_use":
                        try:
                            b["_parsed_input"] = json.loads(b["_json"]) if b["_json"] else {}
                        except Exception:
                            b["_parsed_input"] = {}

            elif etype == "message_delta":
                usage = evt.get("usage", {})
                output_tokens += usage.get("output_tokens", 0)

            elif etype == "message_start":
                usage = evt.get("message", {}).get("usage", {})
                input_tokens += usage.get("input_tokens", 0)

        await executor_future
        self._set_usage(input_tokens, output_tokens)

        # Reconstruct full content blocks for history (ordered by index).
        full_content_blocks: List[Dict[str, Any]] = []
        tool_use_blocks: List[Dict[str, Any]] = []
        for idx in sorted(blocks.keys()):
            b = blocks[idx]
            btype = b["type"]
            if btype == "thinking":
                full_content_blocks.append({
                    "type":      "thinking",
                    "thinking":  b["_thinking"],
                    "signature": b["_sig"],
                })
            elif btype == "text":
                if b["_text"]:
                    full_content_blocks.append({"type": "text", "text": b["_text"]})
            elif btype == "tool_use":
                tu = {
                    "type":  "tool_use",
                    "id":    b["id"],
                    "name":  b["name"],
                    "input": b.get("_parsed_input", {}),
                }
                full_content_blocks.append(tu)
                tool_use_blocks.append(tu)

        return thinking_text, response_text, full_content_blocks, tool_use_blocks

    async def _stream_converse(
        self,
        system: str,
        messages: List[Dict[str, Any]],
        on_chunk,
    ) -> str:
        """Stream a plain (no-thinking) chat response via converse_stream.

        Yields text deltas to on_chunk as they arrive so the UI animates
        token-by-token.  Returns the full response text.
        """
        loop = asyncio.get_running_loop()
        queue: asyncio.Queue = asyncio.Queue()

        def _run() -> None:
            try:
                resp = self._boto_client.converse_stream(
                    modelId=self.chat_model,
                    system=[{"text": system}],
                    messages=messages,
                    inferenceConfig={
                        "maxTokens": self._max_chat_tokens(),
                        "temperature": 0.3,
                    },
                )
                for evt in resp["stream"]:
                    loop.call_soon_threadsafe(queue.put_nowait, evt)
            except Exception as exc:
                loop.call_soon_threadsafe(queue.put_nowait, {"_error": str(exc)})
            finally:
                loop.call_soon_threadsafe(queue.put_nowait, None)  # sentinel

        executor_future = loop.run_in_executor(None, _run)

        response_text = ""
        input_tokens = output_tokens = 0

        while True:
            evt = await queue.get()
            if evt is None:
                break
            if "_error" in evt:
                raise RuntimeError(f"AWS Bedrock converse_stream error: {evt['_error']}")

            if "contentBlockDelta" in evt:
                delta = evt["contentBlockDelta"].get("delta", {})
                t = delta.get("text", "")
                if t:
                    response_text += t
                    await on_chunk(t)
            elif "metadata" in evt:
                usage = evt["metadata"].get("usage", {})
                input_tokens = usage.get("inputTokens", 0)
                output_tokens = usage.get("outputTokens", 0)

        await executor_future
        self._set_usage(input_tokens, output_tokens)
        return response_text

    # ── MCP tool-loop helpers ─────────────────────────────────────────────────

    @staticmethod
    def _mcp_tools_to_bedrock(mcp_tools: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """Convert Anthropic-format MCP tool definitions to Bedrock Converse toolSpec."""
        result = []
        for t in mcp_tools:
            result.append({
                "toolSpec": {
                    "name": t["name"],
                    "description": (t.get("description") or "")[:1000],
                    "inputSchema": {
                        "json": t.get("input_schema", {"type": "object", "properties": {}})
                    },
                }
            })
        return result

    async def run_converse_mcp_loop(
        self,
        system: str,
        user,
        chat_history,
        mcp_manager,
        on_chunk,
        on_thought=None,
        max_rounds: int = 8,
    ) -> str:
        """Agentic loop for MCP tool use.

        When extended thinking is enabled, routes through _run_thinking_mcp_loop
        which uses invoke_model (Anthropic Messages API) — the only Bedrock path
        that supports both thinking and tool use simultaneously.

        Otherwise falls back to the Converse API tool loop (faster, no thinking).
        """
        await self._ensure_credentials()

        mcp_tools = mcp_manager.get_all_tools() if mcp_manager else []

        # Build history in Anthropic Messages API format (used by both paths).
        history = list(chat_history or [])
        while history and history[0].get("role") != "user":
            history = history[1:]
        converse_history = [
            {"role": h["role"], "content": [{"text": h["content"]}]} for h in history
        ]
        anthropic_msgs = self._converse_messages_to_anthropic(converse_history)
        if isinstance(user, str):
            anthropic_msgs.append({"role": "user", "content": user})
        else:
            anthropic_msgs.append({"role": "user", "content": user})

        if self.enable_thinking and self._supports_thinking():
            log.info(
                "Bedrock MCP: routing through thinking loop (budget=%d, tools=%d)",
                self.thinking_budget, len(mcp_tools),
            )
            return await self._run_thinking_mcp_loop(
                system=system,
                messages=anthropic_msgs,
                mcp_tools=mcp_tools,
                mcp_manager=mcp_manager,
                on_chunk=on_chunk,
                on_thought=on_thought,
                max_rounds=max_rounds,
            )

        # Converse API path — no thinking, but fast.
        # Re-build messages in Converse format for this path.
        msgs: List[Dict[str, Any]] = [
            {"role": h["role"], "content": [{"text": h["content"]}]} for h in history
        ]
        if isinstance(user, str):
            msgs.append({"role": "user", "content": [{"text": user}]})
        else:
            # Vision content-block list
            msgs.append({"role": "user", "content": user})

        tool_config: Dict[str, Any] = {
            "tools": self._mcp_tools_to_bedrock(mcp_tools),
            "toolChoice": {"auto": {}},
        }

        full_response = ""

        for _round in range(max_rounds):
            def _call(msgs=msgs):
                return self._boto_client.converse(
                    modelId=self.chat_model,
                    system=[{"text": system}],
                    messages=msgs,
                    toolConfig=tool_config,
                    inferenceConfig={
                        "maxTokens": self._max_chat_tokens(),
                        "temperature": 0.3,
                    },
                )

            try:
                resp = await self._call_with_auto_refresh(_call)
            except Exception as e:
                log.error("Bedrock MCP converse loop error (round %d): %s", _round, e)
                raise RuntimeError(f"AWS Bedrock error: {e}") from e

            u = resp.get("usage", {})
            self._set_usage(u.get("inputTokens", 0), u.get("outputTokens", 0))

            output_message = resp.get("output", {}).get("message", {})
            content_blocks = output_message.get("content", [])
            stop_reason = resp.get("stopReason", "")

            # Collect text from this round.
            for block in content_blocks:
                if "text" in block:
                    full_response = block["text"]

            tool_use_blocks = [b for b in content_blocks if "toolUse" in b]

            if not tool_use_blocks:
                # Final round — stream the text instead of emitting a blob.
                # We already have `full_response` from the synchronous round above,
                # but we want streaming UX.  Re-run the final call with converse_stream.
                # Build a fresh copy of msgs so the stream call sees the correct history.
                try:
                    full_response = await self._stream_converse(
                        system=system,
                        messages=msgs,
                        on_chunk=on_chunk,
                    )
                except Exception:
                    # Fallback: emit the already-collected text as-is.
                    if full_response:
                        await on_chunk(full_response)
                break

            # Add assistant turn to history.
            msgs.append({"role": "assistant", "content": content_blocks})

            # Execute each tool call and collect results.
            tool_results: List[Dict[str, Any]] = []
            for block in tool_use_blocks:
                tu = block["toolUse"]
                name = tu["name"]
                inp = tu.get("input", {})
                use_id = tu["toolUseId"]
                log.info("Bedrock MCP: calling tool %s with %r", name, inp)
                try:
                    result_text = await mcp_manager.call_tool(name, inp)
                except Exception as exc:
                    result_text = f"[Tool error: {exc}]"
                    log.warning("Bedrock MCP tool %s error: %s", name, exc)

                tool_results.append({
                    "toolResult": {
                        "toolUseId": use_id,
                        "content": [{"text": str(result_text)}],
                    }
                })

            msgs.append({"role": "user", "content": tool_results})

        return full_response

    # ── stream_chat override ──────────────────────────────────────────────────

    async def stream_chat(
        self,
        system: str,
        user,
        on_chunk,
        on_thought=None,
        chat_history=None,
    ) -> None:
        """True streaming chat for Bedrock — token-by-token, matching Anthropic UX.

        Thinking path  → invoke_model_with_response_stream (Anthropic Messages API)
                         streams thinking_delta and text_delta events.
        Plain path     → converse_stream
                         streams contentBlockDelta events.
        """
        await self._ensure_credentials()

        history = list(chat_history or [])
        while history and history[0].get("role") != "user":
            history = history[1:]

        log.info(
            "Bedrock stream_chat: enable_thinking=%s supports_thinking=%s model=%s",
            self.enable_thinking, self._supports_thinking(), self.chat_model,
        )

        if self.enable_thinking and self._supports_thinking():
            log.info(
                "Bedrock stream_chat: THINKING path "
                "(enable_thinking=%s budget=%d model=%s)",
                self.enable_thinking, self.thinking_budget, self.chat_model,
            )
            # Delegate to chat() which is confirmed to call _invoke_with_thinking()
            # and populate self._last_thinking.  We then emit thinking first via
            # on_thought, then stream the text word-by-word for a live UX.
            try:
                text = await self.chat(
                    system=system, user=user, chat_history=chat_history
                )
                log.info(
                    "Bedrock stream_chat (thinking) chat() done: "
                    "thinking_len=%d text_len=%d",
                    len(self._last_thinking), len(text or ""),
                )
                if self._last_thinking and on_thought:
                    await on_thought(self._last_thinking)
                if text:
                    words = text.split(" ")
                    for i, word in enumerate(words):
                        chunk = word if i == len(words) - 1 else word + " "
                        if chunk:
                            await on_chunk(chunk)
                            await asyncio.sleep(0)
            except Exception as e:
                log.error("Bedrock stream_chat (thinking) error: %s", e)
                raise RuntimeError(f"AWS Bedrock error: {e}") from e
            return

        # Plain converse_stream path (no thinking).
        self._last_thinking = ""
        msgs: List[Dict[str, Any]] = [
            {"role": h["role"], "content": [{"text": h["content"]}]} for h in history
        ]
        if isinstance(user, str):
            msgs.append({"role": "user", "content": [{"text": user}]})
        else:
            msgs.append({"role": "user", "content": user})

        try:
            await self._stream_converse(system=system, messages=msgs, on_chunk=on_chunk)
        except Exception as e:
            log.error("Bedrock stream_chat (converse_stream) error: %s", e)
            raise RuntimeError(f"AWS Bedrock error: {e}") from e

    def has_vision(self) -> bool:
        name = self.chat_model.lower()
        return "claude-3" in name or "claude-sonnet" in name or "claude-haiku" in name

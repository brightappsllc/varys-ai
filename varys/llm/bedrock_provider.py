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

    def _build_system(self, skills: List[Dict[str, str]], memory: str, reasoning_mode: str = "off") -> str:
        return _build_system_prompt_shared(skills, memory, reasoning_mode=reasoning_mode)

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
                inferenceConfig={"maxTokens": 4096, "temperature": 0.2},
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

        def _call():
            resp = self._boto_client.converse(
                modelId=self.chat_model,
                system=[{"text": system}],
                messages=messages,
                inferenceConfig={"maxTokens": 8192, "temperature": 0.3},
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

    def has_vision(self) -> bool:
        name = self.chat_model.lower()
        return "claude-3" in name or "claude-sonnet" in name or "claude-haiku" in name

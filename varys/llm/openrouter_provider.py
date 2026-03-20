"""OpenRouter provider — access 200+ models via a single OpenAI-compatible API.

https://openrouter.ai/docs
"""
import logging
from typing import Any, Dict, List, Optional

from .openai_provider import OpenAIProvider

log = logging.getLogger(__name__)

_OPENROUTER_BASE = "https://openrouter.ai/api/v1"

# Vision-capable model families available on OpenRouter
_VISION_PREFIXES = (
    "anthropic/",
    "openai/gpt-4o",
    "openai/gpt-4-vision",
    "google/gemini",
    "meta-llama/llama-3.2",       # multimodal variant
    "mistralai/pixtral",
    "qwen/qwen-vl",
)


class OpenRouterProvider(OpenAIProvider):
    """Thin wrapper around OpenAIProvider pointing at openrouter.ai."""

    def __init__(
        self,
        api_key: str,
        chat_model: str = "anthropic/claude-sonnet-4-6",
        completion_model: str = "google/gemini-2.0-flash",
        site_url: str = "",
        site_name: str = "Varys",
    ) -> None:
        self.site_url = site_url
        self.site_name = site_name
        super().__init__(
            api_key=api_key,
            chat_model=chat_model,
            completion_model=completion_model,
            base_url=_OPENROUTER_BASE,
        )

    def _make_async_client(self):
        try:
            from openai import AsyncOpenAI
        except ImportError:
            raise RuntimeError("openai package not installed. Run: pip install openai")
        headers: Dict[str, str] = {}
        if getattr(self, "site_url", ""):
            headers["HTTP-Referer"] = self.site_url
        if getattr(self, "site_name", ""):
            headers["X-Title"] = self.site_name
        return AsyncOpenAI(
            api_key=self.api_key,
            base_url=_OPENROUTER_BASE,
            **({"default_headers": headers} if headers else {}),
        )

    def has_vision(self) -> bool:
        name = self.chat_model.lower()
        return any(name.startswith(p) for p in _VISION_PREFIXES)

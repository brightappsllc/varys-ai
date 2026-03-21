"""Azure OpenAI provider — same models as OpenAI, different endpoint/auth."""
import logging
from typing import Any, Dict, List, Optional

from .openai_provider import OpenAIProvider

log = logging.getLogger(__name__)


class AzureProvider(OpenAIProvider):
    VENDOR = "azure"

    """Calls Azure OpenAI Service using the openai SDK with Azure settings."""

    def __init__(
        self,
        api_key: str,
        endpoint: str,
        api_version: str = "2024-02-01",
        chat_model: str = "gpt-4o",
        completion_model: str = "gpt-4o-mini",
    ) -> None:
        self.endpoint = endpoint.rstrip("/")
        self.api_version = api_version
        super().__init__(
            api_key=api_key,
            chat_model=chat_model,
            completion_model=completion_model,
        )

    def _make_async_client(self):
        try:
            from openai import AsyncAzureOpenAI
        except ImportError:
            raise RuntimeError("openai package not installed. Run: pip install openai")
        return AsyncAzureOpenAI(
            api_key=self.api_key,
            azure_endpoint=getattr(self, "endpoint", ""),
            api_version=getattr(self, "api_version", "2024-02-01"),
        )

    def has_vision(self) -> bool:
        name = self.chat_model.lower()
        return "gpt-4o" in name or "gpt-4-vision" in name

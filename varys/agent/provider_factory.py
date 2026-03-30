"""Factory for building the configured AgentProvider.

build_agent_provider() reads VARYS_AGENT_PROVIDER from the environment
(with local_cfg taking precedence) and returns the appropriate provider.

Also houses:
  - TOOL_INCOMPATIBLE_MODELS: known models that do not support tool calling.
  - _check_tool_support(): proactive detection before any API call.
"""
from __future__ import annotations

import os

from .local_config import get_agent_env
from .provider_base import AgentProvider, ToolUseNotSupportedError

# ── Known-incompatible model list ─────────────────────────────────────────────
# Strings ending in "-" are prefix matches; others are exact or colon-variant
# matches (e.g. "llava" also matches "llava:latest").

TOOL_INCOMPATIBLE_MODELS: dict[str, list[str]] = {
    "ollama": [
        "llava", "llava-llama3", "llava-phi3",
        "nomic-embed-text", "mxbai-embed-large", "snowflake-arctic-embed",
        "all-minilm", "bge-m3", "bge-large",
        "codellama",
    ],
    "bedrock": [
        "amazon.titan-",        # all Titan models
        "stability.",           # all Stability AI models
        "amazon.nova-canvas-",  # image generation
        "amazon.nova-reel-",    # video generation
    ],
    "openai": [
        "text-embedding-",      # embedding models
        "whisper-",             # audio transcription
        "dall-e-",              # image generation
        "tts-",                 # text-to-speech
        "babbage-",             # legacy completions
        "davinci-",             # legacy completions
    ],
    "azure": [
        "text-embedding-",      # embedding deployments
    ],
}


def _suggestion(provider: str, model: str) -> str:  # noqa: ARG001
    suggestions: dict[str, str] = {
        "ollama": (
            "Switch to a tool-capable model in Ollama settings. "
            "Models that support tool calling include: "
            "qwen2.5-coder, llama3.1, llama3.2, mistral-nemo, mistral."
        ),
        "openai": (
            "Embedding, audio, and image models do not support tool calling. "
            "Use gpt-4o, gpt-4o-mini, or gpt-4.1 instead."
        ),
        "azure": (
            "Check that your Azure deployment uses a chat model (gpt-4o, gpt-4.1) "
            "rather than an embedding or completions-only deployment."
        ),
        "bedrock": (
            "This Bedrock model does not support tool calling via the Converse API. "
            "Use a Claude model (e.g. anthropic.claude-3-5-sonnet-20241022-v2:0) "
            "or another Converse-compatible model."
        ),
    }
    return suggestions.get(provider, "Select a model that supports tool calling.")


def _check_tool_support(provider: str, model: str) -> None:
    """Raise ToolUseNotSupportedError if the model is known to not support tools."""
    for pattern in TOOL_INCOMPATIBLE_MODELS.get(provider, []):
        if pattern.endswith("-"):
            if model.startswith(pattern):
                raise ToolUseNotSupportedError(
                    provider=provider,
                    model=model,
                    reason=f"Model family '{pattern}' does not support tool calling.",
                    suggestion=_suggestion(provider, model),
                )
        else:
            # Exact match or colon-variant (e.g. "llava:latest")
            if model == pattern or model.startswith(pattern + ":"):
                raise ToolUseNotSupportedError(
                    provider=provider,
                    model=model,
                    reason=f"Model '{model}' does not support tool calling.",
                    suggestion=_suggestion(provider, model),
                )


def check_tool_support_safe(provider: str, model: str) -> dict:
    """Return {supported: bool, reason: str|None} without raising.

    Used by the GET /varys/agent-settings/tool-support endpoint.
    """
    try:
        _check_tool_support(provider, model)
        return {"supported": True, "reason": None}
    except ToolUseNotSupportedError as e:
        return {"supported": False, "reason": e.reason}


class AgentConfigError(ValueError):
    """Raised when a required env var is missing for the selected provider."""
    pass


def _req(key: str, provider: str, local_cfg: dict[str, str]) -> str:
    """Return the value of a required env var or raise AgentConfigError."""
    val = get_agent_env(key, local_cfg, "")
    if not val:
        raise AgentConfigError(
            f"File Agent with provider '{provider}' requires {key}. "
            f"Add it to your varys.env file."
        )
    return val


def build_agent_provider(
    app_settings: dict,
    local_cfg: dict[str, str] | None = None,
) -> AgentProvider:
    """Instantiate and return the configured AgentProvider.

    Provider resolution order:
      1. VARYS_AGENT_PROVIDER in project-local config
      2. VARYS_AGENT_PROVIDER in os.environ
      3. ds_assistant_chat_provider from app_settings (the user's chat provider)
      4. Raise AgentConfigError — no implicit Anthropic default

    Raises AgentConfigError for missing credentials or unconfigured provider.
    Raises ToolUseNotSupportedError for known-incompatible models.
    """
    if local_cfg is None:
        local_cfg = {}

    # Check if VARYS_AGENT_PROVIDER is explicitly configured (local cfg or env)
    explicit = get_agent_env("VARYS_AGENT_PROVIDER", local_cfg, "")
    if explicit:
        name = explicit.lower()
    else:
        # Fall back to the user's configured chat provider so the File Agent /
        # background scan uses the same LLM stack as chat — no surprise Anthropic
        # calls when the user is on OpenAI/Google/Bedrock/etc.
        chat_provider = (app_settings or {}).get("ds_assistant_chat_provider", "")
        if not chat_provider:
            raise AgentConfigError(
                "File Agent provider not configured. "
                "Set VARYS_AGENT_PROVIDER in your varys.env file."
            )
        name = chat_provider.lower()

    if name == "anthropic":
        from .utils import validate_agent_config  # type: ignore[attr-defined]
        api_key, model = validate_agent_config()
        from .providers.anthropic_provider import AnthropicAgentProvider
        return AnthropicAgentProvider(api_key=api_key, model=model)

    elif name == "openai":
        import openai
        api_key = _req("OPENAI_API_KEY", name, local_cfg)
        model   = _req("OPENAI_CHAT_MODEL", name, local_cfg)
        _check_tool_support(name, model)
        client = openai.AsyncOpenAI(api_key=api_key)
        from .providers.openai_provider import OpenAIAgentProvider
        return OpenAIAgentProvider(client=client, model=model)

    elif name == "azure":
        api_key  = _req("AZURE_OPENAI_API_KEY", name, local_cfg)
        endpoint = _req("AZURE_OPENAI_ENDPOINT", name, local_cfg)
        version  = get_agent_env("AZURE_OPENAI_API_VERSION", local_cfg, "2024-12-01-preview")
        deploy   = _req("AZURE_OPENAI_DEPLOYMENT", name, local_cfg)
        _check_tool_support(name, deploy)
        from .providers.azure_provider import AzureOpenAIAgentProvider
        return AzureOpenAIAgentProvider(api_key, endpoint, version, deploy)

    elif name == "bedrock":
        region   = get_agent_env("AWS_DEFAULT_REGION", local_cfg, "us-east-1")
        model_id = _req("BEDROCK_CHAT_MODEL", name, local_cfg)
        _check_tool_support(name, model_id)
        from .providers.bedrock_provider import BedrockAgentProvider
        return BedrockAgentProvider(region=region, model_id=model_id)

    elif name == "ollama":
        base_url = get_agent_env("OLLAMA_BASE_URL", local_cfg, "http://localhost:11434/v1")
        model    = _req("OLLAMA_CHAT_MODEL", name, local_cfg)
        _check_tool_support(name, model)
        from .providers.ollama_provider import OllamaAgentProvider
        return OllamaAgentProvider(base_url=base_url, model=model)

    else:
        if explicit:
            raise AgentConfigError(
                f"Unknown VARYS_AGENT_PROVIDER '{name}'. "
                f"Valid values: anthropic, openai, azure, bedrock, ollama."
            )
        else:
            # Provider came from the chat-provider fallback (e.g. google, openrouter).
            # These providers don't have a File Agent implementation — skip silently.
            raise AgentConfigError(
                f"Your chat provider '{name}' does not support the File Agent. "
                f"To use /file_agent, set VARYS_AGENT_PROVIDER to one of: "
                f"anthropic, openai, azure, bedrock, ollama."
            )

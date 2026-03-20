"""Provider factory.

Two task types:
  - chat        → DS_CHAT_PROVIDER + {PROVIDER}_CHAT_MODEL
  - completion  → DS_COMPLETION_PROVIDER + {PROVIDER}_COMPLETION_MODEL

Adding a new provider only requires:
  - Its .env block  (PROVIDER_API_KEY, PROVIDER_CHAT_MODEL, PROVIDER_COMPLETION_MODEL)
  - Setting DS_CHAT_PROVIDER / DS_COMPLETION_PROVIDER
  - A provider class + a branch in _build_provider()
"""
import logging
import os
import re
from pathlib import Path
from typing import Any, Dict, Literal

from .base import BaseLLMProvider


def _load_varys_env() -> None:
    """Load the active varys.env into os.environ (only keys not already set)."""
    try:
        from ..handlers.settings import resolve_env_path
        env_file = resolve_env_path()
    except Exception:
        env_file = Path.home() / ".jupyter" / "varys.env"
    if not env_file.exists():
        return
    for line in env_file.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        m = re.match(r"^([A-Z0-9_]+)\s*=\s*(.*)", stripped)
        if m:
            key, val = m.group(1), re.sub(r"\s+#.*$", "", m.group(2)).strip().strip("\"'")
            if key not in os.environ:
                os.environ[key] = val


log = logging.getLogger(__name__)

TaskType = Literal["chat", "completion"]

_provider_cache: Dict[str, "BaseLLMProvider"] = {}

# Default models — used only when no model is set in .env or settings.
# No silent fallback for provider — user must set DS_CHAT_PROVIDER / DS_COMPLETION_PROVIDER.
_DEFAULTS: Dict[str, Dict[str, str]] = {
    "anthropic": {
        "chat":       "claude-sonnet-4-6",
        "completion": "claude-haiku-4-5-20251001",
    },
    "ollama": {
        "chat":       "qwen2.5-coder:7b-instruct",
        "completion": "qwen2.5-coder:7b-instruct",
    },
    "openai": {
        "chat":       "gpt-4o",
        "completion": "gpt-4o-mini",
    },
    "google": {
        "chat":       "gemini-2.0-flash",
        "completion": "gemini-2.0-flash",
    },
    "bedrock": {
        "chat":       "anthropic.claude-3-5-sonnet-20241022-v2:0",
        "completion": "anthropic.claude-3-haiku-20240307-v1:0",
    },
    "azure": {
        "chat":       "gpt-4o",
        "completion": "gpt-4o-mini",
    },
    "openrouter": {
        "chat":       "anthropic/claude-sonnet-4-6",
        "completion": "google/gemini-2.0-flash",
    },
}

_ENV_PROVIDER_KEY = {
    "chat":       "DS_CHAT_PROVIDER",
    "completion": "DS_COMPLETION_PROVIDER",
}


def _cache_key(provider_name: str, task: str, model: str, settings: Dict[str, Any]) -> str:
    cred = (
        settings.get(f"ds_assistant_{provider_name}_api_key", "")
        or settings.get("ds_assistant_ollama_url", "")
        or settings.get("ds_assistant_aws_access_key_id", "")
    )
    return f"{task}:{provider_name}:{model}:{cred[:8]}"


def _resolve(settings: Dict[str, Any], task: TaskType) -> tuple[str, str]:
    """Return (provider_name, model) for task. Raises ValueError if not configured."""
    _load_varys_env()

    env_key = _ENV_PROVIDER_KEY.get(task, f"DS_{task.upper()}_PROVIDER")
    provider_name = (
        settings.get(f"ds_assistant_{task}_provider")
        or os.environ.get(env_key, "")
    ).strip().lower()

    if not provider_name:
        raise ValueError(
            f"No provider set for '{task}'. "
            f"Open Varys settings and set {env_key} "
            f"(e.g. anthropic, openai, ollama, google, bedrock, azure, openrouter)."
        )

    # Pull credentials from os.environ if missing from settings
    _sync_credentials(settings)

    model = (
        settings.get(f"ds_assistant_{provider_name}_{task}_model", "").strip()
        or os.environ.get(f"{provider_name.upper()}_{task.upper()}_MODEL", "").strip()
        or _DEFAULTS.get(provider_name, {}).get(task, "")
    )

    if not model:
        raise ValueError(
            f"No model set for '{task}' with provider '{provider_name}'. "
            f"Open Varys settings and set {provider_name.upper()}_{task.upper()}_MODEL."
        )

    # Validate API key for providers that require one
    _check_api_key(provider_name, settings)

    return provider_name, model


def _sync_credentials(settings: Dict[str, Any]) -> None:
    """Copy credentials from os.environ into settings if not already there."""
    pairs = [
        ("ds_assistant_anthropic_api_key",        "ANTHROPIC_API_KEY"),
        ("ds_assistant_openai_api_key",            "OPENAI_API_KEY"),
        ("ds_assistant_google_api_key",            "GOOGLE_API_KEY"),
        ("ds_assistant_openrouter_api_key",        "OPENROUTER_API_KEY"),
        ("ds_assistant_azure_openai_api_key",      "AZURE_OPENAI_API_KEY"),
        ("ds_assistant_aws_profile",               "AWS_PROFILE"),
        ("ds_assistant_aws_auth_refresh",          "AWS_AUTH_REFRESH"),
        ("ds_assistant_aws_access_key_id",         "AWS_ACCESS_KEY_ID"),
        ("ds_assistant_aws_secret_access_key",     "AWS_SECRET_ACCESS_KEY"),
        ("ds_assistant_aws_session_token",         "AWS_SESSION_TOKEN"),
        ("ds_assistant_ollama_url",                "OLLAMA_URL"),
    ]
    for skey, ekey in pairs:
        if not settings.get(skey):
            val = os.environ.get(ekey, "")
            if val:
                settings[skey] = val


_NEEDS_API_KEY = {
    "anthropic":  "ds_assistant_anthropic_api_key",
    "openai":     "ds_assistant_openai_api_key",
    "google":     "ds_assistant_google_api_key",
    "openrouter": "ds_assistant_openrouter_api_key",
    "azure":      "ds_assistant_azure_openai_api_key",
    # bedrock is intentionally absent: it supports profile-based auth via
    # AWS_PROFILE / ~/.aws/credentials with no explicit key required.
}


def _check_api_key(provider_name: str, settings: Dict[str, Any]) -> None:
    skey = _NEEDS_API_KEY.get(provider_name)
    if skey and not settings.get(skey):
        env_key = skey.replace("ds_assistant_", "").replace("_", " ").upper().replace(" ", "_")
        raise ValueError(
            f"No API key set for provider '{provider_name}'. "
            f"Open Varys settings and set {env_key.upper()}."
        )


def create_simple_task_provider(settings: Dict[str, Any]) -> "BaseLLMProvider | None":
    """Return a provider configured for Simple Tasks (DS_SIMPLE_TASKS_PROVIDER +
    {PROVIDER}_SIMPLE_TASKS_MODEL).

    Returns ``None`` when either the provider or the model is not configured,
    so callers can fall back to keyword-only matching without crashing.
    """
    _load_varys_env()

    provider_name = (
        settings.get("ds_assistant_simple_tasks_provider", "")
        or os.environ.get("DS_SIMPLE_TASKS_PROVIDER", "")
    ).strip().lower()
    if not provider_name:
        return None

    simple_model = (
        settings.get(f"ds_assistant_{provider_name}_simple_tasks_model", "")
        or os.environ.get(f"{provider_name.upper()}_SIMPLE_TASKS_MODEL", "")
    ).strip()
    if not simple_model:
        return None

    try:
        _sync_credentials(settings)
        _check_api_key(provider_name, settings)
        # Cache under "simple" task to avoid colliding with chat/completion cache entries
        key = _cache_key(provider_name, "simple", simple_model, settings)
        if key in _provider_cache:
            return _provider_cache[key]
        provider = _build_provider(provider_name, "chat", simple_model, settings)
        _provider_cache[key] = provider
        return provider
    except Exception as exc:
        log.debug("create_simple_task_provider: %s", exc)
        return None


def create_provider(settings: Dict[str, Any], task: TaskType = "chat") -> BaseLLMProvider:
    """Return a configured provider instance for *task* ('chat' or 'completion')."""
    provider_name, model = _resolve(settings, task)
    key = _cache_key(provider_name, task, model, settings)
    if key in _provider_cache:
        return _provider_cache[key]
    provider = _build_provider(provider_name, task, model, settings)
    _provider_cache[key] = provider
    return provider


def get_provider_info(settings: Dict[str, Any]) -> Dict[str, Dict[str, str]]:
    """Return provider + model for each task — used by the health endpoint."""
    _load_varys_env()
    result: Dict[str, Dict[str, str]] = {}
    for task in ("chat", "completion"):
        env_key = _ENV_PROVIDER_KEY[task]
        provider_name = (
            settings.get(f"ds_assistant_{task}_provider")
            or os.environ.get(env_key, "")
        ).strip().lower()
        model = (
            settings.get(f"ds_assistant_{provider_name}_{task}_model", "").strip()
            or os.environ.get(f"{provider_name.upper()}_{task.upper()}_MODEL", "").strip()
            or _DEFAULTS.get(provider_name, {}).get(task, "")
        )
        result[task] = {"provider": provider_name or "(not set)", "model": model or "(not set)"}
    return result


# ---------------------------------------------------------------------------
# Internal
# ---------------------------------------------------------------------------

def _as_bool(value: object, default: bool = True) -> bool:
    """Convert a settings value to bool, handling string 'false'/'true' correctly."""
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() not in ("false", "0", "no", "off")
    if value is None:
        return default
    return bool(value)


def _build_provider(
    provider_name: str,
    task: str,
    model: str,
    settings: Dict[str, Any],
) -> BaseLLMProvider:
    log.info("Varys factory: task=%s  provider=%s  model=%s", task, provider_name, model)

    # Resolve the completion model independently — the incoming `model` is for
    # the current task only (chat or completion).  When this factory is called
    # for a chat task, `model` is the chat model; the completion engine needs
    # the dedicated, usually cheaper, completion model.
    # Completion is optional: if no completion provider is configured we fall
    # back to the chat model so that chat/plan requests are never blocked.
    if task == "chat":
        try:
            _, completion_model = _resolve(settings, "completion")
        except ValueError:
            completion_model = model
    else:
        completion_model = model

    if provider_name == "ollama":
        from .ollama_provider import OllamaProvider
        return OllamaProvider(
            base_url=settings.get("ds_assistant_ollama_url") or "http://localhost:11434",
            chat_model=model,
            completion_model=completion_model,
        )

    if provider_name == "anthropic":
        from .anthropic_provider import AnthropicProvider
        return AnthropicProvider(
            api_key=settings.get("ds_assistant_anthropic_api_key", ""),
            chat_model=model,
            completion_model=completion_model,
            extended_thinking=_as_bool(settings.get("ds_assistant_anthropic_extended_thinking"), default=True),
        )

    if provider_name == "openai":
        from .openai_provider import OpenAIProvider
        return OpenAIProvider(
            api_key=settings.get("ds_assistant_openai_api_key", ""),
            chat_model=model,
            completion_model=completion_model,
        )

    if provider_name == "google":
        from .google_provider import GoogleProvider
        return GoogleProvider(
            api_key=settings.get("ds_assistant_google_api_key", ""),
            chat_model=model,
            completion_model=completion_model,
        )

    if provider_name == "bedrock":
        from .bedrock_provider import BedrockProvider
        return BedrockProvider(
            aws_profile=settings.get("ds_assistant_aws_profile", ""),
            aws_auth_refresh=settings.get("ds_assistant_aws_auth_refresh", ""),
            access_key_id=settings.get("ds_assistant_aws_access_key_id", ""),
            secret_access_key=settings.get("ds_assistant_aws_secret_access_key", ""),
            session_token=settings.get("ds_assistant_aws_session_token", ""),
            region=settings.get("ds_assistant_aws_region", "us-east-1"),
            chat_model=model,
            completion_model=completion_model,
        )

    if provider_name == "azure":
        from .azure_provider import AzureProvider
        return AzureProvider(
            api_key=settings.get("ds_assistant_azure_openai_api_key", ""),
            endpoint=settings.get("ds_assistant_azure_openai_endpoint", ""),
            api_version=settings.get("ds_assistant_azure_openai_api_version", "2024-02-01"),
            chat_model=model,
            completion_model=completion_model,
        )

    if provider_name == "openrouter":
        from .openrouter_provider import OpenRouterProvider
        return OpenRouterProvider(
            api_key=settings.get("ds_assistant_openrouter_api_key", ""),
            chat_model=model,
            completion_model=completion_model,
            site_url=settings.get("ds_assistant_openrouter_site_url", ""),
            site_name=settings.get("ds_assistant_openrouter_site_name", "Varys"),
        )

    raise ValueError(
        f"Unknown provider '{provider_name}'. "
        "Supported: anthropic, ollama, openai, google, bedrock, azure, openrouter."
    )

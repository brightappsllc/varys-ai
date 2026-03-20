"""Project-local Varys File Agent configuration.

Each project stores its own agent settings in:
  <notebook_dir>/.jupyter-assistant/local_varys.env

This keeps agent settings project-scoped so that multiple notebooks open
simultaneously don't share a single global working directory or tool set.
Resolution order for every VARYS_AGENT_* key:
  1. local_varys.env in the notebook's parent directory  (highest priority)
  2. os.environ (includes ~/.jupyter/varys.env loaded at JupyterLab startup)

Thread-safety: load_local_agent_config() and get_agent_env() are pure reads
that never mutate os.environ, making them safe to call concurrently from
multiple async request handlers.
"""
from __future__ import annotations

import os
from pathlib import Path

AGENT_CONFIG_KEYS: list[str] = [
    "VARYS_AGENT_ENABLED",
    "VARYS_AGENT_WORKING_DIR",
    "VARYS_AGENT_MAX_TURNS",
    "VARYS_AGENT_ALLOWED_TOOLS",
    "VARYS_AGENT_BACKGROUND_SCAN",
    "VARYS_AGENT_PROVIDER",
]

# Default values written into every new local_varys.env so the file is
# self-documenting and numeric keys can never be blank.
AGENT_CONFIG_DEFAULTS: dict[str, str] = {
    "VARYS_AGENT_ENABLED": "false",
    "VARYS_AGENT_WORKING_DIR": "",          # resolved to notebook's parent dir at write time
    "VARYS_AGENT_MAX_TURNS": "10",
    "VARYS_AGENT_ALLOWED_TOOLS": "Read,Write,Edit,Glob,Grep",
    "VARYS_AGENT_BACKGROUND_SCAN": "true",
    "VARYS_AGENT_PROVIDER": "anthropic",    # anthropic | openai | azure | bedrock | ollama
}

_LOCAL_ENV_FILENAME = "local_varys.env"


def get_local_config_path(notebook_path: str) -> Path | None:
    """Return the path to .jupyter-assistant/local_varys.env for the given notebook.

    Returns None when notebook_path is empty.
    """
    if not notebook_path:
        return None
    return Path(notebook_path).parent / ".jupyter-assistant" / _LOCAL_ENV_FILENAME


def load_local_agent_config(notebook_path: str) -> dict[str, str]:
    """Read local_varys.env and return its values as a plain dict.

    Returns an empty dict when the file does not exist or notebook_path is empty.
    Never raises — failures are silently swallowed.
    """
    path = get_local_config_path(notebook_path)
    if path is None or not path.exists():
        return {}
    try:
        from dotenv import dotenv_values
        return {k: v for k, v in dotenv_values(path).items() if v is not None}
    except Exception:
        return {}


def get_agent_env(key: str, local_config: dict[str, str], default: str = "") -> str:
    """Resolve an agent env var with local_config taking precedence over os.environ.

    Empty strings are treated as "not set" so that blank entries in
    varys.env / local_varys.env fall through to the default value.
    This prevents ValueError crashes when numeric settings (e.g.
    VARYS_AGENT_MAX_TURNS) are present but blank.

    This is the canonical way to read any VARYS_AGENT_* value inside request
    handlers — never call os.environ.get() directly for these keys.
    """
    local_val = local_config.get(key, "").strip()
    if local_val:
        return local_val
    env_val = os.environ.get(key, "").strip()
    return env_val if env_val else default


def write_local_agent_config(notebook_path: str, updates: dict[str, str]) -> Path:
    """Persist key-value pairs to .jupyter-assistant/local_varys.env.

    On first creation the file is seeded with AGENT_CONFIG_DEFAULTS so every
    key is present with a valid value — prevents blank entries that cause
    int('') crashes.  Subsequent writes merge updates on top of whatever the
    file already contains.

    Unknown keys (not in AGENT_CONFIG_KEYS) are silently dropped.
    Creates the .jupyter-assistant/ directory if it does not exist.
    """
    path = get_local_config_path(notebook_path)
    if path is None:
        raise ValueError("notebook_path is required to write local agent config")

    path.parent.mkdir(parents=True, exist_ok=True)

    # Start from defaults so every key is always present in the file.
    merged: dict[str, str] = dict(AGENT_CONFIG_DEFAULTS)

    if path.exists():
        try:
            from dotenv import dotenv_values
            on_disk = {k: v for k, v in dotenv_values(path).items() if v is not None}
            merged.update(on_disk)
        except Exception:
            pass

    # Apply the caller's updates (only known keys).
    merged.update({k: v for k, v in updates.items() if k in AGENT_CONFIG_KEYS})

    # VARYS_AGENT_WORKING_DIR: if still empty after all merges, resolve to the
    # notebook's parent directory so the file never contains a blank path entry.
    if not merged.get("VARYS_AGENT_WORKING_DIR", "").strip():
        nb_dir = str(Path(notebook_path).parent.resolve()) if notebook_path else ""
        merged["VARYS_AGENT_WORKING_DIR"] = nb_dir

    lines = [f"{k}={merged.get(k, AGENT_CONFIG_DEFAULTS.get(k, ''))}" for k in AGENT_CONFIG_KEYS]
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return path

"""Utilities for the Varys File Agent: config validation and working directory resolution."""
import os
from pathlib import Path


class AgentConfigError(Exception):
    """Raised when ANTHROPIC_API_KEY or ANTHROPIC_CHAT_MODEL is not configured."""


class WorkingDirectoryError(Exception):
    """Raised when the resolved working directory is invalid."""


def validate_agent_config() -> tuple[str, str]:
    """Read and validate ANTHROPIC_API_KEY and ANTHROPIC_CHAT_MODEL.

    Returns (api_key, model). Raises AgentConfigError with a user-friendly message
    if either env var is missing or empty.
    """
    api_key = os.environ.get("ANTHROPIC_API_KEY", "").strip()
    model   = os.environ.get("ANTHROPIC_CHAT_MODEL", "").strip()
    if not api_key:
        raise AgentConfigError(
            "ANTHROPIC_API_KEY is not set. Add it to your varys.env file and restart JupyterLab."
        )
    if not model:
        raise AgentConfigError(
            "ANTHROPIC_CHAT_MODEL is not set. Add it to your varys.env file (e.g. claude-3-5-sonnet-20241022)."
        )
    return api_key, model


def resolve_working_directory(
    notebook_path: str,
    app_settings: dict,
    local_config: "dict[str, str] | None" = None,
) -> str:
    """Resolve and validate the agent working directory.

    Resolution order:
    1. VARYS_AGENT_WORKING_DIR in local_config  (project-local .jupyter-assistant/local_varys.env)
    2. VARYS_AGENT_WORKING_DIR env var           (global ~/.jupyter/varys.env)
    3. app_settings["ds_assistant_root_dir"]
    4. os.path.dirname(os.path.abspath(notebook_path)) — if notebook_path provided

    Post-resolution validation: must exist, must not be "/", must not be str(Path.home()).
    Raises WorkingDirectoryError with a user-friendly message on failure.
    """
    override = (local_config or {}).get("VARYS_AGENT_WORKING_DIR", "").strip()
    if not override:
        override = os.environ.get("VARYS_AGENT_WORKING_DIR", "").strip()
    if override:
        candidate = override
    else:
        root_dir = app_settings.get("ds_assistant_root_dir", "")
        if root_dir:
            candidate = root_dir
        elif notebook_path:
            candidate = os.path.dirname(os.path.abspath(notebook_path))
        else:
            raise WorkingDirectoryError(
                "Cannot determine working directory: neither VARYS_AGENT_WORKING_DIR "
                "nor root_dir is available."
            )

    resolved = os.path.realpath(candidate)

    if resolved == "/":
        raise WorkingDirectoryError(
            f"Working directory '{resolved}' is the filesystem root — not allowed for safety. "
            "Set VARYS_AGENT_WORKING_DIR to your project directory."
        )
    if resolved == str(Path.home()):
        raise WorkingDirectoryError(
            f"Working directory '{resolved}' is your home directory — not allowed for safety. "
            "Set VARYS_AGENT_WORKING_DIR to your project directory."
        )
    if not os.path.isdir(resolved):
        raise WorkingDirectoryError(
            f"Working directory '{resolved}' does not exist or is not a directory."
        )
    return resolved

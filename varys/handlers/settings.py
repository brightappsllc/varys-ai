"""Settings handler — GET/POST /varys/settings

Reads and writes the .env file in the notebook root directory so users
can configure the extension through the JupyterLab UI instead of manually
editing the file.  After a POST the backend settings are hot-reloaded so
no server restart is needed.

The GET response also includes ``advisoryPhrases`` — the list of message
prefixes that trigger the disambiguation card.  These are loaded from
``.jupyter-assistant/rules/advisory-phrases.md`` (falls back to the
built-in defaults when the file is absent).
"""
import json
import os
import re
from pathlib import Path

from jupyter_server.base.handlers import JupyterHandler
from tornado.web import authenticated

# Keys exposed to the UI (in display order)
_ENV_KEYS = [
    # ── Routing ──────────────────────────────────────────────────────────
    "DS_CHAT_PROVIDER",
    "DS_COMPLETION_PROVIDER",
    "COMPLETION_MAX_TOKENS",
    "DS_EMBED_PROVIDER",
    "DS_SIMPLE_TASKS_PROVIDER",
    # ── Anthropic ────────────────────────────────────────────────────────
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_CHAT_MODEL",
    "ANTHROPIC_COMPLETION_MODEL",
    "ANTHROPIC_SIMPLE_TASKS_MODEL",
    "ANTHROPIC_EMBED_MODEL",
    "ANTHROPIC_EXTENDED_THINKING",
    # ── OpenAI ───────────────────────────────────────────────────────────
    "OPENAI_API_KEY",
    "OPENAI_CHAT_MODEL",
    "OPENAI_COMPLETION_MODEL",
    "OPENAI_SIMPLE_TASKS_MODEL",
    "OPENAI_EMBED_MODEL",
    # ── Google ───────────────────────────────────────────────────────────
    "GOOGLE_API_KEY",
    "GOOGLE_CHAT_MODEL",
    "GOOGLE_COMPLETION_MODEL",
    "GOOGLE_SIMPLE_TASKS_MODEL",
    "GOOGLE_EMBED_MODEL",
    # ── AWS Bedrock ──────────────────────────────────────────────────────
    "AWS_PROFILE",
    "AWS_AUTH_REFRESH",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "AWS_REGION",
    "BEDROCK_CHAT_MODEL",
    "BEDROCK_COMPLETION_MODEL",
    "BEDROCK_SIMPLE_TASKS_MODEL",
    "BEDROCK_EMBED_MODEL",
    # ── Azure OpenAI ─────────────────────────────────────────────────────
    "AZURE_OPENAI_API_KEY",
    "AZURE_OPENAI_ENDPOINT",
    "AZURE_OPENAI_API_VERSION",
    "AZURE_CHAT_MODEL",
    "AZURE_COMPLETION_MODEL",
    "AZURE_SIMPLE_TASKS_MODEL",
    "AZURE_EMBED_MODEL",
    # ── Ollama ───────────────────────────────────────────────────────────
    "OLLAMA_URL",
    "OLLAMA_CHAT_MODEL",
    "OLLAMA_COMPLETION_MODEL",
    "OLLAMA_SIMPLE_TASKS_MODEL",
    "OLLAMA_EMBED_MODEL",
    # ── OpenRouter ───────────────────────────────────────────────────────
    "OPENROUTER_API_KEY",
    "OPENROUTER_SITE_URL",
    "OPENROUTER_SITE_NAME",
    "OPENROUTER_CHAT_MODEL",
    "OPENROUTER_COMPLETION_MODEL",
    "OPENROUTER_SIMPLE_TASKS_MODEL",
    "OPENROUTER_EMBED_MODEL",
    # ── Model zoos (comma-separated lists, one per provider) ─────────────
    "ANTHROPIC_MODELS",
    "OPENAI_MODELS",
    "GOOGLE_MODELS",
    "BEDROCK_MODELS",
    "AZURE_MODELS",
    "OPENROUTER_MODELS",
    "OLLAMA_MODELS",
    # ── Varys File Agent ─────────────────────────────────────────────────────
    "VARYS_AGENT_PROVIDER",
    "VARYS_AGENT_PROMPT_CACHING",
    # ── Varys Remote Kernel ──────────────────────────────────────────────────
    # Set to "true" when using sshpyk or any SSH-based kernel that does NOT
    # use the "rnk_" naming prefix (which remote_ikernel sets automatically).
    # Tells Varys to inject an EC2-aware note in every LLM context block.
    "VARYS_KERNEL_IS_REMOTE",
]

_SENSITIVE = {
    "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_API_KEY",
    "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN",
    "AZURE_OPENAI_API_KEY", "OPENROUTER_API_KEY",
}
_MASK_PLACEHOLDER = "••••••••"


_DEFAULT_ENV_PATH = Path.home() / ".jupyter" / "varys.env"
_POINTER_FILE     = Path.home() / ".jupyter" / ".varys_env_path"


def resolve_env_path() -> Path:
    """Return the active varys.env path.

    Resolution order (first match wins):
      1. ``VARYS_ENV_PATH`` environment variable — set in your shell profile
         or when launching JupyterLab to override for that session.
      2. Pointer file ``~/.jupyter/.varys_env_path`` — a single-line text
         file written by the Settings UI when the user chooses a custom
         location.
      3. Default: ``~/.jupyter/varys.env``
    """
    # 1. Shell / process environment variable
    env_var = os.environ.get("VARYS_ENV_PATH", "").strip()
    if env_var:
        return Path(env_var).expanduser()

    # 2. Pointer file written by the UI
    if _POINTER_FILE.exists():
        try:
            stored = _POINTER_FILE.read_text(encoding="utf-8").strip()
            if stored:
                return Path(stored).expanduser()
        except OSError:
            pass

    # 3. Default
    return _DEFAULT_ENV_PATH


def _env_path(settings: dict) -> Path:
    """Return path to the Varys .env config file (settings-dict compat wrapper)."""
    return resolve_env_path()


def _read_env(path: Path) -> dict:
    """Parse key=value pairs from an .env file.

    Consistent with factory._load_varys_env(): strips surrounding quotes and
    inline comments so the UI never shows raw ``"sk-ant-..."`` values.
    """
    values: dict = {}
    if not path.exists():
        return values
    for line in path.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        m = re.match(r"^([A-Z0-9_]+)\s*=\s*(.*)", stripped)
        if m:
            key, val = m.group(1), m.group(2).strip()
            # Strip inline comments (value ends at first unquoted #)
            val = re.sub(r"\s+#.*$", "", val)
            # Strip surrounding quotes (single or double) — same as factory._load_varys_env
            val = val.strip("\"'")
            values[key] = val
    return values


def _write_env(path: Path, updates: dict) -> None:
    """Update key=value pairs in .env, preserving comments and structure.

    Keys already in the file are updated in-place.
    New keys are appended at the end.
    """
    remaining = dict(updates)  # keys not yet written
    lines: list = []

    if path.exists():
        for line in path.read_text(encoding="utf-8").splitlines():
            m = re.match(r"^([A-Z0-9_]+)\s*=", line)
            if m and m.group(1) in remaining:
                key = m.group(1)
                lines.append(f"{key}={remaining.pop(key)}")
            else:
                lines.append(line)

    # Append any keys that were not in the file yet
    for key, val in remaining.items():
        lines.append(f"{key}={val}")

    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def _reload_settings(handler: JupyterHandler, env_path: Path) -> None:
    """Re-read .env and update self.settings without restarting Jupyter."""
    try:
        from dotenv import load_dotenv
        load_dotenv(env_path, override=True)
    except ImportError:
        pass

    s = handler.settings
    # No silent fallbacks: empty string means unconfigured; user must set via Settings UI
    s["ds_assistant_chat_provider"]           = os.environ.get("DS_CHAT_PROVIDER", "").lower()
    s["ds_assistant_completion_provider"]     = os.environ.get("DS_COMPLETION_PROVIDER", "").lower()
    s["ds_assistant_completion_max_tokens"]   = int(os.environ.get("COMPLETION_MAX_TOKENS", "") or "128")
    s["ds_assistant_embed_provider"]          = os.environ.get("DS_EMBED_PROVIDER", "").lower()
    s["ds_assistant_simple_tasks_provider"]   = os.environ.get("DS_SIMPLE_TASKS_PROVIDER", "").lower()

    # Anthropic feature flags (default true — "false" string turns them off)
    s["ds_assistant_anthropic_extended_thinking"] = (
        os.environ.get("ANTHROPIC_EXTENDED_THINKING", "true").lower() != "false"
    )

    # Credentials
    s["ds_assistant_anthropic_api_key"]          = os.environ.get("ANTHROPIC_API_KEY", "")
    s["ds_assistant_openai_api_key"]             = os.environ.get("OPENAI_API_KEY", "")
    s["ds_assistant_google_api_key"]             = os.environ.get("GOOGLE_API_KEY", "")
    s["ds_assistant_aws_profile"]                = os.environ.get("AWS_PROFILE", "")
    s["ds_assistant_aws_auth_refresh"]           = os.environ.get("AWS_AUTH_REFRESH", "")
    s["ds_assistant_aws_access_key_id"]          = os.environ.get("AWS_ACCESS_KEY_ID", "")
    s["ds_assistant_aws_secret_access_key"]      = os.environ.get("AWS_SECRET_ACCESS_KEY", "")
    s["ds_assistant_aws_session_token"]          = os.environ.get("AWS_SESSION_TOKEN", "")
    s["ds_assistant_aws_region"]                 = os.environ.get("AWS_REGION", "us-east-1")
    s["ds_assistant_azure_openai_api_key"]       = os.environ.get("AZURE_OPENAI_API_KEY", "")
    s["ds_assistant_azure_openai_endpoint"]      = os.environ.get("AZURE_OPENAI_ENDPOINT", "")
    s["ds_assistant_azure_openai_api_version"]   = os.environ.get("AZURE_OPENAI_API_VERSION", "2024-02-01")
    s["ds_assistant_ollama_url"]                 = os.environ.get("OLLAMA_URL", "http://localhost:11434")
    s["ds_assistant_openrouter_api_key"]         = os.environ.get("OPENROUTER_API_KEY", "")
    s["ds_assistant_openrouter_site_url"]        = os.environ.get("OPENROUTER_SITE_URL", "")
    s["ds_assistant_openrouter_site_name"]       = os.environ.get("OPENROUTER_SITE_NAME", "Varys")

    for provider in ("ANTHROPIC", "OPENAI", "GOOGLE", "BEDROCK", "AZURE", "OPENROUTER", "OLLAMA"):
        for task in ("chat", "completion", "embed", "simple_tasks"):
            s[f"ds_assistant_{provider.lower()}_{task}_model"] = os.environ.get(
                f"{provider}_{task.upper()}_MODEL", ""
            )


# ---------------------------------------------------------------------------
# Advisory phrases — loaded from .jupyter-assistant/rules/advisory-phrases.md
# ---------------------------------------------------------------------------

_DEFAULT_ADVISORY_PHRASES = [
    "what ", "what is ", "what are ", "what does ", "what do ",
    "what was ", "what were ",
    "how ", "how does ", "how do ", "how can ", "how would ",
    "why ", "when ", "where ", "who ", "which ",
    "explain ", "describe ", "tell me", "can you tell",
    "give me a summary", "give me an overview",
    "analyze ", "analyse ", "interpret ", "look at ", "check ",
    "summarize ", "summarise ",
    "is there ", "are there ", "do you think", "would you ",
]

_ADVISORY_PHRASES_FILENAME = "advisory-phrases.md"


def _load_advisory_phrases(root_dir: str) -> list[str]:
    """Load advisory phrases from .jupyter-assistant/rules/advisory-phrases.md.

    Lines starting with '#' and empty lines are ignored.  Falls back to the
    built-in defaults when the file does not exist.
    """
    rules_file = (
        Path(root_dir) / ".jupyter-assistant" / "rules" / _ADVISORY_PHRASES_FILENAME
    )
    if not rules_file.exists():
        return _DEFAULT_ADVISORY_PHRASES

    phrases: list[str] = []
    for raw in rules_file.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        phrases.append(line)

    return phrases if phrases else _DEFAULT_ADVISORY_PHRASES


class SettingsHandler(JupyterHandler):
    """GET  — return current .env values (API key masked) + advisory phrases.
    POST — receive updated values, write .env, hot-reload settings.
    """

    @authenticated
    def get(self):
        self.set_header("Content-Type", "application/json")
        path = _env_path(self.settings)
        current = _read_env(path)

        result = {}
        for key in _ENV_KEYS:
            val = current.get(key, "")
            if key in _SENSITIVE and val:
                # Show only the prefix so users know a value is set
                visible = val[:12] + _MASK_PLACEHOLDER if len(val) > 12 else _MASK_PLACEHOLDER
                result[key] = {"value": visible, "masked": True}
            else:
                result[key] = {"value": val, "masked": False}

        result["_env_path"]         = str(path)
        result["_env_exists"]       = path.exists()
        result["_env_path_is_custom"] = path != _DEFAULT_ENV_PATH

        # Include advisory phrases so the frontend can use the user-configured
        # list instead of the hardcoded defaults.
        root_dir = self.settings.get("ds_assistant_root_dir", ".")
        result["_advisoryPhrases"] = _load_advisory_phrases(root_dir)

        self.finish(json.dumps(result))

    @authenticated
    def post(self):
        self.set_header("Content-Type", "application/json")
        path = _env_path(self.settings)

        try:
            body = json.loads(self.request.body)
        except json.JSONDecodeError:
            self.set_status(400)
            self.finish(json.dumps({"error": "Invalid JSON"}))
            return

        # ── Handle env-file path change BEFORE collecting key/value updates ─
        new_path_raw = body.get("_new_env_path", "").strip()
        if new_path_raw:
            new_path = Path(new_path_raw).expanduser().resolve()
            old_path = path
            if new_path != old_path:
                try:
                    new_path.parent.mkdir(parents=True, exist_ok=True)
                    # Copy existing env content to the new location
                    if old_path.exists():
                        import shutil
                        shutil.copy2(old_path, new_path)
                    else:
                        new_path.touch()
                    # Write pointer so future startups use the new path
                    _POINTER_FILE.write_text(str(new_path), encoding="utf-8")
                    path = new_path
                    self.log.info("Varys: env file moved to %s", new_path)
                except Exception as e:
                    self.set_status(400)
                    self.finish(json.dumps({"error": f"Cannot move env file: {e}"}))
                    return

        updates = {}
        for key in _ENV_KEYS:
            val = body.get(key)
            if val is None:
                continue
            # Skip sensitive fields that weren't changed (still masked)
            if key in _SENSITIVE and _MASK_PLACEHOLDER in str(val):
                continue
            updates[key] = str(val).strip()

        if not updates and new_path_raw == "":
            self.finish(json.dumps({"status": "no changes"}))
            return

        try:
            if updates:
                _write_env(path, updates)
            _reload_settings(self, path)
            self.log.info("Varys: settings updated and reloaded from %s", path)
            self.finish(json.dumps({"status": "ok", "updated": list(updates.keys())}))
        except Exception as e:
            self.log.error("Varys: failed to write settings: %s", e)
            self.set_status(500)
            self.finish(json.dumps({"error": str(e)}))

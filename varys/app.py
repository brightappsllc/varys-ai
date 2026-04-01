"""Server extension application for Varys — your DS assistant for Jupyter Notebook."""
import os
from pathlib import Path

from jupyter_server.extension.application import ExtensionApp
from jupyter_server.utils import url_path_join

from .handlers.health import HealthHandler
from .handlers.task import TaskHandler
from .handlers.complete import CompleteHandler
from .handlers.ollama import (
    OllamaHealthHandler,
    OllamaModelsHandler,
    OllamaCheckInstallHandler,
)
from .handlers.settings import SettingsHandler
from .handlers.skills import SkillsListHandler, SkillHandler, CommandsHandler
from .handlers.bundled_skills import BundledSkillsHandler
from .utils.config import init_config
from .handlers.report import ReportHandler
from .handlers.wiki import WikiHandler
from .handlers.magic_task import MagicTaskHandler
from .handlers.chat_history import ChatHistoryHandler
from .modules.reproducibility_guardian.handler import (
    ReproAnalyzeHandler,
    ReproDismissHandler,
    ReproIssuesHandler,
)
from .handlers.mcp_handler import MCPStatusHandler, MCPReloadHandler, MCPServersHandler
from .handlers.cell_executed import CellExecutedHandler
from .handlers.cell_lifecycle import CellLifecycleHandler
from .handlers.symbols import SymbolsHandler
from .handlers.auto_tag import AutoTagHandler
from .handlers.agent_accept import AgentAcceptHandler
from .handlers.agent_reject import AgentRejectHandler
from .handlers.agent_change import AgentChangeHandler
from .handlers.agent_handler import AgentHandler
from .handlers.agent_settings import AgentSettingsHandler, AgentToolSupportHandler
from .handlers.notebook_opened import NotebookOpenedHandler
from .handlers.warnings import WarningsHandler
from .handlers.usage import UsageHandler
from .handlers.graph import GraphHandler
from .handlers.version_check import VersionCheckHandler
from .handlers.changelog import ChangelogHandler
from .handlers.nb_move import NbMoveHandler


class DSAssistantExtension(ExtensionApp):
    """Varys JupyterLab server extension."""

    name = "varys"
    default_url = "/varys"
    load_other_extensions = True

    def _load_env_file(self, path: Path) -> None:
        """Load key=value pairs from an env file into os.environ."""
        import re
        try:
            for line in path.read_text(encoding="utf-8").splitlines():
                stripped = line.strip()
                if not stripped or stripped.startswith("#"):
                    continue
                m = re.match(r"^([A-Z0-9_]+)\s*=\s*(.*)", stripped)
                if m:
                    key, val = m.group(1), m.group(2).strip()
                    val = re.sub(r"\s+#.*$", "", val).strip('"\'')
                    os.environ[key] = val
            self.log.info(f"Varys: Loaded env from {path}")
        except Exception as exc:
            self.log.warning(f"Varys: could not read {path}: {exc}")

    def initialize_settings(self):
        """Initialize extension settings."""
        self.log.info("Varys: Initializing settings")

        # Load the configured varys.env (user-level, persists across projects)
        # then optionally overlay with a project-level .env in root_dir.
        # Also load the global skill-disabled state from ~/.jupyter/varys_skills.env.
        from .handlers.settings import resolve_env_path
        env_paths = [
            resolve_env_path(),
            Path(self.serverapp.root_dir) / ".env",
            Path.home() / ".jupyter" / "varys_skills.env",
        ]
        for env_path in env_paths:
            if env_path.exists():
                self._load_env_file(env_path)

        # Initialise the centralised config loader so every module can call
        # get_config() without needing the root_dir passed explicitly.
        cfg = init_config(str(self.serverapp.root_dir))
        self.log.info("Varys: Config loaded from %s/.jupyter-assistant/config/", self.serverapp.root_dir)

        # ----------------------------------------------------------------
        # Task routing: DS_CHAT_PROVIDER / DS_COMPLETION_PROVIDER
        # Values are provider names matching the .env blocks (e.g. ANTHROPIC).
        # Stored lower-case internally.
        # ----------------------------------------------------------------
        chat_provider         = os.environ.get("DS_CHAT_PROVIDER", "").upper()
        completion_provider   = os.environ.get("DS_COMPLETION_PROVIDER", "").upper()
        simple_tasks_provider = os.environ.get("DS_SIMPLE_TASKS_PROVIDER", "").upper()

        providers_in_use = {chat_provider, completion_provider, simple_tasks_provider}
        settings_patch: dict = {
            "ds_assistant_root_dir":              self.serverapp.root_dir,
            "ds_assistant_chat_provider":         chat_provider.lower(),
            "ds_assistant_completion_provider":   completion_provider.lower(),
            "ds_assistant_simple_tasks_provider": simple_tasks_provider.lower(),
        }

        # ----------------------------------------------------------------
        # Provider credentials (always loaded regardless of which providers
        # are active — the factory uses only what it needs)
        # ----------------------------------------------------------------
        def _bool_env(key: str) -> bool:
            return os.environ.get(key, "").lower() in ("1", "true", "yes")

        def _int_env(key: str, default: int) -> int:
            return int(os.environ.get(key, "") or str(default))

        settings_patch.update({
            # Anthropic
            "ds_assistant_anthropic_api_key":       os.environ.get("ANTHROPIC_API_KEY", ""),
            # OpenAI
            "ds_assistant_openai_api_key":          os.environ.get("OPENAI_API_KEY", ""),
            # Google
            "ds_assistant_google_api_key":              os.environ.get("GOOGLE_API_KEY", ""),
            "ds_assistant_google_service_account_json": os.environ.get("GOOGLE_SERVICE_ACCOUNT_JSON", ""),
            "ds_assistant_google_enable_thinking":      _bool_env("GOOGLE_ENABLE_THINKING"),
            "ds_assistant_google_thinking_budget":      _int_env("GOOGLE_THINKING_BUDGET", 8192),
            # AWS Bedrock
            "ds_assistant_aws_profile":             os.environ.get("AWS_PROFILE", ""),
            "ds_assistant_aws_auth_refresh":        os.environ.get("AWS_AUTH_REFRESH", ""),
            "ds_assistant_aws_access_key_id":       os.environ.get("AWS_ACCESS_KEY_ID", ""),
            "ds_assistant_aws_secret_access_key":   os.environ.get("AWS_SECRET_ACCESS_KEY", ""),
            "ds_assistant_aws_session_token":       os.environ.get("AWS_SESSION_TOKEN", ""),
            "ds_assistant_aws_region":              os.environ.get("AWS_REGION", "us-east-1"),
            "ds_assistant_bedrock_enable_thinking": _bool_env("BEDROCK_ENABLE_THINKING"),
            "ds_assistant_bedrock_thinking_budget": _int_env("BEDROCK_THINKING_BUDGET", 10000),
            "ds_assistant_bedrock_max_tokens":      _int_env("BEDROCK_MAX_TOKENS", 0),
            # Azure OpenAI
            "ds_assistant_azure_openai_api_key":    os.environ.get("AZURE_OPENAI_API_KEY", ""),
            "ds_assistant_azure_openai_endpoint":   os.environ.get("AZURE_OPENAI_ENDPOINT", ""),
            "ds_assistant_azure_openai_api_version": os.environ.get("AZURE_OPENAI_API_VERSION", "2024-02-01"),
            # Ollama
            "ds_assistant_ollama_url":              os.environ.get("OLLAMA_URL", "http://localhost:11434"),
            # OpenRouter
            "ds_assistant_openrouter_api_key":      os.environ.get("OPENROUTER_API_KEY", ""),
            "ds_assistant_openrouter_site_url":     os.environ.get("OPENROUTER_SITE_URL", ""),
            "ds_assistant_openrouter_site_name":    os.environ.get("OPENROUTER_SITE_NAME", "Varys"),
        })

        # Embedding provider routing
        embed_provider = os.environ.get("DS_EMBED_PROVIDER", "").upper()
        settings_patch["ds_assistant_embed_provider"] = embed_provider.lower()

        # Collect {PROVIDER}_{TASK}_MODEL for every provider and task type
        all_providers = {"ANTHROPIC", "OLLAMA", "OPENAI", "GOOGLE", "BEDROCK", "AZURE", "OPENROUTER"}
        for provider in all_providers:
            for task in ("chat", "completion", "embed", "simple_tasks"):
                env_key  = f"{provider}_{task.upper()}_MODEL"
                sett_key = f"ds_assistant_{provider.lower()}_{task}_model"
                settings_patch[sett_key] = os.environ.get(env_key, "")

        # Completion token limit
        settings_patch["ds_assistant_completion_max_tokens"] = int(
            os.environ.get("COMPLETION_MAX_TOKENS", "") or "128"
        )

        # ----------------------------------------------------------------
        # Bash guard configuration
        # ----------------------------------------------------------------
        # BASH_GUARD_ENABLED and BASH_GUARD_BLOCK_ON_WARN are read directly
        # from os.environ by bash_guard.py (_guard_enabled / _block_on_warn).
        # Logging their effective values here helps with misconfiguration diagnosis.
        _bg_enabled = os.environ.get("BASH_GUARD_ENABLED", "true").strip().lower()
        _bg_strict  = os.environ.get("BASH_GUARD_BLOCK_ON_WARN", "false").strip().lower()
        self.log.info(
            "Varys: bash guard enabled=%s block_on_warn=%s", _bg_enabled, _bg_strict
        )

        # ----------------------------------------------------------------
        # Debug logging
        # ----------------------------------------------------------------
        raw_debug = os.environ.get("DEBUG_LOG", "false").strip().lower()
        settings_patch["ds_assistant_debug_log"] = raw_debug in ("1", "true", "yes", "on")
        settings_patch["ds_assistant_debug_log_dir"] = os.environ.get(
            "DEBUG_LOG_DIR", "~/.jupyter/varys_logs"
        )

        # ----------------------------------------------------------------
        # Scorer / pruning parameters — validated on startup
        # ----------------------------------------------------------------
        try:
            scorer_min_cells = int(os.environ.get("SCORER_MIN_CELLS", "2") or "2")
        except ValueError as exc:
            raise ValueError(
                f"Varys: SCORER_MIN_CELLS must be an integer — {exc}"
            ) from exc

        raw_threshold = os.environ.get("SCORER_MIN_SCORE_THRESHOLD", "0.3") or "0.3"
        try:
            scorer_threshold = float(raw_threshold)
        except ValueError as exc:
            raise ValueError(
                f"Varys: SCORER_MIN_SCORE_THRESHOLD must be a float — {exc}"
            ) from exc
        if not (0.0 <= scorer_threshold <= 1.0):
            raise ValueError(
                f"Varys: SCORER_MIN_SCORE_THRESHOLD={scorer_threshold!r} is outside [0, 1]. "
                "Fix the value in ~/.jupyter/varys.env and restart JupyterLab."
            )

        settings_patch["ds_assistant_scorer_min_cells"] = scorer_min_cells
        settings_patch["ds_assistant_scorer_min_score_threshold"] = scorer_threshold

        self.settings.update(settings_patch)

        self.log.info(
            f"Varys: "
            f"chat={chat_provider or '(not set)'}  "
            f"completion={completion_provider or '(not set)'}  "
            f"embed={embed_provider or '(not set)'}"
        )

        # ----------------------------------------------------------------
        # Pre-load all skills from .jupyter-assistant/skills/ at startup
        # so the first request has zero disk-read latency.
        # ----------------------------------------------------------------
        try:
            from .skills.loader import SkillLoader
            skill_loader = SkillLoader(root_dir=self.serverapp.root_dir)
            skill_loader.preload()
            self.settings["ds_assistant_skill_loader"] = skill_loader
        except Exception as exc:
            self.log.warning("Varys: could not pre-load skills — %s", exc)

        # ----------------------------------------------------------------
        # Anthropic feature flags
        # ----------------------------------------------------------------
        self.settings["ds_assistant_anthropic_extended_thinking"] = (
            os.environ.get("ANTHROPIC_EXTENDED_THINKING", "true").lower() != "false"
        )

        # ----------------------------------------------------------------
        # MCP server manager — start all configured servers in background.
        # Failures are non-fatal: Varys works fine with zero MCP servers.
        # ----------------------------------------------------------------
        try:
            import asyncio
            from .mcp.manager import MCPManager
            mcp_manager = MCPManager()
            self.settings["ds_mcp_manager"] = mcp_manager
            # Schedule startup on the running event loop without blocking init
            loop = asyncio.get_event_loop()
            loop.create_task(mcp_manager.start_all())
            self.log.info("Varys MCP: manager registered; servers starting in background")
        except Exception as exc:
            self.log.warning("Varys MCP: could not initialise manager — %s", exc)

        # ── Agent sessions — in-memory store for staged file changes ──────────
        self.settings["agent_sessions"] = {}

        # ── TTL cleanup for abandoned agent sessions (30-minute fallback) ────
        try:
            from tornado.ioloop import PeriodicCallback
            from datetime import datetime, timedelta

            def _agent_session_ttl_cleanup():
                import json
                from pathlib import Path
                sessions = self.settings.get("agent_sessions", {})
                cutoff = datetime.now() - timedelta(minutes=30)
                stale_ids = [
                    op_id for op_id, s in sessions.items()
                    if s.get("created_at", datetime.now()) < cutoff
                ]
                for op_id in stale_ids:
                    session = sessions.pop(op_id, None)
                    if session is None:
                        continue
                    working_dir = session.get("working_dir", "")
                    if not working_dir:
                        continue
                    # Write partial audit log entry
                    try:
                        log_dir = Path(working_dir) / ".jupyter-assistant" / "logs"
                        log_dir.mkdir(parents=True, exist_ok=True)
                        outcomes = session.get("outcomes", {})
                        pending  = session.get("pending_changes", {})
                        all_changes = session.get("all_changes", {})
                        file_changes = []
                        for cid, outcome in outcomes.items():
                            fc = all_changes.get(cid)
                            file_changes.append({
                                "file_path": fc.file_path if fc and hasattr(fc, "file_path") else "unknown",
                                "change_type": fc.change_type if fc and hasattr(fc, "change_type") else "unknown",
                                "outcome": outcome,
                            })
                        for cid, fc in pending.items():
                            if cid not in outcomes:
                                file_changes.append({
                                    "file_path": fc.file_path if hasattr(fc, "file_path") else "unknown",
                                    "change_type": fc.change_type if hasattr(fc, "change_type") else "unknown",
                                    "outcome": None,
                                })
                        entry = {
                            "timestamp": datetime.now().isoformat(),
                            "trigger": session.get("trigger", "slash_command"),
                            "operation_id": op_id,
                            "task_description": session.get("task_description", ""),
                            "working_dir": working_dir,
                            "tools_used": session.get("tools_used", []),
                            "files_read": session.get("files_read", []),
                            "bash_commands": [],
                            "turn_count": session.get("turn_count", 0),
                            "duration_seconds": session.get("duration_seconds", 0.0),
                            "model": session.get("model", ""),
                            "incomplete": True,
                            "file_changes": file_changes,
                            "ttl_expired": True,
                        }
                        with open(log_dir / "agent_audit.jsonl", "a", encoding="utf-8") as fh:
                            fh.write(json.dumps(entry) + "\n")
                    except Exception as cleanup_exc:
                        self.log.debug("TTL audit log failed: %s", cleanup_exc)
                if stale_ids:
                    self.log.info("Varys: TTL cleanup removed %d stale agent session(s)", len(stale_ids))

            # Run every 5 minutes
            _ttl_cb = PeriodicCallback(_agent_session_ttl_cleanup, 5 * 60 * 1000)
            _ttl_cb.start()
            self.settings["_agent_ttl_callback"] = _ttl_cb
        except Exception as ttl_exc:
            self.log.warning("Varys: could not register agent TTL cleanup: %s", ttl_exc)

    def initialize_handlers(self):
        """Register URL handlers."""
        self.log.info("Varys: Registering handlers")
        base = self.default_url

        self.handlers.extend([
            (url_path_join(base, "health"), HealthHandler),
            (url_path_join(base, "task"), TaskHandler),
            (url_path_join(base, "complete"), CompleteHandler),
            # Ollama utility endpoints
            (url_path_join(base, "ollama", "health"), OllamaHealthHandler),
            (url_path_join(base, "ollama", "models"), OllamaModelsHandler),
            (url_path_join(base, "ollama", "check-install"), OllamaCheckInstallHandler),
            # Settings (read/write .env)
            (url_path_join(base, "settings"), SettingsHandler),
            # Skills (list / read / write .md files)
            (url_path_join(base, "skills"), SkillsListHandler),
            (url_path_join(base, r"skills/([\w\-]+)"), SkillHandler),
            (url_path_join(base, "bundled-skills"), BundledSkillsHandler),
            # Slash commands (built-ins + skill commands)
            (url_path_join(base, "commands"), CommandsHandler),
            # Report generation
            (url_path_join(base, "report"), ReportHandler),
            # Local wiki
            (url_path_join(base, "wiki"), WikiHandler),
            # %%ai magic — synchronous (non-SSE) chat endpoint
            (url_path_join(base, "magic"), MagicTaskHandler),
            # Chat thread persistence (GET / POST / DELETE)
            (url_path_join(base, "chat-history"), ChatHistoryHandler),
            (url_path_join(base, "reproducibility", "analyze"), ReproAnalyzeHandler),
            (url_path_join(base, "reproducibility", "dismiss"), ReproDismissHandler),
            (url_path_join(base, "reproducibility"),            ReproIssuesHandler),
            # MCP server management
            (url_path_join(base, "mcp"),           MCPStatusHandler),
            (url_path_join(base, "mcp", "reload"), MCPReloadHandler),
            (url_path_join(base, "mcp", "servers"), MCPServersHandler),
            # Smart Cell Context — execution + lifecycle hooks
            (url_path_join(base, "cell-executed"),  CellExecutedHandler),
            (url_path_join(base, "cell-lifecycle"), CellLifecycleHandler),
            # @-mention autocomplete — symbol names from SummaryStore
            (url_path_join(base, "symbols"), SymbolsHandler),
            # LLM-based auto-tagging for a single cell
            (url_path_join(base, "auto-tag"), AutoTagHandler),
            # Varys File Agent endpoints
            (url_path_join(base, "agent", "accept"),        AgentAcceptHandler),
            (url_path_join(base, "agent", "reject"),        AgentRejectHandler),
            (url_path_join(base, r"agent/change/([^/]+)"), AgentChangeHandler),
            (url_path_join(base, "agent"),                  AgentHandler),
            (url_path_join(base, "agent-settings", "tool-support"), AgentToolSupportHandler),
            (url_path_join(base, "agent-settings"),                  AgentSettingsHandler),
            (url_path_join(base, "notebook-opened"),        NotebookOpenedHandler),
            (url_path_join(base, "warnings"),               WarningsHandler),
            (url_path_join(base, "usage"),                  UsageHandler),
            # Notebook Dependency Graph
            (url_path_join(base, "graph"),                  GraphHandler),
            # Version update check (queries GitHub Releases, cached 1 h)
            (url_path_join(base, "version-check"),          VersionCheckHandler),
            # Changelog (serves local CHANGELOG.md, optionally sliced)
            (url_path_join(base, "changelog"),              ChangelogHandler),
            # Notebook move — relocates .ipynb + UUID-scoped Varys data atomically
            (url_path_join(base, "nb", "move"),             NbMoveHandler),
        ])

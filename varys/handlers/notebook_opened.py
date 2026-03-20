"""POST /varys/notebook-opened — trigger background repo scan on notebook open."""
from __future__ import annotations

import asyncio
import json
import logging
import os

from jupyter_server.base.handlers import JupyterHandler
from tornado.web import authenticated

log = logging.getLogger(__name__)


class NotebookOpenedHandler(JupyterHandler):
    """POST /varys/notebook-opened"""

    @authenticated
    async def post(self):
        try:
            body = json.loads(self.request.body)
        except json.JSONDecodeError:
            self.set_status(400)
            self.finish(json.dumps({"error": "Invalid JSON body"}))
            return

        notebook_path = body.get("notebook_path", "")

        # Load project-local config — run in a thread because dotenv reads disk.
        from ..agent.local_config import load_local_agent_config, get_agent_env
        local_cfg = await asyncio.to_thread(load_local_agent_config, notebook_path)

        # Check feature flags using local config
        enabled = get_agent_env("VARYS_AGENT_ENABLED", local_cfg, "false").lower() in ("1", "true", "yes")
        scan_enabled = get_agent_env("VARYS_AGENT_BACKGROUND_SCAN", local_cfg, "true").lower() not in ("0", "false", "no")

        if not enabled or not scan_enabled:
            self.set_header("Content-Type", "application/json")
            self.finish(json.dumps({"scan_status": "disabled"}))
            return

        # Validate config (reads .env file — run in thread)
        try:
            from ..agent.utils import validate_agent_config
            await asyncio.to_thread(validate_agent_config)
        except Exception:
            self.set_header("Content-Type", "application/json")
            self.finish(json.dumps({"scan_status": "disabled", "reason": "configuration_missing"}))
            return

        # Resolve working directory (local config takes precedence)
        try:
            from ..agent.utils import resolve_working_directory
            working_dir = resolve_working_directory(notebook_path, self.settings, local_cfg)
        except Exception as exc:
            self.set_header("Content-Type", "application/json")
            self.finish(json.dumps({"scan_status": "disabled", "reason": str(exc)}))
            return

        # ── Freshness check ───────────────────────────────────────────────────
        # _compute_file_tree_hash() walks the entire project tree (os.stat on
        # every file up to depth 4).  Running it on the event loop would block
        # all other Tornado handlers — including the simultaneous
        # GET /varys/chat-history that loads the notebook's chat messages.
        # Offload to a thread so the event loop stays responsive.
        from ..agent.repo_scan_store import _compute_file_tree_hash, is_scan_fresh
        current_hash = await asyncio.to_thread(_compute_file_tree_hash, working_dir)

        # is_scan_fresh reads a JSON file — also off-thread for consistency.
        fresh = await asyncio.to_thread(is_scan_fresh, working_dir, current_hash)
        if fresh:
            self.set_header("Content-Type", "application/json")
            self.finish(json.dumps({"scan_status": "fresh"}))
            return

        # Queue background scan — pass the already-computed hash so the scan
        # coroutine doesn't have to recompute it at the end.
        max_tokens = int(os.environ.get("VARYS_AGENT_MAX_TOKENS", "8192"))
        from ..agent.repo_scan_store import run_background_scan
        asyncio.ensure_future(run_background_scan(
            working_dir,
            max_tokens=max_tokens,
            app_settings=self.settings,
            known_hash=current_hash,
        ))

        self.set_header("Content-Type", "application/json")
        self.finish(json.dumps({"scan_status": "queued"}))

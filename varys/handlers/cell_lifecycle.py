"""POST /varys/cell-lifecycle — cell delete / restore / tag lifecycle events.

Receives lifecycle events from the frontend and updates the SummaryStore.
This endpoint is separate from /cell-executed because the semantics differ:
execution produces summaries, lifecycle events only mutate metadata flags.

Expected request body:
  {
    "notebook_path": "relative/path/to/notebook.ipynb",
    "cell_id":       "<stable JupyterLab UUID>",
    "action":        "deleted" | "restored" | "tags_changed",
    "tags":          ["important", "skip-execution"]   // required for tags_changed
  }

Action semantics
----------------
deleted       — set deleted=True on the latest version entry.
restored      — clear deleted flag on the latest version entry.
tags_changed  — patch ``tags`` and ``tags_updated_at`` in the latest version's
                summary dict **without** creating a new version or changing the
                source hash.  Handles both tag additions and removals — the
                frontend always sends the complete current tag list.
"""
import json
import logging

from jupyter_server.base.handlers import JupyterHandler
from tornado.web import authenticated

log = logging.getLogger(__name__)


class CellLifecycleHandler(JupyterHandler):
    """Handle cell-removed and cell-added (restore) lifecycle events."""

    @authenticated
    async def post(self) -> None:
        self.set_header("Content-Type", "application/json")

        try:
            body: dict = json.loads(self.request.body.decode())
        except json.JSONDecodeError:
            self.set_status(400)
            self.finish(json.dumps({"error": "invalid JSON"}))
            return

        cell_id       = body.get("cell_id", "")
        notebook_path = body.get("notebook_path", "")
        action        = body.get("action", "")

        valid_actions = ("deleted", "restored", "tags_changed")
        if not cell_id or not notebook_path or action not in valid_actions:
            self.set_status(400)
            self.finish(json.dumps({
                "error": f"cell_id, notebook_path, and action ({' | '.join(valid_actions)}) required"
            }))
            return

        if action == "tags_changed" and not isinstance(body.get("tags"), list):
            self.set_status(400)
            self.finish(json.dumps({"error": "'tags' (list) required for tags_changed action"}))
            return

        try:
            from ..context.summary_store import SummaryStore
            root_dir = self.settings.get("ds_assistant_root_dir", ".")
            store    = SummaryStore(root_dir, notebook_path)

            if action == "deleted":
                store.mark_deleted(cell_id)
                log.debug("SummaryStore: marked deleted cell %s…", cell_id[:8])
            elif action == "restored":
                store.mark_restored(cell_id)
                log.debug("SummaryStore: marked restored cell %s…", cell_id[:8])
            else:  # tags_changed
                tags    = body.get("tags", [])
                changed = store.patch_tags(cell_id, tags)
                log.debug(
                    "SummaryStore: tags %s for cell %s… → %s",
                    "updated" if changed else "unchanged",
                    cell_id[:8],
                    tags,
                )

            self.finish(json.dumps({"ok": True}))

        except Exception as exc:
            log.warning("CellLifecycleHandler: %s", exc)
            self.set_status(500)
            self.finish(json.dumps({"error": str(exc)}))

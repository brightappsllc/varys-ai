"""POST /varys/cell-executed — fire-and-forget cell execution hook.

Receives cell execution data from the frontend after each kernel execution,
builds a cell summary, and persists it to the SummaryStore asynchronously.

Returns 200 immediately so the kernel idle signal is never delayed.

Expected request body:
  {
    "notebook_path":    "relative/path/to/notebook.ipynb",
    "cell_id":          "<stable JupyterLab UUID>",
    "source":           "<full cell source text>",
    "output":           "<plain-text output | null>",
    "execution_count":  5,
    "had_error":        false,
    "error_text":       null,
    "cell_type":        "code",
    "kernel_snapshot":  { "var_name": {"type": "int", "value": 42}, ... },
    "tags":             ["important", "skip-execution"]
  }
"""
import asyncio
import json
import logging

from jupyter_server.base.handlers import JupyterHandler
from tornado.web import authenticated

log = logging.getLogger(__name__)


class CellExecutedHandler(JupyterHandler):
    """Receives cell execution events and updates the SummaryStore asynchronously."""

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

        if not cell_id or not notebook_path:
            self.set_status(400)
            self.finish(json.dumps({"error": "cell_id and notebook_path required"}))
            return

        # Return 200 immediately — processing is deferred to a background task
        self.finish(json.dumps({"ok": True}))

        asyncio.create_task(
            _summarize_and_store(
                root_dir        = self.settings.get("ds_assistant_root_dir", "."),
                notebook_path   = notebook_path,
                cell_id         = cell_id,
                source          = body.get("source", ""),
                output          = body.get("output") or None,
                execution_count = body.get("execution_count"),
                had_error       = bool(body.get("had_error", False)),
                error_text      = body.get("error_text") or None,
                cell_type       = body.get("cell_type", "code"),
                kernel_snapshot = body.get("kernel_snapshot") or {},
                tags            = body.get("tags") or [],
                settings        = dict(self.settings),
            )
        )


# ── Thread-safe sync helpers (called via asyncio.to_thread) ───────────────────


def _upsert_to_store(
    root_dir:       str,
    notebook_path:  str,
    cell_id:        str,
    source:         str,
    summary:        dict,
) -> bool:
    """Construct the SummaryStore and persist *summary*.

    Returns True when the inference counter has reached its threshold and a
    long-term memory inference run should be scheduled.

    This function is intentionally synchronous — it must be called via
    ``asyncio.to_thread`` so that its disk I/O (mkdir + stat + read + write)
    never blocks Tornado's event loop.
    """
    from ..context.summary_store import SummaryStore
    store = SummaryStore(root_dir, notebook_path)
    written = store.upsert(cell_id, source, summary)
    if written and store.should_run_inference():
        return True
    return False


# ── Background coroutine ───────────────────────────────────────────────────────


async def _summarize_and_store(
    root_dir:        str,
    notebook_path:   str,
    cell_id:         str,
    source:          str,
    output:          "str | None",
    execution_count: "int | None",
    had_error:       bool,
    error_text:      "str | None",
    cell_type:       str,
    kernel_snapshot: dict,
    tags:            list,
    settings:        dict,
) -> None:
    """Build a summary and persist it to the SummaryStore.

    All CPU and disk work is offloaded to a thread via asyncio.to_thread so the
    Tornado event loop is never blocked — which would otherwise prevent the kernel's
    execute_reply WebSocket frame from being forwarded to the browser.

    After a successful write, checks the inference counter and fires the
    long-term memory inference pipeline when the threshold is reached.
    """
    try:
        from ..context.summarizer    import (
            build_summary,
            build_markdown_summary_async,
            MARKDOWN_THRESHOLD,
        )
        from ..llm.factory import create_simple_task_provider

        # For large markdown cells, try the LLM prose-summary path first (it is
        # already async and yields the event loop between network calls).
        if cell_type == "markdown" and len(source) > MARKDOWN_THRESHOLD:
            simple_provider = create_simple_task_provider(settings)
            if simple_provider:
                summary = await build_markdown_summary_async(source, simple_provider, tags=tags)
            else:
                # build_summary is CPU-only; run in thread to avoid blocking.
                summary = await asyncio.to_thread(
                    build_summary,
                    cell_id=cell_id, source=source, cell_type=cell_type,
                    output=output, execution_count=execution_count,
                    had_error=had_error, error_text=error_text,
                    kernel_snapshot=kernel_snapshot, tags=tags,
                )
        else:
            # build_summary does AST parsing + string work — run in thread.
            summary = await asyncio.to_thread(
                build_summary,
                cell_id=cell_id, source=source, cell_type=cell_type,
                output=output, execution_count=execution_count,
                had_error=had_error, error_text=error_text,
                kernel_snapshot=kernel_snapshot, tags=tags,
            )

        # Persist summary to disk in a thread.
        # The SummaryStore constructor calls mkdir() on the HDD (expensive seek),
        # and upsert() does read-modify-write JSON — both must NOT run on the
        # Tornado event loop or they will block execute_reply forwarding.
        trigger_inference = await asyncio.to_thread(
            _upsert_to_store, root_dir, notebook_path, cell_id, source, summary
        )

        if trigger_inference:
            from ..memory.inference import run_inference
            asyncio.create_task(run_inference(root_dir, notebook_path, settings))
            log.debug("Inference pipeline triggered for %s", notebook_path)
        else:
            log.debug("SummaryStore: upserted cell %s … (notebook: %s)", cell_id[:8], notebook_path)

    except Exception as exc:
        log.warning(
            "SummaryStore: background summarize failed for cell %s: %s",
            cell_id[:8], exc,
        )

"""REST handlers for the Varys RAG (knowledge-base) feature.

Endpoints:
    POST  /varys/rag/learn
        Body:  { "path": "<relative or absolute path>", "force": false }
        Returns SSE stream of progress events, then a "done" event.

    GET   /varys/rag/status
        Returns JSON: { available, total_chunks, indexed_files, files }

    DELETE /varys/rag/forget
        Body:  { "path": "<absolute or relative path to remove>" }
        Returns JSON: { ok, chunks_removed }
"""
from __future__ import annotations

import asyncio
import json
import logging
from pathlib import Path

from jupyter_server.base.handlers import JupyterHandler
from tornado.web import authenticated

from ..utils.paths import project_base as nb_base
from ..utils.config import get_config as _get_cfg

log = logging.getLogger(__name__)


def _get_manager(settings: dict, notebook_path: str = ""):
    """Build (or retrieve) a RAGManager for the notebook's .jupyter-assistant dir.

    Each unique base_dir gets its own manager instance (no cross-notebook leakage).
    """
    from ..rag.manager import RAGManager
    root_dir = settings.get("ds_assistant_root_dir", ".")
    base = nb_base(root_dir, notebook_path)
    key = f"ds_assistant_rag_manager:{base}"
    cached = settings.get(key)
    if cached is not None:
        return cached
    mgr = RAGManager(base)
    settings[key] = mgr
    return mgr


# ── /rag/learn ─────────────────────────────────────────────────────────────────

class RAGLearnHandler(JupyterHandler):
    """Index a file or directory into the local knowledge base.

    Streams progress as Server-Sent Events so the frontend can display
    real-time feedback while embeddings are being computed.

    SSE events:
        { "type": "progress", "text": "... message ..." }
        { "type": "done",     "result": { total, processed, skipped, errors } }
        { "type": "error",    "text":   "error message" }
    """

    @authenticated
    async def post(self):
        try:
            body  = json.loads(self.request.body)
        except json.JSONDecodeError:
            self.set_status(400)
            self.finish(json.dumps({"error": "Invalid JSON body"}))
            return

        raw_path      = body.get("path", "").strip()
        force         = bool(body.get("force", False))
        notebook_path = body.get("notebookPath", "")
        root_dir      = self.settings.get("ds_assistant_root_dir", ".")

        # The knowledge folder lives alongside the notebook.
        knowledge_root = (nb_base(root_dir, notebook_path) / "knowledge").resolve()

        # Default to the full knowledge folder when no path given.
        if not raw_path:
            p = knowledge_root
        else:
            p = Path(raw_path)
            if not p.is_absolute():
                p = (Path(root_dir) / p).resolve()
            else:
                p = p.resolve()

        # Enforce the boundary — reject anything outside knowledge/.
        try:
            p.relative_to(knowledge_root)
        except ValueError:
            self.set_header("Content-Type", "text/event-stream")
            self.set_header("Cache-Control", "no-cache")
            err_msg = (
                f"⛔ Only files inside .jupyter-assistant/knowledge/ can be indexed.\n"
                f"Requested path: {p}\n"
                f"Allowed root:   {knowledge_root}"
            )
            self.write(f"data: {json.dumps({'type': 'error', 'text': err_msg})}\n\n")
            self.finish()
            return

        # Auto-create the knowledge directory so the user can drop files in immediately.
        knowledge_root.mkdir(parents=True, exist_ok=True)
        path = str(p)

        self.set_header("Content-Type", "text/event-stream")
        self.set_header("Cache-Control", "no-cache")
        self.set_header("X-Accel-Buffering", "no")

        try:
            mgr = _get_manager(self.settings, notebook_path)
        except ImportError as exc:
            self.write(f"data: {json.dumps({'type': 'error', 'text': str(exc)})}\n\n")
            self.finish()
            return

        if not mgr.is_available():
            hint = mgr.install_hint()
            self.write(f"data: {json.dumps({'type': 'error', 'text': hint})}\n\n")
            self.finish()
            return

        # Queue for progress messages produced by the thread
        queue: asyncio.Queue = asyncio.Queue()

        def progress_cb(msg: str) -> None:
            """Called from the background thread — put msg into async queue."""
            asyncio.run_coroutine_threadsafe(queue.put(msg), asyncio.get_event_loop())

        # Run blocking learn() in a thread pool to avoid blocking the event loop
        loop   = asyncio.get_event_loop()
        future = loop.run_in_executor(None, _learn_sync, mgr, path, force, progress_cb)

        # Drain the progress queue while the thread is running
        while not future.done():
            try:
                msg = await asyncio.wait_for(queue.get(), timeout=0.2)
                self.write(f"data: {json.dumps({'type': 'progress', 'text': msg})}\n\n")
                await self.flush()
                await asyncio.sleep(0)
            except asyncio.TimeoutError:
                pass

        # Drain any remaining messages
        while not queue.empty():
            msg = queue.get_nowait()
            self.write(f"data: {json.dumps({'type': 'progress', 'text': msg})}\n\n")
            await self.flush()

        result = await future  # re-raises any exception from the thread

        self.write(f"data: {json.dumps({'type': 'done', 'result': result})}\n\n")
        self.finish()


def _learn_sync(mgr, path: str, force: bool, cb) -> dict:
    """Wrapper so we can call mgr.learn() inside a thread pool executor."""
    return mgr.learn(path, force=force, progress_cb=cb)


# ── /rag/status ────────────────────────────────────────────────────────────────

class RAGStatusHandler(JupyterHandler):
    """Return a summary of the current knowledge-base index."""

    @authenticated
    async def get(self):
        nb = self.get_query_argument("notebookPath", "")
        self.set_header("Content-Type", "application/json")
        try:
            mgr    = _get_manager(self.settings, nb)
            status = await asyncio.get_event_loop().run_in_executor(None, mgr.status)
        except ImportError:
            status = {
                "available":     False,
                "total_chunks":  0,
                "indexed_files": 0,
                "files":         [],
                "hint":          RAGStatusHandler._hint(),
            }
        self.finish(json.dumps(status))

    @staticmethod
    def _hint() -> str:
        return "Install with: pip install chromadb sentence-transformers"


# ── /rag/forget ────────────────────────────────────────────────────────────────

class RAGForgetHandler(JupyterHandler):
    """Remove a specific file from the knowledge-base index."""

    @authenticated
    async def delete(self):
        self.set_header("Content-Type", "application/json")
        try:
            body = json.loads(self.request.body)
        except (json.JSONDecodeError, TypeError):
            body = {}

        notebook_path = body.get("notebookPath", "")
        raw_path      = body.get("path", "").strip()
        if not raw_path:
            self.set_status(400)
            self.finish(json.dumps({"error": "path is required"}))
            return

        root_dir = self.settings.get("ds_assistant_root_dir", ".")
        p = Path(raw_path)
        if not p.is_absolute():
            p = Path(root_dir) / p
        path = str(p)

        try:
            mgr    = _get_manager(self.settings, notebook_path)
            result = await asyncio.get_event_loop().run_in_executor(
                None, mgr.forget, path
            )
        except ImportError as exc:
            self.set_status(503)
            self.finish(json.dumps({"error": str(exc)}))
            return

        self.finish(json.dumps(result))


# ── /rag/ask (thin wrapper around the task handler for direct RAG queries) ────

class RAGAskHandler(JupyterHandler):
    """Retrieve relevant chunks for a query (no LLM call — just retrieval).

    POST body: { "query": "...", "top_k": 5 }
    Response:  { "chunks": [...], "context": "..." }

    The main LLM answer is handled by the TaskHandler (/task) when the
    /ask slash command is detected.  This endpoint is useful for debugging
    or for custom frontends that want raw retrieval results.
    """

    @authenticated
    async def post(self):
        self.set_header("Content-Type", "application/json")
        try:
            body = json.loads(self.request.body)
        except json.JSONDecodeError:
            self.set_status(400)
            self.finish(json.dumps({"error": "Invalid JSON body"}))
            return

        query         = body.get("query", "").strip()
        _default_top_k = _get_cfg().getint("retrieval", "top_k", 5)
        top_k         = int(body.get("top_k", _default_top_k))
        notebook_path = body.get("notebookPath", "")

        if not query:
            self.set_status(400)
            self.finish(json.dumps({"error": "query is required"}))
            return

        try:
            mgr    = _get_manager(self.settings, notebook_path)
            if not mgr.is_available():
                self.set_status(503)
                self.finish(json.dumps({"error": mgr.install_hint()}))
                return
            result = await asyncio.get_event_loop().run_in_executor(
                None, lambda: mgr.ask(query, top_k=top_k)
            )
        except Exception as exc:
            log.exception("RAGAskHandler error")
            self.set_status(500)
            self.finish(json.dumps({"error": str(exc)}))
            return

        self.finish(json.dumps(result))

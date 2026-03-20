"""HTTP handlers for the Reproducibility Guardian module.

Routes (registered in app.py):
    POST  /varys/reproducibility/analyze  — run rules, persist, return issues
    POST  /varys/reproducibility/dismiss  — mark one issue dismissed
    GET   /varys/reproducibility          — return active issues for a notebook
"""
from __future__ import annotations

import asyncio
import json
import traceback

from jupyter_server.base.handlers import JupyterHandler
from tornado.web import authenticated

from .analyzer import analyze_notebook
from .storage import ReproducibilityStorage


class ReproAnalyzeHandler(JupyterHandler):
    """Run all rules against the current notebook state and persist results."""

    @authenticated
    async def post(self):
        self.set_header('Content-Type', 'application/json')
        try:
            body          = json.loads(self.request.body)
            notebook_path = body.get('notebookPath', '')
            cells         = body.get('cells', [])
            root_dir      = self.settings.get('ds_assistant_root_dir', '.')

            # Run in a thread so the synchronous rule checks don't block
            # Tornado's event loop — otherwise it cannot forward the kernel's
            # execute_reply WebSocket frame while analysis is running.
            issues = await asyncio.to_thread(analyze_notebook, cells)

            storage = ReproducibilityStorage(root_dir, notebook_path)
            await storage.save(issues)

            self.finish(json.dumps({
                'issues': [_issue_to_dict(i) for i in issues]
            }))
        except Exception:
            self.log.error('Reproducibility analyze error:\n%s', traceback.format_exc())
            self.set_status(500)
            self.finish(json.dumps({'error': 'Analysis failed'}))


class ReproDismissHandler(JupyterHandler):
    """Mark a single issue as dismissed."""

    @authenticated
    async def post(self):
        self.set_header('Content-Type', 'application/json')
        try:
            body          = json.loads(self.request.body)
            notebook_path = body.get('notebookPath', '')
            issue_id      = body.get('issueId', '')
            root_dir      = self.settings.get('ds_assistant_root_dir', '.')

            storage = ReproducibilityStorage(root_dir, notebook_path)
            await storage.dismiss(issue_id)

            self.finish(json.dumps({'ok': True}))
        except Exception:
            self.log.error('Reproducibility dismiss error:\n%s', traceback.format_exc())
            self.set_status(500)
            self.finish(json.dumps({'error': 'Dismiss failed'}))


class ReproIssuesHandler(JupyterHandler):
    """Return active issues for a given notebook (used on panel mount)."""

    @authenticated
    async def get(self):
        self.set_header('Content-Type', 'application/json')
        try:
            notebook_path = self.get_argument('notebook_path', '')
            root_dir      = self.settings.get('ds_assistant_root_dir', '.')

            storage = ReproducibilityStorage(root_dir, notebook_path)
            rows = await storage.load()

            self.finish(json.dumps({'issues': rows}))
        except Exception:
            self.log.error('Reproducibility issues error:\n%s', traceback.format_exc())
            self.set_status(500)
            self.finish(json.dumps({'error': 'Load failed'}))


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

def _issue_to_dict(issue) -> dict:
    from dataclasses import asdict
    return asdict(issue)

"""Report handler — POST /varys/report

Accepts a notebook path, runs the full report generation pipeline,
and returns the saved report metadata including a download URL.
"""
import json
import traceback

from jupyter_server.base.handlers import JupyterHandler
from tornado.web import authenticated

from ..llm.factory import create_provider
from ..report.generator import generate_report


class ReportHandler(JupyterHandler):
    """POST → generate a markdown report from the current notebook."""

    @authenticated
    async def post(self):
        self.set_header("Content-Type", "application/json")

        try:
            body = json.loads(self.request.body)
        except json.JSONDecodeError:
            self.set_status(400)
            self.finish(json.dumps({"error": "Invalid JSON body"}))
            return

        notebook_path = body.get("notebookPath", "").strip()
        if not notebook_path:
            self.set_status(400)
            self.finish(json.dumps({"error": "notebookPath is required"}))
            return

        root_dir = self.settings.get("ds_assistant_root_dir", ".")

        try:
            provider = create_provider(self.settings, task="chat")
            result = await generate_report(
                notebook_path=notebook_path,
                root_dir=root_dir,
                provider=provider,
            )
        except FileNotFoundError as e:
            self.set_status(404)
            self.finish(json.dumps({"error": str(e)}))
            return
        except RuntimeError as e:
            self.set_status(500)
            self.finish(json.dumps({"error": str(e)}))
            return
        except Exception as e:
            self.log.error("Report generation failed: %s\n%s", e, traceback.format_exc())
            self.set_status(500)
            self.finish(json.dumps({"error": f"Report generation failed: {e}"}))
            return

        self.finish(json.dumps({
            "status":        "ok",
            "filename":      result["filename"],
            "relativePath":  result["relative_path"],
            "preview":       result["preview"],
            "stats":         result["stats"],
            "imagesCount":   result["images_count"],
            "wordCount":     result["word_count"],
        }))

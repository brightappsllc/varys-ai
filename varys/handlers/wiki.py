"""Serves the local wiki.html file at /varys/wiki."""
import logging
from pathlib import Path

from jupyter_server.base.handlers import JupyterHandler
from tornado.web import HTTPError

log = logging.getLogger(__name__)

# Candidate locations searched in order:
#   1. <notebook root dir>/wiki.html
#   2. The extension package directory itself (for installed packages)
_WIKI_FILENAME = "wiki.html"


def _find_wiki(root_dir: str) -> Path | None:
    candidates = [
        Path(root_dir) / _WIKI_FILENAME,
        Path(__file__).parent.parent.parent / _WIKI_FILENAME,
    ]
    for p in candidates:
        if p.exists():
            return p
    return None


class WikiHandler(JupyterHandler):
    """Returns wiki.html as a self-contained HTML page."""

    def get(self):
        root_dir = self.settings.get("ds_assistant_root_dir", ".")
        wiki_path = _find_wiki(root_dir)

        if wiki_path is None:
            log.warning("Varys: wiki.html not found (root_dir=%s)", root_dir)
            raise HTTPError(404, "wiki.html not found. Make sure it exists in the notebook directory.")

        self.set_header("Content-Type", "text/html; charset=utf-8")
        # Allow browser to cache the file for 5 minutes
        self.set_header("Cache-Control", "public, max-age=300")
        self.finish(wiki_path.read_text(encoding="utf-8"))

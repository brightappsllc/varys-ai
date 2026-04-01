"""Ollama-specific API endpoints used by the setup wizard and status bar.

Uses Tornado's AsyncHTTPClient (already a dependency via jupyter-server) for
all HTTP calls — no httpx dependency required.
"""
import json
import subprocess

from jupyter_server.base.handlers import JupyterHandler
from tornado import web
from tornado.httpclient import AsyncHTTPClient, HTTPRequest


def _ollama_url(settings: dict) -> str:
    return settings.get("ds_assistant_ollama_url", "http://localhost:11434")


async def _fetch_json(url: str, timeout: float) -> dict:
    """Fetch a URL with Tornado's AsyncHTTPClient and return parsed JSON."""
    client = AsyncHTTPClient()
    req = HTTPRequest(url, method="GET", request_timeout=timeout, connect_timeout=5)
    resp = await client.fetch(req)
    return json.loads(resp.body)


class OllamaHealthHandler(JupyterHandler):
    """GET /varys/ollama/health — check if the Ollama server is running."""

    @web.authenticated
    async def get(self) -> None:
        url = _ollama_url(self.settings)
        try:
            await _fetch_json(f"{url}/api/tags", timeout=5)
            self.finish(json.dumps({"running": True, "url": url}))
        except Exception as exc:
            self.finish(json.dumps({"running": False, "url": url, "error": str(exc)}))


class OllamaModelsHandler(JupyterHandler):
    """GET /varys/ollama/models — list models available on the server."""

    @web.authenticated
    async def get(self) -> None:
        url = _ollama_url(self.settings)
        try:
            data = await _fetch_json(f"{url}/api/tags", timeout=10)
            models = [
                {
                    "name": m.get("name", ""),
                    "size": _fmt_bytes(m.get("size", 0)),
                    "modified": m.get("modified_at", ""),
                }
                for m in data.get("models", [])
            ]
            self.finish(json.dumps({"models": models}))
        except Exception as exc:
            self.set_status(503)
            self.finish(json.dumps({"error": str(exc)}))


class OllamaCheckInstallHandler(JupyterHandler):
    """GET /varys/ollama/check-install — detect if `ollama` CLI is installed."""

    @web.authenticated
    async def get(self) -> None:
        try:
            result = subprocess.run(
                ["ollama", "--version"],
                capture_output=True,
                text=True,
                timeout=5,
            )
            version = result.stdout.strip() or result.stderr.strip()
            self.finish(json.dumps({"installed": True, "version": version}))
        except (FileNotFoundError, subprocess.TimeoutExpired):
            self.finish(json.dumps({"installed": False}))


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _fmt_bytes(n: int) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024:
            return f"{n:.1f} {unit}"
        n /= 1024
    return f"{n:.1f} TB"

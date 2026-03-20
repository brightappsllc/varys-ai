"""Ollama-specific API endpoints used by the setup wizard and status bar."""
import json
import subprocess

import httpx
from jupyter_server.base.handlers import JupyterHandler
from tornado import web


def _ollama_url(settings: dict) -> str:
    return settings.get("ds_assistant_ollama_url", "http://localhost:11434")


class OllamaHealthHandler(JupyterHandler):
    """GET /varys/ollama/health — check if the Ollama server is running."""

    @web.authenticated
    async def get(self) -> None:
        url = _ollama_url(self.settings)
        try:
            async with httpx.AsyncClient(timeout=5) as client:
                resp = await client.get(f"{url}/api/tags")
                if resp.status_code == 200:
                    self.finish(
                        json.dumps({"running": True, "url": url})
                    )
                    return
        except Exception as exc:
            self.finish(
                json.dumps({"running": False, "url": url, "error": str(exc)})
            )
            return
        self.finish(
            json.dumps(
                {"running": False, "url": url, "error": "Unexpected response"}
            )
        )


class OllamaModelsHandler(JupyterHandler):
    """GET /varys/ollama/models — list models available on the server."""

    @web.authenticated
    async def get(self) -> None:
        url = _ollama_url(self.settings)
        try:
            async with httpx.AsyncClient(timeout=10) as client:
                resp = await client.get(f"{url}/api/tags")
                resp.raise_for_status()
                data = resp.json()

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

"""Version-check handler — notifies the UI when a newer Varys release is available.

GET /varys/version-check
  response: {
    "current":          "0.7.0",
    "latest":           "0.7.1",     # or same as current if no newer release
    "update_available": true,
    "release_url":      "https://github.com/..."
  }

The GitHub Releases API is queried at most once per server session (result cached
for CACHE_TTL_SECS, default 1 hour).  All network errors are swallowed and
treated as "no update available" so the UI is never blocked.

Configuration (optional, via varys.env or environment):
  VARYS_UPDATE_CHECK_URL   — release API URL (default: GitHub Releases latest)
  VARYS_GITHUB_TOKEN       — personal access token for private repos
  VARYS_UPDATE_CHECK       — set to "false" to disable all remote checks
"""
from __future__ import annotations

import json
import logging
import os
import time
import urllib.error
import urllib.request
from typing import Optional, Tuple

from jupyter_server.base.handlers import JupyterHandler
from tornado.web import authenticated

log = logging.getLogger(__name__)

_GITHUB_API_URL = (
    "https://api.github.com/repos/brightappsllc/varys-ai/releases/latest"
)
_CACHE_TTL_SECS = 3600   # re-check at most once per hour per server session
_REQUEST_TIMEOUT = 4     # seconds — must be fast enough not to delay sidebar load

# Module-level cache: (fetched_at, current, latest, update_available, release_url)
# (fetched_at, current, latest, update_available, release_url, release_notes)
_cache: Optional[Tuple[float, str, str, bool, str, str]] = None


def _current_version() -> str:
    try:
        from .. import __version__
        return __version__
    except Exception:
        return "0.0.0"


def _semver_tuple(v: str) -> tuple:
    """Convert 'v1.2.3' or '1.2.3' to (1, 2, 3) for comparison."""
    try:
        return tuple(int(x) for x in v.lstrip("v").split(".")[:3])
    except Exception:
        return (0, 0, 0)


def _fetch_latest() -> Tuple[str, str, str]:
    """Return (latest_version_tag, release_html_url, release_body_markdown).

    Raises on any network/parse error — caller decides how to handle.
    """
    url   = os.environ.get("VARYS_UPDATE_CHECK_URL", _GITHUB_API_URL)
    token = os.environ.get("VARYS_GITHUB_TOKEN", "")

    headers = {"Accept": "application/vnd.github+json", "User-Agent": "varys-update-check"}
    if token:
        headers["Authorization"] = f"Bearer {token}"

    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=_REQUEST_TIMEOUT) as resp:
        data = json.loads(resp.read())

    tag      = data.get("tag_name", "")
    html_url = data.get("html_url", "https://github.com/brightappsllc/varys-ai/releases")
    body     = data.get("body", "")  # markdown release notes authored by maintainers
    return tag, html_url, body


def get_update_info() -> dict:
    """Return the update status dict, using the in-process cache."""
    global _cache

    current = _current_version()

    # Honour opt-out
    if os.environ.get("VARYS_UPDATE_CHECK", "").lower() in ("false", "0", "no"):
        return {
            "current": current, "latest": current,
            "update_available": False, "release_url": "", "release_notes": "",
        }

    now = time.monotonic()

    # Return cached result if still fresh
    if _cache is not None and (now - _cache[0]) < _CACHE_TTL_SECS:
        _, cached_current, latest, update_available, release_url, release_notes = _cache
        if cached_current == current:
            return {
                "current": current,
                "latest": latest,
                "update_available": update_available,
                "release_url": release_url,
                "release_notes": release_notes,
            }

    # Fetch from GitHub
    try:
        latest_tag, release_url, release_notes = _fetch_latest()
        update_available = _semver_tuple(latest_tag) > _semver_tuple(current)
        latest = latest_tag.lstrip("v") if latest_tag else current
    except urllib.error.HTTPError as exc:
        if exc.code in (401, 403, 404):
            log.debug("version-check: GitHub API returned %d — private repo or rate-limited", exc.code)
        else:
            log.debug("version-check: HTTP error %d — %s", exc.code, exc)
        latest, update_available, release_url, release_notes = current, False, "", ""
    except Exception as exc:
        log.debug("version-check: could not reach GitHub: %s", exc)
        latest, update_available, release_url, release_notes = current, False, "", ""

    _cache = (now, current, latest, update_available, release_url, release_notes)
    return {
        "current": current,
        "latest": latest,
        "update_available": update_available,
        "release_url": release_url,
        "release_notes": release_notes,
    }


class VersionCheckHandler(JupyterHandler):
    """GET /varys/version-check — return current and latest Varys version."""

    @authenticated
    async def get(self) -> None:
        import asyncio
        loop = asyncio.get_event_loop()
        # Run the blocking urllib call in a thread so Tornado's event loop isn't stalled
        result = await loop.run_in_executor(None, get_update_info)
        self.set_header("Content-Type", "application/json")
        self.finish(json.dumps(result))

"""Changelog handler — serves the bundled CHANGELOG.md content.

GET /varys/changelog
  Query params:
    since=VERSION   (optional) — return only sections for versions NEWER than VERSION
                    e.g. ?since=0.7.0 returns everything above the [0.7.0] heading
  Response:
    { "content": "<markdown string>", "current": "0.7.0" }

The CHANGELOG.md is read from the package root at request time (with a 5-minute
mtime cache so repeated opens are instant).
"""
from __future__ import annotations

import json
import logging
import time
from pathlib import Path
from typing import Optional, Tuple

from jupyter_server.base.handlers import JupyterHandler
from tornado.web import authenticated

log = logging.getLogger(__name__)

# CHANGELOG.md lives two levels up from this file: varys/handlers/ → varys/ → repo root
_CHANGELOG_PATH = Path(__file__).parent.parent.parent / "CHANGELOG.md"

# (mtime, content) — invalidated when the file changes on disk
_cl_cache: Optional[Tuple[float, str]] = None
_cl_cache_ts: float = 0.0
_CACHE_TTL = 300  # 5 minutes


def _read_changelog() -> str:
    """Read CHANGELOG.md with a 5-minute mtime cache."""
    global _cl_cache, _cl_cache_ts

    now = time.monotonic()
    if _cl_cache is not None and (now - _cl_cache_ts) < _CACHE_TTL:
        return _cl_cache[1]

    try:
        mtime = _CHANGELOG_PATH.stat().st_mtime
        # Re-check even within TTL if file changed
        if _cl_cache is not None and _cl_cache[0] == mtime:
            _cl_cache_ts = now
            return _cl_cache[1]
        content = _CHANGELOG_PATH.read_text(encoding="utf-8")
        _cl_cache = (mtime, content)
        _cl_cache_ts = now
        return content
    except Exception as exc:
        log.warning("changelog: could not read CHANGELOG.md: %s", exc)
        return ""


def _semver_tuple(v: str) -> tuple:
    try:
        return tuple(int(x) for x in v.lstrip("v").split(".")[:3])
    except Exception:
        return (0, 0, 0)


def _slice_since(content: str, since: str) -> str:
    """Return only the changelog sections for versions strictly newer than *since*.

    Sections are identified by lines starting with '## ['.
    If *since* is not found, the entire content is returned.
    """
    if not since:
        return content

    since_t = _semver_tuple(since)
    lines = content.splitlines(keepends=True)
    result_lines: list[str] = []
    in_header_block = True  # preamble before first ## section

    for line in lines:
        stripped = line.strip()
        # Detect a version section header: ## [0.7.0] — ...
        if stripped.startswith("## [") and "]" in stripped:
            try:
                ver_str = stripped[4:stripped.index("]")]
                ver_t = _semver_tuple(ver_str)
            except Exception:
                ver_t = (0, 0, 0)

            in_header_block = False
            if ver_t > since_t:
                result_lines.append(line)
            else:
                # We've hit the since-version or older — stop
                break
        elif in_header_block:
            # Keep the preamble (title + description lines before first ## section)
            pass  # drop the preamble for the "since" view; start fresh at sections
        else:
            result_lines.append(line)

    return "".join(result_lines).strip()


class ChangelogHandler(JupyterHandler):
    """GET /varys/changelog — serve CHANGELOG.md, optionally sliced from a version."""

    @authenticated
    def get(self) -> None:
        since = self.get_argument("since", "")
        content = _read_changelog()

        if since:
            content = _slice_since(content, since)
            if not content:
                content = "_No changelog entries found for versions newer than " + since + "._"

        from .version_check import _current_version
        self.set_header("Content-Type", "application/json")
        self.finish(json.dumps({
            "content": content,
            "current": _current_version(),
        }))

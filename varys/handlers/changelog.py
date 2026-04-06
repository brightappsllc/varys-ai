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

# CHANGELOG.md is bundled inside the varys package: varys/handlers/ → varys/CHANGELOG.md
# (The repo-root copy is a symlink/duplicate kept for developers; the package copy is
#  what pip installs into site-packages/varys/CHANGELOG.md.)
_CHANGELOG_PATH = Path(__file__).parent.parent / "CHANGELOG.md"

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


def _slice_since(content: str, since: str, inclusive: bool = False) -> str:
    """Return changelog sections newer than *since* (or from *since* when inclusive=True).

    Sections are identified by lines starting with '## ['.
    If *since* is not found, the entire content is returned.

    inclusive=True  → include the section whose version == since (used by "What's New"
                       so the current version's own changes are always visible).
    inclusive=False → strictly newer (used by the update-available badge path).
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
            keep = (ver_t >= since_t) if inclusive else (ver_t > since_t)
            if keep:
                result_lines.append(line)
            else:
                # We've hit a version older than the cutoff — stop
                break
        elif in_header_block:
            pass  # drop the preamble for the sliced view
        else:
            result_lines.append(line)

    return "".join(result_lines).strip()


class ChangelogHandler(JupyterHandler):
    """GET /varys/changelog — serve CHANGELOG.md, optionally sliced from a version."""

    @authenticated
    def get(self) -> None:
        since     = self.get_argument("since", "")      # exclusive: newer than VERSION
        from_ver  = self.get_argument("from",  "")      # inclusive: VERSION and newer
        content   = _read_changelog()

        if from_ver:
            content = _slice_since(content, from_ver, inclusive=True)
            if not content:
                content = "_No changelog entries found for version " + from_ver + " or newer._"
        elif since:
            content = _slice_since(content, since, inclusive=False)
            if not content:
                content = "_No changelog entries found for versions newer than " + since + "._"

        from .version_check import _current_version
        self.set_header("Content-Type", "application/json")
        self.finish(json.dumps({
            "content": content,
            "current": _current_version(),
        }))

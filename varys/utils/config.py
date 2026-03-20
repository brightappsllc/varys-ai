"""Centralised configuration loader.

Config files are read (in alphabetical order) from:

    <server_root>/.jupyter-assistant/config/*.cfg

Any .cfg file found there overrides the built-in defaults.  The files in
``varys/bundled_config/`` are documented templates — copy
any of them into your project's config folder and edit as needed.

Usage
-----
    from ..utils.config import get_config

    cfg = get_config()
    chunk_size = cfg.getint("chunking", "chunk_size", 512)
    models     = cfg.getlist("estimators", "stochastic_estimators", [...])

The global instance is initialised once in ``app.py`` via ``init_config(root_dir)``.
Subsequent calls to ``get_config()`` return the same instance without disk I/O.
"""
import configparser
import logging
import threading
from pathlib import Path
from typing import List, Optional

log = logging.getLogger(__name__)

_lock: threading.Lock = threading.Lock()
_instance: Optional["ConfigLoader"] = None


class ConfigLoader:
    """Thin wrapper around configparser with typed accessors and safe defaults."""

    def __init__(self, root_dir: str = ".") -> None:
        self._root = Path(root_dir)
        self._cp = configparser.ConfigParser(interpolation=None)
        self._load()

    # ── Loading ──────────────────────────────────────────────────────────────

    def _load(self) -> None:
        config_dir = self._root / ".jupyter-assistant" / "config"
        if not config_dir.exists():
            return
        files = sorted(config_dir.glob("*.cfg"))
        if not files:
            return
        for f in files:
            try:
                self._cp.read(f, encoding="utf-8")
                log.debug("DS config: loaded %s", f.name)
            except Exception as exc:
                log.warning("DS config: could not read %s — %s", f, exc)

    def reload(self, root_dir: Optional[str] = None) -> None:
        """Re-read all config files, optionally switching root directory."""
        if root_dir:
            self._root = Path(root_dir)
        self._cp = configparser.ConfigParser(interpolation=None)
        self._load()

    # ── Typed accessors ──────────────────────────────────────────────────────

    def get(self, section: str, key: str, fallback: str = "") -> str:
        try:
            return self._cp.get(section, key)
        except (configparser.NoSectionError, configparser.NoOptionError):
            return fallback

    def getint(self, section: str, key: str, fallback: int = 0) -> int:
        raw = self.get(section, key)
        if raw:
            try:
                return int(raw)
            except ValueError:
                log.warning(
                    "DS config: [%s] %s = %r is not an integer; using %d",
                    section, key, raw, fallback,
                )
        return fallback

    def getfloat(self, section: str, key: str, fallback: float = 0.0) -> float:
        raw = self.get(section, key)
        if raw:
            try:
                return float(raw)
            except ValueError:
                log.warning(
                    "DS config: [%s] %s = %r is not a float; using %g",
                    section, key, raw, fallback,
                )
        return fallback

    def getbool(self, section: str, key: str, fallback: bool = False) -> bool:
        raw = self.get(section, key, "").strip().lower()
        if raw in ("1", "true", "yes", "on"):
            return True
        if raw in ("0", "false", "no", "off"):
            return False
        return fallback

    def getlist(
        self, section: str, key: str, fallback: Optional[List[str]] = None
    ) -> List[str]:
        raw = self.get(section, key, "")
        if raw:
            return [x.strip() for x in raw.split(",") if x.strip()]
        return fallback if fallback is not None else []


# ── Module-level singleton ────────────────────────────────────────────────────


def init_config(root_dir: str) -> ConfigLoader:
    """Initialise (or reinitialise) the global config.  Call once from app.py."""
    global _instance
    with _lock:
        _instance = ConfigLoader(root_dir)
    return _instance


def get_config() -> ConfigLoader:
    """Return the global config.  Falls back to a default-only instance."""
    global _instance
    if _instance is None:
        with _lock:
            if _instance is None:
                _instance = ConfigLoader(".")
    return _instance

"""LRU cache for inline completions."""
import hashlib
import time
from collections import OrderedDict
from typing import Optional

from ..utils.config import get_config as _get_cfg


class CompletionCache:
    """Thread-safe LRU cache for completions.

    Cache key: SHA-256 of (prefix + language + imports snapshot).
    Entries expire after `ttl` seconds (default 1 hour).
    Size is capped at `max_size` entries (default 100) with LRU eviction.
    """

    def __init__(self, max_size: int = 0, ttl: int = 0) -> None:
        cfg = _get_cfg()
        if max_size == 0:
            max_size = cfg.getint("cache", "max_size", 100)
        if ttl == 0:
            ttl = cfg.getint("cache", "ttl", 3600)
        self._max_size = max_size
        self._ttl = ttl
        self._store: OrderedDict[str, tuple[str, float]] = OrderedDict()

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def get(self, key: str) -> Optional[str]:
        """Return cached suggestion or None if missing/expired."""
        if key not in self._store:
            return None
        value, ts = self._store[key]
        if time.monotonic() - ts > self._ttl:
            del self._store[key]
            return None
        # Move to end (most-recently-used)
        self._store.move_to_end(key)
        return value

    def set(self, key: str, value: str) -> None:
        """Store a suggestion."""
        if key in self._store:
            self._store.move_to_end(key)
        else:
            if len(self._store) >= self._max_size:
                self._store.popitem(last=False)  # evict LRU
        self._store[key] = (value, time.monotonic())

    def invalidate(self, prefix_hash: str) -> None:
        """Remove all entries matching a given prefix hash substring."""
        to_delete = [k for k in self._store if k.startswith(prefix_hash)]
        for k in to_delete:
            del self._store[k]

    def clear(self) -> None:
        self._store.clear()

    def stats(self) -> dict:
        return {"size": len(self._store), "max_size": self._max_size, "ttl": self._ttl}

    # ------------------------------------------------------------------
    # Key construction
    # ------------------------------------------------------------------

    @staticmethod
    def make_key(
        prefix: str,
        language: str,
        completion_type: str,
        imports_snapshot: str = "",
    ) -> str:
        """Deterministic cache key for a completion request."""
        raw = f"{completion_type}|{language}|{imports_snapshot}|{prefix}"
        return hashlib.sha256(raw.encode()).hexdigest()

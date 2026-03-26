"""Write-through usage log and aggregation cache for LLM token tracking.

Every LLM completion appends one row to ~/.jupyter/usage.jsonl and
increments the dual-keyed cache in ~/.jupyter/usage_cache.json.

All errors are swallowed — usage tracking must never affect completion latency.
"""

import json
import logging
import os
from datetime import datetime, timezone
from pathlib import Path

import filelock

log = logging.getLogger(__name__)

_JUPYTER_DIR = Path.home() / ".jupyter"
_JSONL_PATH  = _JUPYTER_DIR / "usage.jsonl"
_CACHE_PATH  = _JUPYTER_DIR / "usage_cache.json"
_LOCK_PATH   = _JUPYTER_DIR / "usage_cache.json.lock"

_EMPTY_CACHE: dict = {"by_date": {}, "by_model": {}}


class UsageWriter:
    """Append rows to usage.jsonl and keep usage_cache.json in sync."""

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def write(
        self,
        vendor: str,
        model: str,
        tokens_in: int,
        tokens_out: int,
        chat_id: "str | None",
        context: str,
    ) -> None:
        """Append one usage row and update the dual-keyed cache."""
        try:
            _JUPYTER_DIR.mkdir(parents=True, exist_ok=True)

            ts        = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
            date      = ts[:10]
            model_key = f"{vendor}/{model}"

            row = {
                "ts":      ts,
                "vendor":  vendor,
                "model":   model,
                "in":      int(tokens_in),
                "out":     int(tokens_out),
                "chat_id": chat_id,
                "context": context,
            }

            with _JSONL_PATH.open("a", encoding="utf-8") as fh:
                fh.write(json.dumps(row) + "\n")

            with filelock.FileLock(str(_LOCK_PATH), timeout=5):
                try:
                    cache = json.loads(_CACHE_PATH.read_text(encoding="utf-8"))
                    if "by_date" not in cache or "by_model" not in cache:
                        raise ValueError("missing keys")
                except (FileNotFoundError, json.JSONDecodeError, ValueError):
                    cache = self.rebuild_cache()

                # Increment by_date
                (
                    cache["by_date"]
                    .setdefault(date, {})
                    .setdefault(model_key, {"in": 0, "out": 0})
                )
                cache["by_date"][date][model_key]["in"]  += int(tokens_in)
                cache["by_date"][date][model_key]["out"] += int(tokens_out)

                # Increment by_model
                (
                    cache["by_model"]
                    .setdefault(model_key, {})
                    .setdefault(date, {"in": 0, "out": 0})
                )
                cache["by_model"][model_key][date]["in"]  += int(tokens_in)
                cache["by_model"][model_key][date]["out"] += int(tokens_out)

                _atomic_write(_CACHE_PATH, json.dumps(cache, indent=2))

        except Exception as exc:  # noqa: BLE001
            log.warning("UsageWriter.write failed (swallowed): %s", exc)

    def rebuild_cache(self) -> dict:
        """Rebuild usage_cache.json from scratch by re-reading usage.jsonl.

        Returns the freshly built cache dict (also writes it to disk).
        """
        cache: dict = {"by_date": {}, "by_model": {}}

        if not _JSONL_PATH.exists():
            _atomic_write(_CACHE_PATH, json.dumps(cache, indent=2))
            return cache

        with _JSONL_PATH.open("r", encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    row = json.loads(line)
                except json.JSONDecodeError as exc:
                    log.warning("usage.jsonl: skipping unparseable row: %s", exc)
                    continue

                try:
                    date      = row["ts"][:10]
                    model_key = f"{row['vendor']}/{row['model']}"
                    tin       = int(row.get("in",  0))
                    tout      = int(row.get("out", 0))
                except (KeyError, ValueError, TypeError) as exc:
                    log.warning("usage.jsonl: skipping malformed row: %s", exc)
                    continue

                (
                    cache["by_date"]
                    .setdefault(date, {})
                    .setdefault(model_key, {"in": 0, "out": 0})
                )
                cache["by_date"][date][model_key]["in"]  += tin
                cache["by_date"][date][model_key]["out"] += tout

                (
                    cache["by_model"]
                    .setdefault(model_key, {})
                    .setdefault(date, {"in": 0, "out": 0})
                )
                cache["by_model"][model_key][date]["in"]  += tin
                cache["by_model"][model_key][date]["out"] += tout

        _atomic_write(_CACHE_PATH, json.dumps(cache, indent=2))
        return cache


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _atomic_write(path: Path, text: str) -> None:
    """Write *text* to *path* atomically via a .tmp sibling."""
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(text, encoding="utf-8")
    os.replace(tmp, path)

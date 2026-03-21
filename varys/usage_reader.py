"""Read-only query layer over usage_cache.json.

Never reads usage.jsonl at runtime — only the pre-aggregated cache.
"""

import json
import logging
from datetime import datetime, timedelta, timezone
from pathlib import Path

log = logging.getLogger(__name__)

_CACHE_PATH = Path.home() / ".jupyter" / "usage_cache.json"
_EMPTY_CACHE: dict = {"by_date": {}, "by_model": {}}


class UsageReader:
    """Query the aggregated usage cache.

    Load once per instance; call refresh() to reload from disk.
    """

    def __init__(self) -> None:
        self._cache: dict = _EMPTY_CACHE.copy()
        self.refresh()

    def refresh(self) -> None:
        """Reload cache from disk. Returns silently if file is missing."""
        try:
            text = _CACHE_PATH.read_text(encoding="utf-8")
            data = json.loads(text)
            if "by_date" in data and "by_model" in data:
                self._cache = data
            else:
                self._cache = _EMPTY_CACHE.copy()
        except FileNotFoundError:
            self._cache = _EMPTY_CACHE.copy()
        except json.JSONDecodeError as exc:
            log.warning("usage_cache.json is corrupt, treating as empty: %s", exc)
            self._cache = _EMPTY_CACHE.copy()

    # ------------------------------------------------------------------
    # Query methods
    # ------------------------------------------------------------------

    def get_heatmap(self, model_key: "str | None" = None) -> "dict[str, int]":
        """Return token totals for every day in the trailing 12 months.

        Days with no usage are included with value 0.
        """
        today     = datetime.now(timezone.utc).date()
        start     = today - timedelta(days=364)
        result    = {}
        current   = start
        while current <= today:
            result[current.isoformat()] = 0
            current += timedelta(days=1)

        if model_key is None:
            by_date = self._cache.get("by_date", {})
            for day, models in by_date.items():
                if day in result:
                    for mk, counts in models.items():
                        result[day] += counts.get("in", 0) + counts.get("out", 0)
        else:
            by_model = self._cache.get("by_model", {})
            model_data = by_model.get(model_key, {})
            for day, counts in model_data.items():
                if day in result:
                    result[day] += counts.get("in", 0) + counts.get("out", 0)

        return result

    def get_totals(
        self, period: str, model_key: "str | None" = None
    ) -> "dict[str, int]":
        """Return aggregated token counts for *period*.

        period: "day" | "week" | "month" | "year" | "all"
        Returns {"in": int, "out": int, "total": int}.
        """
        today = datetime.now(timezone.utc).date()

        if period == "day":
            date_range = {today.isoformat()}
        elif period == "week":
            date_range = {(today - timedelta(days=i)).isoformat() for i in range(7)}
        elif period == "month":
            date_range = {(today - timedelta(days=i)).isoformat() for i in range(30)}
        elif period == "year":
            date_range = {(today - timedelta(days=i)).isoformat() for i in range(365)}
        else:
            date_range = None  # "all"

        total_in = total_out = 0

        if model_key is None:
            by_date = self._cache.get("by_date", {})
            for day, models in by_date.items():
                if date_range is not None and day not in date_range:
                    continue
                for mk, counts in models.items():
                    total_in  += counts.get("in",  0)
                    total_out += counts.get("out", 0)
        else:
            by_model = self._cache.get("by_model", {})
            model_data = by_model.get(model_key, {})
            for day, counts in model_data.items():
                if date_range is not None and day not in date_range:
                    continue
                total_in  += counts.get("in",  0)
                total_out += counts.get("out", 0)

        return {"in": total_in, "out": total_out, "total": total_in + total_out}

    def get_models(self) -> "list[str]":
        """Return sorted list of all vendor/model keys present in the cache."""
        return sorted(self._cache.get("by_model", {}).keys())

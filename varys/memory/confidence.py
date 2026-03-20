"""Deterministic confidence computation for preference entries.

No LLM calls — purely arithmetic based on evidence count, consistency, and recency.
Formula from spec §6.1:

  confidence = evidence_floor × consistency_ratio × recency_factor × source_weight

All inputs are read directly from the preference dict fields.
"""
import datetime
import math
from typing import Any, Dict


_RECENCY_DECAY_DAYS = 90   # half-life: confidence decays to ~0.1 after 90 days of no reinforcement
_SOURCE_PENALTY     = 0.8  # inferred prefs start at 80 % of an explicit pref's confidence


def compute_confidence(pref: Dict[str, Any]) -> float:
    """Return a [0, 1] confidence score for *pref*.

    Args:
        pref: preference dict with fields ``evidence_count``, ``consistent_count``,
              ``last_reinforced`` (ISO-8601 string or None), and ``source``.

    Returns:
        Float in [0.0, 1.0].  Never raises — returns 0.0 on any error.
    """
    try:
        evidence:   int   = int(pref.get("evidence_count",  1))
        consistent: int   = int(pref.get("consistent_count", 1))
        source:     str   = str(pref.get("source", "inferred"))
        last_str:   Any   = pref.get("last_reinforced")

        # Evidence floor: 3 observations → 1.0; fewer → proportional fraction
        ev_floor = min(evidence / 3.0, 1.0)

        # Consistency ratio: fraction of observations that are consistent
        if evidence > 0:
            consistency = min(consistent / evidence, 1.0)
        else:
            consistency = 0.0

        # Recency factor: linear decay from 1.0 → 0.1 over RECENCY_DECAY_DAYS
        recency = _recency_factor(last_str)

        # Source weight: explicit user statements carry full weight
        src_weight = 1.0 if source == "explicit" else _SOURCE_PENALTY

        score = ev_floor * consistency * recency * src_weight
        # Clamp to [0, 1] and apply 2 decimal precision
        return round(max(0.0, min(1.0, score)), 2)

    except Exception:
        return 0.0


def _recency_factor(last_reinforced: Any) -> float:
    """Linear decay: 1.0 when just reinforced, 0.1 after RECENCY_DECAY_DAYS."""
    if not last_reinforced:
        return 0.5  # unknown age → moderate recency

    try:
        if isinstance(last_reinforced, str):
            # Handle both full ISO-8601 and date-only strings
            ts = datetime.datetime.fromisoformat(last_reinforced.replace("Z", "+00:00"))
        elif isinstance(last_reinforced, datetime.datetime):
            ts = last_reinforced
        elif isinstance(last_reinforced, datetime.date):
            ts = datetime.datetime.combine(last_reinforced, datetime.time())
        else:
            return 0.5

        # Strip timezone for arithmetic consistency
        if ts.tzinfo is not None:
            ts = ts.replace(tzinfo=None)

        now = datetime.datetime.utcnow()
        days_since = max(0, (now - ts).days)
        decay = 1.0 - days_since / _RECENCY_DECAY_DAYS
        return round(max(0.1, min(1.0, decay)), 4)

    except Exception:
        return 0.5

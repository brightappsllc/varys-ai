"""Injection pipeline — select relevant preferences for system-prompt injection.

Entry point: ``await select_preferences(query, pref_store, settings)``

Selection order:
  1. Always-inject entries (any confidence, any relevance)
  2. Keyword-matched entries above the confidence threshold
  3. If Simple Tasks model configured AND matched list > 10: LLM re-rank and trim
  4. Dedup + cap at MAX_INJECTED

Explicit preference detection:
  ``detect_explicit_preference(user_message)`` scans for statements like
  "always use X", "remember to Y", "I prefer Z" and returns a structured
  preference dict ready for ``PreferenceStore.upsert()``, or None.
"""
from __future__ import annotations

import logging
import re
from typing import Any, Dict, List, Optional

log = logging.getLogger(__name__)

_CONFIDENCE_THRESHOLD = 0.7
_MAX_INJECTED = 15
_LLM_SELECT_THRESHOLD = 10   # if candidates exceed this, call LLM to re-rank

# ---------------------------------------------------------------------------
# Explicit preference detection
# ---------------------------------------------------------------------------

# Patterns that strongly indicate the user is expressing a personal coding
# preference or asking Varys to remember something.
_EXPLICIT_PATTERNS = [
    # "always use X", "always add X", "always set X"
    re.compile(
        r"\b(?:always|never)\b.{0,60}\b(?:use|add|set|include|avoid|prefer|remember)\b",
        re.IGNORECASE,
    ),
    # "remember to X", "please remember X"
    re.compile(r"\bremember\s+(?:to\s+)?.{5,120}", re.IGNORECASE),
    # "I prefer X", "I like to X", "I always X"
    re.compile(r"\bI\s+(?:prefer|like\s+to|always|never)\b.{3,120}", re.IGNORECASE),
    # "add (this )?to (my )?preferences", "save this preference"
    re.compile(r"\badd.{0,20}preference|save.{0,20}preference", re.IGNORECASE),
    # "note that I always/never/prefer"
    re.compile(r"\bnote\s+that\b.{3,120}", re.IGNORECASE),
]

# Keywords that, when present, suggest the preference type
_TYPE_HINTS: List[tuple[re.Pattern, str]] = [
    (re.compile(r"\bimport|library|package|pd\s*=|np\s*=|sklearn\b", re.IGNORECASE), "library"),
    (re.compile(r"\brandom_state|seed|reproducib", re.IGNORECASE),                   "coding_style"),
    (re.compile(r"\btest_size|stratify|train_test|split\b", re.IGNORECASE),           "data_handling"),
    (re.compile(r"\bformat|style|docstring|comment|type.hint", re.IGNORECASE),        "coding_style"),
]


def detect_explicit_preference(user_message: str) -> Optional[Dict[str, Any]]:
    """Scan *user_message* for an explicit preference statement.

    Returns a preference dict ready for ``PreferenceStore.upsert()`` or ``None``
    if no preference was detected.  Does NOT call any LLM.
    """
    if not user_message or len(user_message) > 2000:
        return None

    matched = any(p.search(user_message) for p in _EXPLICIT_PATTERNS)
    if not matched:
        return None

    # Infer type from content keywords
    pref_type = "workflow"
    for pattern, hint in _TYPE_HINTS:
        if pattern.search(user_message):
            pref_type = hint
            break

    # Extract keywords from the message (words ≥ 4 chars, not common stop words)
    words = re.findall(r"\b[a-zA-Z_][a-zA-Z0-9_]{3,}\b", user_message)
    _STOP = {
        "always", "never", "please", "remember", "prefer", "that", "this",
        "with", "when", "then", "should", "would", "could", "have", "will",
        "your", "from", "just", "want", "need", "make", "sure", "note",
    }
    keywords = list(dict.fromkeys(  # preserve order, deduplicate
        w.lower() for w in words if w.lower() not in _STOP
    ))[:10]

    from .preference_store import make_preference
    return make_preference(
        pref_type=pref_type,
        content=user_message[:400],   # store first 400 chars
        source="explicit",
        keywords_include=keywords,
        evidence_count=1,
        consistent_count=1,
        always_inject=False,
    )


# ---------------------------------------------------------------------------
# Keyword fallback selector
# ---------------------------------------------------------------------------

def _keyword_score(entry: Dict[str, Any], query: str) -> float:
    """Return how well *entry* matches *query* based on keyword overlap.

    Returns a [0, 1] float: 0.0 = no match, 1.0 = all include keywords hit.
    Exclude-keyword hits penalty: any match reduces score toward 0.
    """
    kw = entry.get("keywords", {}) or {}
    includes: List[str] = kw.get("include") or []
    excludes: List[str] = kw.get("exclude") or []
    query_lc = query.lower()

    # Exclusion: if any exclude keyword found, score = 0
    for exc in excludes:
        if exc.lower() in query_lc:
            return 0.0

    if not includes:
        # No keywords defined → moderate base relevance (include if confidence is high)
        return 0.5

    hits = sum(1 for kw_word in includes if kw_word.lower() in query_lc)
    return hits / len(includes)


def select_by_keywords(
    query: str,
    candidates: List[Dict[str, Any]],
    min_keyword_score: float = 0.0,
) -> List[Dict[str, Any]]:
    """Return *candidates* sorted by (confidence × keyword_score) desc.

    Entries with keyword_score == 0.0 are excluded.
    """
    scored = []
    for entry in candidates:
        ks = _keyword_score(entry, query)
        if ks <= 0.0:
            continue
        combined = float(entry.get("confidence", 0.0)) * ks
        scored.append((combined, entry))

    scored.sort(key=lambda t: t[0], reverse=True)
    return [e for _, e in scored if _ >= min_keyword_score]


# ---------------------------------------------------------------------------
# LLM selector (when Simple Tasks model configured and candidate list is large)
# ---------------------------------------------------------------------------

async def _llm_select(
    query: str,
    candidates: List[Dict[str, Any]],
    settings: dict,
    limit: int = _MAX_INJECTED,
) -> List[Dict[str, Any]]:
    """Use the Simple Tasks model to re-rank and trim *candidates* to *limit*.

    Falls back to the keyword order when the LLM call fails or returns garbage.
    """
    try:
        from ..llm.factory import create_bg_task_provider
        provider = create_bg_task_provider(settings)
        if provider is None:
            return candidates[:limit]

        ids_content = "\n".join(
            f"[{i}] {e.get('id', '?')}: {e.get('content', '')[:120]}"
            for i, e in enumerate(candidates)
        )
        system = (
            "You are a preference-selection assistant. "
            "Your task is to select the most relevant user preferences for a given query. "
            "Reply with ONLY a JSON array of integer indices, e.g. [0, 2, 5]. "
            "Do NOT include any explanation."
        )
        user = (
            f"Query: {query[:300]}\n\n"
            f"Preferences (index: id: content):\n{ids_content}\n\n"
            f"Select up to {limit} most relevant indices, ordered by relevance."
        )
        raw = await provider.chat(system=system, user=user)
        # Parse the JSON array
        m = re.search(r"\[[\d,\s]+\]", raw or "")
        if not m:
            return candidates[:limit]

        import json
        indices = json.loads(m.group())
        selected = [candidates[i] for i in indices if isinstance(i, int) and 0 <= i < len(candidates)]
        return selected[:limit] if selected else candidates[:limit]

    except Exception as exc:
        log.debug("LLM preference selection failed (%s) — using keyword order", exc)
        return candidates[:limit]


# ---------------------------------------------------------------------------
# Main entry point
# ---------------------------------------------------------------------------

async def select_preferences(
    query: str,
    pref_store: Any,   # PreferenceStore
    settings: dict,
) -> List[Dict[str, Any]]:
    """Select preferences relevant to *query* from *pref_store*.

    Returns a list ready to pass to ``format_preferences_for_prompt()``.
    """
    all_prefs = pref_store.get_all()
    if not all_prefs:
        return []

    # Always-inject entries go in regardless
    always = [p for p in all_prefs if p.get("always_inject")]
    remaining = [p for p in all_prefs if not p.get("always_inject")]

    # Filter by confidence threshold
    eligible = [
        p for p in remaining
        if float(p.get("confidence", 0.0)) >= _CONFIDENCE_THRESHOLD
    ]

    # Keyword ranking
    ranked = select_by_keywords(query, eligible)

    # LLM re-rank when list is large and Simple Tasks model is configured
    if len(ranked) > _LLM_SELECT_THRESHOLD and settings.get("ds_assistant_bg_task_provider"):
        ranked = await _llm_select(query, ranked, settings, limit=_MAX_INJECTED)

    # Combine: always-inject first, then ranked (up to cap)
    slots_left = max(0, _MAX_INJECTED - len(always))
    combined = always + ranked[:slots_left]

    # Deduplicate by id
    seen: set = set()
    result = []
    for p in combined:
        pid = p.get("id", id(p))
        if pid not in seen:
            seen.add(pid)
            result.append(p)

    return result


# ---------------------------------------------------------------------------
# Prompt formatter (spec §7.5)
# ---------------------------------------------------------------------------

def format_preferences_for_prompt(preferences: List[Dict[str, Any]]) -> str:
    """Serialize *preferences* into the system-prompt memory block.

    Format (§7.5):
      ## User Preferences
      [coding_style] Always sets random_state=42 on stochastic estimators. (confidence: 0.91)
      [library] Consistently imports pandas as pd and numpy as np.
      ...
    """
    if not preferences:
        return ""

    lines = ["## User Preferences"]
    for pref in preferences:
        ptype = pref.get("type", "general")
        content = pref.get("content", "").strip()
        conf = float(pref.get("confidence", 0.0))
        always = pref.get("always_inject", False)

        if not content:
            continue

        conf_str = f"  (confidence: {conf:.2f})" if not always else ""
        lines.append(f"[{ptype}] {content}.{conf_str}")

    if len(lines) == 1:
        return ""  # No valid entries

    return "\n".join(lines)

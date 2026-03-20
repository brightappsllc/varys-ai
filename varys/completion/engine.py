"""Code completion engine — calls Claude to generate code suggestions."""
import re
from typing import Any, Dict, List, Optional

import anthropic

from .cache import CompletionCache
from ..utils.config import get_config as _get_cfg

DEFAULT_COMPLETION_MODEL = "claude-haiku-4-5-20251001"

COMPLETION_SYSTEM = (
    "You are a Python code completion assistant embedded in JupyterLab. "
    "Respond with ONLY valid Python code — no explanation, no markdown fences. "
    "Complete the code at the cursor position. Use proper indentation and match "
    "the existing coding style."
)


def _build_context_block(previous_cells: List[Dict[str, Any]]) -> str:
    """Format the last N executed cells as context."""
    if not previous_cells:
        return ""
    cfg = _get_cfg()
    n_cells = cfg.getint("context", "prev_cells", 5)
    cell_limit = cfg.getint("context", "cell_source_limit", 800)
    lines = ["# --- Notebook context (previous cells) ---"]
    for cell in previous_cells[-n_cells:]:
        src = cell.get("source", "").strip()
        if src:
            lines.append(src[:cell_limit])
            lines.append("")
    return "\n".join(lines)


def _extract_imports(cells: List[Dict[str, Any]]) -> str:
    """Pull all import lines from previous cells (cheap context)."""
    imports: List[str] = []
    for cell in cells:
        for line in cell.get("source", "").splitlines():
            if re.match(r"^\s*(import |from \w)", line):
                imports.append(line.strip())
    return "\n".join(dict.fromkeys(imports))


class CompletionEngine:
    """Generate code completions using the Anthropic API."""

    def __init__(
        self,
        api_key: str,
        completion_model: str = DEFAULT_COMPLETION_MODEL,
    ) -> None:
        self._api_key = api_key
        self._completion_model = completion_model
        self._cache = CompletionCache()
        self._aclient: Optional[anthropic.AsyncAnthropic] = (
            anthropic.AsyncAnthropic(api_key=api_key) if api_key else None
        )

    async def complete(
        self,
        prefix: str,
        suffix: str,
        language: str,
        previous_cells: List[Dict[str, Any]],
    ) -> Dict[str, Any]:
        """Return a completion dict: {suggestion, type, lines, cached}."""
        imports_snapshot = _extract_imports(previous_cells)
        cache_key = CompletionCache.make_key(prefix, language, "completion", imports_snapshot)

        cached = self._cache.get(cache_key)
        if cached is not None:
            return {
                "suggestion": cached,
                "type": "completion",
                "lines": cached.splitlines(),
                "cached": True,
            }

        suggestion = await self._call_claude(prefix, suffix, previous_cells)

        if suggestion:
            self._cache.set(cache_key, suggestion)

        return {
            "suggestion": suggestion,
            "type": "completion",
            "lines": suggestion.splitlines() if suggestion else [],
            "cached": False,
        }

    def cache_stats(self) -> Dict[str, Any]:
        return self._cache.stats()

    async def _call_claude(
        self,
        prefix: str,
        suffix: str,
        previous_cells: List[Dict[str, Any]],
    ) -> str:
        if not self._aclient:
            return ""
        context_block = _build_context_block(previous_cells)
        user_msg = (
            f"{context_block}\n\n"
            f"# --- Current cell ---\n"
            f"{prefix}<CURSOR>{suffix}\n\n"
            "Complete the code at <CURSOR>. Output only the inserted text."
        ).strip()

        import os as _os
        cfg = _get_cfg()
        max_tok = int(_os.environ.get("COMPLETION_MAX_TOKENS") or cfg.getint("tokens", "completion_max_tokens", 128))
        response = await self._aclient.messages.create(
            model=self._completion_model,
            max_tokens=max_tok,
            system=COMPLETION_SYSTEM,
            messages=[{"role": "user", "content": user_msg}],
        )
        if not response.content or not hasattr(response.content[0], "text"):
            return ""
        return self._clean(response.content[0].text.strip())

    @staticmethod
    def _clean(text: str) -> str:
        text = re.sub(r"^```[a-z]*\n?", "", text, flags=re.MULTILINE)
        text = re.sub(r"\n?```$", "", text, flags=re.MULTILINE)
        return text.strip()

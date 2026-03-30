"""AST-based symbol extractor for unexecuted cells.

Thin wrapper around _extract_symbols() from varys/context/summarizer.py.
Used by GraphBuilder for cells absent from the SummaryStore.
"""
from __future__ import annotations

from ..context.summarizer import _extract_symbols


class ASTParser:
    """Extracts defined/consumed symbols via static AST analysis."""

    @staticmethod
    def extract(source: str) -> dict:
        """Return {'defines': [...], 'loads': [...]} for the given source."""
        defines, loads = _extract_symbols(source)
        return {"defines": defines, "loads": loads}

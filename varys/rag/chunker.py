"""Document chunking for Varys RAG.

Supported formats
-----------------
* .ipynb  — Jupyter notebooks (cell-by-cell with output extraction)
* .md     — Markdown (split by heading then by paragraph)
* .txt    — Plain text (sliding window)
* .pdf    — PDFs via PyMuPDF (optional dep); page-level then sliding window
* .py     — Python source (function/class-level then fallback to sliding window)

Each chunk is a dict:
    text:        str   — content to embed
    source_file: str   — absolute path
    chunk_type:  str   — 'notebook_code' | 'notebook_markdown' | 'text' | 'pdf' | 'python'
    cell_idx:    int   — (notebooks only)
    page:        int   — (PDFs only)
    exec_count:  int?  — (notebooks only)
"""
from __future__ import annotations

import ast
import json
import logging
import re
from pathlib import Path
from typing import Any, Dict, List, Optional

log = logging.getLogger(__name__)

# ── Constants (overridable via .jupyter-assistant/config/rag.cfg) ─────────────

from ..utils.config import get_config as _get_config  # noqa: E402

def _cfg_int(section: str, key: str, default: int) -> int:
    return _get_config().getint(section, key, default)

CHUNK_SIZE    = _cfg_int("chunking", "chunk_size",    512)
CHUNK_OVERLAP = _cfg_int("chunking", "chunk_overlap",  64)
MAX_OUTPUT    = _cfg_int("chunking", "max_cell_output", 400)


# ── Public entry point ────────────────────────────────────────────────────────

def chunk_file(path: str) -> List[Dict[str, Any]]:
    """Dispatch to the correct parser based on file extension."""
    p = Path(path)
    ext = p.suffix.lower()
    try:
        if ext == ".ipynb":
            return _chunk_notebook(path)
        elif ext in {".md", ".markdown"}:
            return _chunk_text(path, chunk_type="markdown")
        elif ext == ".txt":
            return _chunk_text(path, chunk_type="text")
        elif ext == ".pdf":
            return _chunk_pdf(path)
        elif ext == ".py":
            return _chunk_python(path)
        else:
            return []
    except Exception as exc:
        log.warning("RAG chunker: error processing %s — %s", path, exc)
        return []


# ── Notebook chunker ──────────────────────────────────────────────────────────

def _extract_cell_outputs(cell: Dict) -> str:
    """Extract plain-text output from a notebook cell."""
    lines: List[str] = []
    for output in cell.get("outputs", []):
        otype = output.get("output_type", "")
        if otype in ("stream", "display_data", "execute_result"):
            data = output.get("data", {})
            text = data.get("text/plain") or output.get("text", [])
            if isinstance(text, list):
                lines.extend(text)
            elif isinstance(text, str):
                lines.append(text)
    result = "".join(lines).strip()
    return result[:MAX_OUTPUT] if result else ""


def _chunk_notebook(path: str) -> List[Dict[str, Any]]:
    """Parse a .ipynb file into semantic chunks.

    Strategy (recommended in reference doc, applied critically):
    - Each markdown cell → one chunk (headers act as natural section boundaries).
    - Each code cell → one chunk combining code + trimmed output.
    - We do NOT group markdown+code together into sections because the individual
      cell granularity gives better retrieval precision.
    """
    with open(path, encoding="utf-8") as f:
        nb = json.load(f)

    chunks: List[Dict[str, Any]] = []
    cells = nb.get("cells", [])

    for idx, cell in enumerate(cells):
        source = "".join(cell.get("source", [])).strip()
        if not source:
            continue

        if cell["cell_type"] == "markdown":
            chunks.append({
                "text":        source,
                "source_file": path,
                "chunk_type":  "notebook_markdown",
                "cell_idx":    idx,
                "exec_count":  None,
            })

        elif cell["cell_type"] == "code":
            output = _extract_cell_outputs(cell)
            text = f"Code:\n{source}"
            if output:
                text += f"\n\nOutput:\n{output}"
            chunks.append({
                "text":        text,
                "source_file": path,
                "chunk_type":  "notebook_code",
                "cell_idx":    idx,
                "exec_count":  cell.get("execution_count"),
            })

    return chunks


# ── Text / Markdown chunker ───────────────────────────────────────────────────

def _sliding_window(text: str, size: int = CHUNK_SIZE, overlap: int = CHUNK_OVERLAP) -> List[str]:
    """Split text into overlapping chunks."""
    if not text.strip():
        return []
    if len(text) <= size:
        return [text.strip()]
    chunks = []
    start = 0
    while start < len(text):
        end = min(start + size, len(text))
        chunk = text[start:end].strip()
        if chunk:
            chunks.append(chunk)
        if end == len(text):
            break
        start = end - overlap
    return chunks


def _chunk_text(path: str, chunk_type: str = "text") -> List[Dict[str, Any]]:
    """Split a plain-text or markdown file into overlapping chunks.

    For markdown, first split by heading (## / ###) to preserve sections.
    """
    text = Path(path).read_text(encoding="utf-8", errors="replace")
    chunks: List[Dict[str, Any]] = []

    if chunk_type == "markdown":
        # Split by level-1 or level-2 headings
        sections = re.split(r"(?m)^#{1,2}\s+", text)
        for section in sections:
            section = section.strip()
            if not section:
                continue
            for sub in _sliding_window(section):
                chunks.append({
                    "text":        sub,
                    "source_file": path,
                    "chunk_type":  "markdown",
                    "cell_idx":    None,
                    "page":        None,
                })
    else:
        for sub in _sliding_window(text):
            chunks.append({
                "text":        sub,
                "source_file": path,
                "chunk_type":  "text",
                "cell_idx":    None,
                "page":        None,
            })

    return chunks


# ── PDF chunker ───────────────────────────────────────────────────────────────

def _chunk_pdf(path: str) -> List[Dict[str, Any]]:
    """Extract text from a PDF using PyMuPDF (optional dep).

    Falls back gracefully if PyMuPDF is not installed.
    """
    try:
        import fitz  # PyMuPDF  # noqa: F401
    except ImportError:
        log.warning("RAG chunker: PyMuPDF not installed — skipping %s", path)
        return []

    import fitz  # type: ignore

    chunks: List[Dict[str, Any]] = []
    try:
        doc = fitz.open(path)
        for page_num, page in enumerate(doc, start=1):
            text = page.get_text().strip()
            if not text:
                continue
            for sub in _sliding_window(text):
                chunks.append({
                    "text":        sub,
                    "source_file": path,
                    "chunk_type":  "pdf",
                    "cell_idx":    None,
                    "page":        page_num,
                })
        doc.close()
    except Exception as exc:
        log.warning("RAG chunker: PDF error %s — %s", path, exc)

    return chunks


# ── Python source chunker ────────────────────────────────────────────────────

def _chunk_python(path: str) -> List[Dict[str, Any]]:
    """Parse Python source: each top-level function/class is one chunk.

    Falls back to sliding window if parsing fails.
    """
    source = Path(path).read_text(encoding="utf-8", errors="replace")
    chunks: List[Dict[str, Any]] = []

    try:
        tree = ast.parse(source)
        lines = source.splitlines(keepends=True)

        for node in ast.walk(tree):
            if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                continue
            if not hasattr(node, "lineno"):
                continue
            start = node.lineno - 1
            end   = node.end_lineno if hasattr(node, "end_lineno") else start + 50
            snippet = "".join(lines[start:end]).strip()
            if snippet:
                for sub in _sliding_window(snippet):
                    chunks.append({
                        "text":        sub,
                        "source_file": path,
                        "chunk_type":  "python",
                        "cell_idx":    None,
                        "page":        None,
                    })

    except SyntaxError:
        # Fallback: sliding window
        for sub in _sliding_window(source):
            chunks.append({
                "text":        sub,
                "source_file": path,
                "chunk_type":  "python",
                "cell_idx":    None,
                "page":        None,
            })

    return chunks


# ── Supported file extensions ─────────────────────────────────────────────────

def _get_supported_extensions() -> set:
    defaults = [".ipynb", ".md", ".markdown", ".txt", ".pdf", ".py"]
    exts = _get_config().getlist("chunking", "supported_extensions", defaults)
    return {e if e.startswith(".") else f".{e}" for e in exts}

SUPPORTED_EXTENSIONS = _get_supported_extensions()


def find_files(root: str) -> List[str]:
    """Recursively find all indexable files under root."""
    p = Path(root)
    exts = _get_supported_extensions()
    if p.is_file() and p.suffix.lower() in exts:
        return [str(p)]
    results = []
    for ext in exts:
        results.extend(str(f) for f in p.rglob(f"*{ext}"))
    return results

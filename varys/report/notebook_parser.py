"""Notebook parser — converts a notebook JSON to a structured text representation
for LLM consumption, with full cell outputs.

Based on the nbformat 4.x specification.
"""
from __future__ import annotations

import html
import re
from typing import Any, Dict, List


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def format_notebook_for_llm(notebook_json: Dict[str, Any]) -> str:
    """Convert a notebook JSON object to a rich text string for the LLM.

    Includes:
    - Notebook metadata
    - Cell statistics
    - Every cell's source + all outputs (text, tables, error messages)
    - IMAGE markers referencing figure numbers (actual base64 is in a separate
      section built by image_extractor.py)
    """
    meta   = _format_metadata(notebook_json)
    stats  = _format_statistics(notebook_json)
    cells  = _format_cells(notebook_json)
    return f"{meta}\n\n{stats}\n\n{cells}"


def count_cell_statistics(notebook_json: Dict[str, Any]) -> Dict[str, int]:
    """Return counts for the Appendix completeness table."""
    cells = notebook_json.get("cells", [])
    code_cells   = [c for c in cells if c.get("cell_type") == "code"]
    md_cells     = [c for c in cells if c.get("cell_type") == "markdown"]
    with_outputs = [c for c in code_cells if c.get("outputs")]
    errors       = [
        c for c in code_cells
        if any(o.get("output_type") == "error" for o in c.get("outputs", []))
    ]
    return {
        "total":        len(cells),
        "markdown":     len(md_cells),
        "code":         len(code_cells),
        "with_outputs": len(with_outputs),
        "errors":       len(errors),
    }


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _format_metadata(nb: Dict[str, Any]) -> str:
    meta     = nb.get("metadata", {})
    ks       = meta.get("kernelspec", {})
    lang_inf = meta.get("language_info", {})
    lines = ["=== NOTEBOOK METADATA ==="]
    lines.append(f"Kernel:   {ks.get('display_name', ks.get('name', 'unknown'))}")
    lines.append(f"Language: {lang_inf.get('name', ks.get('language', 'unknown'))}")
    version = lang_inf.get("version", "")
    if version:
        lines.append(f"Version:  {version}")
    lines.append(f"Format:   nbformat {nb.get('nbformat', '?')}.{nb.get('nbformat_minor', '?')}")
    return "\n".join(lines)


def _format_statistics(nb: Dict[str, Any]) -> str:
    s = count_cell_statistics(nb)
    lines = [
        "=== CELL STATISTICS ===",
        f"Total cells:            {s['total']}",
        f"Markdown cells:         {s['markdown']}",
        f"Code cells:             {s['code']}",
        f"Code cells with output: {s['with_outputs']}",
        f"Code cells with errors: {s['errors']}",
    ]
    return "\n".join(lines)


def _format_cells(nb: Dict[str, Any]) -> str:
    cells = nb.get("cells", [])
    parts = ["=== NOTEBOOK CELLS ==="]
    fig_counter = [0]  # mutable int for nested helper
    for idx, cell in enumerate(cells):
        parts.append(_format_cell(cell, idx, fig_counter))
    return "\n".join(parts)


def _format_cell(cell: Dict[str, Any], idx: int, fig_counter: List[int]) -> str:
    cell_type = cell.get("cell_type", "code")
    exec_count = cell.get("execution_count")

    header_parts = [f"--- #{idx + 1} ({cell_type})"]
    if cell_type == "code" and exec_count is None:
        header_parts.append("[not run]")
    header = " ".join(header_parts) + " ---"

    source = _join_source(cell.get("source", []))
    lines = [header, "SOURCE:", source or "(empty)"]

    if cell_type == "code" and cell.get("outputs"):
        lines.append("OUTPUTS:")
        for out_idx, output in enumerate(cell["outputs"]):
            formatted = _format_output(output, out_idx, fig_counter)
            lines.append(formatted)

    lines.append("")  # blank separator
    return "\n".join(lines)


def _format_output(output: Dict[str, Any], out_idx: int, fig_counter: List[int]) -> str:
    otype = output.get("output_type", "")
    prefix = f"  Output {out_idx} ({otype}):"

    if otype == "stream":
        text = _join_source(output.get("text", []))
        return f"{prefix}\n    {_indent(text, 4)}"

    if otype in ("execute_result", "display_data"):
        data = output.get("data", {})
        # Check for images first
        for mime in ("image/png", "image/jpeg", "image/svg+xml"):
            if mime in data:
                fig_counter[0] += 1
                short_mime = mime.split("/")[1].upper()
                return f"{prefix}\n    [IMAGE: Figure {fig_counter[0]}, {short_mime}]"
        # HTML table — strip tags for readability
        if "text/html" in data:
            raw_html = _join_source(data["text/html"])
            table_text = _html_table_to_text(raw_html)
            return f"{prefix} (HTML table)\n    {_indent(table_text, 4)}"
        # Plain text fallback
        text = _join_source(data.get("text/plain", []))
        return f"{prefix}\n    {_indent(text, 4)}"

    if otype == "error":
        ename  = output.get("ename", "Error")
        evalue = output.get("evalue", "")
        # Strip ANSI escape codes from traceback
        tb = output.get("traceback", [])
        tb_clean = [_strip_ansi(line) for line in tb[-5:]]  # last 5 lines
        tb_str = "\n".join(tb_clean)
        return f"{prefix}\n    {ename}: {evalue}\n    {_indent(tb_str, 4)}"

    return f"{prefix}\n    (unrecognised output type)"


def _join_source(source) -> str:
    if isinstance(source, list):
        return "".join(source)
    return str(source)


def _indent(text: str, spaces: int) -> str:
    pad = " " * spaces
    return text.replace("\n", f"\n{pad}")


def _strip_ansi(text: str) -> str:
    return re.sub(r"\x1b\[[0-9;]*[mGKHF]", "", text)


def _html_table_to_text(html_str: str) -> str:
    """Very light HTML table → plain-text converter (no external deps)."""
    # Remove style/script blocks
    html_str = re.sub(r"<style[^>]*>.*?</style>", "", html_str, flags=re.DOTALL | re.I)
    # Extract rows
    rows = re.findall(r"<tr[^>]*>(.*?)</tr>", html_str, re.DOTALL | re.I)
    table_lines = []
    for row in rows:
        cells = re.findall(r"<t[dh][^>]*>(.*?)</t[dh]>", row, re.DOTALL | re.I)
        clean = [html.unescape(re.sub(r"<[^>]+>", "", c)).strip() for c in cells]
        table_lines.append(" | ".join(clean))
    return "\n".join(table_lines) if table_lines else re.sub(r"<[^>]+>", " ", html_str).strip()

"""Image extractor — pulls base64-encoded images from notebook outputs.

Images are already base64 in the notebook JSON (image/png, image/jpeg).
SVG is XML text which we base64-encode here for uniform handling.
"""
from __future__ import annotations

import base64
import re
from typing import Any, Dict, List


def extract_all_images(notebook_json: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Return a list of image dicts, one per image found in any cell output.

    Each dict contains:
      cell_index   : int    — zero-based cell index
      output_index : int    — zero-based output index within the cell
      mime_type    : str    — 'image/png' | 'image/jpeg' | 'image/svg+xml'
      data         : str    — base64 string (ready for data: URI)
      context      : str    — surrounding markdown text for caption hints
      figure_number: int    — sequential 1-based figure number
    """
    cells = notebook_json.get("cells", [])
    images = []
    fig_num = 0

    for cell_idx, cell in enumerate(cells):
        if cell.get("cell_type") != "code":
            continue
        for out_idx, output in enumerate(cell.get("outputs", [])):
            if output.get("output_type") not in ("display_data", "execute_result"):
                continue
            data = output.get("data", {})
            for mime in ("image/png", "image/jpeg", "image/svg+xml"):
                if mime not in data:
                    continue
                raw = data[mime]
                if mime == "image/svg+xml":
                    # SVG is stored as raw XML string — base64-encode it
                    svg_bytes = (
                        raw if isinstance(raw, bytes)
                        else "".join(raw).encode("utf-8") if isinstance(raw, list)
                        else raw.encode("utf-8")
                    )
                    encoded = base64.b64encode(svg_bytes).decode("ascii")
                else:
                    # PNG/JPEG is already a base64 string; strip whitespace
                    encoded = (
                        "".join(raw) if isinstance(raw, list) else raw
                    ).replace("\n", "").strip()

                fig_num += 1
                images.append({
                    "cell_index":    cell_idx,
                    "output_index":  out_idx,
                    "mime_type":     mime,
                    "data":          encoded,
                    "context":       get_image_context(notebook_json, cell_idx),
                    "figure_number": fig_num,
                })
                break  # one image per output (prefer PNG over JPEG over SVG)

    return images


def get_image_context(notebook_json: Dict[str, Any], cell_index: int) -> str:
    """Return contextual text from cells surrounding cell_index.

    Looks at:
    - Up to 2 markdown cells immediately before
    - Up to 1 markdown cell immediately after
    - Variable / plt.title() hints from the code cell itself
    """
    cells = notebook_json.get("cells", [])
    context_parts = []

    # Cells before (markdown only, up to 2)
    before_md = []
    for i in range(max(0, cell_index - 3), cell_index):
        if cells[i].get("cell_type") == "markdown":
            src = _join(cells[i].get("source", []))
            if src.strip():
                before_md.append(src.strip())
    context_parts.extend(before_md[-2:])  # at most 2

    # Hints from the code cell itself
    if cell_index < len(cells):
        src = _join(cells[cell_index].get("source", []))
        hints = _extract_plot_hints(src)
        if hints:
            context_parts.append(hints)

    # Cell after (markdown only)
    if cell_index + 1 < len(cells):
        after = cells[cell_index + 1]
        if after.get("cell_type") == "markdown":
            src = _join(after.get("source", []))
            if src.strip():
                context_parts.append(src.strip())

    return " | ".join(context_parts) if context_parts else "No surrounding context found."


def build_images_section(images: List[Dict[str, Any]]) -> str:
    """Format the EXTRACTED IMAGES block that goes into the LLM prompt."""
    if not images:
        return "EXTRACTED IMAGES:\n(No images found in notebook outputs)"

    parts = ["EXTRACTED IMAGES:"]
    for img in images:
        mime_short = img["mime_type"].split("/")[1].upper()
        parts.append(
            f"\nFigure {img['figure_number']} "
            f"(Cell {img['cell_index']}, Output {img['output_index']}):\n"
            f"Type:    {img['mime_type']}\n"
            f"Context: {img['context']}\n"
            f"Data:    {img['data'][:80]}...  [{mime_short}, {len(img['data'])} chars base64]"
        )
    return "\n".join(parts)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _join(source) -> str:
    if isinstance(source, list):
        return "".join(source)
    return str(source)


def _extract_plot_hints(code: str) -> str:
    """Extract plt.title(), plt.xlabel(), variable names used in plot calls."""
    hints = []
    for pattern, label in [
        (r'plt\.title\(["\']([^"\']+)["\']', "Title"),
        (r'plt\.xlabel\(["\']([^"\']+)["\']', "X-axis"),
        (r'plt\.ylabel\(["\']([^"\']+)["\']', "Y-axis"),
        (r'\.set_title\(["\']([^"\']+)["\']', "Title"),
        (r'fig\.suptitle\(["\']([^"\']+)["\']', "Title"),
    ]:
        m = re.search(pattern, code)
        if m:
            hints.append(f"{label}: {m.group(1)}")
    return "; ".join(hints)

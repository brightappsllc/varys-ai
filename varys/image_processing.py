"""In-memory image processing utilities for Varys.

Handles strip and resize operations on notebook cell image outputs before they
are sent to LLM providers.  No files on disk are ever modified.
"""

from __future__ import annotations

import base64
import io
import re
from typing import Any, Dict, List, Optional, Tuple


# ---------------------------------------------------------------------------
# DIM argument parsing and validation
# ---------------------------------------------------------------------------

def parse_resize_dim(arg: str) -> int:
    """Parse and validate the DIM argument from ``/resize(DIM)``.

    Accepts either the full command ``/resize(7800)`` or a bare integer
    ``7800``.  Raises ``ValueError`` with a user-friendly message if invalid.
    """
    arg = arg.strip()
    m = re.match(r"^/resize\((\d+)\)$", arg) or re.match(r"^(\d+)$", arg)
    if not m:
        raise ValueError(
            f"Invalid resize argument '{arg}'. "
            "Use a positive integer ≥ 10, e.g. /resize(7800)."
        )
    dim = int(m.group(1))
    if dim < 10:
        raise ValueError(
            f"Resize dimension must be ≥ 10 (got {dim})."
        )
    return dim


# ---------------------------------------------------------------------------
# Single-image resize
# ---------------------------------------------------------------------------

def resize_b64_image(b64_data: str, max_dim: int) -> Tuple[Optional[str], Optional[str]]:
    """Resize a base64-encoded image so neither dimension exceeds *max_dim*.

    Returns ``(resized_b64, None)`` on success, or ``(None, warning_message)``
    when the image should be skipped.  The returned base64 string uses the
    same format as the input (no ``data:`` URI prefix).

    Pillow is required at runtime; if absent the image is skipped with a
    warning rather than raising.
    """
    try:
        from PIL import Image  # type: ignore[import-untyped]
    except ImportError:
        return None, "Pillow is not installed; cannot resize images (pip install Pillow)"

    try:
        raw = base64.b64decode(b64_data)
        img = Image.open(io.BytesIO(raw))
        w, h = img.size

        if w <= max_dim and h <= max_dim:
            # Already within limits — return unchanged
            return b64_data, None

        scale = min(max_dim / w, max_dim / h)
        new_w = max(1, round(w * scale))
        new_h = max(1, round(h * scale))

        if new_w < 10 or new_h < 10:
            return None, (
                f"Image ({w}×{h}): resizing to fit {max_dim}px would produce a "
                f"degenerate {new_w}×{new_h} image — skipped"
            )

        # Preserve format; fall back to PNG for unknown formats
        fmt = (img.format or "PNG").upper()
        if fmt not in ("PNG", "JPEG", "WEBP", "GIF"):
            fmt = "PNG"

        img = img.resize((new_w, new_h), Image.LANCZOS)
        buf = io.BytesIO()
        img.save(buf, format=fmt)
        resized_b64 = base64.b64encode(buf.getvalue()).decode("ascii")
        return resized_b64, None

    except Exception as exc:  # noqa: BLE001
        return None, f"Could not process image: {exc}"


# ---------------------------------------------------------------------------
# Payload-level operations
# ---------------------------------------------------------------------------

def apply_image_mode(
    notebook_context: Dict[str, Any],
    image_mode: Dict[str, Any],
) -> Tuple[int, List[str]]:
    """Apply the active image mode to *notebook_context* **in-place**.

    ``image_mode`` must be one of:
    - ``{"mode": "no_figures"}``
    - ``{"mode": "resize", "dim": <int>}``

    Returns ``(resized_count, warnings)`` where *resized_count* is the number
    of images that were actually downscaled (0 for strip mode) and *warnings*
    is a list of per-image advisory strings for images that were skipped.
    """
    mode = image_mode.get("mode", "")
    resized_count = 0
    warnings: List[str] = []

    if mode == "no_figures":
        # Remove imageOutput from every cell
        for cell in notebook_context.get("cells", []):
            cell.pop("imageOutput", None)

        # Remove selectedOutput if it carries an image
        sel = notebook_context.get("selectedOutput")
        if sel and isinstance(sel, dict) and sel.get("mimeType", "").startswith("image"):
            notebook_context.pop("selectedOutput", None)

    elif mode == "resize":
        dim: int = int(image_mode.get("dim", 7800))

        # Resize per-cell images
        for cell in notebook_context.get("cells", []):
            img = cell.get("imageOutput")
            if not img:
                continue
            idx = cell.get("index", "?")
            label = f"#{idx + 1}" if isinstance(idx, int) else "#?"
            resized, warn = resize_b64_image(img, dim)
            if warn:
                warnings.append(f"Cell {label}: {warn}")
            elif resized is not None and resized != img:
                cell["imageOutput"] = resized
                resized_count += 1

        # Resize selectedOutput
        sel = notebook_context.get("selectedOutput")
        if sel and isinstance(sel, dict):
            img_data = sel.get("imageData")
            if img_data and sel.get("mimeType", "").startswith("image"):
                resized, warn = resize_b64_image(img_data, dim)
                if warn:
                    warnings.append(f"Selected output: {warn}")
                elif resized is not None and resized != img_data:
                    sel["imageData"] = resized
                    resized_count += 1

    return resized_count, warnings


# ---------------------------------------------------------------------------
# Error detection
# ---------------------------------------------------------------------------

# Patterns that indicate the API rejected the request because an image was
# too large.  Matching is done on the lowercased exception string.
_ANTHROPIC_PATTERNS = (
    "image dimensions",
    "image exceeds",
    "image size exceeds",
    "max image dimensions",
    "image too large",
)

_OPENAI_PATTERNS = (
    "image_too_large",
    "image dimensions",
    "image exceeds",
    "image too large",
    "invalid image",
    "image size",
)


def is_image_dimension_error(exc: Exception) -> bool:
    """Return ``True`` if *exc* is an image-too-large API error.

    Covers known error message patterns from both Anthropic and OpenAI.
    Conservative by design: an unrelated 400-level error must not match.
    """
    msg = str(exc).lower()

    # Must mention "image" somewhere to avoid false positives on generic
    # "too large" or "size" messages from other API responses.
    if "image" not in msg:
        return False

    combined = _ANTHROPIC_PATTERNS + _OPENAI_PATTERNS
    return any(p in msg for p in combined)

"""Report generator — orchestrates the full notebook → markdown report pipeline.

Flow:
  1. Read the notebook JSON from disk.
  2. Parse cells + outputs into a structured text context.
  3. Extract all images (already base64 in the notebook JSON).
  4. Load the notebook-report-generation SKILL.md.
  5. Build the LLM prompt.
  6. Call provider.chat(system, user) — free-form, not cell-operation JSON.
  7. Post-process: embed actual base64 image data into the markdown.
  8. Save the report as UTF-8 .md file.
  9. Return metadata (filename, relative_path, preview).
"""
from __future__ import annotations

import json
import logging
import os
import re
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List

from .notebook_parser import format_notebook_for_llm, count_cell_statistics
from .image_extractor import extract_all_images, build_images_section

log = logging.getLogger(__name__)

# Maximum context size sent to the LLM (characters) to avoid token limit issues.
_MAX_CONTEXT_CHARS = 120_000
_MAX_IMAGES = 20          # embed at most this many images to control prompt size


def _find_skill_file(root_dir: str, notebook_path: str = "") -> str | None:
    """Locate the notebook-report-generation SKILL.md.

    Searches the notebook's own .jupyter-assistant directory first, then the
    root-level directory as a fallback (backward compat).
    """
    from ..utils.paths import project_base
    candidates = [
        project_base(root_dir, notebook_path) / "skills" / "notebook-report-generation" / "SKILL.md",
        Path(root_dir) / ".jupyter-assistant" / "skills" / "notebook-report-generation" / "SKILL.md",
    ]
    for p in candidates:
        if p.exists():
            return p.read_text(encoding="utf-8")
    return None


def _generate_filename(notebook_name: str) -> str:
    stem = re.sub(r"\.ipynb$", "", notebook_name, flags=re.I)
    stem = re.sub(r"[^\w\-]", "_", stem)
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    return f"{stem}_report_{ts}.md"


def _build_prompt(
    skill_content: str,
    notebook_context: str,
    images: List[Dict[str, Any]],
    stats: Dict[str, int],
) -> tuple[str, str]:
    """Return (system_prompt, user_prompt) for the LLM chat() call."""

    system_prompt = (
        "You are an expert technical writer and data scientist. "
        "Your task is to generate a professional, accurate markdown report "
        "from a Jupyter notebook. Follow all instructions in the skill file provided. "
        "Output ONLY the markdown report — no preamble, no explanation, no code fences "
        "wrapping the entire response."
    )

    # Build the images section with placeholders (no raw base64 in the prompt).
    embedded_images = images[:_MAX_IMAGES]
    images_section = _build_images_section_for_prompt(embedded_images)

    # Truncate notebook context if it's very large
    if len(notebook_context) > _MAX_CONTEXT_CHARS:
        notebook_context = (
            notebook_context[:_MAX_CONTEXT_CHARS]
            + f"\n\n... [TRUNCATED — notebook context exceeds {_MAX_CONTEXT_CHARS} chars] ..."
        )

    user_prompt = f"""{skill_content}

---

NOTEBOOK TO ANALYZE:

{notebook_context}

---

{images_section}

---

ANALYSIS COMPLETENESS SUMMARY:
Total cells: {stats['total']}
Markdown cells: {stats['markdown']}
Code cells: {stats['code']}
Cells with outputs: {stats['with_outputs']}
Cells with errors: {stats['errors']}
Images extracted: {len(images)}

---

Generate the complete markdown report now. Follow the structure template in the skill file exactly.
For every image listed above, embed it using the placeholder syntax on a SINGLE line:
  ![Figure N: descriptive caption](FIGURE_N_DATA)
The placeholders (FIGURE_1_DATA, FIGURE_2_DATA, …) will be replaced with real base64 data automatically.
Every numerical claim MUST be traceable to an OUTPUT section above.
"""
    return system_prompt, user_prompt


def _build_images_section_for_prompt(images: List[Dict[str, Any]]) -> str:
    """Images section for the LLM prompt — uses placeholders, NOT raw base64.

    The actual base64 data is injected by _embed_images_in_markdown() after
    the LLM responds.  This prevents the LLM from wrapping the base64 string
    across multiple lines, which would produce broken image tags.
    """
    if not images:
        return "EXTRACTED IMAGES:\n(No images found in notebook outputs)"

    parts = [
        "EXTRACTED IMAGES:",
        "",
        "IMPORTANT — image embedding instructions:",
        "  • When you want to embed Figure N, write EXACTLY this one-liner (no line breaks):",
        "      ![Figure N: your descriptive caption](FIGURE_N_DATA)",
        "  • Replace N with the figure number (1, 2, 3…).",
        "  • The FIGURE_N_DATA placeholder is mandatory — do NOT write base64 yourself.",
        "  • Keep the entire ![...](FIGURE_N_DATA) on a SINGLE line.",
        "",
    ]
    for img in images:
        n = img["figure_number"]
        mime_short = img["mime_type"].split("/")[1].upper()
        parts.append(
            f"Figure {n} (Cell {img['cell_index']}, Output {img['output_index']}):\n"
            f"  Type:      {img['mime_type']} ({mime_short})\n"
            f"  Context:   {img['context']}\n"
            f"  Embed as:  ![Figure {n}: your caption here](FIGURE_{n}_DATA)\n"
        )
    return "\n".join(parts)


def _embed_images_in_markdown(report_md: str, images: List[Dict[str, Any]]) -> str:
    """Substitute FIGURE_N_DATA placeholders with clean, single-line data URIs.

    Also handles defensive cases where the LLM ignored instructions and wrote
    the base64 itself (possibly with line breaks) or used other placeholder
    naming conventions.

    All substitutions produce a single-line ![alt](data:...) tag so markdown
    renderers never see a broken URL.
    """
    # Step 1 — fix any broken image syntax the LLM may have produced:
    #   ]<whitespace/newlines>(  →  ](
    report_md = re.sub(r'\]\s*\n\s*\(', '](', report_md)

    # Step 2 — if the LLM embedded raw base64 with line breaks inside a
    # data: URI, strip the whitespace so the URL is a single token.
    def _clean_data_uri_url(m: re.Match) -> str:
        alt = m.group(1)
        url = m.group(2)
        if 'data:' in url:
            url = re.sub(r'\s+', '', url)  # strip ALL whitespace in data URIs
        return f'![{alt}]({url})'

    # Match ![alt](url) where url may span multiple lines (use DOTALL)
    report_md = re.sub(
        r'!\[([^\]]*)\]\(([^)]+)\)',
        _clean_data_uri_url,
        report_md,
        flags=re.DOTALL,
    )

    # Step 3 — replace our FIGURE_N_DATA placeholders with real data URIs.
    for img in images:
        n = img["figure_number"]
        mime = img["mime_type"]
        clean_data = img["data"].replace("\n", "").replace("\r", "").strip()
        data_uri = f"data:{mime};base64,{clean_data}"
        placeholder = f"FIGURE_{n}_DATA"

        # Direct placeholder replacement (the expected case)
        report_md = report_md.replace(placeholder, data_uri)

        # Fallback: LLM wrote Figure_N or Figure N as the URL
        report_md = re.sub(
            rf'!\[([^\]]*)\]\(Figure[_ ]{n}\)',
            lambda m, uri=data_uri: f"![{m.group(1)}]({uri})",
            report_md,
        )

    return report_md


async def generate_report(
    notebook_path: str,
    root_dir: str,
    provider,
    notebook_name: str | None = None,
) -> Dict[str, Any]:
    """Full pipeline: notebook path → saved .md file.

    Args:
        notebook_path: Path relative to root_dir (e.g. "analysis.ipynb").
        root_dir:      Jupyter server root directory.
        provider:      A BaseLLMProvider instance (must implement chat()).
        notebook_name: Override for the filename stem (defaults to notebook_path basename).

    Returns a dict:
        filename:      "analysis_report_20250219_143022.md"
        relative_path: "analysis_report_20250219_143022.md" (relative to root_dir)
        preview:       First 500 chars of the report
        stats:         Cell statistics dict
        images_count:  Number of images embedded
    """
    nb_full_path = Path(root_dir) / notebook_path

    if not nb_full_path.exists():
        raise FileNotFoundError(f"Notebook not found: {nb_full_path}")

    # 1. Read notebook JSON
    log.info("Report: reading notebook %s", nb_full_path)
    with open(nb_full_path, encoding="utf-8") as f:
        nb_json = json.load(f)

    # 2. Parse
    notebook_context = format_notebook_for_llm(nb_json)
    stats = count_cell_statistics(nb_json)
    log.info("Report: parsed %d cells (%d code, %d markdown)",
             stats["total"], stats["code"], stats["markdown"])

    # 3. Extract images
    images = extract_all_images(nb_json)
    log.info("Report: extracted %d image(s)", len(images))

    # 4. Load skill (look in the notebook's own .jupyter-assistant first)
    skill_content = _find_skill_file(root_dir, notebook_path)
    if skill_content is None:
        log.warning("Report: skill file not found — using minimal instructions")
        skill_content = (
            "Generate a professional markdown report from the notebook analysis. "
            "Include: Executive Summary, Data Overview, EDA, Methodology, Results, Conclusions. "
            "Embed all images. Only report facts visible in cell outputs."
        )

    # 5 & 6. Build prompt and call LLM
    system_prompt, user_prompt = _build_prompt(skill_content, notebook_context, images, stats)
    log.info("Report: calling LLM chat() — context=%d chars, images=%d",
             len(user_prompt), len(images))

    report_md = await provider.chat(system=system_prompt, user=user_prompt)

    if not report_md or not report_md.strip():
        raise RuntimeError("LLM returned empty report.")

    # 7. Post-process — embed actual base64 data where the LLM left placeholders
    report_md = _embed_images_in_markdown(report_md, images)

    # Ensure Unix line endings
    report_md = report_md.replace("\r\n", "\n").replace("\r", "\n")

    # 8. Save file
    nb_stem = notebook_name or Path(notebook_path).stem
    filename = _generate_filename(nb_stem)
    # Save in the same directory as the notebook
    report_dir = Path(root_dir) / Path(notebook_path).parent
    report_path = report_dir / filename
    report_path.write_text(report_md, encoding="utf-8")
    log.info("Report: saved → %s", report_path)

    # Relative path from root_dir (for the download URL)
    rel_path = report_path.relative_to(Path(root_dir))

    return {
        "filename":      filename,
        "relative_path": str(rel_path),
        "preview":       report_md[:500],
        "stats":         stats,
        "images_count":  len(images),
        "word_count":    len(report_md.split()),
    }

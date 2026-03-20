"""Context assembler — composes the LLM context from summaries + full-fidelity cells.

Unified assembly flow (single path for all queries)
----------------------------------------------------
1. Determine *visible* cells: active notebook cells up to the active-cell
   boundary (same window as the @-mention autocomplete).
2. Detect the *focal* cell (the one the query is explicitly about), if any.
3. Score every visible cell via ``score_cells``.
4. Prune: keep cells whose normalised score >= SCORER_MIN_SCORE_THRESHOLD.
   The focal cell is always pinned (never pruned regardless of score).
   Floor override: if survivors < SCORER_MIN_CELLS, promote the top-ranked
   dismissed cells until the floor is met.
5. Sort survivors to notebook order.
6. Render: focal cell → full source + full output; every other survivor →
   compact summary block.
7. Optionally append one explicitly-referenced *downstream* cell (past the
   active-cell boundary) when the query contains "cell N" pointing beyond it.
8. Write the full scoring + pruning decision to the assembler log.

Integration pattern
-------------------
task.py calls ``assemble_context()`` and stores the result in
``notebook_context['_cell_context_override']``.
"""
from __future__ import annotations

import ast
import os
import re
from pathlib import Path
from typing import Any, Dict, List, Optional

from .summary_store import SummaryStore
from .scorer import score_cells
from .scorer_log import write_scorer_log
from ..debug_logger import log as dlog

# ── Focal cell detection ───────────────────────────────────────────────────────

# Matches "cell 10", "cell[10]", "cell #10", "#10"
_CELL_REF_RE = re.compile(r"(?:cell\s*[\[#]?\s*|#\s*)(\d+)", re.IGNORECASE)


def detect_focal_cell(
    user_query: str,
    active_cell_id: Optional[str],
    cell_order: List[Dict[str, Any]],
    summary_store: SummaryStore,
) -> Optional[str]:
    """Resolve the focal cell UUID in priority order (spec §3.2).

    Priority:
    1. Explicit "cell N" / "#N" reference in query → cell at position N-1
    2. active_cell_id (JupyterLab focus)
    3. @variable reference → cell where var was most recently defined
    4. None  (no-focal-cell path)
    """
    ids_in_order = [c.get("cell_id", "") for c in cell_order]

    # P1: explicit "#N" or "cell N" in the query
    m = _CELL_REF_RE.search(user_query)
    if m:
        n   = int(m.group(1))
        idx = n - 1          # spec: #N = Nth cell from top → index N-1
        if 0 <= idx < len(cell_order):
            return cell_order[idx].get("cell_id")

    # P2: active cell reported by JupyterLab
    if active_cell_id and active_cell_id in ids_in_order:
        return active_cell_id

    # P3: @variable reference → find most-recently-defining cell
    at_refs = set(re.findall(r"@([A-Za-z_]\w*)", user_query))
    if at_refs:
        for cell in reversed(cell_order):
            cid     = cell.get("cell_id", "")
            summary = summary_store.get_summary(cid)
            if summary:
                if at_refs & set(summary.get("symbols_defined", [])):
                    return cid

    return None


# ── Public entry point ─────────────────────────────────────────────────────────


def assemble_context(
    user_query: str,
    cell_order: List[Dict[str, Any]],
    summary_store: SummaryStore,
    active_cell_id: Optional[str] = None,
    focal_cell_full_output: Optional[str] = None,
    nb_base: Optional[Path] = None,
    kernel_name: str = "",
) -> str:
    """Build the cell-context string for injection into the LLM prompt.

    Args:
        user_query:              Raw user message text.
        cell_order:              Ordered list of cell dicts from notebookContext.cells.
                                 Expected keys: cellId (or cell_id), index, source,
                                 type, output, executionCount.
        summary_store:           SummaryStore instance for this notebook.
        active_cell_id:          UUID of the JupyterLab-focused cell, or None.
        focal_cell_full_output:  Untruncated output of the focal cell (from
                                 notebookContext.focalCellOutput).  Falls back to
                                 the cell dict's ``output`` field when absent.
        nb_base:                 Path to the notebook's ``.jupyter-assistant``
                                 directory.  When provided, the scoring + pruning
                                 decision is persisted to the assembler log.
        kernel_name:             The JupyterLab kernel spec name (e.g. "rnk_1" for
                                 remote_ikernel).  Used to detect remote kernels and
                                 inject an EC2-aware note into the context block.

    Returns:
        A multi-line string describing the relevant cells, ready to be embedded
        as the cell-context block in the system prompt.
    """
    # ── Remote kernel detection ───────────────────────────────────────────────
    # Detection order (first match wins):
    #   1. VARYS_KERNEL_IS_REMOTE=true in env (explicit override; required for
    #      sshpyk whose kernel names have no standard prefix)
    #   2. kernel name starts with "rnk_" (remote_ikernel always uses this prefix)
    #   3. Default: local kernel
    is_remote = (
        os.environ.get("VARYS_KERNEL_IS_REMOTE", "").lower() == "true"
        or kernel_name.startswith("rnk_")
    )
    dlog("assembler", "remote_kernel_detected", {"is_remote": is_remote, "kernel": kernel_name})
    norm   = _normalize_cells(cell_order)
    active = [c for c in norm if not _is_deleted(c["cell_id"], summary_store)]

    if not active:
        return "(no cells in notebook)"

    active_ids = {c["cell_id"] for c in active}

    # ── Step 1: visible window (cells up to active-cell boundary) ─────────────
    cutoff_cell_idx: Optional[int] = None
    if active_cell_id and active_cell_id in active_ids:
        aidx            = next(i for i, c in enumerate(active) if c["cell_id"] == active_cell_id)
        visible         = active[: aidx + 1]
        cutoff_cell_idx = (active[aidx].get("index") or aidx) + 1   # 1-based
    else:
        visible = active

    # ── Step 2: detect focal cell (rendering hint only — not a routing fork) ──
    focal_id  = detect_focal_cell(user_query, active_cell_id, visible, summary_store)
    focal_cid = focal_id if (focal_id and focal_id in {c["cell_id"] for c in visible}) else None

    # ── Step 3: score every visible cell ─────────────────────────────────────
    threshold, min_cells = _read_pruning_config()
    summaries = summary_store.get_all_current()
    ranked    = score_cells(visible, summaries, user_query)

    # ── Step 4: prune — focal cell is always pinned ───────────────────────────
    kept:      List[Dict[str, Any]] = []
    dismissed: List[Dict[str, Any]] = []
    for cell in ranked:
        pinned = cell.get("cell_id", "") == focal_cid
        if pinned or cell["_score"] >= threshold:
            kept.append({**cell, "_floor_override": False, "_pinned": pinned})
        else:
            dismissed.append(cell)

    floor_triggered = False
    while len(kept) < min_cells and dismissed:
        promoted = dismissed.pop(0)   # dismissed is score-descending
        kept.append({**promoted, "_floor_override": True, "_pinned": False})
        floor_triggered = True

    kept_ids = {c.get("cell_id", "") for c in kept}

    # ── Step 5: sort survivors to notebook order ──────────────────────────────
    survivors = sorted(kept, key=lambda c: c.get("index", 0))

    # ── Step 6: render ────────────────────────────────────────────────────────
    focal_parts: List[str] = []
    summary_parts: List[str] = []
    for cell in survivors:
        if cell.get("cell_id") == focal_cid:
            focal_parts.append(_format_focal_cell(cell, focal_cell_full_output))
        else:
            summary_parts.append(_format_summary_cell(cell, summary_store))

    # ── Phase 4: local import enrichment (independently shippable) ───────────
    focal_cell_dict = next(
        (c for c in survivors if c.get("cell_id") == focal_cid), None
    )
    # TODO(Phase4 — import enrichment): when local import resolution is
    # implemented, check is_remote here.  If True, skip the filesystem
    # lookup and log:
    #   dlog("assembler", "import_enrichment_skipped",
    #        {"reason": "remote_kernel", "imports": [...]})
    # Do NOT show the "local deps" chip in the UI when skipping.
    # Do NOT attempt to SCP or fetch files from EC2.
    enrichment_blocks = _enrich_local_imports(focal_cell_dict, list(visible), nb_base)

    parts = focal_parts + enrichment_blocks + summary_parts

    # ── Step 7: optional downstream ref (beyond visible window) ──────────────
    downstream_ref = None
    if focal_cid:
        focal_list_idx = next(
            (i for i, c in enumerate(active) if c["cell_id"] == focal_cid), -1
        )
        if focal_list_idx + 1 < len(active):
            downstream_ref = _find_downstream_ref(user_query, active[focal_list_idx + 1:])
            if downstream_ref and downstream_ref.get("cell_id") not in kept_ids:
                parts.append(
                    "(downstream cell referenced in query)\n"
                    + _format_summary_cell(downstream_ref, summary_store)
                )

    context = "\n".join(parts)

    # ── Remote kernel note ────────────────────────────────────────────────────
    # Appended after cell content so it is always present regardless of how
    # many cells were pruned.  Guides the LLM to suggest EC2-side file paths.
    if is_remote:
        remote_note = (
            f"Note: the kernel is executing on a remote machine"
            f"{f' (kernel: {kernel_name})' if kernel_name else ''}. "
            f"File path suggestions must use the remote filesystem. "
            f"Local paths such as /Users/ or C:\\ are not valid in this environment."
        )
        context = context + "\n\n" + remote_note

    # ── Step 8: log ───────────────────────────────────────────────────────────
    all_cells_log = sorted(kept + dismissed, key=lambda c: c.get("index", 0))
    cell_rows: List[Dict[str, Any]] = []
    for cell in all_cells_log:
        bd      = cell.get("_score_breakdown", {})
        raw_idx = cell.get("index")
        cell_rows.append({
            "cell_idx":        (raw_idx + 1) if isinstance(raw_idx, int) else None,
            "cell_id":         cell.get("cell_id", ""),
            "in_prompt":       cell.get("cell_id", "") in kept_ids,
            "pinned":          cell.get("_pinned", False),
            "floor_override":  cell.get("_floor_override", False),
            "relevance_score": round(cell.get("_score", 0.0), 6),
            "feature_scores": {
                "at_ref":     round(bd.get("at_ref",    0.0), 4),
                "recency":    round(bd.get("recency",   0.0), 4),
                "error":      round(bd.get("error",     0.0), 4),
                "fan_out":    round(bd.get("fan_out",   0.0), 4),
                "import":     round(bd.get("import",    0.0), 4),
                "dead":       round(bd.get("dead",      0.0), 4),
                "raw":        round(bd.get("raw",       0.0), 4),
                "normalized": round(bd.get("normalized", 0.0), 6),
            },
        })

    cells_in_prompt = [r["cell_idx"] for r in cell_rows if r["in_prompt"]]
    if downstream_ref:
        dr_idx = downstream_ref.get("index")
        if isinstance(dr_idx, int):
            cells_in_prompt.append(dr_idx + 1)

    dlog("assembler", "context_built", {
        "query":           user_query[:200],
        "focal_cell_idx":  (next((c.get("index", 0) + 1 for c in visible
                                  if c.get("cell_id") == focal_cid), None)),
        "cutoff_cell_idx": cutoff_cell_idx,
        "threshold":       threshold,
        "total_cells":     len(ranked),
        "kept_count":      len(kept),
        "dismissed_count": len(dismissed),
        "floor_triggered": floor_triggered,
        "cells_in_prompt": cells_in_prompt,
        "estimated_chars": len(context),
        "cells":           cell_rows,
    }, nb_base=nb_base)

    if nb_base is not None:
        write_scorer_log(
            nb_base=nb_base,
            query=user_query,
            ranked_cells=kept + dismissed,
            kept_ids=kept_ids,
            threshold=threshold,
            floor_triggered=floor_triggered,
            cutoff_cell_idx=cutoff_cell_idx,
        )

    return context


# ── Serialisation helpers (spec §3.4) ─────────────────────────────────────────


def _format_summary_cell(cell: Dict[str, Any], store: SummaryStore) -> str:
    """Compact summary block for a pre-focal cell."""
    position = cell["index"] + 1   # 1-based for the LLM
    cell_id  = cell["cell_id"]
    summary  = store.get_summary(cell_id)

    if summary is None:
        # Never executed — show snippet with label
        source  = cell.get("source", "")
        snippet = source[:300] if source else "(empty)"
        return (
            f"--- Cell {position} [not yet executed] ---\n"
            f"{snippet}\n"
            f"---"
        )

    ctype = summary.get("cell_type", "code")
    lines = [
        f"--- Cell {position} [summary] ---",
        f"Type: {ctype}",
    ]

    if ctype == "code":
        defined   = summary.get("symbols_defined", [])
        consumed  = summary.get("symbols_consumed", [])
        sym_vals  = summary.get("symbol_values", {})
        sym_types = summary.get("symbol_types", {})
        output    = summary.get("output")
        ec        = summary.get("execution_count")

        if defined:
            lines.append(f"Defines: {', '.join(defined)}")
        if consumed:
            # Annotate consumed names with their known values
            c_parts = [
                f"{s}={repr(sym_vals[s])}" if s in sym_vals else s
                for s in consumed
            ]
            lines.append(f"Consumes: {', '.join(c_parts)}")
        if sym_types:
            lines.append(f"Types: {', '.join(f'{k}={v}' for k, v in sym_types.items())}")
        if output:
            snippet = output[:200] + (" […]" if len(output) > 200 else "")
            lines.append(f'Output: "{snippet}"')
        if summary.get("had_error"):
            lines.append(f"⚠️ Error: {summary.get('error_text', 'unknown')}")
        if summary.get("is_import_cell"):
            lines.append("(import cell)")
        if summary.get("is_mutation_only"):
            snip = summary.get("source_snippet", "")[:200]
            lines.append(f"Source: {snip}")
        if ec is not None:
            lines.append(f"Execution: [{ec}]")
    else:
        # Markdown / raw: prefer LLM prose summary when available
        llm_summary = summary.get("llm_summary")
        if llm_summary:
            lines.append(llm_summary)
            lines.append("[LLM-generated summary]")
        else:
            snippet = summary.get("source_snippet", "")
            if snippet:
                lines.append(snippet)
            if summary.get("truncated"):
                lines.append("[markdown truncated at sentence boundary — configure Simple Tasks model for full LLM summarization]")

    lines.append("---")
    return "\n".join(lines)


def _format_focal_cell(
    cell: Dict[str, Any],
    full_output: Optional[str],
) -> str:
    """Full-fidelity block for the focal cell (spec §3.4)."""
    position = cell["index"] + 1
    source   = cell.get("source", "(empty)")
    # Prefer untruncated output from the request payload; fall back to cell dict
    output   = full_output or cell.get("output") or ""

    lines = [
        f"--- Cell {position} [FULL SOURCE — user query target] ---",
        source,
    ]
    if output.strip():
        lines.append("\nOUTPUT:")
        lines.append(output)
    lines.append("---")
    return "\n".join(lines)


# ── Config helper ─────────────────────────────────────────────────────────────


def _read_pruning_config() -> tuple[float, int]:
    """Read SCORER_MIN_SCORE_THRESHOLD and SCORER_MIN_CELLS from os.environ.

    Values are validated on startup by app.py; these defaults are only a
    safety net for callers that bypass the extension (e.g. tests).
    """
    try:
        threshold = float(os.environ.get("SCORER_MIN_SCORE_THRESHOLD", "0.3") or "0.3")
        threshold = max(0.0, min(1.0, threshold))
    except ValueError:
        threshold = 0.3

    try:
        min_cells = int(os.environ.get("SCORER_MIN_CELLS", "2") or "2")
        min_cells = max(0, min_cells)
    except ValueError:
        min_cells = 2

    return threshold, min_cells


# ── Utility helpers ────────────────────────────────────────────────────────────


def _normalize_cells(cell_order: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Ensure every cell dict has a ``cell_id`` key (maps ``cellId`` if needed)."""
    result = []
    for c in cell_order:
        cid = c.get("cell_id") or c.get("cellId") or ""
        result.append({**c, "cell_id": cid})
    return result


def _is_deleted(cell_id: str, store: SummaryStore) -> bool:
    """Return True if this cell's latest entry is marked deleted in the store."""
    versions = store._load().get(cell_id, [])
    return bool(versions) and bool(versions[-1].get("deleted", False))


def _find_downstream_ref(
    user_query: str,
    downstream_cells: List[Dict[str, Any]],
) -> Optional[Dict[str, Any]]:
    """Return a downstream cell if the query explicitly references it by number."""
    m = _CELL_REF_RE.search(user_query)
    if not m:
        return None
    n   = int(m.group(1))
    idx = n - 1
    for cell in downstream_cells:
        if cell.get("index") == idx:
            return cell
    return None


# ── Phase 4: local import enrichment ──────────────────────────────────────────

import sys as _sys

_STDLIB_MODULES: frozenset = frozenset(
    getattr(
        _sys, "stdlib_module_names",
        {
            "abc", "ast", "asyncio", "builtins", "collections", "contextlib",
            "copy", "csv", "dataclasses", "datetime", "decimal", "enum", "functools",
            "gc", "glob", "hashlib", "http", "importlib", "inspect", "io", "itertools",
            "json", "logging", "math", "multiprocessing", "operator", "os", "pathlib",
            "pickle", "platform", "pprint", "queue", "random", "re", "shutil", "signal",
            "socket", "sqlite3", "statistics", "string", "struct", "subprocess", "sys",
            "tempfile", "threading", "time", "traceback", "types", "typing", "unittest",
            "urllib", "uuid", "warnings", "weakref", "xml", "zipfile",
        }
    )
)

_KNOWN_THIRDPARTY: frozenset = frozenset({
    "pandas", "numpy", "sklearn", "scipy", "matplotlib", "seaborn", "torch",
    "tensorflow", "keras", "requests", "flask", "fastapi", "sqlalchemy", "pytest",
    "IPython", "ipywidgets", "pydantic", "PIL", "cv2", "plotly", "bokeh", "altair",
    "xgboost", "lightgbm", "catboost", "transformers", "datasets", "huggingface_hub",
    "aiohttp", "httpx", "boto3", "botocore", "celery", "redis", "pymongo", "psycopg2",
    "anthropic", "openai", "google", "azure", "yaml", "toml", "click", "typer",
    "rich", "tqdm", "joblib", "dask", "polars", "pyarrow", "h5py", "zarr",
})


def _is_stdlib_or_thirdparty(name: str) -> bool:
    return name in _STDLIB_MODULES or name in _KNOWN_THIRDPARTY


def _resolve_local_module(name: str, working_dir: str) -> Optional[str]:
    """Resolve a module name to a local .py file path, or None if not found."""
    candidates = [
        os.path.join(working_dir, f"{name}.py"),
        os.path.join(working_dir, name, "__init__.py"),
        os.path.join(working_dir, "src", f"{name}.py"),
        os.path.join(working_dir, "src", name, "__init__.py"),
    ]
    for path in candidates:
        if os.path.isfile(path):
            return path
    return None


def _get_module_content(file_path: str, char_limit: int) -> str:
    """Return full content if under char_limit, else AST-extracted stubs."""
    try:
        with open(file_path, encoding="utf-8", errors="replace") as fh:
            content = fh.read()
    except OSError:
        return ""

    if len(content) <= char_limit:
        return content

    try:
        tree = ast.parse(content)
    except SyntaxError:
        return content[:char_limit] + "\n... (truncated)"

    stubs: List[str] = []
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            stub = _extract_func_stub(node, content)
            if stub:
                stubs.append(stub)
        elif isinstance(node, ast.ClassDef):
            stub = _extract_class_stub(node, content)
            if stub:
                stubs.append(stub)

    return "\n\n".join(stubs) if stubs else content[:char_limit] + "\n... (truncated)"


def _extract_func_stub(
    node: "ast.FunctionDef | ast.AsyncFunctionDef",
    source: str,
) -> str:
    """Extract function signature + docstring."""
    lines = source.splitlines()
    start = node.lineno - 1
    sig_lines: List[str] = []
    for i in range(start, min(start + 20, len(lines))):
        sig_lines.append(lines[i])
        if lines[i].rstrip().endswith(":"):
            break
    sig = "\n".join(sig_lines)

    docstring = ""
    if node.body and isinstance(node.body[0], ast.Expr):
        val = node.body[0].value
        if isinstance(val, ast.Constant) and isinstance(val.s, str):
            docstring = f'    """{val.s[:200]}"""'

    return f"{sig}\n{docstring}\n    ..." if docstring else f"{sig}\n    ..."


def _extract_class_stub(node: "ast.ClassDef", source: str) -> str:
    """Extract class signature + docstring + method stubs."""
    lines = source.splitlines()
    start = node.lineno - 1
    class_line = lines[start] if start < len(lines) else f"class {node.name}:"

    class_doc = ""
    if node.body and isinstance(node.body[0], ast.Expr):
        val = node.body[0].value
        if isinstance(val, ast.Constant) and isinstance(val.s, str):
            class_doc = f'    """{val.s[:200]}"""'

    method_stubs: List[str] = []
    for item in node.body:
        if isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef)):
            method_stubs.append(f"    def {item.name}(self, ...): ...")

    stub_parts = [class_line]
    if class_doc:
        stub_parts.append(class_doc)
    stub_parts.extend(method_stubs[:10])
    if not method_stubs:
        stub_parts.append("    ...")
    return "\n".join(stub_parts)


def _enrich_local_imports(
    focal_cell: Optional[Dict[str, Any]],
    visible_cells: List[Dict[str, Any]],
    nb_base: Optional[Path],
) -> List[str]:
    """Return local-module content blocks for imports in the focal/active cell.

    Returns a list of formatted strings (one per resolved module).
    Returns [] if enrichment is disabled, no cell, or no local imports found.
    """
    enabled = os.environ.get("VARYS_AGENT_CELL_ENRICHMENT", "true").lower() not in (
        "0", "false", "no"
    )
    if not enabled:
        return []

    char_limit = int(os.environ.get("VARYS_AGENT_MODULE_CHAR_LIMIT", "3000"))

    if nb_base is None:
        return []
    working_dir = str(nb_base.parent) if nb_base.name == ".jupyter-assistant" else str(nb_base)

    target_cell = focal_cell
    if target_cell is None and visible_cells:
        target_cell = max(visible_cells, key=lambda c: c.get("index", 0))
    if target_cell is None:
        return []

    source = target_cell.get("source", "")
    if not source.strip():
        return []

    try:
        tree = ast.parse(source)
    except SyntaxError:
        return []

    local_module_names: List[str] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                local_module_names.append(alias.name.split(".")[0])
        elif isinstance(node, ast.ImportFrom):
            if node.module:
                local_module_names.append(node.module.split(".")[0])

    seen: set = set()
    candidates: List[str] = []
    for name in local_module_names:
        if name in seen:
            continue
        seen.add(name)
        if _is_stdlib_or_thirdparty(name):
            continue
        candidates.append(name)

    if not candidates:
        return []

    blocks: List[str] = []
    for name in candidates:
        resolved = _resolve_local_module(name, working_dir)
        if resolved is None:
            continue
        rel_path = os.path.relpath(resolved, working_dir)
        content = _get_module_content(resolved, char_limit)
        if content:
            blocks.append(f"--- Local module: {rel_path} ---\n{content}\n---")

    return blocks

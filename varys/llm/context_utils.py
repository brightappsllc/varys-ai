"""Shared notebook-context serialisation utilities.

All LLM providers (OpenAI, Bedrock, Google, Ollama) and the task handler's
advisory path use this single canonical implementation so that the prompt
format, truncation limits, and selection/active-cell handling are consistent
across the entire codebase.

Anthropic's ClaudeClient keeps its own _build_content_blocks() because it
must produce Anthropic-format message blocks (including base64 image blocks
interleaved with text).  Everything else calls build_notebook_context().

Smart Cell Context integration
-------------------------------
When ``task.py`` has a SummaryStore available it pre-assembles the cell-context
block and stores it in ``notebook_context['_cell_context_override']``.
``build_notebook_context()`` uses that pre-built string in place of the old
per-cell truncation loop.  All other prompt sections (header, selection,
@variables, DataFrames, selectedOutput) are unaffected.
"""
from typing import Any, Dict, List, Optional

from ..utils.config import get_config as _get_cfg

# ---------------------------------------------------------------------------
# Shared constants — kept for the completion engine and backward-compat paths
# that do not have a SummaryStore available.
# ---------------------------------------------------------------------------

# Fallback per-cell truncation limit used when no SummaryStore is present.
CELL_CONTENT_LIMIT: int = _get_cfg().getint("context", "cell_content_limit", 2_000)

# How many preceding cells to include in inline / multiline completion
# requests.  Matches the frontend's _extractCells window.
# Also overridable via completion.cfg [context] prev_cells.
COMPLETION_PREV_CELLS: int = _get_cfg().getint("context", "prev_cells", 5)


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def format_variable_context(variables: List[Dict[str, Any]]) -> str:
    """Format resolved @variable_name references into a human-readable prompt section.

    Args:
        variables: List of ResolvedVariable dicts sent from the frontend.
                   Each entry has: expr (str) and summary (dict from kernel).

    Returns:
        A markdown section string, or empty string when the list is empty.
    """
    if not variables:
        return ""

    lines: List[str] = ["## Referenced Variables (@var)", ""]

    for var in variables:
        expr: str = var.get("expr", "?")
        s: Dict[str, Any] = var.get("summary", {})
        vtype: str = s.get("type", "unknown")

        lines.append(f"### @{expr}  ({vtype})")

        if vtype == "error":
            lines.append(f"⚠️ Could not evaluate: {s.get('error', '')}")

        elif vtype == "dataframe":
            shape = s.get("shape", [0, 0])
            mem = s.get("memory_mb")
            mem_str = f"  ({mem:.1f} MB)" if mem is not None else ""
            lines.append(f"Shape: {shape[0]:,} rows × {shape[1]} columns{mem_str}")
            if s.get("columns"):
                dtypes = s.get("dtypes", {})
                col_lines = [
                    f"  {c:<20} {dtypes.get(c, '?')}"
                    for c in s["columns"]
                ]
                lines.append("Columns:")
                lines.extend(col_lines)
            missing = s.get("missing", {})
            if missing:
                lines.append(f"Missing values: {missing}")
            if s.get("note"):
                lines.append(f"⚠️ {s['note']}")
            if s.get("full_table"):
                lines.append(f"\n{s['full_table']}")
            elif s.get("stats"):
                lines.append(f"\nStatistics:\n{s['stats']}")
                if s.get("head"):
                    lines.append(f"\nFirst 5 rows:\n{s['head']}")
                elif s.get("sample"):
                    lines.append(f"\nRandom sample:\n{s['sample']}")
            elif s.get("head_str"):
                lines.append(f"\n{s['head_str']}")

        elif vtype == "series":
            _len = s.get('length')
            _len_str = f"{_len:,}" if isinstance(_len, int) else "?"
            lines.append(f"pandas Series — {s.get('name', expr)}, dtype={s.get('dtype')}, length={_len_str}")
            if s.get("stats"):
                lines.append(f"\n{s['stats']}")

        elif vtype == "ndarray":
            lines.append(f"numpy array — shape={s.get('shape')}, dtype={s.get('dtype')}")
            if s.get("sample") is not None:
                lines.append(f"First values: {s['sample']}")

        elif vtype in ("int", "float", "bool"):
            lines.append(f"Value: {s.get('value')}")

        elif vtype == "str":
            lines.append(f"String — length={s.get('length', '?')}")
            lines.append(f'"{s.get("value", "")}"')

        elif vtype in ("list", "tuple"):
            lines.append(f"{vtype} — length={s.get('length', '?')}")
            if s.get("sample") is not None:
                lines.append(f"First items: {s['sample']}")

        elif vtype == "dict":
            lines.append(f"dict — {s.get('length', '?')} keys")
            if s.get("keys"):
                lines.append(f"Keys (up to 20): {s['keys']}")
            if s.get("sample"):
                lines.append(f"Sample: {s['sample']}")

        else:
            if s.get("repr"):
                lines.append(f"{s['repr']}")

        lines.append("")

    return "\n".join(lines)


def format_dataframe_context(dataframes: List[Dict[str, Any]]) -> str:
    """Format live DataFrame schemas into a human-readable section for the prompt.

    Args:
        dataframes: List of DataFrameSchema dicts sent from the frontend.
                    Each entry has: name, shape, columns, dtypes, sample, memory_mb.

    Returns:
        A markdown-style section string, or empty string when the list is empty.
    """
    if not dataframes:
        return ""

    lines: List[str] = ["## Live DataFrame Context (from kernel)", ""]
    for df in dataframes:
        name: str = df.get("name", "?")
        shape = df.get("shape", [0, 0])
        columns: List[str] = df.get("columns", [])
        dtypes: Dict[str, str] = df.get("dtypes", {})
        sample: List[Dict] = df.get("sample", [])
        mem: Optional[float] = df.get("memoryMb")

        mem_str = f"  ({mem:.1f} MB)" if mem is not None else ""
        lines.append(f"`{name}` — {shape[0]:,} rows × {shape[1]} cols{mem_str}")

        # Column listing: name (dtype), aligned for readability
        if columns:
            max_col_len = max(len(c) for c in columns)
            for col in columns:
                dtype = dtypes.get(col, "?")
                lines.append(f"  {col:<{max_col_len}}  {dtype}")

        # Sample rows
        if sample:
            lines.append(f"  Sample ({len(sample)} rows):")
            for row in sample:
                # Keep each row repr short
                row_str = ", ".join(
                    f"{k}={repr(v)[:40]}" for k, v in list(row.items())[:8]
                )
                lines.append(f"    {{{row_str}}}")

        lines.append("")

    return "\n".join(lines)


def build_notebook_context(
    user_message: str,
    notebook_context: Dict[str, Any],
) -> str:
    """Serialise *notebook_context* into a flat text block for the LLM prompt.

    Args:
        user_message:     The raw message the user typed in the chat panel.
        notebook_context: The ``NotebookContext`` dict sent from the frontend.

    Returns:
        A multi-line string formatted as::

            ## User Request
            <user_message>

            ## Notebook
            Notebook: <path>
            Cells: <N>  (cells are numbered #1, #2, … from the top)
            CELL INDEX RULE: '#N' = Nth cell from top → cellIndex = N-1
            Active cell: #<K>        (omitted when unknown)

            #1  CODE
            <source>
            OUTPUT:
            <output>

            #2  MARKDOWN
            ...

            ## SELECTED TEXT (lines A–B of #C)   (omitted when absent)
            ...
    """
    # ── File context (non-notebook file active) ──────────────────────────────
    # When the user has a .py/.md/etc. file open, task.py injects _file_context.
    # Serialize it directly and return — no cell/notebook boilerplate needed.
    _file_ctx: Optional[Dict[str, Any]] = notebook_context.get("_file_context")
    if _file_ctx:
        file_path: str = _file_ctx.get("path", "unknown")
        file_content: str = _file_ctx.get("content", "")
        # Guess language for fenced code block from the file extension
        _ext = file_path.rsplit(".", 1)[-1].lower() if "." in file_path else ""
        _lang = {
            "py": "python", "js": "javascript", "ts": "typescript",
            "md": "markdown", "sh": "bash", "r": "r", "sql": "sql",
            "yaml": "yaml", "yml": "yaml", "json": "json", "toml": "toml",
            "csv": "csv", "txt": "",
        }.get(_ext, _ext)
        fence = f"```{_lang}" if _lang else "```"
        return (
            f"## User Request\n{user_message}\n\n"
            f"## File Context\n"
            f"File: {file_path}\n\n"
            f"{fence}\n{file_content}\n```"
        )

    cells: List[Dict[str, Any]] = notebook_context.get("cells", [])
    nb_path: str = notebook_context.get("notebookPath", "unknown")
    active_idx: Optional[int] = notebook_context.get("activeCellIndex")
    selection: Optional[Dict[str, Any]] = notebook_context.get("selection")

    lines: List[str] = [
        f"Notebook: {nb_path}",
        f"Cells: {len(cells)}  (cells are numbered #1, #2, … from the top)",
        f"CELL INDEX RULE: '#N' = Nth cell from top → cellIndex = N-1  (e.g. #16 → cellIndex=15, #1 → cellIndex=0)",
        f"CELL REFERENCE FORMAT: In ALL your output always use #N — NEVER write cell[N], [N], pos:N, position N, or any other variant.",
    ]
    if active_idx is not None:
        lines.append(f"Active cell: #{active_idx + 1}")
    lines.append("")

    # ── Smart Cell Context path ──────────────────────────────────────────────
    # When task.py has pre-assembled the cell context (via SummaryStore +
    # assemble_context()), it stores the result in _cell_context_override so
    # we can inject it directly without re-serialising every cell.
    _override: Optional[str] = notebook_context.get("_cell_context_override")
    if _override is not None:
        lines.append(_override)
    else:
        # ── Legacy path: per-cell truncation loop (fallback / backward compat) ──
        for cell in cells:
            idx: int = cell.get("index", 0)
            ctype: str = cell.get("type", "code")
            source: str = cell.get("source", "")
            ec = cell.get("executionCount")
            output: Optional[str] = cell.get("output")
            cell_id: str = cell.get("cellId", "") or ""

            id_tag = f"  [id:{cell_id.split('-')[0]}]" if cell_id else ""
            run_info = "" if ctype != "code" else ("" if ec is not None else "  [not run]")
            lines.append(f"#{idx + 1}  {ctype.upper()}{run_info}{id_tag}")
            lines.append(source[:CELL_CONTENT_LIMIT] if source.strip() else "(empty)")
            if output and output.strip():
                lines.append(f"OUTPUT:\n{output}")
            elif cell.get("imageOutput"):
                lines.append("OUTPUT: [Visualization — image attached]")
            lines.append("")

    if selection and selection.get("text", "").strip():
        sel_idx = selection.get("cellIndex", "?")
        cell_ref = f"#{sel_idx + 1}" if isinstance(sel_idx, int) else f"#{sel_idx}"
        start_line = selection.get("startLine", "?")
        end_line = selection.get("endLine", "?")
        lines += [
            f"\n## SELECTED TEXT (lines {start_line}–{end_line} of {cell_ref})",
            "Operate on ONLY this highlighted code:",
            "```",
            selection["text"],
            "```",
        ]

    base = f"## User Request\n{user_message}\n\n## Notebook\n" + "\n".join(lines)

    # Append selected-output annotation (right-click output overlay)
    sel_out: Optional[Dict[str, Any]] = notebook_context.get("selectedOutput")
    if sel_out and isinstance(sel_out, dict):
        sel_label = sel_out.get("label", "selected output")
        sel_mime  = sel_out.get("mimeType", "")
        if sel_mime.startswith("image"):
            base += f"\n\n## Focused Output\nThe user is asking specifically about: **{sel_label}** (image attached separately)."
        elif sel_out.get("textData"):
            td = sel_out["textData"][:_get_cfg().getint("context", "selected_output_limit", 2_000)]
            base += f"\n\n## Focused Output\nThe user is asking specifically about: **{sel_label}**\n```\n{td}\n```"

    # Append @variable_ref context (explicit references from the chat message)
    variables: List[Dict[str, Any]] = notebook_context.get("variables") or []
    var_section = format_variable_context(variables)
    if var_section:
        base = base + "\n\n" + var_section

    # Append live DataFrame schemas when the frontend provides them
    dataframes: List[Dict[str, Any]] = notebook_context.get("dataframes") or []
    df_section = format_dataframe_context(dataframes)
    if df_section:
        base = base + "\n\n" + df_section

    return base

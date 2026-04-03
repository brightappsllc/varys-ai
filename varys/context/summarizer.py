"""Cell summarizer — builds structured summary objects from execution data.

Large markdown cells (> MARKDOWN_THRESHOLD chars) are summarised via the
Simple Tasks LLM when one is configured.  ``build_markdown_summary_async``
handles this path and falls back to sentence-boundary truncation when the
provider is unavailable or the call fails.

Summary object schema (spec §2.3):
  {
    "cell_type":        "code | markdown | raw",
    "source_snippet":   "<first 300 chars of source>",
    "auto_summary":     "<TextRank or LLM-generated prose summary | null>",
    "output":           "<output string, up to 1000 chars | null>",
    "symbols_defined":  ["model", "X_train"],
    "symbols_consumed": ["df", "THRESHOLD"],
    "symbol_values":    {"THRESHOLD": 0.85},
    "symbol_types":     {"model": "GradientBoostingClassifier"},
    "execution_count":  3,
    "had_error":        false,
    "error_text":       null,
    "is_mutation_only": false,
    "is_import_cell":   false,
    "truncated":        false,
    "deleted":          false,
    "tags":             ["important", "skip-execution"]
  }
"""
from __future__ import annotations

import ast
import logging
import math
import re
from typing import Any, Dict, List, Optional

log = logging.getLogger(__name__)

# ── Constants ──────────────────────────────────────────────────────────────────

SNIPPET_CHARS              = 300    # source_snippet length cap
OUTPUT_SUMMARY_CHARS       = 1_000  # output stored in summary (hard cap / LLM trigger)
OUTPUT_LLM_INPUT_CHARS     = 4_000  # cap on output text sent to the LLM for summarization
MARKDOWN_THRESHOLD         = 2_000  # chars before LLM/truncation path activates
LLM_SUMMARY_MAX_INPUT_CHARS = 6_000  # cap on markdown text sent to the LLM
SYMBOL_VALUE_MAX           = 500    # max serialized length for symbol_values entries

_MARKDOWN_SUMMARY_SYSTEM = (
    "You are a precise summarizer for Jupyter notebook markdown cells. "
    "Produce a concise prose summary (2–4 sentences) that captures the main topic, "
    "key concepts, and any important context or decisions. "
    "Output ONLY the summary text — no preamble, no labels, no markdown formatting."
)

_OUTPUT_SUMMARY_SYSTEM = (
    "You are summarizing the terminal output of a Jupyter notebook cell execution. "
    "Produce a concise 1–2 sentence summary capturing the key result, metric, or message. "
    "Output ONLY the summary — no preamble, no labels, no markdown formatting."
)

_COMMENTS_SUMMARY_SYSTEM = (
    "You are summarizing inline comments from a Jupyter notebook code cell. "
    "Produce a concise 1–2 sentence summary capturing the main intent or explanation. "
    "Output ONLY the summary — no preamble, no labels, no markdown formatting."
)

_MD_NOISE_RE = re.compile(r'[#*`_\[\]()>~|]')

# ── TextRank summarizer ────────────────────────────────────────────────────────


def _textrank_summary(text: str, n_sentences: int = 3) -> Optional[str]:
    """Extract the most central sentences using a lightweight TextRank algorithm.

    Strips markdown syntax markers before scoring so headers/bullets don't
    distort word-overlap similarity.  Original sentence text is preserved in
    the output.

    Returns None when the text has fewer than n_sentences + 1 scoreable
    sentences — the caller should fall back to LLM or truncation in that case.
    """
    # Split at sentence-ending punctuation or blank lines (paragraph breaks)
    raw = re.split(r'(?<=[.!?])\s+|\n{2,}', text.strip())
    sentences = [s.strip() for s in raw if len(s.strip()) > 10]

    if len(sentences) <= n_sentences:
        return None  # too few sentences to meaningfully rank

    def word_set(s: str) -> set:
        return set(re.findall(r'\b\w{3,}\b', _MD_NOISE_RE.sub(' ', s).lower()))

    cleaned = [word_set(s) for s in sentences]
    n = len(sentences)

    # Sentence-to-sentence similarity: word-overlap / log(|A| + 1) + log(|B| + 1)
    sim: List[List[float]] = [[0.0] * n for _ in range(n)]
    for i in range(n):
        for j in range(i + 1, n):
            wi, wj = cleaned[i], cleaned[j]
            if not wi or not wj:
                continue
            overlap = len(wi & wj)
            if overlap:
                val = overlap / (math.log(len(wi) + 1) + math.log(len(wj) + 1))
                sim[i][j] = sim[j][i] = val

    # PageRank iteration (20 steps is sufficient for convergence on short texts)
    damping = 0.85
    scores = [1.0 / n] * n
    for _ in range(20):
        new_scores = [(1 - damping) / n] * n
        for i in range(n):
            col_sum = sum(sim[j][i] for j in range(n))
            if col_sum == 0:
                continue
            for j in range(n):
                if sim[j][i] > 0:
                    new_scores[i] += damping * scores[j] * sim[j][i] / col_sum
        scores = new_scores

    # Pick top n_sentences; restore original document order
    top = sorted(
        sorted(range(n), key=lambda i: scores[i], reverse=True)[:n_sentences]
    )
    return ' '.join(sentences[idx] for idx in top)


# ── Builtins set (excluded from consumed to reduce noise) ─────────────────────

_BUILTINS: frozenset = frozenset(
    dir(__builtins__) if isinstance(__builtins__, dict) else dir(__builtins__)  # type: ignore[arg-type]
)

# ── AST helpers ───────────────────────────────────────────────────────────────


def _extract_symbols(source: str) -> tuple[list[str], list[str]]:
    """Return (symbols_defined, symbols_consumed) via static AST analysis.

    symbols_defined  — names assigned / imported at module (cell) level.
    symbols_consumed — names loaded that are NOT defined in this cell
                       and NOT Python builtins.

    Dynamic patterns (exec, globals() manipulation) are not handled —
    acceptable for typical data-science notebooks.
    """
    try:
        tree = ast.parse(source)
    except SyntaxError:
        return [], []

    defined: set[str] = set()
    consumed: set[str] = set()

    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            defined.add(node.name)
        elif isinstance(node, ast.Assign):
            for target in node.targets:
                _collect_target_names(target, defined)
        elif isinstance(node, (ast.AugAssign, ast.AnnAssign)):
            if node.target:  # type: ignore[union-attr]
                _collect_target_names(node.target, defined)  # type: ignore[arg-type]
        elif isinstance(node, ast.Name) and isinstance(node.ctx, ast.Load):
            consumed.add(node.id)
        elif isinstance(node, ast.Import):
            for alias in node.names:
                name = alias.asname if alias.asname else alias.name.split(".")[0]
                defined.add(name)
        elif isinstance(node, ast.ImportFrom):
            for alias in node.names:
                name = alias.asname if alias.asname else alias.name
                if name != "*":
                    defined.add(name)

    consumed = consumed - defined - _BUILTINS
    return sorted(defined), sorted(consumed)


def _collect_target_names(node: ast.expr, names: set) -> None:
    """Recursively collect assigned names from an assignment target node."""
    if isinstance(node, ast.Name):
        names.add(node.id)
    elif isinstance(node, (ast.Tuple, ast.List)):
        for elt in node.elts:
            _collect_target_names(elt, names)
    elif isinstance(node, ast.Starred):
        _collect_target_names(node.value, names)


def _extract_comments(source: str) -> str:
    """Return all full-line comments from a code cell, joined with newlines.

    Only collects lines whose first non-whitespace character is ``#`` — inline
    comments after code (``x = 1  # note``) are intentionally excluded because
    they are rarely self-contained explanations.  The leading ``#`` and any
    immediately following whitespace are stripped from each line.
    """
    lines = []
    for line in source.splitlines():
        stripped = line.strip()
        if stripped.startswith('#'):
            lines.append(stripped.lstrip('#').strip())
    return '\n'.join(ln for ln in lines if ln)


def _is_import_cell(source: str) -> bool:
    """Return True if every non-blank, non-comment line is an import statement."""
    lines = [
        ln.strip()
        for ln in source.splitlines()
        if ln.strip() and not ln.strip().startswith("#")
    ]
    return bool(lines) and all(
        ln.startswith("import ") or ln.startswith("from ") for ln in lines
    )


def _is_mutation_only(defined: list[str]) -> bool:
    """Heuristic: cell only mutates existing objects, defines no new names."""
    return len(defined) == 0


# ── Public entry point ────────────────────────────────────────────────────────


def build_summary(
    cell_id: str,
    source: str,
    cell_type: str,
    output: Optional[str],
    execution_count: Optional[int],
    had_error: bool,
    error_text: Optional[str],
    kernel_snapshot: Optional[Dict[str, Any]] = None,
    tags: Optional[List[str]] = None,
    stems: Optional[Dict[str, List[str]]] = None,
    execution_ms: Optional[int] = None,
) -> Dict[str, Any]:
    """Build a structured summary object for a cell.

    Args:
        cell_id:          Stable JupyterLab cell UUID (used only for logging).
        source:           Cell source (code or markdown text).
        cell_type:        "code" | "markdown" | "raw".
        output:           Plain-text cell output string, or None.
        execution_count:  Kernel execution counter, or None if unrun.
        had_error:        True when the last execution produced an error output.
        error_text:       "ErrName: message" string if had_error is True.
        kernel_snapshot:  Dict of {var_name: {type, value/shape/…}} captured from
                          the live kernel immediately after this cell ran.  The
                          summarizer uses it to populate symbol_values/symbol_types
                          for names that appear in symbols_defined.
        tags:             List of cell metadata tags (e.g. ``["important",
                          "skip-execution"]``).  Defaults to an empty list.
                          Tags are stored verbatim and never affect the source
                          hash — use ``SummaryStore.patch_tags()`` to update them
                          independently of a cell execution event.
    """
    normalised_tags: List[str] = sorted(set(tags)) if tags else []
    if cell_type == "markdown":
        return _build_markdown_summary(source, normalised_tags)
    if cell_type == "raw":
        return _build_raw_summary(source, normalised_tags)
    return _build_code_summary(
        source, output, execution_count, had_error, error_text,
        kernel_snapshot or {}, normalised_tags, stems=stems,
        execution_ms=execution_ms,
    )


# ── Cell-type dispatch ─────────────────────────────────────────────────────────


def _build_code_summary(
    source: str,
    output: Optional[str],
    execution_count: Optional[int],
    had_error: bool,
    error_text: Optional[str],
    kernel_snapshot: Dict[str, Any],
    tags: Optional[List[str]] = None,
    stems: Optional[Dict[str, List[str]]] = None,
    execution_ms: Optional[int] = None,
) -> Dict[str, Any]:
    from .action_stems import DEFAULT_STEMS, detect_actions
    is_import = _is_import_cell(source)

    if is_import:
        # Import cells: full source IS the summary — symbol_values empty
        defined, _ = _extract_symbols(source)
        return {
            "cell_type":        "code",
            "source_snippet":   source[:SNIPPET_CHARS].strip(),
            "auto_summary":      None,
            "output":           None,
            "symbols_defined":  defined,
            "symbols_consumed": [],
            "symbol_values":    {},
            "symbol_types":     {},
            "execution_count":  execution_count,
            "had_error":        False,
            "error_text":       None,
            "is_mutation_only": False,
            "is_import_cell":   True,
            "truncated":        False,
            "deleted":          False,
            "tags":             tags or [],
            "cell_action":      detect_actions(source, True, stems or DEFAULT_STEMS, tags=normalised_tags),
            "execution_ms":     execution_ms,
        }

    defined, consumed = _extract_symbols(source)
    mutation_only = _is_mutation_only(defined)

    # Populate symbol_values, symbol_types, and symbol_meta from kernel snapshot
    symbol_values: Dict[str, Any] = {}
    symbol_types:  Dict[str, str] = {}
    symbol_meta:   Dict[str, Any] = {}

    for name in defined:
        snap = kernel_snapshot.get(name)
        if snap is None:
            continue
        vtype = snap.get("type", "unknown")

        # symbol_types — human-readable display string
        if vtype == "dataframe":
            shape = snap.get("shape", [0, 0])
            symbol_types[name] = f"DataFrame({shape[0]}, {shape[1]})"
            # symbol_meta — structured column profiles (columns, dtypes, stats)
            columns = snap.get("columns")
            if isinstance(columns, dict) and columns:
                symbol_meta[name] = {"columns": columns}
        elif vtype == "series":
            shape = snap.get("shape", [0])
            dtype = snap.get("dtype", "")
            symbol_types[name] = f"Series({shape[0]})" if not dtype else f"Series({shape[0]}, {dtype})"
        elif vtype == "ndarray":
            shape = snap.get("shape", [])
            dtype = snap.get("dtype", "")
            symbol_types[name] = f"ndarray{tuple(shape)}" if not dtype else f"ndarray{tuple(shape)} {dtype}"
        elif vtype in ("function", "builtin_function_or_method", "method"):
            symbol_types[name] = "function"
        else:
            symbol_types[name] = vtype

        # symbol_values — only compact, serializable types (spec §2.5)
        if vtype in ("int", "float", "bool"):
            symbol_values[name] = snap.get("value")
        elif vtype == "str":
            val = snap.get("value", "")
            if isinstance(val, str) and len(val) <= 200:
                symbol_values[name] = val
        elif vtype in ("list", "tuple"):
            sample = snap.get("sample")
            if sample is not None:
                if len(str(sample)) <= SYMBOL_VALUE_MAX:
                    symbol_values[name] = sample
        elif vtype == "dict":
            sample = snap.get("sample")
            if sample is not None:
                if len(str(sample)) <= SYMBOL_VALUE_MAX:
                    symbol_values[name] = sample

    # ── Comment-based auto_summary ────────────────────────────────────────────
    # Aggregate full-line comments.  Short blocks are stored verbatim; long
    # blocks are compressed with TextRank.  If TextRank returns None (too few
    # prose sentences) we store None here and cell_executed.py will run the
    # async LLM fallback after this synchronous function returns.
    comments = _extract_comments(source)
    if not comments:
        auto_summary: Optional[str] = None
    elif len(comments) <= MARKDOWN_THRESHOLD:
        auto_summary = comments
    else:
        auto_summary = _textrank_summary(comments)   # None signals LLM needed

    # Truncate output for summary storage (full output is used for focal cell)
    summary_output: Optional[str] = None
    if output and output.strip():
        if len(output) > OUTPUT_SUMMARY_CHARS:
            summary_output = output[:OUTPUT_SUMMARY_CHARS] + "\n[…output truncated in summary]"
        else:
            summary_output = output

    return {
        "cell_type":        "code",
        "source_snippet":   source[:SNIPPET_CHARS].strip(),
        "auto_summary":     auto_summary,
        "output":           summary_output,
        "symbols_defined":  defined,
        "symbols_consumed": consumed,
        "symbol_values":    symbol_values,
        "symbol_types":     symbol_types,
        "symbol_meta":      symbol_meta,
        "execution_count":  execution_count,
        "had_error":        had_error,
        "error_text":       error_text,
        "is_mutation_only": mutation_only,
        "is_import_cell":   False,
        "truncated":        False,
        "deleted":          False,
        "tags":             tags or [],
        "cell_action":      detect_actions(source, False, stems or DEFAULT_STEMS, tags=tags),
        "execution_ms":     execution_ms,
    }


def _build_markdown_summary(
    source: str,
    tags: Optional[List[str]] = None,
) -> Dict[str, Any]:
    truncated = len(source) > MARKDOWN_THRESHOLD
    if truncated:
        auto_summary: Optional[str] = _textrank_summary(source) or _truncate_at_sentence(source, MARKDOWN_THRESHOLD)
    else:
        auto_summary = source.strip()
    return {
        "cell_type":        "markdown",
        "source_snippet":   source[:SNIPPET_CHARS].strip(),
        "auto_summary":     auto_summary,
        "output":           None,
        "symbols_defined":  [],
        "symbols_consumed": [],
        "symbol_values":    {},
        "symbol_types":     {},
        "execution_count":  None,
        "had_error":        False,
        "error_text":       None,
        "is_mutation_only": False,
        "is_import_cell":   False,
        "truncated":        truncated,
        "deleted":          False,
        "tags":             tags or [],
        "cell_action":      [],
    }


def _build_raw_summary(
    source: str,
    tags: Optional[List[str]] = None,
) -> Dict[str, Any]:
    return {
        "cell_type":        "raw",
        "source_snippet":   source[:SNIPPET_CHARS].strip(),
        "auto_summary":      None,
        "output":           None,
        "symbols_defined":  [],
        "symbols_consumed": [],
        "symbol_values":    {},
        "symbol_types":     {},
        "execution_count":  None,
        "had_error":        False,
        "error_text":       None,
        "is_mutation_only": False,
        "is_import_cell":   False,
        "truncated":        False,
        "deleted":          False,
        "tags":             tags or [],
        "cell_action":      [],
    }


# ── Async LLM path for large markdown cells ───────────────────────────────────


async def build_markdown_summary_async(
    source: str,
    provider: Any,
    tags: Optional[List[str]] = None,
) -> Dict[str, Any]:
    """Summarise a large markdown cell.

    Priority:
      1. TextRank extractive summary (fast, free, no network).
      2. LLM prose summary via the Background model — only when TextRank returns
         None (too few scoreable sentences, e.g. the cell is mostly code blocks).
      3. ``_build_markdown_summary()`` (sentence-boundary truncation) as final
         fallback when the LLM call fails or no provider is configured.

    Args:
        source:   Full markdown source text.
        provider: A configured ``BaseLLMProvider`` instance (Background model).
                  May be None — TextRank still runs; only the LLM step is skipped.
        tags:     Cell metadata tags (passed through to the summary dict).
    """
    if len(source) <= MARKDOWN_THRESHOLD:
        return _build_markdown_summary(source, tags)

    # ── Pass 1: TextRank ──────────────────────────────────────────────────────
    tr = _textrank_summary(source)
    if tr:
        return {
            "cell_type":        "markdown",
            "source_snippet":   source[:SNIPPET_CHARS].strip(),
            "auto_summary":     tr,
            "output":           None,
            "symbols_defined":  [],
            "symbols_consumed": [],
            "symbol_values":    {},
            "symbol_types":     {},
            "execution_count":  None,
            "had_error":        False,
            "error_text":       None,
            "is_mutation_only": False,
            "is_import_cell":   False,
            "truncated":        False,
            "deleted":          False,
            "tags":             tags or [],
            "cell_action":      [],
        }

    # ── Pass 2: LLM fallback (cell has too few prose sentences for TextRank) ──
    if provider:
        capped   = source[:LLM_SUMMARY_MAX_INPUT_CHARS]
        user_msg = f"Summarize this Jupyter notebook markdown cell:\n\n{capped}"
        try:
            summary_text = await provider.chat(
                system=_MARKDOWN_SUMMARY_SYSTEM,
                user=user_msg,
            )
            return {
                "cell_type":        "markdown",
                "source_snippet":   source[:SNIPPET_CHARS].strip(),
                "auto_summary":     summary_text.strip() if summary_text else None,
                "output":           None,
                "symbols_defined":  [],
                "symbols_consumed": [],
                "symbol_values":    {},
                "symbol_types":     {},
                "execution_count":  None,
                "had_error":        False,
                "error_text":       None,
                "is_mutation_only": False,
                "is_import_cell":   False,
                "truncated":        False,
                "deleted":          False,
                "tags":             tags or [],
                "cell_action":      [],
            }
        except Exception as exc:
            _model = getattr(getattr(provider, "_chat_client", None), "model", "?")
            log.warning(
                "build_markdown_summary_async: LLM call failed (model=%s). "
                "Check ANTHROPIC_BG_TASK_MODEL / DS_BG_TASK_PROVIDER in varys.env. "
                "Error: %s",
                _model,
                exc,
            )

    # ── Pass 3: sentence-boundary truncation ─────────────────────────────────
    return _build_markdown_summary(source, tags)


# ── Output pre-processing ─────────────────────────────────────────────────────


def _lines_similar(a: str, b: str) -> bool:
    """True when two lines differ only in digit/percentage sequences.

    Matches tqdm progress bars, Keras epoch logs, numbered iterations, etc.
    """
    return re.sub(r'\d+\.?\d*%?', '#', a) == re.sub(r'\d+\.?\d*%?', '#', b)


def collapse_output(text: str) -> str:
    """Collapse runs of similar lines (tqdm bars, epoch logs, numbered iterations).

    Runs of more than 3 similar lines become:
        <first line>
        [N similar lines omitted]
        <last line>

    Lines are considered similar when they differ only in numeric/percentage values.
    """
    lines = text.splitlines()
    result: list[str] = []
    i = 0
    while i < len(lines):
        j = i + 1
        while j < len(lines) and _lines_similar(lines[i], lines[j]):
            j += 1
        run = j - i
        if run > 3:
            result.append(lines[i])
            result.append(f"    [{run - 2} similar lines omitted]")
            result.append(lines[j - 1])
        else:
            result.extend(lines[i:j])
        i = j
    return '\n'.join(result)


async def patch_code_summary_comments_async(
    summary: Dict[str, Any],
    comments: str,
    provider: Any,
) -> Dict[str, Any]:
    """LLM fallback: populate ``auto_summary`` when TextRank returned None.

    Called by ``cell_executed._summarize_and_store`` after the sync
    ``build_summary`` path when:
      - cell_type == "code"
      - auto_summary is None  (TextRank had too few sentences to rank)
      - len(comments) > MARKDOWN_THRESHOLD

    Mutates and returns the summary dict in-place.
    Falls back to truncated comments on any LLM failure.
    """
    capped   = comments[:LLM_SUMMARY_MAX_INPUT_CHARS]
    user_msg = f"Summarize these code cell comments:\n\n{capped}"
    try:
        result = await provider.chat(system=_COMMENTS_SUMMARY_SYSTEM, user=user_msg)
        summary["auto_summary"] = result.strip() if result else comments[:OUTPUT_SUMMARY_CHARS]
    except Exception as exc:
        _model = getattr(getattr(provider, "_chat_client", None), "model", "?")
        log.warning(
            "patch_code_summary_comments_async: LLM call failed (model=%s): %s",
            _model, exc,
        )
        summary["auto_summary"] = comments[:OUTPUT_SUMMARY_CHARS]
    return summary


async def summarize_output_async(output: str, provider: Any) -> str:
    """Summarize long cell output via the Background model.

    Expects ``output`` to have already been collapsed by ``collapse_output()``.
    Falls back to hard truncation at OUTPUT_SUMMARY_CHARS on any LLM failure.
    """
    capped   = output[:OUTPUT_LLM_INPUT_CHARS]
    user_msg = f"Summarize this Jupyter notebook cell output:\n\n{capped}"
    try:
        result = await provider.chat(system=_OUTPUT_SUMMARY_SYSTEM, user=user_msg)
        return result.strip() if result else output[:OUTPUT_SUMMARY_CHARS]
    except Exception as exc:
        _model = getattr(getattr(provider, "_chat_client", None), "model", "?")
        log.warning(
            "summarize_output_async: LLM call failed (model=%s): %s", _model, exc
        )
        return output[:OUTPUT_SUMMARY_CHARS]


# ── Utility ────────────────────────────────────────────────────────────────────


def _truncate_at_sentence(text: str, limit: int) -> str:
    """Truncate at the nearest sentence boundary before `limit` chars."""
    if len(text) <= limit:
        return text
    chunk = text[:limit]
    m = re.search(r"[.!?]\s", chunk[::-1])
    if m:
        cut = limit - m.start()
        return text[:cut].strip() + " […]"
    return chunk.strip() + " […]"

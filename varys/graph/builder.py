"""GraphBuilder — produces GraphData from SummaryStore + AST fallback."""
from __future__ import annotations

import os
import re
import time
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Set, Tuple

from ..context.summary_store import SummaryStore
from .ast_fallback import ASTParser


# ── Constants ─────────────────────────────────────────────────────────────────

# Matches data-loading calls to extract the source filename for node labels.
# Captures the first string argument of common pandas/builtins read functions.
_DATA_SOURCE_RE = re.compile(
    r'(?:(?:pd|pandas)\.)?'
    r'read_(?:csv|excel|parquet|json|table|feather|orc|sas|spss|stata|html|pickle|hdf)\s*\(\s*[rf]?([\'"])([^\'"]+)\1'
    r'|open\s*\(\s*[rf]?([\'"])([^\'"]+)\3',
)


def _extract_data_source_file(source: str) -> Optional[str]:
    """Return the basename of the first data file path found in *source*, or None."""
    m = _DATA_SOURCE_RE.search(source)
    if not m:
        return None
    # Groups 2 or 4 hold the path string depending on which branch matched.
    path = m.group(2) or m.group(4)
    if not path:
        return None
    return os.path.basename(path)


# Matches top-level import statements to detect reimports across cells.
_IMPORT_RE = re.compile(
    r'^(?:import\s+(\w+)|from\s+(\w+)\s+import)',
    re.MULTILINE,
)


def _extract_imports(source: str) -> Set[str]:
    """Return the set of top-level module names imported in *source*."""
    mods: Set[str] = set()
    for m in _IMPORT_RE.finditer(source):
        mod = m.group(1) or m.group(2)
        if mod:
            mods.add(mod)
    return mods


# Matplotlib / seaborn state handles that are not data artifacts.
# Filtered from defines, loads, and external_loads at graph-build time;
# the raw SummaryStore data is never mutated.
VIZ_HANDLE_SYMBOLS = frozenset({"plt", "sns", "fig", "ax", "axes"})

# Matches plt.title(...), plt.suptitle(...), fig.suptitle(...) — including
# f-strings.  Group 1 = optional "f", group 2 = quote char, group 3 = content.
_TITLE_RE = re.compile(
    r'(?:plt\.(?:sup)?title|fig\.suptitle)\s*\(\s*(f?)([\'"])(.*?)\2'
)


# ── Data classes ──────────────────────────────────────────────────────────────


@dataclass
class NodeData:
    cell_uuid: str
    cell_index: int
    label: str
    sublabel: str
    unexecuted: bool
    data_source: str          # "store" | "ast"
    defines: List[str]        # effective defines — viz handles already removed
    loads: List[str]          # effective loads   — viz handles already removed
    external_loads: List[str]
    execution_count: Optional[int]
    anomalies: List[str] = field(default_factory=list)
    node_role: str = 'empty'   # 'defines' | 'redefines' | 'consumes' | 'empty'


@dataclass
class EdgeData:
    source_uuid: str
    target_uuid: str
    symbol: str
    anomaly: Optional[str] = None   # SKIP_LINK | OUT_OF_ORDER | None
    edge_type: str = 'dependency'   # 'dependency' | 'redefines' | 'reimport'


@dataclass
class GraphData:
    notebook_path: str
    nodes: List[NodeData]
    edges: List[EdgeData]
    computed_at: float        # Unix timestamp


# ── Label helpers ─────────────────────────────────────────────────────────────


def _extract_plot_titles(source: str) -> List[str]:
    """Return all plot title string literals found in source.

    Handles ``plt.title()``, ``plt.suptitle()``, ``fig.suptitle()``.
    For f-strings the literal prefix up to the first ``{`` is extracted;
    if that prefix is fewer than 4 characters the extraction is discarded
    individually — other valid titles in the same cell are unaffected.
    """
    titles: List[str] = []
    for m in _TITLE_RE.finditer(source):
        is_fstring = bool(m.group(1))
        content = m.group(3)
        if is_fstring:
            brace = content.find("{")
            if brace != -1:
                content = content[:brace]
            if len(content) < 4:
                continue
        if content:
            titles.append(content)
    return titles


def _build_label(
    effective_defines: List[str],
    symbol_types: Dict[str, str],
    symbol_values: Dict[str, Any],
    source: str,
    unexecuted: bool,
) -> tuple[str, str]:
    """Return ``(label, sublabel)`` using the unified four-priority cascade.

    ``effective_defines`` must already have ``VIZ_HANDLE_SYMBOLS`` removed.
    If ``unexecuted`` is True, ``" · not executed"`` is appended to the sublabel.

    Priority:
      1. First define with a ``symbol_types`` entry  → symbol name / type shape
      2. First define with no type info              → symbol name / ""
      3. Plot title extraction                       → joined titles / "plot"
      4. Source truncation                           → first 40 chars / ""
    """
    # ── Priority 1 & 2: symbol-based label ────────────────────────────────────
    primary: Optional[str] = None
    for sym in effective_defines:
        if sym in symbol_types:
            primary = sym
            break
    if primary is None and effective_defines:
        primary = effective_defines[0]

    if primary is not None:
        label = primary
        typ = symbol_types.get(primary, "")
        val = symbol_values.get(primary)

        if typ == "DataFrame":
            if isinstance(val, str):
                base_sub = f"DataFrame · {val}"
            elif isinstance(val, dict):
                rows = val.get("rows", "?")
                cols = val.get("cols", "?")
                base_sub = (
                    f"DataFrame · {rows:,} × {cols}"
                    if isinstance(rows, int)
                    else f"DataFrame · {rows} × {cols}"
                )
            else:
                base_sub = "DataFrame"
        elif typ == "ndarray":
            base_sub = f"ndarray · {val}" if isinstance(val, str) else "ndarray"
        elif typ in ("str", "int", "float", "bool"):
            val_str = str(val) if val is not None else ""
            base_sub = f"{typ} · {val_str}" if val_str and len(val_str) <= 20 else typ
        else:
            base_sub = typ

        # Append the source filename when this cell loads data from a file.
        data_file = _extract_data_source_file(source)
        if data_file:
            base_sub = f"{base_sub} · {data_file}" if base_sub else data_file

        sublabel = f"{base_sub} · not executed" if unexecuted and base_sub else (
            "not executed" if unexecuted else base_sub
        )
        return label, sublabel

    # ── Priority 3: plot title extraction ─────────────────────────────────────
    titles = _extract_plot_titles(source)
    if titles:
        sublabel = "plot · not executed" if unexecuted else "plot"
        return ", ".join(titles), sublabel

    # ── Priority 4: source truncation ─────────────────────────────────────────
    label = source[:40].strip().replace("\n", " ") if source else "(empty)"
    sublabel = "not executed" if unexecuted else ""
    return label, sublabel


# ── GraphBuilder ──────────────────────────────────────────────────────────────


class GraphBuilder:
    """Builds GraphData from SummaryStore entries + AST fallback."""

    def __init__(self, root_dir: str, notebook_path: str) -> None:
        self._store = SummaryStore(root_dir, notebook_path)
        self._notebook_path = notebook_path

    def build(self, cells: List[Dict[str, Any]]) -> GraphData:
        """Build and return GraphData.

        Args:
            cells: list of ``{cell_id, index, source}`` from the request body,
                   already filtered to code cells only by the frontend.
                   Empty-source cells are also dropped here.
        """
        sorted_cells = sorted(
            (c for c in cells if c.get("source", "").strip()),
            key=lambda c: c["index"],
        )
        store_data = self._store.get_all_current()

        # Source text keyed by cell_id — needed for reimport detection.
        source_map: Dict[str, str] = {
            c.get("cell_id", ""): c.get("source", "")
            for c in sorted_cells
        }

        nodes: List[NodeData] = []

        for cell in sorted_cells:
            cell_uuid: str = cell.get("cell_id", "")
            cell_index: int = cell.get("index", 0)
            source: str = cell.get("source", "")

            summary = store_data.get(cell_uuid)
            executed = (
                summary is not None
                and isinstance(summary.get("execution_count"), int)
                and summary["execution_count"] > 0
            )

            if executed and summary is not None:
                raw_defines: List[str] = summary.get("symbols_defined") or []
                raw_loads: List[str] = summary.get("symbols_consumed") or []
                symbol_types: Dict[str, str] = summary.get("symbol_types") or {}
                symbol_values: Dict[str, Any] = summary.get("symbol_values") or {}
                execution_count: Optional[int] = summary.get("execution_count")
                data_source = "store"
                unexecuted = False
            else:
                parsed = ASTParser.extract(source)
                raw_defines = parsed["defines"]
                raw_loads = parsed["loads"]
                symbol_types = {}
                symbol_values = {}
                execution_count = None
                data_source = "ast"
                unexecuted = True

            # Filter viz handles at build time — never mutate stored data
            effective_defines = [d for d in raw_defines if d not in VIZ_HANDLE_SYMBOLS]
            effective_loads = [s for s in raw_loads if s not in VIZ_HANDLE_SYMBOLS]

            label, sublabel = _build_label(
                effective_defines, symbol_types, symbol_values, source, unexecuted
            )

            nodes.append(NodeData(
                cell_uuid=cell_uuid,
                cell_index=cell_index,
                label=label,
                sublabel=sublabel,
                unexecuted=unexecuted,
                data_source=data_source,
                defines=effective_defines,
                loads=effective_loads,
                external_loads=[],
                execution_count=execution_count,
                anomalies=[],
            ))

        # ── Edge construction ─────────────────────────────────────────────────
        # node.defines and node.loads are already free of viz handle symbols,
        # so no plt/sns/fig/ax edges will be created and no false SKIP_LINKs
        # will fire.
        edges: List[EdgeData] = []

        for node in nodes:
            resolved: set[str] = set()
            for sym in node.loads:
                # Most-recent preceding definer by notebook position
                definer: Optional[NodeData] = None
                for other in nodes:
                    if other.cell_index >= node.cell_index:
                        continue
                    if sym in other.defines:
                        if definer is None or other.cell_index > definer.cell_index:
                            definer = other
                if definer is not None:
                    edges.append(EdgeData(
                        source_uuid=definer.cell_uuid,
                        target_uuid=node.cell_uuid,
                        symbol=sym,
                    ))
                    resolved.add(sym)

            node.external_loads = [s for s in node.loads if s not in resolved]

        # ── Redefine edge pass ────────────────────────────────────────────────
        # When a symbol is defined by multiple cells (e.g. df = df.dropna()),
        # the SummaryStore often records no loads for the reassignment cell,
        # leaving the graph disconnected.  We connect consecutive definers of
        # the same symbol with an explicit "redefines" edge.
        existing_keys: Set[Tuple[str, str, str]] = {
            (e.source_uuid, e.target_uuid, e.symbol) for e in edges
        }
        symbol_definers: Dict[str, List[NodeData]] = {}
        for node in nodes:
            for sym in node.defines:
                symbol_definers.setdefault(sym, []).append(node)

        for sym, definers in symbol_definers.items():
            if len(definers) < 2:
                continue
            sorted_definers = sorted(definers, key=lambda n: n.cell_index)
            for i in range(1, len(sorted_definers)):
                prev = sorted_definers[i - 1]
                curr = sorted_definers[i]
                key = (prev.cell_uuid, curr.cell_uuid, sym)
                if key not in existing_keys:
                    edges.append(EdgeData(
                        source_uuid=prev.cell_uuid,
                        target_uuid=curr.cell_uuid,
                        symbol=sym,
                        edge_type='redefines',
                    ))
                    existing_keys.add(key)

        # ── Node role computation ─────────────────────────────────────────────
        seen_syms: Set[str] = set()
        for node in sorted(nodes, key=lambda n: n.cell_index):
            is_redefine  = any(s in seen_syms for s in node.defines)
            is_new_define = any(s not in seen_syms for s in node.defines)
            seen_syms.update(node.defines)
            if is_redefine:
                node.node_role = 'redefines'
            elif is_new_define:
                node.node_role = 'defines'
            elif node.loads:
                node.node_role = 'consumes'
            # else: stays 'empty'

        # ── Reimport edge pass ────────────────────────────────────────────────
        first_importer: Dict[str, str] = {}   # module → cell_uuid
        for node in nodes:
            cell_imports = _extract_imports(source_map.get(node.cell_uuid, ''))
            for mod in sorted(cell_imports):
                if mod in first_importer:
                    key = (first_importer[mod], node.cell_uuid, mod)
                    if key not in existing_keys:
                        edges.append(EdgeData(
                            source_uuid=first_importer[mod],
                            target_uuid=node.cell_uuid,
                            symbol=mod,
                            edge_type='reimport',
                        ))
                        existing_keys.add(key)
                else:
                    first_importer[mod] = node.cell_uuid

        return GraphData(
            notebook_path=self._notebook_path,
            nodes=nodes,
            edges=edges,
            computed_at=time.time(),
        )

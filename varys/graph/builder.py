"""GraphBuilder — produces GraphData from SummaryStore + AST fallback."""
from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

from ..context.summary_store import SummaryStore
from .ast_fallback import ASTParser


# ── Data classes ──────────────────────────────────────────────────────────────


@dataclass
class NodeData:
    cell_uuid: str
    cell_index: int
    label: str
    sublabel: str
    unexecuted: bool
    data_source: str          # "store" | "ast"
    defines: List[str]
    loads: List[str]
    external_loads: List[str]
    execution_count: Optional[int]
    anomalies: List[str] = field(default_factory=list)


@dataclass
class EdgeData:
    source_uuid: str
    target_uuid: str
    symbol: str
    anomaly: Optional[str] = None   # SKIP_LINK | OUT_OF_ORDER | None


@dataclass
class GraphData:
    notebook_path: str
    nodes: List[NodeData]
    edges: List[EdgeData]
    computed_at: float        # Unix timestamp


# ── Label helpers ─────────────────────────────────────────────────────────────


def _build_label(summary: Dict[str, Any]) -> tuple[str, str]:
    """Return (label, sublabel) derived deterministically from SummaryStore data."""
    defines: List[str] = summary.get("symbols_defined") or []
    symbol_types: Dict[str, str] = summary.get("symbol_types") or {}
    symbol_values: Dict[str, Any] = summary.get("symbol_values") or {}

    # Primary symbol: first define with a non-null type; else first define
    primary: Optional[str] = None
    for sym in defines:
        if sym in symbol_types:
            primary = sym
            break
    if primary is None and defines:
        primary = defines[0]

    if primary is None:
        return "(no output)", ""

    label = primary
    typ = symbol_types.get(primary, "")
    val = symbol_values.get(primary)

    if typ == "DataFrame":
        if isinstance(val, str):
            sublabel = f"DataFrame · {val}"
        elif isinstance(val, dict):
            rows = val.get("rows", "?")
            cols = val.get("cols", "?")
            if isinstance(rows, int):
                sublabel = f"DataFrame · {rows:,} × {cols}"
            else:
                sublabel = f"DataFrame · {rows} × {cols}"
        else:
            sublabel = "DataFrame"
    elif typ == "ndarray":
        sublabel = f"ndarray · {val}" if isinstance(val, str) else "ndarray"
    elif typ in ("str", "int", "float", "bool"):
        val_str = str(val) if val is not None else ""
        sublabel = f"{typ} · {val_str}" if val_str and len(val_str) <= 20 else typ
    else:
        sublabel = typ  # type name only

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
            cells: list of {cell_id, index, source} from the request body,
                   already filtered to code cells only by the frontend.
        """
        sorted_cells = sorted(
            (c for c in cells if c.get("source", "").strip()),
            key=lambda c: c["index"],
        )
        store_data = self._store.get_all_current()

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
                defines: List[str] = summary.get("symbols_defined") or []
                loads: List[str] = summary.get("symbols_consumed") or []
                execution_count: Optional[int] = summary.get("execution_count")
                label, sublabel = _build_label(summary)
                data_source = "store"
                unexecuted = False
            else:
                parsed = ASTParser.extract(source)
                defines = parsed["defines"]
                loads = parsed["loads"]
                execution_count = None
                label = (source[:40] if source else "(empty)").replace("\n", " ")
                sublabel = "not executed"
                data_source = "ast"
                unexecuted = True

            nodes.append(NodeData(
                cell_uuid=cell_uuid,
                cell_index=cell_index,
                label=label,
                sublabel=sublabel,
                unexecuted=unexecuted,
                data_source=data_source,
                defines=defines,
                loads=loads,
                external_loads=[],
                execution_count=execution_count,
                anomalies=[],
            ))

        # ── Edge construction ─────────────────────────────────────────────────
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

        return GraphData(
            notebook_path=self._notebook_path,
            nodes=nodes,
            edges=edges,
            computed_at=time.time(),
        )

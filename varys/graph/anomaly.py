"""AnomalyDetector — detects four anomaly classes in a GraphData object.

Mutates NodeData.anomalies and EdgeData.anomaly in-place.
Called by GraphHandler after GraphBuilder produces GraphData.
"""
from __future__ import annotations

from typing import Dict, List, Optional

from .builder import EdgeData, GraphData, NodeData

SKIP_LINK           = "SKIP_LINK"
DEAD_SYMBOL         = "DEAD_SYMBOL"
OUT_OF_ORDER        = "OUT_OF_ORDER"
UNEXECUTED_IN_CHAIN = "UNEXECUTED_IN_CHAIN"


class AnomalyDetector:
    """Run all four anomaly checks against GraphData."""

    def run(self, data: GraphData) -> None:
        self._detect_skip_link(data)
        self._detect_dead_symbol(data)
        self._detect_out_of_order(data)
        self._detect_unexecuted_in_chain(data)

    # ── SKIP_LINK ─────────────────────────────────────────────────────────────

    def _detect_skip_link(self, data: GraphData) -> None:
        node_by_uuid: Dict[str, NodeData] = {n.cell_uuid: n for n in data.nodes}

        for edge in data.edges:
            target = node_by_uuid.get(edge.target_uuid)
            a_node = node_by_uuid.get(edge.source_uuid)
            if target is None or a_node is None:
                continue

            # Guard (spec step 4): if A is unexecuted, skip — covered by UNEXECUTED_IN_CHAIN
            if a_node.execution_count is None:
                continue

            sym = edge.symbol

            # All cells that define sym with index < target
            definers = [
                n for n in data.nodes
                if n.cell_index < target.cell_index and sym in n.defines
            ]

            # Execution-order definer: highest execution_count among executed definers
            exec_definer: Optional[NodeData] = None
            max_ec = -1
            for d in definers:
                if d.execution_count is not None and d.execution_count > max_ec:
                    max_ec = d.execution_count
                    exec_definer = d

            if exec_definer is None:
                continue

            if a_node.cell_uuid != exec_definer.cell_uuid:
                edge.anomaly = SKIP_LINK
                if SKIP_LINK not in target.anomalies:
                    target.anomalies.append(SKIP_LINK)

    # ── DEAD_SYMBOL ───────────────────────────────────────────────────────────

    def _detect_dead_symbol(self, data: GraphData) -> None:
        for node in data.nodes:
            for sym in node.defines:
                consumed_downstream = any(
                    sym in other.loads and other.cell_index > node.cell_index
                    for other in data.nodes
                )
                if not consumed_downstream:
                    if DEAD_SYMBOL not in node.anomalies:
                        node.anomalies.append(DEAD_SYMBOL)
                    break  # one dead symbol is enough to flag the node

    # ── OUT_OF_ORDER ──────────────────────────────────────────────────────────

    def _detect_out_of_order(self, data: GraphData) -> None:
        executed = sorted(
            [n for n in data.nodes if n.execution_count is not None],
            key=lambda n: n.cell_index,
        )

        for i in range(len(executed) - 1):
            ci = executed[i]
            cj = executed[i + 1]
            if (
                ci.execution_count is not None
                and cj.execution_count is not None
                and ci.execution_count > cj.execution_count
            ):
                if OUT_OF_ORDER not in ci.anomalies:
                    ci.anomalies.append(OUT_OF_ORDER)
                for edge in data.edges:
                    if edge.source_uuid == ci.cell_uuid and edge.anomaly is None:
                        edge.anomaly = OUT_OF_ORDER

    # ── UNEXECUTED_IN_CHAIN ───────────────────────────────────────────────────

    def _detect_unexecuted_in_chain(self, data: GraphData) -> None:
        executed = [n for n in data.nodes if not n.unexecuted]
        unexecuted = [n for n in data.nodes if n.unexecuted]

        for u in unexecuted:
            u_defines = set(u.defines)
            flagged = False
            for sym in u_defines:
                if flagged:
                    break
                # Executed cells that define sym before U
                a_cells = [
                    a for a in executed
                    if a.cell_index < u.cell_index and sym in a.defines
                ]
                if not a_cells:
                    continue
                # Executed cells that load sym after U
                n_cells = [
                    n for n in executed
                    if n.cell_index > u.cell_index and sym in n.loads
                ]
                if not n_cells:
                    continue
                if UNEXECUTED_IN_CHAIN not in u.anomalies:
                    u.anomalies.append(UNEXECUTED_IN_CHAIN)
                flagged = True

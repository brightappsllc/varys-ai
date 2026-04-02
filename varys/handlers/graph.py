"""HTTP handler for the Notebook Dependency Graph.

Route (registered in app.py):
    POST /varys/graph — compute and return GraphData for the given notebook
"""
from __future__ import annotations

import asyncio
import json
import traceback

from jupyter_server.base.handlers import JupyterHandler
from tornado.web import authenticated

from ..graph.anomaly import AnomalyDetector
from ..graph.builder import EdgeData, GraphBuilder, GraphData, NodeData


class GraphHandler(JupyterHandler):
    """Compute the dependency graph for the active notebook."""

    @authenticated
    async def post(self) -> None:
        self.set_header("Content-Type", "application/json")
        try:
            body: dict = json.loads(self.request.body)
            notebook_path: str = body.get("notebookPath", "")
            cells: list = body.get("cells", [])
            root_dir: str = self.settings.get("ds_assistant_root_dir", ".")

            def _build() -> GraphData:
                builder = GraphBuilder(root_dir, notebook_path)
                graph_data = builder.build(cells)
                AnomalyDetector().run(graph_data)
                return graph_data

            graph_data = await asyncio.to_thread(_build)
            self.finish(json.dumps(_serialize(graph_data)))

        except Exception:
            self.log.error("Graph handler error:\n%s", traceback.format_exc())
            self.set_status(500)
            self.finish(json.dumps({"error": "Graph computation failed"}))


# ── Serialization ─────────────────────────────────────────────────────────────


def _serialize(g: GraphData) -> dict:
    return {
        "notebookPath": g.notebook_path,
        "computedAt": g.computed_at,
        "nodes": [_node(n) for n in g.nodes],
        "edges": [_edge(e) for e in g.edges],
    }


def _node(n: NodeData) -> dict:
    return {
        "cellUuid":      n.cell_uuid,
        "cellIndex":     n.cell_index,
        "label":         n.label,
        "sublabel":      n.sublabel,
        "unexecuted":    n.unexecuted,
        "dataSource":    n.data_source,
        "defines":       n.defines,
        "loads":         n.loads,
        "externalLoads": n.external_loads,
        "executionCount": n.execution_count,
        "anomalies":     n.anomalies,
        "nodeRole":      n.node_role,
    }


def _edge(e: EdgeData) -> dict:
    return {
        "sourceUuid": e.source_uuid,
        "targetUuid": e.target_uuid,
        "symbol":     e.symbol,
        "anomaly":    e.anomaly,
        "edgeType":   e.edge_type,
    }

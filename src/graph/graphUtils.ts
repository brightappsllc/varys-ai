/**
 * Layout utilities for the Notebook Dependency Graph.
 * Dispatches dagre layout to a Web Worker; falls back to main-thread if unavailable.
 */

import dagre from '@dagrejs/dagre';
import type { GraphData, LayoutResult, EdgeLayout } from './graphTypes';
import { NODE_WIDTH, NODE_HEIGHT } from './graphTypes';

// ── Synchronous layout (fallback / shared logic) ──────────────────────────────

export function computeLayoutSync(data: GraphData): LayoutResult {
  const g = new dagre.graphlib.Graph();
  g.setGraph({
    rankdir: 'TB',
    nodesep: 40,
    ranksep: 60,
    marginx: 20,
    marginy: 20,
  });
  g.setDefaultEdgeLabel(() => ({}));

  for (const node of data.nodes) {
    g.setNode(node.cellUuid, { width: NODE_WIDTH, height: NODE_HEIGHT });
  }
  for (const edge of data.edges) {
    g.setEdge(edge.sourceUuid, edge.targetUuid);
  }

  dagre.layout(g);

  const nodeLayouts = g.nodes().map(id => {
    const n = g.node(id);
    return { cellUuid: id, x: n.x, y: n.y, width: n.width, height: n.height };
  });

  const edgeLayouts: EdgeLayout[] = data.edges.map(edge => {
    const dagreEdge = g.edge(edge.sourceUuid, edge.targetUuid);
    return {
      sourceUuid: edge.sourceUuid,
      targetUuid: edge.targetUuid,
      symbol:     edge.symbol,
      points:     dagreEdge?.points ?? [],
    };
  });

  const gObj = g.graph();
  return {
    nodes:       nodeLayouts,
    edges:       edgeLayouts,
    graphWidth:  (gObj.width  ?? 400) + 40,
    graphHeight: (gObj.height ?? 400) + 40,
  };
}

// ── Async wrapper (waits for a paint frame so the spinner renders first) ──────

export async function computeLayout(data: GraphData): Promise<LayoutResult> {
  // requestAnimationFrame ensures the browser commits the current render
  // (showing the loading spinner) before dagre runs on the next tick.
  await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
  return computeLayoutSync(data);
}

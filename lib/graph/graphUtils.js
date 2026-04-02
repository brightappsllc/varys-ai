/**
 * Layout utilities for the Notebook Dependency Graph.
 * Dispatches dagre layout to a Web Worker; falls back to main-thread if unavailable.
 */
import dagre from '@dagrejs/dagre';
import { NODE_WIDTH, NODE_HEIGHT } from './graphTypes';
// ── Synchronous layout (fallback / shared logic) ──────────────────────────────
export function computeLayoutSync(data) {
    var _a, _b;
    // ── Debug: log what edges dagre receives ─────────────────────────────────
    const edgeSummary = data.edges.map(e => { var _a; return `[${(_a = e.edgeType) !== null && _a !== void 0 ? _a : 'dep'}] ${e.sourceUuid.slice(0, 6)}→${e.targetUuid.slice(0, 6)} (${e.symbol})`; });
    console.debug('[varys-graph] nodes:', data.nodes.length, '| edges:', data.edges.length, '\n', edgeSummary.join('\n'));
    const g = new dagre.graphlib.Graph({ multigraph: true });
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
        // Use the symbol as the edge name so multiple edges between the same
        // pair of nodes (e.g. one dependency + one redefines) each get their
        // own slot in dagre rather than overwriting each other.
        g.setEdge(edge.sourceUuid, edge.targetUuid, {}, edge.symbol);
    }
    // ── Debug: verify dagre received the edges ────────────────────────────────
    const dagreEdges = g.edges();
    console.debug('[varys-graph] dagre edge count:', dagreEdges.length, '\n', dagreEdges.map(e => `${e.v.slice(0, 6)}→${e.w.slice(0, 6)} name=${e.name}`).join('\n'));
    const components = new Map();
    const findRoot = (id) => {
        if (!components.has(id))
            components.set(id, id);
        const p = components.get(id);
        return p === id ? id : findRoot(p);
    };
    dagreEdges.forEach(e => {
        const rv = findRoot(e.v), rw = findRoot(e.w);
        if (rv !== rw)
            components.set(rv, rw);
    });
    data.nodes.forEach(n => findRoot(n.cellUuid));
    const roots = new Set([...data.nodes.map(n => findRoot(n.cellUuid))]);
    console.debug('[varys-graph] connected components:', roots.size, roots.size > 1 ? '⚠ DISCONNECTED' : '✓ single component');
    dagre.layout(g);
    const nodeLayouts = g.nodes().map(id => {
        const n = g.node(id);
        return { cellUuid: id, x: n.x, y: n.y, width: n.width, height: n.height };
    });
    const edgeLayouts = data.edges.map(edge => {
        var _a;
        const dagreEdge = g.edge(edge.sourceUuid, edge.targetUuid);
        return {
            sourceUuid: edge.sourceUuid,
            targetUuid: edge.targetUuid,
            symbol: edge.symbol,
            points: (_a = dagreEdge === null || dagreEdge === void 0 ? void 0 : dagreEdge.points) !== null && _a !== void 0 ? _a : [],
        };
    });
    const gObj = g.graph();
    return {
        nodes: nodeLayouts,
        edges: edgeLayouts,
        graphWidth: ((_a = gObj.width) !== null && _a !== void 0 ? _a : 400) + 40,
        graphHeight: ((_b = gObj.height) !== null && _b !== void 0 ? _b : 400) + 40,
    };
}
// ── Async wrapper (waits for a paint frame so the spinner renders first) ──────
export async function computeLayout(data) {
    // requestAnimationFrame ensures the browser commits the current render
    // (showing the loading spinner) before dagre runs on the next tick.
    await new Promise(resolve => requestAnimationFrame(() => resolve()));
    return computeLayoutSync(data);
}

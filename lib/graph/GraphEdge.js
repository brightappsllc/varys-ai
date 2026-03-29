/**
 * GraphEdge — SVG curved path between two graph nodes.
 */
import React from 'react';
const EDGE_COLORS = {
    SKIP_LINK: '#E8891A',
    OUT_OF_ORDER: '#D94040',
};
const ARROW_ID_PREFIX = 'varys-graph-arrow-';
function getEdgeColor(anomaly) {
    var _a;
    return anomaly ? ((_a = EDGE_COLORS[anomaly]) !== null && _a !== void 0 ? _a : 'var(--jp-border-color2)') : 'var(--jp-border-color2)';
}
function cubicBezierPath(points, src, tgt) {
    var _a;
    if (points.length >= 2) {
        // Use dagre waypoints as bezier control points
        const all = points;
        const p0 = all[0];
        const pN = all[all.length - 1];
        if (all.length === 2) {
            return `M ${p0.x} ${p0.y} L ${pN.x} ${pN.y}`;
        }
        // Build a smooth polyline through the waypoints
        let d = `M ${p0.x} ${p0.y}`;
        for (let i = 1; i < all.length - 1; i++) {
            const cp = all[i];
            const next = (_a = all[i + 1]) !== null && _a !== void 0 ? _a : pN;
            const mx = (cp.x + next.x) / 2;
            const my = (cp.y + next.y) / 2;
            d += ` Q ${cp.x} ${cp.y} ${mx} ${my}`;
        }
        d += ` L ${pN.x} ${pN.y}`;
        return d;
    }
    // Fallback: direct cubic bezier from source center to target center
    const dx = tgt.x - src.x;
    const dy = tgt.y - src.y;
    const cx1 = src.x + dx * 0.1;
    const cy1 = src.y + dy * 0.6;
    const cx2 = tgt.x - dx * 0.1;
    const cy2 = tgt.y - dy * 0.3;
    return `M ${src.x} ${src.y} C ${cx1} ${cy1} ${cx2} ${cy2} ${tgt.x} ${tgt.y}`;
}
export const GraphEdge = ({ edge, layout, nodeLayouts, zoom, dimmed }) => {
    var _a;
    const srcLayout = nodeLayouts.get(edge.sourceUuid);
    const tgtLayout = nodeLayouts.get(edge.targetUuid);
    if (!srcLayout || !tgtLayout)
        return null;
    const src = { x: srcLayout.x, y: srcLayout.y + srcLayout.height / 2 };
    const tgt = { x: tgtLayout.x, y: tgtLayout.y - tgtLayout.height / 2 };
    const color = getEdgeColor(edge.anomaly);
    const pathData = cubicBezierPath(layout.points, src, tgt);
    const arrowId = `${ARROW_ID_PREFIX}${(_a = edge.anomaly) !== null && _a !== void 0 ? _a : 'normal'}`;
    // Midpoint for label
    const midPts = layout.points.length > 0 ? layout.points : [src, tgt];
    const mid = midPts[Math.floor(midPts.length / 2)];
    const showLabel = zoom >= 0.7;
    return (React.createElement("g", { className: "ds-graph-edge", style: { opacity: dimmed ? 0.3 : 1, transition: 'opacity 0.15s' } },
        React.createElement("path", { d: pathData, fill: "none", stroke: color, strokeWidth: edge.anomaly ? 2 : 1.5, markerEnd: `url(#${arrowId})`, strokeDasharray: undefined }),
        showLabel && (React.createElement("text", { x: mid.x, y: mid.y - 4, textAnchor: "middle", fontSize: 10, fill: "var(--jp-ui-font-color2)", className: "ds-graph-edge-label", pointerEvents: "none" }, edge.symbol))));
};
/** SVG <defs> block with arrowhead markers. Render once inside the SVG. */
export const GraphEdgeDefs = () => (React.createElement("defs", null, [
    { id: `${ARROW_ID_PREFIX}normal`, color: 'var(--jp-border-color2)' },
    { id: `${ARROW_ID_PREFIX}SKIP_LINK`, color: '#E8891A' },
    { id: `${ARROW_ID_PREFIX}OUT_OF_ORDER`, color: '#D94040' },
].map(({ id, color }) => (React.createElement("marker", { key: id, id: id, markerWidth: 8, markerHeight: 8, refX: 6, refY: 3, orient: "auto" },
    React.createElement("path", { d: "M0,0 L0,6 L8,3 z", fill: color }))))));

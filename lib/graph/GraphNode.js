/**
 * GraphNode — SVG foreignObject node for the dependency graph.
 */
import React from 'react';
import { NODE_WIDTH, NODE_HEIGHT } from './graphTypes';
const BADGE_PRIORITY = [
    'OUT_OF_ORDER',
    'SKIP_LINK',
    'UNEXECUTED_IN_CHAIN',
    'DEAD_SYMBOL',
];
const BADGE_COLORS = {
    OUT_OF_ORDER: '#D94040',
    SKIP_LINK: '#E8891A',
    UNEXECUTED_IN_CHAIN: '#E8891A',
    DEAD_SYMBOL: '#9CA3AF',
};
// Role-based node fill and border colours
const ROLE_BG = {
    defines: '#d1fae5',
    redefines: '#fed7aa',
    consumes: '#ede9fe',
    empty: 'var(--jp-layout-color2, #f3f3f3)',
};
const ROLE_BORDER = {
    defines: '#059669',
    redefines: '#d97706',
    consumes: '#7c3aed',
    empty: 'var(--jp-border-color1)',
};
function getBadgeColor(anomalies) {
    for (const id of BADGE_PRIORITY) {
        if (anomalies.includes(id))
            return BADGE_COLORS[id];
    }
    return '#9CA3AF';
}
function nodeBackground(nodeRole, anomalies, selected, upstream, downstream) {
    var _a;
    if (selected)
        return 'var(--jp-brand-color4, #dbeafe)';
    if (upstream)
        return '#dbeafe';
    if (downstream)
        return '#fef9c3';
    if (anomalies.length > 0)
        return '#fef9c3';
    return (_a = ROLE_BG[nodeRole]) !== null && _a !== void 0 ? _a : 'var(--jp-layout-color2, #f3f3f3)';
}
function nodeBorder(nodeRole, anomalies, selected) {
    var _a;
    if (selected)
        return { color: '#3B82F6', width: 2 };
    const hasUnexecuted = anomalies.includes('UNEXECUTED_IN_CHAIN');
    if (hasUnexecuted)
        return { color: '#E8891A', width: 2, dash: '5,3' };
    return { color: (_a = ROLE_BORDER[nodeRole]) !== null && _a !== void 0 ? _a : 'var(--jp-border-color1)', width: 1.5 };
}
export const GraphNode = ({ node, layout, selected, upstream, downstream, dimmed, onClick, }) => {
    var _a;
    const x = layout.x - NODE_WIDTH / 2;
    const y = layout.y - NODE_HEIGHT / 2;
    const hasBadge = node.anomalies.length > 0;
    const badgeColor = hasBadge ? getBadgeColor(node.anomalies) : '';
    const role = ((_a = node.nodeRole) !== null && _a !== void 0 ? _a : 'empty');
    const bg = nodeBackground(role, node.anomalies, selected, upstream, downstream);
    const bdr = nodeBorder(role, node.anomalies, selected);
    const opacity = dimmed ? 0.3 : 1;
    return (React.createElement("g", { className: "ds-graph-node", transform: `translate(${x},${y})`, style: { cursor: 'pointer', opacity, transition: 'opacity 0.15s' }, onClick: () => onClick(node.cellUuid) },
        React.createElement("rect", { x: 2, y: 3, width: NODE_WIDTH, height: NODE_HEIGHT, rx: 8, fill: "rgba(0,0,0,0.08)" }),
        React.createElement("rect", { x: 0, y: 0, width: NODE_WIDTH, height: NODE_HEIGHT, rx: 8, fill: bg, stroke: bdr.color, strokeWidth: bdr.width, strokeDasharray: bdr.dash }),
        React.createElement("foreignObject", { x: 0, y: 0, width: NODE_WIDTH, height: NODE_HEIGHT },
            React.createElement("div", { className: "ds-graph-node-inner", style: {
                    width: NODE_WIDTH,
                    height: NODE_HEIGHT,
                    padding: '5px 10px 5px',
                    boxSizing: 'border-box',
                    display: 'flex',
                    flexDirection: 'column',
                    justifyContent: 'center',
                    alignItems: 'center',
                    overflow: 'hidden',
                    position: 'relative',
                } },
                hasBadge && (React.createElement("span", { className: "ds-graph-anomaly-badge", title: node.anomalies.join(', '), style: {
                        position: 'absolute',
                        top: 4,
                        right: 6,
                        fontSize: 9,
                        fontWeight: 700,
                        color: '#fff',
                        background: badgeColor,
                        borderRadius: '50%',
                        width: 16,
                        height: 16,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        lineHeight: 1,
                    } }, node.anomalies.length)),
                React.createElement("span", { className: "ds-graph-node-cell-tag", style: {
                        fontSize: 9,
                        fontWeight: 400,
                        color: 'var(--jp-ui-font-color2)',
                        letterSpacing: '0.04em',
                        lineHeight: 1,
                        marginBottom: 3,
                        whiteSpace: 'nowrap',
                    } },
                    "Cell ",
                    node.cellIndex + 1),
                React.createElement("span", { className: "ds-graph-node-label", style: {
                        fontSize: 14,
                        fontWeight: 700,
                        color: 'var(--jp-ui-font-color0)',
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        maxWidth: NODE_WIDTH - 20,
                        textAlign: 'center',
                        lineHeight: 1.2,
                    } }, node.label),
                node.sublabel && (React.createElement("span", { className: "ds-graph-node-sublabel", style: {
                        fontSize: 9,
                        color: 'var(--jp-ui-font-color2)',
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        maxWidth: NODE_WIDTH - 20,
                        textAlign: 'center',
                        marginTop: 3,
                        lineHeight: 1,
                    } }, node.sublabel))))));
};

/**
 * GraphPanel — Notebook Dependency Graph, rendered in a JupyterLab main-area panel.
 */
import React, { useState, useRef, useCallback, useMemo } from 'react';
import { ReactWidget } from '@jupyterlab/apputils';
import { useGraphData } from './useGraphData';
import { GraphNode } from './GraphNode';
import { GraphEdge, GraphEdgeDefs } from './GraphEdge';
// ── Legend ────────────────────────────────────────────────────────────────────
const LegendBox = ({ bg, border }) => (React.createElement("span", { style: {
        display: 'inline-block', width: 14, height: 14, borderRadius: 3,
        background: bg, border: `1.5px solid ${border}`, flexShrink: 0,
    } }));
const Legend = () => (React.createElement("div", { className: "ds-graph-legend" },
    React.createElement("span", { className: "ds-graph-legend-item" },
        React.createElement(LegendBox, { bg: "#d1fae5", border: "#059669" }),
        " defines symbol"),
    React.createElement("span", { className: "ds-graph-legend-item" },
        React.createElement(LegendBox, { bg: "#ede9fe", border: "#7c3aed" }),
        " consumes only"),
    React.createElement("span", { className: "ds-graph-legend-item" },
        React.createElement(LegendBox, { bg: "#fed7aa", border: "#d97706" }),
        " redefines symbol"),
    React.createElement("span", { className: "ds-graph-legend-item" },
        React.createElement(LegendBox, { bg: "var(--jp-layout-color2,#f3f3f3)", border: "var(--jp-border-color1)" }),
        " empty cell"),
    React.createElement("span", { className: "ds-graph-legend-item" },
        React.createElement("span", { style: {
                display: 'inline-block', width: 22, height: 0,
                borderTop: '2px dashed #ef4444', flexShrink: 0,
            } }),
        "reimport")));
const GraphCanvas = ({ tracker, onScrollToCell }) => {
    var _a, _b;
    const { data, layout, loading, error, refresh } = useGraphData(tracker);
    // Pan & zoom state
    const [zoom, setZoom] = useState(1);
    const [panX, setPanX] = useState(0);
    const [panY, setPanY] = useState(0);
    const [isPanning, setIsPanning] = useState(false);
    const panStart = useRef(null);
    // Selection state
    const [selectedUuid, setSelectedUuid] = useState(null);
    const notebookName = (_b = (_a = tracker.currentWidget) === null || _a === void 0 ? void 0 : _a.context.path.split('/').pop()) !== null && _b !== void 0 ? _b : '';
    const computedAgo = useMemo(() => {
        if (!data)
            return '';
        const secs = Math.round(Date.now() / 1000 - data.computedAt);
        if (secs < 5)
            return 'just now';
        if (secs < 60)
            return `${secs}s ago`;
        return `${Math.floor(secs / 60)}m ago`;
    }, [data]);
    // Build adjacency for highlight
    const { upstream, downstream } = useMemo(() => {
        if (!data || !selectedUuid)
            return { upstream: new Set(), downstream: new Set() };
        const parents = new Map();
        const children = new Map();
        for (const e of data.edges) {
            if (!parents.has(e.targetUuid))
                parents.set(e.targetUuid, []);
            if (!children.has(e.sourceUuid))
                children.set(e.sourceUuid, []);
            parents.get(e.targetUuid).push(e.sourceUuid);
            children.get(e.sourceUuid).push(e.targetUuid);
        }
        const bfs = (start, adj) => {
            var _a;
            const visited = new Set();
            const queue = [start];
            while (queue.length) {
                const cur = queue.shift();
                for (const nb of (_a = adj.get(cur)) !== null && _a !== void 0 ? _a : []) {
                    if (!visited.has(nb)) {
                        visited.add(nb);
                        queue.push(nb);
                    }
                }
            }
            return visited;
        };
        return {
            upstream: bfs(selectedUuid, parents),
            downstream: bfs(selectedUuid, children),
        };
    }, [data, selectedUuid]);
    const nodeLayoutMap = useMemo(() => {
        const m = new Map();
        if (layout)
            layout.nodes.forEach(n => m.set(n.cellUuid, n));
        return m;
    }, [layout]);
    const edgeLayoutMap = useMemo(() => {
        const m = new Map();
        if (layout)
            layout.edges.forEach(e => m.set(`${e.sourceUuid}→${e.targetUuid}`, e));
        return m;
    }, [layout]);
    const handleNodeClick = useCallback((cellUuid) => {
        setSelectedUuid(prev => prev === cellUuid ? null : cellUuid);
        const node = data === null || data === void 0 ? void 0 : data.nodes.find(n => n.cellUuid === cellUuid);
        if (node !== undefined)
            onScrollToCell(node.cellIndex);
    }, [data, onScrollToCell]);
    const handleCanvasClick = useCallback(() => setSelectedUuid(null), []);
    // Wheel zoom
    const handleWheel = useCallback((e) => {
        e.preventDefault();
        setZoom(z => Math.max(0.2, Math.min(4, z * (1 - e.deltaY * 0.001))));
    }, []);
    // Pan with mouse drag
    const handleMouseDown = useCallback((e) => {
        if (e.button !== 0)
            return;
        setIsPanning(true);
        panStart.current = { x: e.clientX, y: e.clientY, px: panX, py: panY };
    }, [panX, panY]);
    const handleMouseMove = useCallback((e) => {
        if (!isPanning || !panStart.current)
            return;
        setPanX(panStart.current.px + (e.clientX - panStart.current.x));
        setPanY(panStart.current.py + (e.clientY - panStart.current.y));
    }, [isPanning]);
    const handleMouseUp = useCallback(() => setIsPanning(false), []);
    if (!tracker.currentWidget) {
        return (React.createElement("div", { className: "ds-graph-empty" }, "No notebook active \u2014 open a notebook to view its dependency graph."));
    }
    return (React.createElement("div", { className: "ds-graph-panel" },
        React.createElement("div", { className: "ds-graph-header" },
            React.createElement("div", { className: "ds-graph-header-left" },
                React.createElement("svg", { width: "18", height: "18", viewBox: "0 0 13 13", fill: "none", "aria-hidden": "true", style: { opacity: 0.75, flexShrink: 0 } },
                    React.createElement("circle", { cx: "6.5", cy: "2", r: "1.7", fill: "currentColor" }),
                    React.createElement("circle", { cx: "2.2", cy: "10.5", r: "1.7", fill: "currentColor" }),
                    React.createElement("circle", { cx: "10.8", cy: "10.5", r: "1.7", fill: "currentColor" }),
                    React.createElement("line", { x1: "5.7", y1: "3.6", x2: "3.0", y2: "8.8", stroke: "currentColor", strokeWidth: "1.3", strokeLinecap: "round" }),
                    React.createElement("line", { x1: "7.3", y1: "3.6", x2: "10.0", y2: "8.8", stroke: "currentColor", strokeWidth: "1.3", strokeLinecap: "round" })),
                React.createElement("div", null,
                    React.createElement("div", { className: "ds-graph-title" }, "Notebook dependency graph"),
                    data && (React.createElement("div", { className: "ds-graph-subtitle" },
                        notebookName,
                        " \u00B7 computed ",
                        computedAgo)))),
            React.createElement("button", { className: "ds-graph-refresh-btn", onClick: refresh, disabled: loading, title: "Refresh graph" }, loading ? '⟳ Loading…' : '⟳ Refresh')),
        React.createElement(Legend, null),
        React.createElement("div", { className: "ds-graph-canvas-wrap", style: { cursor: isPanning ? 'grabbing' : 'grab' }, onWheel: handleWheel, onMouseDown: handleMouseDown, onMouseMove: handleMouseMove, onMouseUp: handleMouseUp, onMouseLeave: handleMouseUp, onClick: handleCanvasClick },
            error && (React.createElement("div", { className: "ds-graph-error" },
                "Error: ",
                error)),
            loading && !data && (React.createElement("div", { className: "ds-graph-loading" }, "Computing graph\u2026")),
            data && layout && (React.createElement("svg", { width: layout.graphWidth * zoom, height: layout.graphHeight * zoom, style: {
                    transform: `translate(${panX}px, ${panY}px)`,
                    transformOrigin: '0 0',
                    display: 'block',
                }, viewBox: `0 0 ${layout.graphWidth} ${layout.graphHeight}` },
                React.createElement(GraphEdgeDefs, null),
                data.edges.map(edge => {
                    const el = edgeLayoutMap.get(`${edge.sourceUuid}→${edge.targetUuid}`);
                    if (!el)
                        return null;
                    const isInvolved = selectedUuid === edge.sourceUuid ||
                        selectedUuid === edge.targetUuid ||
                        upstream.has(edge.sourceUuid) ||
                        upstream.has(edge.targetUuid) ||
                        downstream.has(edge.sourceUuid) ||
                        downstream.has(edge.targetUuid);
                    const dimmed = !!selectedUuid && !isInvolved;
                    return (React.createElement(GraphEdge, { key: `${edge.sourceUuid}→${edge.targetUuid}→${edge.symbol}`, edge: edge, layout: el, nodeLayouts: nodeLayoutMap, zoom: zoom, dimmed: dimmed }));
                }),
                data.nodes.map(node => {
                    const nl = nodeLayoutMap.get(node.cellUuid);
                    if (!nl)
                        return null;
                    const isSelected = selectedUuid === node.cellUuid;
                    const isUpstream = upstream.has(node.cellUuid);
                    const isDownstream = downstream.has(node.cellUuid);
                    const dimmed = !!selectedUuid && !isSelected && !isUpstream && !isDownstream;
                    return (React.createElement(GraphNode, { key: node.cellUuid, node: node, layout: nl, selected: isSelected, upstream: isUpstream, downstream: isDownstream, dimmed: dimmed, onClick: handleNodeClick }));
                }))),
            data && data.nodes.length === 0 && (React.createElement("div", { className: "ds-graph-empty" }, "No code cells found in this notebook.")))));
};
const GraphPanelRoot = ({ tracker, scrollToCell }) => (React.createElement(GraphCanvas, { tracker: tracker, onScrollToCell: scrollToCell }));
export class GraphPanelWidget extends ReactWidget {
    constructor(tracker, scrollToCell) {
        super();
        this._tracker = tracker;
        this._scrollToCell = scrollToCell;
        this.id = 'varys-graph-panel';
        this.title.label = 'Varys Graph';
        this.title.closable = true;
        this.addClass('ds-graph-panel-widget');
    }
    render() {
        return (React.createElement(GraphPanelRoot, { tracker: this._tracker, scrollToCell: this._scrollToCell }));
    }
}

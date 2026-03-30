/**
 * GraphPanel — Notebook Dependency Graph, rendered in a JupyterLab main-area panel.
 */

import React, { useState, useRef, useCallback, useMemo } from 'react';
import { ReactWidget } from '@jupyterlab/apputils';
import { INotebookTracker } from '@jupyterlab/notebook';
import { useGraphData } from './useGraphData';
import { GraphNode } from './GraphNode';
import { GraphEdge, GraphEdgeDefs } from './GraphEdge';

// ── Legend ────────────────────────────────────────────────────────────────────

const Legend: React.FC = () => (
  <div className="ds-graph-legend">
    <span className="ds-graph-legend-item">
      <span className="ds-graph-legend-line ds-graph-legend-normal" /> Normal flow
    </span>
    <span className="ds-graph-legend-item">
      <span className="ds-graph-legend-line ds-graph-legend-skip" /> Skip-link
    </span>
    <span className="ds-graph-legend-item">
      <span className="ds-graph-legend-line ds-graph-legend-order" /> Out-of-order
    </span>
    <span className="ds-graph-legend-item">
      <span className="ds-graph-legend-dot ds-graph-legend-dead" />Dead symbol
    </span>
    <span className="ds-graph-legend-item">
      <span className="ds-graph-legend-dashed" /> Unexecuted
    </span>
  </div>
);

// ── Canvas (SVG) ──────────────────────────────────────────────────────────────

interface CanvasProps {
  tracker: INotebookTracker;
  onScrollToCell: (index: number) => void;
}

const GraphCanvas: React.FC<CanvasProps> = ({ tracker, onScrollToCell }) => {
  const { data, layout, loading, error, refresh } = useGraphData(tracker);

  // Pan & zoom state
  const [zoom, setZoom]       = useState(1);
  const [panX, setPanX]       = useState(0);
  const [panY, setPanY]       = useState(0);
  const [isPanning, setIsPanning] = useState(false);
  const panStart = useRef<{ x: number; y: number; px: number; py: number } | null>(null);

  // Selection state
  const [selectedUuid, setSelectedUuid] = useState<string | null>(null);

  const notebookName = tracker.currentWidget?.context.path.split('/').pop() ?? '';

  const computedAgo = useMemo(() => {
    if (!data) return '';
    const secs = Math.round(Date.now() / 1000 - data.computedAt);
    if (secs < 5)  return 'just now';
    if (secs < 60) return `${secs}s ago`;
    return `${Math.floor(secs / 60)}m ago`;
  }, [data]);

  // Build adjacency for highlight
  const { upstream, downstream } = useMemo(() => {
    if (!data || !selectedUuid) return { upstream: new Set<string>(), downstream: new Set<string>() };

    const parents  = new Map<string, string[]>();
    const children = new Map<string, string[]>();
    for (const e of data.edges) {
      if (!parents.has(e.targetUuid))  parents.set(e.targetUuid, []);
      if (!children.has(e.sourceUuid)) children.set(e.sourceUuid, []);
      parents.get(e.targetUuid)!.push(e.sourceUuid);
      children.get(e.sourceUuid)!.push(e.targetUuid);
    }

    const bfs = (start: string, adj: Map<string, string[]>): Set<string> => {
      const visited = new Set<string>();
      const queue = [start];
      while (queue.length) {
        const cur = queue.shift()!;
        for (const nb of adj.get(cur) ?? []) {
          if (!visited.has(nb)) { visited.add(nb); queue.push(nb); }
        }
      }
      return visited;
    };

    return {
      upstream:   bfs(selectedUuid, parents),
      downstream: bfs(selectedUuid, children),
    };
  }, [data, selectedUuid]);

  const nodeLayoutMap = useMemo(() => {
    const m = new Map<string, { cellUuid: string; x: number; y: number; width: number; height: number }>();
    if (layout) layout.nodes.forEach(n => m.set(n.cellUuid, n));
    return m;
  }, [layout]);

  const edgeLayoutMap = useMemo(() => {
    const m = new Map<string, { sourceUuid: string; targetUuid: string; symbol: string; points: Array<{x: number; y: number}> }>();
    if (layout) layout.edges.forEach(e => m.set(`${e.sourceUuid}→${e.targetUuid}`, e));
    return m;
  }, [layout]);

  const handleNodeClick = useCallback((cellUuid: string) => {
    setSelectedUuid(prev => prev === cellUuid ? null : cellUuid);
    const node = data?.nodes.find(n => n.cellUuid === cellUuid);
    if (node !== undefined) onScrollToCell(node.cellIndex);
  }, [data, onScrollToCell]);

  const handleCanvasClick = useCallback(() => setSelectedUuid(null), []);

  // Wheel zoom
  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    setZoom(z => Math.max(0.2, Math.min(4, z * (1 - e.deltaY * 0.001))));
  }, []);

  // Pan with mouse drag
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return;
    setIsPanning(true);
    panStart.current = { x: e.clientX, y: e.clientY, px: panX, py: panY };
  }, [panX, panY]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!isPanning || !panStart.current) return;
    setPanX(panStart.current.px + (e.clientX - panStart.current.x));
    setPanY(panStart.current.py + (e.clientY - panStart.current.y));
  }, [isPanning]);

  const handleMouseUp = useCallback(() => setIsPanning(false), []);

  if (!tracker.currentWidget) {
    return (
      <div className="ds-graph-empty">
        No notebook active — open a notebook to view its dependency graph.
      </div>
    );
  }

  return (
    <div className="ds-graph-panel">
      {/* Header */}
      <div className="ds-graph-header">
        <div className="ds-graph-header-left">
          <svg width="18" height="18" viewBox="0 0 13 13" fill="none" aria-hidden="true" style={{ opacity: 0.75, flexShrink: 0 }}>
              <circle cx="6.5" cy="2" r="1.7" fill="currentColor"/>
              <circle cx="2.2" cy="10.5" r="1.7" fill="currentColor"/>
              <circle cx="10.8" cy="10.5" r="1.7" fill="currentColor"/>
              <line x1="5.7" y1="3.6" x2="3.0" y2="8.8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
              <line x1="7.3" y1="3.6" x2="10.0" y2="8.8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
            </svg>
          <div>
            <div className="ds-graph-title">Notebook dependency graph</div>
            {data && (
              <div className="ds-graph-subtitle">{notebookName} · computed {computedAgo}</div>
            )}
          </div>
        </div>
        <button
          className="ds-graph-refresh-btn"
          onClick={refresh}
          disabled={loading}
          title="Refresh graph"
        >
          {loading ? '⟳ Loading…' : '⟳ Refresh'}
        </button>
      </div>

      {/* Legend */}
      <Legend />

      {/* Body */}
      <div
        className="ds-graph-canvas-wrap"
        style={{ cursor: isPanning ? 'grabbing' : 'grab' }}
        onWheel={handleWheel}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        onClick={handleCanvasClick}
      >
        {error && (
          <div className="ds-graph-error">Error: {error}</div>
        )}

        {loading && !data && (
          <div className="ds-graph-loading">Computing graph…</div>
        )}

        {data && layout && (
          <svg
            width={layout.graphWidth * zoom}
            height={layout.graphHeight * zoom}
            style={{
              transform: `translate(${panX}px, ${panY}px)`,
              transformOrigin: '0 0',
              display: 'block',
            }}
            viewBox={`0 0 ${layout.graphWidth} ${layout.graphHeight}`}
          >
            <GraphEdgeDefs />

            {/* Edges below nodes */}
            {data.edges.map(edge => {
              const el = edgeLayoutMap.get(`${edge.sourceUuid}→${edge.targetUuid}`);
              if (!el) return null;

              const isInvolved =
                selectedUuid === edge.sourceUuid ||
                selectedUuid === edge.targetUuid ||
                upstream.has(edge.sourceUuid)  ||
                upstream.has(edge.targetUuid)  ||
                downstream.has(edge.sourceUuid) ||
                downstream.has(edge.targetUuid);

              const dimmed = !!selectedUuid && !isInvolved;

              return (
                <GraphEdge
                  key={`${edge.sourceUuid}→${edge.targetUuid}→${edge.symbol}`}
                  edge={edge}
                  layout={el}
                  nodeLayouts={nodeLayoutMap as any}
                  zoom={zoom}
                  dimmed={dimmed}
                />
              );
            })}

            {/* Nodes */}
            {data.nodes.map(node => {
              const nl = nodeLayoutMap.get(node.cellUuid);
              if (!nl) return null;

              const isSelected   = selectedUuid === node.cellUuid;
              const isUpstream   = upstream.has(node.cellUuid);
              const isDownstream = downstream.has(node.cellUuid);
              const dimmed =
                !!selectedUuid && !isSelected && !isUpstream && !isDownstream;

              return (
                <GraphNode
                  key={node.cellUuid}
                  node={node}
                  layout={nl}
                  selected={isSelected}
                  upstream={isUpstream}
                  downstream={isDownstream}
                  dimmed={dimmed}
                  onClick={handleNodeClick}
                />
              );
            })}
          </svg>
        )}

        {data && data.nodes.length === 0 && (
          <div className="ds-graph-empty">
            No code cells found in this notebook.
          </div>
        )}
      </div>
    </div>
  );
};

// ── ReactWidget wrapper ───────────────────────────────────────────────────────

interface PanelProps {
  tracker:         INotebookTracker;
  scrollToCell:    (index: number) => void;
}

const GraphPanelRoot: React.FC<PanelProps> = ({ tracker, scrollToCell }) => (
  <GraphCanvas tracker={tracker} onScrollToCell={scrollToCell} />
);

export class GraphPanelWidget extends ReactWidget {
  private _tracker:      INotebookTracker;
  private _scrollToCell: (index: number) => void;

  constructor(
    tracker: INotebookTracker,
    scrollToCell: (index: number) => void,
  ) {
    super();
    this._tracker      = tracker;
    this._scrollToCell = scrollToCell;
    this.id            = 'varys-graph-panel';
    this.title.label   = 'Varys Graph';
    this.title.closable = true;
    this.addClass('ds-graph-panel-widget');
  }

  render(): React.ReactElement {
    return (
      <GraphPanelRoot
        tracker={this._tracker}
        scrollToCell={this._scrollToCell}
      />
    );
  }
}

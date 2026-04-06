/**
 * GraphEdge — SVG curved path between two graph nodes.
 */

import React from 'react';
import type { EdgeData } from './graphTypes';
import type { EdgeLayout, NodeLayout } from './graphTypes';

interface Props {
  edge:        EdgeData;
  layout:      EdgeLayout;
  nodeLayouts: Map<string, NodeLayout>;
  zoom:        number;
  dimmed:      boolean;
}

const ANOMALY_COLORS: Record<string, string> = {
  SKIP_LINK:    '#E8891A',
  OUT_OF_ORDER: '#D94040',
};

const EDGE_TYPE_COLORS: Record<string, string> = {
  dependency: 'var(--jp-border-color2)',
  redefines:  '#d97706',
  reimport:   '#ef4444',
};

const ARROW_ID_PREFIX = 'varys-graph-arrow-';

function getEdgeColor(edge: EdgeData): string {
  if (edge.anomaly) return ANOMALY_COLORS[edge.anomaly] ?? 'var(--jp-border-color2)';
  return EDGE_TYPE_COLORS[edge.edgeType ?? 'dependency'] ?? 'var(--jp-border-color2)';
}

function getArrowId(edge: EdgeData): string {
  if (edge.anomaly) return `${ARROW_ID_PREFIX}${edge.anomaly}`;
  if (edge.edgeType === 'redefines') return `${ARROW_ID_PREFIX}redefines`;
  if (edge.edgeType === 'reimport')  return `${ARROW_ID_PREFIX}reimport`;
  return `${ARROW_ID_PREFIX}normal`;
}

function cubicBezierPath(
  points: Array<{ x: number; y: number }>,
  src: { x: number; y: number },
  tgt: { x: number; y: number },
): string {
  if (points.length >= 2) {
    const all = points;
    const p0 = all[0];
    const pN = all[all.length - 1];
    if (all.length === 2) {
      return `M ${p0.x} ${p0.y} L ${pN.x} ${pN.y}`;
    }
    let d = `M ${p0.x} ${p0.y}`;
    for (let i = 1; i < all.length - 1; i++) {
      const cp = all[i];
      const next = all[i + 1] ?? pN;
      const mx = (cp.x + next.x) / 2;
      const my = (cp.y + next.y) / 2;
      d += ` Q ${cp.x} ${cp.y} ${mx} ${my}`;
    }
    d += ` L ${pN.x} ${pN.y}`;
    return d;
  }
  // Fallback: direct cubic bezier
  const dx = tgt.x - src.x;
  const dy = tgt.y - src.y;
  const cx1 = src.x + dx * 0.1;
  const cy1 = src.y + dy * 0.6;
  const cx2 = tgt.x - dx * 0.1;
  const cy2 = tgt.y - dy * 0.3;
  return `M ${src.x} ${src.y} C ${cx1} ${cy1} ${cx2} ${cy2} ${tgt.x} ${tgt.y}`;
}

export const GraphEdge: React.FC<Props> = ({ edge, layout, nodeLayouts, zoom, dimmed }) => {
  const srcLayout = nodeLayouts.get(edge.sourceUuid);
  const tgtLayout = nodeLayouts.get(edge.targetUuid);
  if (!srcLayout || !tgtLayout) return null;

  const src = { x: srcLayout.x, y: srcLayout.y + srcLayout.height / 2 };
  const tgt = { x: tgtLayout.x, y: tgtLayout.y - tgtLayout.height / 2 };

  const color    = getEdgeColor(edge);
  const arrowId  = getArrowId(edge);
  const pathData = cubicBezierPath(layout.points, src, tgt);
  const isDashed = edge.edgeType === 'reimport';
  const isThick  = !!(edge.anomaly) || edge.edgeType === 'redefines';

  // Midpoint for label
  const midPts = layout.points.length > 0 ? layout.points : [src, tgt];
  const mid = midPts[Math.floor(midPts.length / 2)];

  const showLabel = zoom >= 0.7;

  return (
    <g
      className="ds-graph-edge"
      style={{ opacity: dimmed ? 0.3 : 1, transition: 'opacity 0.15s' }}
    >
      <path
        d={pathData}
        fill="none"
        stroke={color}
        strokeWidth={isThick ? 2 : 1.5}
        markerEnd={`url(#${arrowId})`}
        strokeDasharray={isDashed ? '6,4' : undefined}
      />
      {showLabel && (
        <text
          x={mid.x}
          y={mid.y - 4}
          textAnchor="middle"
          fontSize={10}
          fill="var(--jp-ui-font-color2)"
          className="ds-graph-edge-label"
          pointerEvents="none"
        >
          {edge.symbol}
        </text>
      )}
    </g>
  );
};

/** SVG <defs> block with arrowhead markers. Render once inside the SVG. */
export const GraphEdgeDefs: React.FC = () => (
  <defs>
    {[
      { id: `${ARROW_ID_PREFIX}normal`,       color: 'var(--jp-border-color2)' },
      { id: `${ARROW_ID_PREFIX}SKIP_LINK`,    color: '#E8891A' },
      { id: `${ARROW_ID_PREFIX}OUT_OF_ORDER`, color: '#D94040' },
      { id: `${ARROW_ID_PREFIX}redefines`,    color: '#d97706' },
      { id: `${ARROW_ID_PREFIX}reimport`,     color: '#ef4444' },
    ].map(({ id, color }) => (
      <marker
        key={id}
        id={id}
        markerWidth={8}
        markerHeight={8}
        refX={6}
        refY={3}
        orient="auto"
      >
        <path d="M0,0 L0,6 L8,3 z" fill={color} />
      </marker>
    ))}
  </defs>
);

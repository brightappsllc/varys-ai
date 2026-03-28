/**
 * GraphNode — SVG foreignObject node for the dependency graph.
 */

import React from 'react';
import type { NodeData, AnomalyId } from './graphTypes';
import type { NodeLayout } from './graphTypes';
import { NODE_WIDTH, NODE_HEIGHT } from './graphTypes';

interface Props {
  node:       NodeData;
  layout:     NodeLayout;
  selected:   boolean;
  upstream:   boolean;
  downstream: boolean;
  dimmed:     boolean;
  onClick:    (cellUuid: string) => void;
}

const BADGE_PRIORITY: AnomalyId[] = [
  'OUT_OF_ORDER',
  'SKIP_LINK',
  'UNEXECUTED_IN_CHAIN',
  'DEAD_SYMBOL',
];

const BADGE_COLORS: Record<AnomalyId, string> = {
  OUT_OF_ORDER:        '#D94040',
  SKIP_LINK:           '#E8891A',
  UNEXECUTED_IN_CHAIN: '#E8891A',
  DEAD_SYMBOL:         '#9CA3AF',
};

function getBadgeColor(anomalies: AnomalyId[]): string {
  for (const id of BADGE_PRIORITY) {
    if (anomalies.includes(id)) return BADGE_COLORS[id];
  }
  return '#9CA3AF';
}

function nodeBackground(
  anomalies: AnomalyId[],
  selected: boolean,
  upstream: boolean,
  downstream: boolean,
): string {
  if (selected)    return 'var(--jp-brand-color4, #dbeafe)';
  if (upstream)    return '#dbeafe';
  if (downstream)  return '#fef3c7';
  if (anomalies.length > 0) return '#fef9c3';
  return 'var(--jp-layout-color2, #f3f3f3)';
}

export const GraphNode: React.FC<Props> = ({
  node, layout, selected, upstream, downstream, dimmed, onClick,
}) => {
  const x = layout.x - NODE_WIDTH  / 2;
  const y = layout.y - NODE_HEIGHT / 2;

  const hasUnexecutedBorder = node.anomalies.includes('UNEXECUTED_IN_CHAIN');
  const hasBadge = node.anomalies.length > 0;
  const badgeColor = hasBadge ? getBadgeColor(node.anomalies) : '';

  const bg = nodeBackground(node.anomalies, selected, upstream, downstream);
  const ringColor = selected ? '#3B82F6' : 'transparent';

  const opacity = dimmed ? 0.3 : 1;

  return (
    <g
      className="ds-graph-node"
      transform={`translate(${x},${y})`}
      style={{ cursor: 'pointer', opacity, transition: 'opacity 0.15s' }}
      onClick={() => onClick(node.cellUuid)}
    >
      {/* Shadow rect */}
      <rect
        x={2} y={3}
        width={NODE_WIDTH}
        height={NODE_HEIGHT}
        rx={8}
        fill="rgba(0,0,0,0.08)"
      />
      {/* Main rect */}
      <rect
        x={0} y={0}
        width={NODE_WIDTH}
        height={NODE_HEIGHT}
        rx={8}
        fill={bg}
        stroke={selected ? ringColor : hasUnexecutedBorder ? '#E8891A' : 'var(--jp-border-color1)'}
        strokeWidth={selected ? 2 : hasUnexecutedBorder ? 2 : 1}
        strokeDasharray={hasUnexecutedBorder && !selected ? '5,3' : undefined}
      />

      {/* Content via foreignObject */}
      <foreignObject x={0} y={0} width={NODE_WIDTH} height={NODE_HEIGHT}>
        <div
          className="ds-graph-node-inner"
          style={{
            width:    NODE_WIDTH,
            height:   NODE_HEIGHT,
            padding:  '6px 10px',
            boxSizing: 'border-box',
            display:  'flex',
            flexDirection: 'column',
            justifyContent: 'center',
            overflow: 'hidden',
            position: 'relative',
          }}
        >
          {/* Cell index badge top-left */}
          <span
            className="ds-graph-cell-badge"
            style={{
              position:   'absolute',
              top:        4,
              left:       6,
              fontSize:   9,
              fontWeight: 600,
              color:      'var(--jp-ui-font-color2)',
              background: 'var(--jp-layout-color3, #e0e0e0)',
              borderRadius: 3,
              padding:    '1px 4px',
              lineHeight: 1.4,
            }}
          >
            #{node.cellIndex + 1}
          </span>

          {/* Anomaly badge top-right */}
          {hasBadge && (
            <span
              className="ds-graph-anomaly-badge"
              title={node.anomalies.join(', ')}
              style={{
                position:   'absolute',
                top:        4,
                right:      6,
                fontSize:   9,
                fontWeight: 700,
                color:      '#fff',
                background: badgeColor,
                borderRadius: '50%',
                width:      16,
                height:     16,
                display:    'flex',
                alignItems: 'center',
                justifyContent: 'center',
                lineHeight: 1,
              }}
            >
              {node.anomalies.length}
            </span>
          )}

          {/* Label */}
          <span
            className="ds-graph-node-label"
            style={{
              fontSize:   13,
              fontWeight: 500,
              color:      'var(--jp-ui-font-color0)',
              whiteSpace: 'nowrap',
              overflow:   'hidden',
              textOverflow: 'ellipsis',
              marginTop:  hasBadge || true ? 10 : 0,
            }}
          >
            {node.label}
          </span>

          {/* Sublabel */}
          {node.sublabel && (
            <span
              className="ds-graph-node-sublabel"
              style={{
                fontSize:   11,
                color:      'var(--jp-ui-font-color2)',
                whiteSpace: 'nowrap',
                overflow:   'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              {node.sublabel}
            </span>
          )}
        </div>
      </foreignObject>
    </g>
  );
};

/**
 * GraphNode — SVG foreignObject node for the dependency graph.
 */
import React from 'react';
import type { NodeData } from './graphTypes';
import type { NodeLayout } from './graphTypes';
interface Props {
    node: NodeData;
    layout: NodeLayout;
    selected: boolean;
    upstream: boolean;
    downstream: boolean;
    dimmed: boolean;
    onClick: (cellUuid: string) => void;
}
export declare const GraphNode: React.FC<Props>;
export {};
//# sourceMappingURL=GraphNode.d.ts.map
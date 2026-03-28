/**
 * GraphEdge — SVG curved path between two graph nodes.
 */
import React from 'react';
import type { EdgeData } from './graphTypes';
import type { EdgeLayout, NodeLayout } from './graphTypes';
interface Props {
    edge: EdgeData;
    layout: EdgeLayout;
    nodeLayouts: Map<string, NodeLayout>;
    zoom: number;
    dimmed: boolean;
}
export declare const GraphEdge: React.FC<Props>;
/** SVG <defs> block with arrowhead markers. Render once inside the SVG. */
export declare const GraphEdgeDefs: React.FC;
export {};
//# sourceMappingURL=GraphEdge.d.ts.map
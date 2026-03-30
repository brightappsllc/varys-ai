/**
 * Layout utilities for the Notebook Dependency Graph.
 * Dispatches dagre layout to a Web Worker; falls back to main-thread if unavailable.
 */
import type { GraphData, LayoutResult } from './graphTypes';
export declare function computeLayoutSync(data: GraphData): LayoutResult;
export declare function computeLayout(data: GraphData): Promise<LayoutResult>;
//# sourceMappingURL=graphUtils.d.ts.map
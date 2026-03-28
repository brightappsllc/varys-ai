/**
 * Hook: fetches graph data from /varys/graph and manages layout computation.
 */
import { INotebookTracker } from '@jupyterlab/notebook';
import type { GraphData, LayoutResult } from './graphTypes';
export interface GraphState {
    data: GraphData | null;
    layout: LayoutResult | null;
    loading: boolean;
    error: string | null;
    refresh: () => void;
}
export declare function useGraphData(tracker: INotebookTracker): GraphState;
//# sourceMappingURL=useGraphData.d.ts.map
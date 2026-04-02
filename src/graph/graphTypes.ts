/**
 * Shared TypeScript types for the Notebook Dependency Graph.
 * These mirror the Python dataclasses in varys/graph/builder.py.
 */

export type AnomalyId =
  | 'SKIP_LINK'
  | 'DEAD_SYMBOL'
  | 'OUT_OF_ORDER'
  | 'UNEXECUTED_IN_CHAIN';

export type DataSource = 'store' | 'ast';
export type NodeRole  = 'defines' | 'redefines' | 'consumes' | 'empty';
export type EdgeType  = 'dependency' | 'redefines' | 'reimport';

export interface NodeData {
  cellUuid:       string;
  cellIndex:      number;
  label:          string;
  sublabel:       string;
  unexecuted:     boolean;
  dataSource:     DataSource;
  defines:        string[];
  loads:          string[];
  externalLoads:  string[];
  executionCount: number | null;
  anomalies:      AnomalyId[];
  nodeRole:       NodeRole;
}

export interface EdgeData {
  sourceUuid: string;
  targetUuid: string;
  symbol:     string;
  anomaly:    'SKIP_LINK' | 'OUT_OF_ORDER' | null;
  edgeType:   EdgeType;
}

export interface GraphData {
  notebookPath: string;
  computedAt:   number;
  nodes:        NodeData[];
  edges:        EdgeData[];
}

/** Node position produced by dagre layout */
export interface NodeLayout {
  cellUuid: string;
  x:        number;   // center x
  y:        number;   // center y
  width:    number;
  height:   number;
}

/** Edge waypoints produced by dagre layout */
export interface EdgeLayout {
  sourceUuid: string;
  targetUuid: string;
  symbol:     string;
  points:     Array<{ x: number; y: number }>;
}

export interface LayoutResult {
  nodes:        NodeLayout[];
  edges:        EdgeLayout[];
  graphWidth:   number;
  graphHeight:  number;
}

/** Message types for the dagre Web Worker */
export interface WorkerRequest {
  type:  'layout';
  data:  GraphData;
}

export interface WorkerResponse {
  type:   'layout';
  result: LayoutResult;
}

export const NODE_WIDTH  = 180;
export const NODE_HEIGHT = 64;

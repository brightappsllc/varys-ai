/**
 * Hook: fetches graph data from /varys/graph and manages layout computation.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { INotebookTracker } from '@jupyterlab/notebook';
import type { GraphData, LayoutResult } from './graphTypes';
import { computeLayout } from './graphUtils';

function getXsrf(): string {
  const m = document.cookie.match(/(?:^|;)\s*_xsrf=([^;]*)/);
  return m ? decodeURIComponent(m[1]) : '';
}

function buildCellsPayload(tracker: INotebookTracker): {
  notebookPath: string;
  cells: Array<{ cell_id: string; index: number; source: string }>;
} | null {
  const panel = tracker.currentWidget;
  if (!panel) return null;

  const notebookPath = panel.context.path;
  const cells: Array<{ cell_id: string; index: number; source: string }> = [];

  panel.content.widgets.forEach((cell, idx) => {
    if (cell.model.type !== 'code') return;
    const source = cell.model.sharedModel.getSource();
    // Empty cells are excluded: they carry no symbol information and would
    // never form edges, so they cannot trigger UNEXECUTED_IN_CHAIN either.
    // The backend applies the same guard as a defense-in-depth measure.
    if (!source.trim()) return;
    const cellId: string =
      (cell.model as any).id ??
      (cell.model as any).sharedModel?.id ??
      '';
    if (!cellId) return;
    cells.push({
      cell_id: cellId,
      index:   idx,
      source,
    });
  });

  return { notebookPath, cells };
}

export interface GraphState {
  data:     GraphData | null;
  layout:   LayoutResult | null;
  loading:  boolean;
  error:    string | null;
  refresh:  () => void;
}

export function useGraphData(tracker: INotebookTracker): GraphState {
  const [data,    setData]    = useState<GraphData | null>(null);
  const [layout,  setLayout]  = useState<LayoutResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState<string | null>(null);
  const fetchIdRef = useRef(0);

  const fetchGraph = useCallback(async () => {
    const payload = buildCellsPayload(tracker);
    if (!payload) {
      setData(null);
      setLayout(null);
      setLoading(false);
      setError(null);
      return;
    }

    const thisId = ++fetchIdRef.current;
    setLoading(true);
    setError(null);

    try {
      const resp = await fetch('/varys/graph', {
        method:      'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
          'X-XSRFToken':  getXsrf(),
        },
        body: JSON.stringify(payload),
      });

      if (thisId !== fetchIdRef.current) return;

      if (!resp.ok) {
        throw new Error(`Server error ${resp.status}`);
      }

      const graphData: GraphData = await resp.json();
      if (thisId !== fetchIdRef.current) return;

      setData(graphData);

      // Run dagre layout (async, worker when available)
      const layoutResult = await computeLayout(graphData);
      if (thisId !== fetchIdRef.current) return;
      setLayout(layoutResult);
    } catch (err: unknown) {
      if (thisId !== fetchIdRef.current) return;
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      if (thisId === fetchIdRef.current) {
        setLoading(false);
      }
    }
  }, [tracker]);

  // Fetch on mount and when active notebook changes
  useEffect(() => {
    void fetchGraph();

    const handler = () => { void fetchGraph(); };
    tracker.currentChanged.connect(handler);
    return () => { tracker.currentChanged.disconnect(handler); };
  }, [fetchGraph, tracker]);

  return { data, layout, loading, error, refresh: fetchGraph };
}

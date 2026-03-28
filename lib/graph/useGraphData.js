/**
 * Hook: fetches graph data from /varys/graph and manages layout computation.
 */
import { useState, useEffect, useCallback, useRef } from 'react';
import { computeLayout } from './graphUtils';
function getXsrf() {
    const m = document.cookie.match(/(?:^|;)\s*_xsrf=([^;]*)/);
    return m ? decodeURIComponent(m[1]) : '';
}
function buildCellsPayload(tracker) {
    const panel = tracker.currentWidget;
    if (!panel)
        return null;
    const notebookPath = panel.context.path;
    const cells = [];
    panel.content.widgets.forEach((cell, idx) => {
        var _a, _b, _c;
        if (cell.model.type !== 'code')
            return;
        const source = cell.model.sharedModel.getSource();
        if (!source.trim())
            return; // skip empty cells
        const cellId = (_c = (_a = cell.model.id) !== null && _a !== void 0 ? _a : (_b = cell.model.sharedModel) === null || _b === void 0 ? void 0 : _b.id) !== null && _c !== void 0 ? _c : '';
        if (!cellId)
            return;
        cells.push({
            cell_id: cellId,
            index: idx,
            source,
        });
    });
    return { notebookPath, cells };
}
export function useGraphData(tracker) {
    const [data, setData] = useState(null);
    const [layout, setLayout] = useState(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);
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
                method: 'POST',
                credentials: 'same-origin',
                headers: {
                    'Content-Type': 'application/json',
                    'X-XSRFToken': getXsrf(),
                },
                body: JSON.stringify(payload),
            });
            if (thisId !== fetchIdRef.current)
                return;
            if (!resp.ok) {
                throw new Error(`Server error ${resp.status}`);
            }
            const graphData = await resp.json();
            if (thisId !== fetchIdRef.current)
                return;
            setData(graphData);
            // Run dagre layout (async, worker when available)
            const layoutResult = await computeLayout(graphData);
            if (thisId !== fetchIdRef.current)
                return;
            setLayout(layoutResult);
        }
        catch (err) {
            if (thisId !== fetchIdRef.current)
                return;
            setError(err instanceof Error ? err.message : 'Unknown error');
        }
        finally {
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

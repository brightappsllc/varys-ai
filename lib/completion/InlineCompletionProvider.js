/**
 * DSAssistantInlineProvider — implements JupyterLab's IInlineCompletionProvider
 * interface so JupyterLab handles all ghost text rendering, debouncing,
 * Tab/Esc/Alt+Right keyboard shortcuts, and settings UI natively.
 */
import { NotebookPanel } from '@jupyterlab/notebook';
export class DSAssistantInlineProvider {
    constructor(apiClient, tracker) {
        this.name = 'Varys';
        this.identifier = 'varys-inline';
        /**
         * Schema contributed to JupyterLab's Inline Completer settings panel.
         * Only the toggle is exposed here — model selection is done in .env.
         */
        this.schema = {
            type: 'object',
            properties: {
                enabled: {
                    title: 'Enable Varys Inline Completion',
                    description: 'Show ghost-text suggestions as you type. ' +
                        'Model and provider are configured in .env.',
                    type: 'boolean',
                    default: true
                }
            }
        };
        this._enabled = true;
        this._apiClient = apiClient;
        this._tracker = tracker;
    }
    /** Called by JupyterLab when user changes settings for this provider. */
    configure(settings) {
        var _a;
        this._enabled = (_a = settings['enabled']) !== null && _a !== void 0 ? _a : true;
    }
    /**
     * Main entry point called by JupyterLab on each inline completion request.
     *
     * JupyterLab already handles:
     *  - Debouncing (configurable via Inline Completer settings, default 200ms)
     *  - Ghost text rendering
     *  - Tab / Esc / Alt+Right keyboard shortcuts
     *  - Cancellation of in-flight requests when user keeps typing
     */
    async fetch(request, context) {
        const empty = { items: [] };
        if (!this._enabled) {
            return empty;
        }
        const prefix = request.text.slice(0, request.offset);
        const suffix = request.text.slice(request.offset);
        // Skip trivially short prefixes to avoid noisy requests
        if (prefix.replace(/\s+$/, '').length < 2) {
            return empty;
        }
        // Map JupyterLab mimeType to a language hint for the backend
        const language = request.mimeType === 'text/x-python'
            ? 'python'
            : request.mimeType === 'text/x-r-source'
                ? 'r'
                : request.mimeType === 'text/x-julia'
                    ? 'julia'
                    : 'python';
        const previousCells = this._gatherPreviousCells(context);
        try {
            const result = await this._apiClient.fetchCompletion({
                prefix,
                suffix,
                language,
                previousCells,
            });
            if (!result.suggestion) {
                return empty;
            }
            return { items: [{ insertText: result.suggestion }] };
        }
        catch (err) {
            console.error('[DSAssistant] completion fetch error:', err);
            return empty;
        }
    }
    /** Collect the last 5 cells before the active one for context. */
    _gatherPreviousCells(context) {
        const widget = context.widget;
        if (!(widget instanceof NotebookPanel)) {
            // Fall back to tracker's current widget
            const panel = this._tracker.currentWidget;
            if (!panel) {
                return [];
            }
            return this._extractCells(panel);
        }
        return this._extractCells(widget);
    }
    _extractCells(panel) {
        const notebook = panel.content;
        const active = notebook.activeCellIndex;
        const start = Math.max(0, active - 5);
        const cells = [];
        for (let i = start; i < active; i++) {
            const cell = notebook.widgets[i];
            if (cell) {
                cells.push({
                    index: i,
                    type: cell.model.type,
                    source: cell.model.sharedModel.getSource()
                });
            }
        }
        return cells;
    }
}

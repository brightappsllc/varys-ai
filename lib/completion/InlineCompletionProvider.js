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
        // ── Stale-completion guard (workaround for jupyterlab/jupyterlab `RangeError:
        //    Invalid line number N in K-line document` race) ──────────────────────
        // When the user edits a cell while a completion request is in flight, the
        // cached response can later be rendered against a now-shorter document and
        // crash JL's inline completer.  We can't fix JL's renderer from here, but we
        // can prevent stale suggestions from ever reaching it: cancel the in-flight
        // request the moment the active cell's content changes, and re-validate the
        // prefix before returning a result.
        this._inFlight = null;
        this._watchedCell = null;
        this._apiClient = apiClient;
        this._tracker = tracker;
        tracker.activeCellChanged.connect(this._onActiveCellChanged, this);
        this._onActiveCellChanged(tracker, tracker.activeCell);
    }
    /**
     * Re-wire the cell-content listener whenever the active cell changes so we
     * always cancel the right cell's in-flight completion on edit.
     *
     * Optional-chain every dereference: when this fires after a notebook close
     * → open sequence, the previously-watched cell may already be disposed and
     * its `.model` set to null.  Lumino signals auto-disconnect on dispose, so
     * skipping the explicit disconnect in that case is safe.
     */
    _onActiveCellChanged(_, cell) {
        var _a, _b, _c, _d, _e, _f, _g;
        (_d = (_c = (_b = (_a = this._watchedCell) === null || _a === void 0 ? void 0 : _a.model) === null || _b === void 0 ? void 0 : _b.sharedModel) === null || _c === void 0 ? void 0 : _c.changed) === null || _d === void 0 ? void 0 : _d.disconnect(this._onCellContentChanged, this);
        this._watchedCell = cell;
        (_g = (_f = (_e = cell === null || cell === void 0 ? void 0 : cell.model) === null || _e === void 0 ? void 0 : _e.sharedModel) === null || _f === void 0 ? void 0 : _f.changed) === null || _g === void 0 ? void 0 : _g.connect(this._onCellContentChanged, this);
    }
    /**
     * The active cell's content changed.  If a completion request is in flight,
     * abort it so JL never gets a suggestion to render against the mutated doc.
     */
    _onCellContentChanged() {
        if (this._inFlight) {
            this._inFlight.abort();
            this._inFlight = null;
        }
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
        var _a, _b, _c;
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
        // Cancel any previous in-flight completion (covers the rapid-typing case;
        // the active-cell signal handler covers cell-structure edits).
        if (this._inFlight) {
            this._inFlight.abort();
        }
        const ctrl = new AbortController();
        this._inFlight = ctrl;
        try {
            const result = await this._apiClient.fetchCompletion({
                prefix,
                suffix,
                language,
                previousCells,
            }, ctrl.signal);
            // Clear in-flight pointer only if we're still the latest request.
            if (this._inFlight === ctrl) {
                this._inFlight = null;
            }
            if (!result.suggestion) {
                return empty;
            }
            // Belt-and-suspenders: verify the active cell still has the prefix we
            // computed against.  Catches the millisecond between fetch resolution
            // and abort handler, plus active-cell switches mid-request.  Optional
            // chain in case the active cell was disposed during the await (e.g.
            // notebook closed mid-request).
            const currentText = (_c = (_b = (_a = this._tracker.activeCell) === null || _a === void 0 ? void 0 : _a.model) === null || _b === void 0 ? void 0 : _b.sharedModel) === null || _c === void 0 ? void 0 : _c.getSource();
            if (currentText !== undefined && !currentText.startsWith(prefix)) {
                return empty;
            }
            return { items: [{ insertText: result.suggestion }] };
        }
        catch (err) {
            if (this._inFlight === ctrl) {
                this._inFlight = null;
            }
            // AbortError fires when the user edited mid-request — that's the
            // intended outcome of this workaround, not an error worth logging.
            if ((err === null || err === void 0 ? void 0 : err.name) === 'AbortError') {
                return empty;
            }
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
        var _a, _b;
        const notebook = panel.content;
        const active = notebook.activeCellIndex;
        const start = Math.max(0, active - 5);
        const cells = [];
        for (let i = start; i < active; i++) {
            const cell = notebook.widgets[i];
            const source = (_b = (_a = cell === null || cell === void 0 ? void 0 : cell.model) === null || _a === void 0 ? void 0 : _a.sharedModel) === null || _b === void 0 ? void 0 : _b.getSource();
            if (cell && source !== undefined) {
                cells.push({
                    index: i,
                    type: cell.model.type,
                    source
                });
            }
        }
        return cells;
    }
}

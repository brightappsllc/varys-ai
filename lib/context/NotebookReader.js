/**
 * NotebookReader - Extracts full context from the active JupyterLab notebook.
 */
/**
 * Maximum characters captured from each cell's output before truncation.
 * Must match CELL_CONTENT_LIMIT in varys/llm/context_utils.py
 * so the backend and frontend agree on the same cap.
 */
const CELL_OUTPUT_MAX_CHARS = 2000;
export class NotebookReader {
    constructor(tracker) {
        this.tracker = tracker;
    }
    /**
     * Returns the full context of the currently active notebook.
     * Returns null if no notebook is open.
     */
    getFullContext() {
        const panel = this.tracker.currentWidget;
        if (!panel) {
            return null;
        }
        return this._extractContext(panel);
    }
    _extractContext(panel) {
        var _a, _b, _c, _d, _e, _f;
        const notebook = panel.content;
        const activeCellIndex = notebook.activeCellIndex;
        const cells = [];
        notebook.widgets.forEach((cell, index) => {
            var _a, _b, _c, _d;
            const model = cell.model;
            // model.id is the stable nbformat cell_id UUID (assigned by JupyterLab,
            // survives cell moves and insertions — changes only on explicit cell delete+recreate).
            const cellId = (_c = (_a = model.id) !== null && _a !== void 0 ? _a : (_b = model.sharedModel) === null || _b === void 0 ? void 0 : _b.id) !== null && _c !== void 0 ? _c : undefined;
            const imgInfo = model.type === 'code' ? this._extractImage(model) : null;
            cells.push({
                index,
                type: model.type,
                source: model.sharedModel.getSource(),
                executionCount: model.type === 'code'
                    ? (_d = model.executionCount) !== null && _d !== void 0 ? _d : null
                    : null,
                output: model.type === 'code' ? this._extractOutput(model) : null,
                imageOutput: imgInfo ? imgInfo.data : null,
                imageOutputMime: imgInfo ? imgInfo.mime : null,
                cellId,
            });
        });
        // Stable UUID of the currently focused cell (for Smart Cell Context focal
        // cell detection).  Sent alongside activeCellIndex for backward compat.
        const activeCell = notebook.activeCell;
        const activeCellId = activeCell
            ? ((_c = (_a = activeCell.model.id) !== null && _a !== void 0 ? _a : (_b = activeCell.model.sharedModel) === null || _b === void 0 ? void 0 : _b.id) !== null && _c !== void 0 ? _c : undefined)
            : undefined;
        // Full (untruncated) output of the active/focal cell.  The backend uses
        // this verbatim for the focal cell instead of the stored 1 000-char summary.
        const focalCellOutput = activeCell && activeCell.model.type === 'code'
            ? this._extractFullOutput(activeCell.model)
            : null;
        return {
            cells,
            activeCellIndex,
            activeCellId,
            focalCellOutput,
            notebookPath: panel.context.path,
            kernelName: (_f = (_e = (_d = panel.sessionContext.session) === null || _d === void 0 ? void 0 : _d.kernel) === null || _e === void 0 ? void 0 : _e.name) !== null && _f !== void 0 ? _f : undefined,
            selection: this._getSelection(panel)
        };
    }
    /**
     * Returns the text currently selected by the user in the active code cell,
     * or null when there is no meaningful selection (cursor only / empty).
     */
    _getSelection(panel) {
        const notebook = panel.content;
        const activeCell = notebook.activeCell;
        if (!activeCell) {
            return null;
        }
        const editor = activeCell.editor;
        if (!editor) {
            return null;
        }
        const selection = editor.getSelection();
        const { start, end } = selection;
        // A cursor position (no text selected) has start === end
        if (start.line === end.line && start.column === end.column) {
            return null;
        }
        const source = activeCell.model.sharedModel.getSource();
        const lines = source.split('\n');
        // Extract the selected lines (inclusive)
        const selectedLines = lines.slice(start.line, end.line + 1);
        // Trim partial first/last lines to the exact column boundaries
        if (selectedLines.length > 0) {
            selectedLines[selectedLines.length - 1] = selectedLines[selectedLines.length - 1].slice(0, end.column);
            selectedLines[0] = selectedLines[0].slice(start.column);
        }
        const text = selectedLines.join('\n');
        if (!text.trim()) {
            return null;
        }
        return {
            cellIndex: notebook.activeCellIndex,
            text,
            startLine: start.line,
            endLine: end.line
        };
    }
    /**
     * Extracts a full (untruncated) plain-text representation of a code cell's
     * outputs.  Used for the focal cell's focalCellOutput payload field — the
     * backend assembler injects this verbatim rather than the stored summary.
     */
    _extractFullOutput(model) {
        return this._extractOutputImpl(model, false);
    }
    /**
     * Extracts a plain-text representation of a code cell's outputs.
     * Handles: execute_result, display_data, stream (stdout/stderr), error.
     * Caps at 2000 chars to keep context size reasonable.
     */
    _extractOutput(model) {
        return this._extractOutputImpl(model, true);
    }
    _extractOutputImpl(model, applyCapLimit) {
        var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o, _p;
        const outputs = model.outputs;
        if (!outputs || outputs.length === 0) {
            return null;
        }
        // Non-error outputs and error outputs are budgeted separately so a
        // long traceback is never silently dropped when stdout fills the limit.
        const regularParts = [];
        const errorParts = [];
        for (let i = 0; i < outputs.length; i++) {
            const output = outputs.get ? outputs.get(i) : outputs[i];
            if (!output)
                continue;
            // JupyterLab wraps raw nbformat dicts in IOutputModel objects.
            // ename / evalue / traceback are NOT direct properties on the model —
            // toJSON() returns the underlying nbformat dict with all fields intact.
            const raw = typeof output.toJSON === 'function' ? output.toJSON() : output;
            const outputType = (_d = (_c = (_b = (_a = raw.output_type) !== null && _a !== void 0 ? _a : raw.type) !== null && _b !== void 0 ? _b : output.output_type) !== null && _c !== void 0 ? _c : output.type) !== null && _d !== void 0 ? _d : '';
            if (outputType === 'stream') {
                const text = (_f = (_e = raw.text) !== null && _e !== void 0 ? _e : output.text) !== null && _f !== void 0 ? _f : '';
                const content = Array.isArray(text) ? text.join('') : String(text);
                if (content.trim())
                    regularParts.push(content.trim());
            }
            else if (outputType === 'execute_result' || outputType === 'display_data') {
                const data = (_h = (_g = raw.data) !== null && _g !== void 0 ? _g : output.data) !== null && _h !== void 0 ? _h : {};
                const plain = (_j = data['text/plain']) !== null && _j !== void 0 ? _j : '';
                const content = Array.isArray(plain) ? plain.join('') : String(plain);
                if (content.trim())
                    regularParts.push(content.trim());
            }
            else if (outputType === 'error') {
                const ename = (_l = (_k = raw.ename) !== null && _k !== void 0 ? _k : output.ename) !== null && _l !== void 0 ? _l : 'Error';
                const evalue = (_o = (_m = raw.evalue) !== null && _m !== void 0 ? _m : output.evalue) !== null && _o !== void 0 ? _o : '';
                const rawTb = (_p = raw.traceback) !== null && _p !== void 0 ? _p : output.traceback;
                if (rawTb && Array.isArray(rawTb) && rawTb.length > 0) {
                    // eslint-disable-next-line no-control-regex
                    const tbClean = rawTb.join('\n').replace(/\x1b\[[0-9;]*m/g, '');
                    errorParts.push(`${ename}: ${evalue}\n${tbClean}`);
                }
                else {
                    errorParts.push(`${ename}: ${evalue}`);
                }
            }
        }
        if (regularParts.length === 0 && errorParts.length === 0)
            return null;
        const regularText = regularParts.join('\n');
        const errorText = errorParts.join('\n');
        const cappedRegular = (applyCapLimit && regularText.length > CELL_OUTPUT_MAX_CHARS)
            ? regularText.slice(0, CELL_OUTPUT_MAX_CHARS) + '\n[...output truncated]'
            : regularText;
        const cappedError = (applyCapLimit && errorText.length > CELL_OUTPUT_MAX_CHARS)
            ? errorText.slice(0, CELL_OUTPUT_MAX_CHARS) + '\n[...traceback truncated]'
            : errorText;
        const hasRegular = cappedRegular.trim().length > 0;
        const hasError = cappedError.trim().length > 0;
        // When both regular output and error exist, label them as separate indexed
        // objects so the LLM can reference each independently:
        //   [1] = stdout / execute_result (the short result line)
        //   [2] = error traceback (the detailed exception, usually the most important)
        if (hasRegular && hasError) {
            return `[1]\n${cappedRegular.trim()}\n\n[2]\n${cappedError.trim()}`;
        }
        if (hasError) {
            // Error only — still label it [1] so the LLM knows it's an indexed object
            return `[1]\n${cappedError.trim()}`;
        }
        return cappedRegular.trim() || null;
    }
    /**
     * Extracts the first image/png output from a code cell, returned as a
     * base64 string (no data-URI prefix).  Returns null if no image present.
     */
    _extractImage(model) {
        var _a;
        const outputs = model.outputs;
        if (!outputs || outputs.length === 0)
            return null;
        // Preferred formats in order: PNG is lossless and most common for plots;
        // JPEG and WEBP are also supported by both Anthropic and OpenAI vision APIs.
        const IMAGE_MIMES = [
            'image/png',
            'image/jpeg',
            'image/webp',
            'image/gif',
        ];
        for (let i = 0; i < outputs.length; i++) {
            const output = outputs.get ? outputs.get(i) : outputs[i];
            if (!output)
                continue;
            const data = (_a = output.data) !== null && _a !== void 0 ? _a : {};
            for (const mime of IMAGE_MIMES) {
                const raw_val = data[mime];
                if (!raw_val)
                    continue;
                const raw = Array.isArray(raw_val) ? raw_val.join('') : String(raw_val);
                // Strip any data-URI prefix (data:image/png;base64,...) before storing
                return { data: raw.replace(/^data:[^;]+;base64,/, '').trim(), mime };
            }
        }
        return null;
    }
    /**
     * Returns a single cell by index, or null if out of bounds.
     */
    getCell(index) {
        var _a;
        const context = this.getFullContext();
        if (!context) {
            return null;
        }
        return (_a = context.cells[index]) !== null && _a !== void 0 ? _a : null;
    }
    /**
     * Returns an inclusive slice of cells from start to end.
     */
    getCellRange(start, end) {
        const context = this.getFullContext();
        if (!context) {
            return [];
        }
        return context.cells.slice(start, end + 1);
    }
    /**
     * Finds cells whose source matches the given regex pattern.
     */
    findCells(pattern) {
        const context = this.getFullContext();
        if (!context) {
            return [];
        }
        return context.cells.filter(cell => pattern.test(cell.source));
    }
    /**
     * Returns the index of the currently active cell in the notebook.
     */
    getCurrentCellIndex() {
        const panel = this.tracker.currentWidget;
        if (!panel) {
            return 0;
        }
        return panel.content.activeCellIndex;
    }
}

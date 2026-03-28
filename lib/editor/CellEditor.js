/**
 * CellEditor - Inserts, modifies, deletes, highlights, and executes notebook cells.
 */
import { NotebookActions } from '@jupyterlab/notebook';
export class CellEditor {
    constructor(tracker) {
        this.pendingOperations = new Map();
        this.highlightedCells = new Set();
        this.tracker = tracker;
    }
    /**
     * Applies a list of operation steps to the notebook, tracks the operation
     * for undo, and highlights the affected cells.
     *
     * Returns an ApplyResult with:
     *  - stepIndexMap: step array index → actual notebook cell index
     *  - capturedOriginals: step array index → original source (for diff view)
     *
     * Steps are applied in safe order (modifies first, then inserts ascending,
     * then deletes descending) to prevent index-shift errors.
     */
    /**
     * Rearranges notebook cells so they appear in the order specified by
     * newOrderIds (array of short cell IDs, i.e. the [id:XXXXXXXX] tag values).
     *
     * Uses a selection-sort approach: for each target position, finds the cell
     * with the matching ID and moves it there via the observable cells list.
     * Returns the original cell ID sequence so the operation can be undone.
     */
    /**
     * Returns the short cell ID (first 8 chars of the UUID, matching the
     * [id:XXXXXXXX] tag the assembler injects into the LLM context).
     */
    _shortId(cell) {
        var _a, _b, _c;
        const fullId = (_c = (_a = cell.model.id) !== null && _a !== void 0 ? _a : (_b = cell.model.sharedModel) === null || _b === void 0 ? void 0 : _b.id) !== null && _c !== void 0 ? _c : '';
        // UUID format: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx — first segment is 8 hex chars
        return fullId.slice(0, 8);
    }
    async reorderCells(newOrderIds) {
        var _a;
        const panel = this.tracker.currentWidget;
        if (!panel)
            return [];
        const notebook = panel.content;
        // Capture original order (as short IDs) for undo
        const originalOrder = notebook.widgets.map(c => this._shortId(c));
        const cells = (_a = notebook.model) === null || _a === void 0 ? void 0 : _a.cells;
        if (!cells || typeof cells.move !== 'function') {
            console.warn('[DSAssistant] reorderCells: cells.move not available');
            return originalOrder;
        }
        for (let targetPos = 0; targetPos < newOrderIds.length; targetPos++) {
            const targetId = newOrderIds[targetPos];
            // Search from targetPos onwards — everything before is already in place.
            // Match on short ID (8 chars) OR full UUID to handle both formats gracefully.
            let currentPos = -1;
            for (let j = targetPos; j < notebook.widgets.length; j++) {
                const shortId = this._shortId(notebook.widgets[j]);
                if (shortId === targetId || shortId.startsWith(targetId) || targetId.startsWith(shortId)) {
                    currentPos = j;
                    break;
                }
            }
            if (currentPos === -1 || currentPos === targetPos)
                continue;
            cells.move(currentPos, targetPos);
        }
        return originalOrder;
    }
    async applyOperations(operationId, steps) {
        var _a, _b, _c, _d;
        const stepIndexMap = new Map();
        /** Keyed by notebook cell index — used internally for undo */
        const originalContentsByNbIdx = new Map();
        /** Keyed by step array index — returned to caller for diff view */
        const capturedOriginals = new Map();
        // --- Reorder (handled atomically — no further steps allowed in same plan) ---
        const reorderStep = steps.find(s => s.type === 'reorder');
        if (reorderStep) {
            const originalOrder = await this.reorderCells((_a = reorderStep.newOrder) !== null && _a !== void 0 ? _a : []);
            this.pendingOperations.set(operationId, {
                operationId,
                cellIndices: [],
                originalContents: new Map(),
                originalOrder,
            });
            return { stepIndexMap, capturedOriginals };
        }
        // --- Modifications (no index shifting) ---
        for (let i = 0; i < steps.length; i++) {
            const step = steps[i];
            if (step.type !== 'modify')
                continue;
            const original = this.getCellSource(step.cellIndex);
            if (original !== null) {
                originalContentsByNbIdx.set(step.cellIndex, original);
                capturedOriginals.set(i, original);
            }
            this.updateCell(step.cellIndex, (_b = step.content) !== null && _b !== void 0 ? _b : '');
            stepIndexMap.set(i, step.cellIndex);
        }
        // --- Inserts (ascending order to keep index arithmetic correct) ---
        const insertPairs = steps
            .map((s, i) => ({ step: s, originalIdx: i }))
            .filter(p => p.step.type === 'insert')
            .sort((a, b) => a.step.cellIndex - b.step.cellIndex);
        for (const { step, originalIdx } of insertPairs) {
            const notebookIdx = await this.insertCell(step.cellIndex, (_c = step.cellType) !== null && _c !== void 0 ? _c : 'code', (_d = step.content) !== null && _d !== void 0 ? _d : '');
            stepIndexMap.set(originalIdx, notebookIdx);
            // Inserts have no original content — capturedOriginals entry omitted (treated as '')
        }
        // --- Deletes (descending order to avoid index shifting) ---
        //     Capture content BEFORE deleting so the diff view can show what was removed.
        const deletePairs = steps
            .map((s, i) => ({ step: s, originalIdx: i }))
            .filter(p => p.step.type === 'delete')
            .sort((a, b) => b.step.cellIndex - a.step.cellIndex);
        for (const { step, originalIdx } of deletePairs) {
            const original = this.getCellSource(step.cellIndex);
            if (original !== null) {
                capturedOriginals.set(originalIdx, original);
                // Deleted cells cannot be restored by notebook index (they're gone), so we
                // store under the step index in originalContentsByNbIdx for undo to find them.
                originalContentsByNbIdx.set(step.cellIndex, original);
            }
            this.deleteCell(step.cellIndex);
            stepIndexMap.set(originalIdx, step.cellIndex);
        }
        // --- run_cell: record the index but don't modify the cell ---
        for (let i = 0; i < steps.length; i++) {
            if (steps[i].type === 'run_cell') {
                stepIndexMap.set(i, steps[i].cellIndex);
            }
        }
        // Collect all unique notebook indices that were changed (not deletes/run_cell)
        const affectedIndices = [];
        for (let i = 0; i < steps.length; i++) {
            const t = steps[i].type;
            if (t === 'insert' || t === 'modify') {
                const idx = stepIndexMap.get(i);
                if (idx !== undefined && !affectedIndices.includes(idx)) {
                    affectedIndices.push(idx);
                }
            }
        }
        // Record pending operation for undo support
        this.pendingOperations.set(operationId, {
            operationId,
            cellIndices: affectedIndices,
            originalContents: originalContentsByNbIdx
        });
        // Highlight cells that were inserted or modified
        for (const idx of affectedIndices) {
            this.highlightCell(idx);
        }
        return { stepIndexMap, capturedOriginals };
    }
    /**
     * Inserts a new cell of the given type at the specified position.
     * Returns the actual index the cell landed at.
     */
    async insertCell(index, type, content) {
        const panel = this.tracker.currentWidget;
        if (!panel) {
            throw new Error('No active notebook');
        }
        const notebook = panel.content;
        const totalCells = notebook.widgets.length;
        // When inserting at 0 into a non-empty notebook use insertAbove on cell 0,
        // otherwise insertBelow on the cell just before the target index.
        if (totalCells === 0) {
            // Notebook is empty: insert below will create first cell
            NotebookActions.insertBelow(notebook);
        }
        else if (index <= 0) {
            notebook.activeCellIndex = 0;
            NotebookActions.insertAbove(notebook);
        }
        else {
            notebook.activeCellIndex = Math.min(index - 1, totalCells - 1);
            NotebookActions.insertBelow(notebook);
        }
        // Change type if needed (default is code)
        if (type === 'markdown') {
            NotebookActions.changeCellType(notebook, 'markdown');
        }
        const newIndex = notebook.activeCellIndex;
        const cell = notebook.activeCell;
        if (cell) {
            cell.model.sharedModel.setSource(content);
        }
        return newIndex;
    }
    /**
     * Overwrites the source of an existing cell at the given index.
     */
    updateCell(index, content) {
        const panel = this.tracker.currentWidget;
        if (!panel) {
            return;
        }
        const cell = panel.content.widgets[index];
        if (cell) {
            cell.model.sharedModel.setSource(content);
        }
    }
    /**
     * Deletes the cell at the given index.
     */
    deleteCell(index) {
        const panel = this.tracker.currentWidget;
        if (!panel) {
            return;
        }
        const notebook = panel.content;
        notebook.activeCellIndex = index;
        NotebookActions.deleteCells(notebook);
    }
    /**
     * Returns the source text of a cell, or null if the index is invalid.
     */
    getCellSource(index) {
        const panel = this.tracker.currentWidget;
        if (!panel) {
            return null;
        }
        const cell = panel.content.widgets[index];
        return cell ? cell.model.sharedModel.getSource() : null;
    }
    /**
     * Executes the cell at the given index using NotebookActions.run(),
     * which is the proper JupyterLab path and correctly updates the
     * execution count display ([N]) in the notebook gutter.
     */
    async executeCell(index) {
        const panel = this.tracker.currentWidget;
        if (!panel) {
            return;
        }
        const notebook = panel.content;
        const sessionContext = panel.sessionContext;
        // Make the target cell active so NotebookActions.run operates on it
        notebook.activeCellIndex = index;
        // NotebookActions.run returns a Promise<boolean> — await it so callers
        // can sequence multiple executions without race conditions.
        await NotebookActions.run(notebook, sessionContext);
    }
    /**
     * Adds the pending-highlight CSS class to a cell node.
     */
    highlightCell(index) {
        const panel = this.tracker.currentWidget;
        if (!panel) {
            return;
        }
        const cell = panel.content.widgets[index];
        if (cell) {
            cell.node.classList.add('ds-assistant-pending');
            this.highlightedCells.add(index);
        }
    }
    /**
     * Removes the pending-highlight CSS class from cells.
     * Clears all highlighted cells when no indices are provided.
     */
    clearHighlighting(indices) {
        const panel = this.tracker.currentWidget;
        if (!panel) {
            return;
        }
        const toClear = indices !== null && indices !== void 0 ? indices : Array.from(this.highlightedCells);
        for (const idx of toClear) {
            const cell = panel.content.widgets[idx];
            if (cell) {
                cell.node.classList.remove('ds-assistant-pending');
            }
            this.highlightedCells.delete(idx);
        }
    }
    /**
     * Applies per-hunk decisions for a pending operation.
     *
     * For 'modify' cells: if the caller computed a partial finalContent from
     *   reconstructFromHunks, that content is written to the cell.  If
     *   finalContent is undefined the cell already holds the correct LLM content
     *   (all hunks were accepted) — no write needed.
     *
     * For 'insert' cells: if decision.accept === false the inserted cell is
     *   deleted.  Otherwise it is kept as-is.
     *
     * For 'delete' cells: currently the cell is already gone in preview mode;
     *   if the user rejects the deletion we restore from originalContents and
     *   re-insert at the original index.
     *
     * Highlighting is cleared and the operation is removed from the pending map.
     */
    partialAcceptOperation(operationId, decisions) {
        const op = this.pendingOperations.get(operationId);
        if (!op)
            return;
        // Process decisions in reverse index order to avoid index shifting
        const sorted = [...decisions].sort((a, b) => b.cellIndex - a.cellIndex);
        for (const d of sorted) {
            if (d.opType === 'modify') {
                if (d.finalContent !== undefined) {
                    // Partial mix: write reconstructed content
                    this.updateCell(d.cellIndex, d.finalContent);
                }
                // If finalContent is undefined: all hunks accepted → cell is already correct
            }
            else if (d.opType === 'insert') {
                if (!d.accept) {
                    this.deleteCell(d.cellIndex);
                }
            }
            else if (d.opType === 'delete') {
                if (!d.accept) {
                    // Restore the original content.  The cell was deleted so we re-insert
                    // it at the original index.  originalContents is keyed by cell index.
                    const original = op.originalContents.get(d.cellIndex);
                    if (original !== undefined) {
                        // insertCell is async but we accept the fire-and-forget here since
                        // the index is known and no further operations depend on it.
                        void this.insertCell(d.cellIndex, 'code', original);
                    }
                }
            }
        }
        this.clearHighlighting(op.cellIndices);
        this.pendingOperations.delete(operationId);
    }
    /**
     * Marks an operation as accepted and clears its highlighting.
     */
    acceptOperation(operationId) {
        const op = this.pendingOperations.get(operationId);
        if (op) {
            this.clearHighlighting(op.cellIndices);
        }
        this.pendingOperations.delete(operationId);
    }
    /**
     * Reverses an operation: restores original content for modified cells,
     * deletes inserted cells, and clears highlighting.
     * For reorder operations, restores the original cell sequence.
     */
    undoOperation(operationId) {
        const op = this.pendingOperations.get(operationId);
        if (!op) {
            return;
        }
        if (op.originalOrder) {
            // Reorder undo: restore original cell sequence
            void this.reorderCells(op.originalOrder);
            this.pendingOperations.delete(operationId);
            return;
        }
        // Reverse order to handle index shifts correctly
        const reversedIndices = [...op.cellIndices].reverse();
        for (const idx of reversedIndices) {
            if (op.originalContents.has(idx)) {
                // Was a modify — restore original source
                this.updateCell(idx, op.originalContents.get(idx));
            }
            else {
                // Was an insert — delete the cell
                this.deleteCell(idx);
            }
        }
        this.clearHighlighting(op.cellIndices);
        this.pendingOperations.delete(operationId);
    }
}

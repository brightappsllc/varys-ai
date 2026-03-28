/**
 * CellEditor - Inserts, modifies, deletes, highlights, and executes notebook cells.
 */
import { INotebookTracker } from '@jupyterlab/notebook';
import { OperationStep } from '../api/client';
import type { CellDecision } from '../ui/DiffView';
export interface PendingOperation {
    operationId: string;
    cellIndices: number[];
    originalContents: Map<number, string>;
    /** Populated for reorder ops — used to restore original cell sequence on undo. */
    originalOrder?: string[];
}
export interface ApplyResult {
    /** Maps step array index → actual notebook cell index after apply */
    stepIndexMap: Map<number, number>;
    /**
     * Maps step array index → original cell source captured before the step ran.
     * Present for 'modify' and 'delete' steps; absent for 'insert'.
     */
    capturedOriginals: Map<number, string>;
}
export declare class CellEditor {
    private tracker;
    private pendingOperations;
    private highlightedCells;
    constructor(tracker: INotebookTracker);
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
    reorderCells(newOrderIds: string[]): Promise<string[]>;
    applyOperations(operationId: string, steps: OperationStep[]): Promise<ApplyResult>;
    /**
     * Inserts a new cell of the given type at the specified position.
     * Returns the actual index the cell landed at.
     */
    insertCell(index: number, type: 'code' | 'markdown', content: string): Promise<number>;
    /**
     * Overwrites the source of an existing cell at the given index.
     */
    updateCell(index: number, content: string): void;
    /**
     * Deletes the cell at the given index.
     */
    deleteCell(index: number): void;
    /**
     * Returns the source text of a cell, or null if the index is invalid.
     */
    getCellSource(index: number): string | null;
    /**
     * Executes the cell at the given index using NotebookActions.run(),
     * which is the proper JupyterLab path and correctly updates the
     * execution count display ([N]) in the notebook gutter.
     */
    executeCell(index: number): Promise<void>;
    /**
     * Adds the pending-highlight CSS class to a cell node.
     */
    highlightCell(index: number): void;
    /**
     * Removes the pending-highlight CSS class from cells.
     * Clears all highlighted cells when no indices are provided.
     */
    clearHighlighting(indices?: number[]): void;
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
    partialAcceptOperation(operationId: string, decisions: CellDecision[]): void;
    /**
     * Marks an operation as accepted and clears its highlighting.
     */
    acceptOperation(operationId: string): void;
    /**
     * Reverses an operation: restores original content for modified cells,
     * deletes inserted cells, and clears highlighting.
     * For reorder operations, restores the original cell sequence.
     */
    undoOperation(operationId: string): void;
}
//# sourceMappingURL=CellEditor.d.ts.map
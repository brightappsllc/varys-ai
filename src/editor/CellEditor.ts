/**
 * CellEditor - Inserts, modifies, deletes, highlights, and executes notebook cells.
 */

import { INotebookTracker } from '@jupyterlab/notebook';
import { NotebookActions } from '@jupyterlab/notebook';
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

export class CellEditor {
  private tracker: INotebookTracker;
  private pendingOperations: Map<string, PendingOperation> = new Map();
  private highlightedCells: Set<number> = new Set();

  constructor(tracker: INotebookTracker) {
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
  private _shortId(cell: any): string {
    const fullId: string = (cell.model as any).id ?? (cell.model as any).sharedModel?.id ?? '';
    // UUID format: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx — first segment is 8 hex chars
    return fullId.slice(0, 8);
  }

  /**
   * Rearranges notebook cells so they appear in the order specified by
   * newOrderIds (array of 8-char short cell IDs matching [id:XXXXXXXX] tags).
   *
   * Uses NotebookActions.moveUp / moveDown — the same actions JupyterLab
   * fires for the keyboard shortcuts Shift+K / Shift+J.  These are guaranteed
   * to work in all JupyterLab 4 versions.  A selection-sort pass positions
   * each target cell one step at a time; internal posMap tracking avoids
   * reading notebook.widgets after each step.
   *
   * Returns the original cell ID sequence so the operation can be undone.
   */
  async reorderCells(newOrderIds: string[]): Promise<string[]> {
    const panel = this.tracker.currentWidget;
    if (!panel) return [];

    const notebook = panel.content;
    const n = notebook.widgets.length;

    // Snapshot all short IDs upfront (before any moves)
    const originalOrder: string[] = [];
    for (let i = 0; i < n; i++) {
      originalOrder.push(this._shortId(notebook.widgets[i]));
    }

    // Internal tracking: currentOrder[pos] = shortId of the cell at position pos.
    // This is kept in sync manually after every moveUp / moveDown so we never
    // need to re-read notebook.widgets mid-sort.
    const currentOrder = [...originalOrder];
    const posMap = new Map<string, number>();
    for (let i = 0; i < currentOrder.length; i++) {
      posMap.set(currentOrder[i], i);
    }

    for (let targetPos = 0; targetPos < newOrderIds.length; targetPos++) {
      const targetId = newOrderIds[targetPos];
      let pos = posMap.get(targetId);
      if (pos === undefined || pos === targetPos) continue;

      // Place the target cell at its desired position by moving it one step
      // at a time.  NotebookActions.moveUp/moveDown operate on the active cell.
      notebook.activeCellIndex = pos;

      while (pos !== targetPos) {
        if (pos > targetPos) {
          // Move active cell one step toward the top
          NotebookActions.moveUp(notebook);

          // After moveUp: cell at pos ↔ cell at pos-1
          const displaced = currentOrder[pos - 1];
          currentOrder[pos - 1] = targetId;
          currentOrder[pos]     = displaced;
          posMap.set(targetId,   pos - 1);
          posMap.set(displaced,  pos);
          pos--;
        } else {
          // Move active cell one step toward the bottom
          NotebookActions.moveDown(notebook);

          // After moveDown: cell at pos ↔ cell at pos+1
          const displaced = currentOrder[pos + 1];
          currentOrder[pos + 1] = targetId;
          currentOrder[pos]     = displaced;
          posMap.set(targetId,   pos + 1);
          posMap.set(displaced,  pos);
          pos++;
        }
      }
    }

    return originalOrder;
  }

  async applyOperations(
    operationId: string,
    steps: OperationStep[]
  ): Promise<ApplyResult> {
    const stepIndexMap = new Map<number, number>();
    /** Keyed by notebook cell index — used internally for undo */
    const originalContentsByNbIdx = new Map<number, string>();
    /** Keyed by step array index — returned to caller for diff view */
    const capturedOriginals = new Map<number, string>();

    // --- Reorder (handled atomically — no further steps allowed in same plan) ---
    const reorderStep = steps.find(s => s.type === 'reorder');
    if (reorderStep) {
      const originalOrder = await this.reorderCells(reorderStep.newOrder ?? []);
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
      if (step.type !== 'modify') continue;
      const original = this.getCellSource(step.cellIndex);
      if (original !== null) {
        originalContentsByNbIdx.set(step.cellIndex, original);
        capturedOriginals.set(i, original);
      }
      this.updateCell(step.cellIndex, step.content ?? '');
      stepIndexMap.set(i, step.cellIndex);
    }

    // --- Inserts (ascending order to keep index arithmetic correct) ---
    const insertPairs = steps
      .map((s, i) => ({ step: s, originalIdx: i }))
      .filter(p => p.step.type === 'insert')
      .sort((a, b) => a.step.cellIndex - b.step.cellIndex);

    for (const { step, originalIdx } of insertPairs) {
      const notebookIdx = await this.insertCell(
        step.cellIndex,
        step.cellType ?? 'code',
        step.content ?? ''
      );
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
    const affectedIndices: number[] = [];
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
  async insertCell(
    index: number,
    type: 'code' | 'markdown',
    content: string
  ): Promise<number> {
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
    } else if (index <= 0) {
      notebook.activeCellIndex = 0;
      NotebookActions.insertAbove(notebook);
    } else {
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
  updateCell(index: number, content: string): void {
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
  deleteCell(index: number): void {
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
  getCellSource(index: number): string | null {
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
  async executeCell(index: number): Promise<void> {
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
   * Sends a kernel interrupt request.  Safe to call while a cell is running —
   * the kernel will raise KeyboardInterrupt in the running cell and become idle.
   * No-op if no kernel is attached.
   */
  async interruptKernel(): Promise<void> {
    const panel = this.tracker.currentWidget;
    if (!panel) return;
    const kernel = panel.sessionContext.session?.kernel;
    if (kernel) {
      try {
        await kernel.interrupt();
      } catch {
        // Interrupt errors (e.g. kernel already idle) are non-fatal.
      }
    }
  }

  /**
   * Adds the pending-highlight CSS class to a cell node.
   */
  highlightCell(index: number): void {
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
  clearHighlighting(indices?: number[]): void {
    const panel = this.tracker.currentWidget;
    if (!panel) {
      return;
    }

    const toClear = indices ?? Array.from(this.highlightedCells);
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
  partialAcceptOperation(operationId: string, decisions: CellDecision[]): void {
    const op = this.pendingOperations.get(operationId);
    if (!op) return;

    // Process decisions in reverse index order to avoid index shifting
    const sorted = [...decisions].sort((a, b) => b.cellIndex - a.cellIndex);

    for (const d of sorted) {
      if (d.opType === 'modify') {
        if (d.finalContent !== undefined) {
          // Partial mix: write reconstructed content
          this.updateCell(d.cellIndex, d.finalContent);
        }
        // If finalContent is undefined: all hunks accepted → cell is already correct
      } else if (d.opType === 'insert') {
        if (!d.accept) {
          this.deleteCell(d.cellIndex);
        }
      } else if (d.opType === 'delete') {
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
  acceptOperation(operationId: string): void {
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
  undoOperation(operationId: string): void {
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
        this.updateCell(idx, op.originalContents.get(idx)!);
      } else {
        // Was an insert — delete the cell
        this.deleteCell(idx);
      }
    }

    this.clearHighlighting(op.cellIndices);
    this.pendingOperations.delete(operationId);
  }
}

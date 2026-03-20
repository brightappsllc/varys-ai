/**
 * NotebookReader - Extracts full context from the active JupyterLab notebook.
 */
import { INotebookTracker } from '@jupyterlab/notebook';
import { CellInfo, NotebookContext } from '../api/client';
export declare class NotebookReader {
    private tracker;
    constructor(tracker: INotebookTracker);
    /**
     * Returns the full context of the currently active notebook.
     * Returns null if no notebook is open.
     */
    getFullContext(): NotebookContext | null;
    private _extractContext;
    /**
     * Returns the text currently selected by the user in the active code cell,
     * or null when there is no meaningful selection (cursor only / empty).
     */
    private _getSelection;
    /**
     * Extracts a full (untruncated) plain-text representation of a code cell's
     * outputs.  Used for the focal cell's focalCellOutput payload field — the
     * backend assembler injects this verbatim rather than the stored summary.
     */
    private _extractFullOutput;
    /**
     * Extracts a plain-text representation of a code cell's outputs.
     * Handles: execute_result, display_data, stream (stdout/stderr), error.
     * Caps at 2000 chars to keep context size reasonable.
     */
    private _extractOutput;
    private _extractOutputImpl;
    /**
     * Extracts the first image/png output from a code cell, returned as a
     * base64 string (no data-URI prefix).  Returns null if no image present.
     */
    private _extractImage;
    /**
     * Returns a single cell by index, or null if out of bounds.
     */
    getCell(index: number): CellInfo | null;
    /**
     * Returns an inclusive slice of cells from start to end.
     */
    getCellRange(start: number, end: number): CellInfo[];
    /**
     * Finds cells whose source matches the given regex pattern.
     */
    findCells(pattern: RegExp): CellInfo[];
    /**
     * Returns the index of the currently active cell in the notebook.
     */
    getCurrentCellIndex(): number;
}
//# sourceMappingURL=NotebookReader.d.ts.map
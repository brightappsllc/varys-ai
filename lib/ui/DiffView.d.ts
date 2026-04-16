/**
 * DiffView - Visual diff panel for pending AI edits.
 *
 * For 'modify' operations: shows per-hunk Accept / Reject toggles so the user
 * can keep only some of the AI's changes.  An "Apply" button reconstructs the
 * final cell content and calls onApplySelection.
 *
 * For 'insert' / 'delete' operations: a whole-cell Accept / Reject toggle.
 *
 * The existing "Accept All" / "Accept & Run" / "Undo All" buttons are still
 * available at the top of the card.
 */
import React from 'react';
export interface DiffInfo {
    cellIndex: number;
    opType: 'insert' | 'modify' | 'delete';
    cellType: 'code' | 'markdown';
    original: string;
    modified: string;
    description?: string;
}
/**
 * Per-cell decision shape — used by CellEditor.partialAcceptOperation.
 * The per-cell UI is removed; the type is kept for the backend API.
 */
export interface CellDecision {
    cellIndex: number;
    opType: 'insert' | 'modify' | 'delete';
    finalContent?: string;
    accept: boolean;
}
export interface DiffViewProps {
    operationId: string;
    description?: string;
    diffs: DiffInfo[];
    onAccept: (operationId: string) => void;
    onUndo: (operationId: string) => void;
    /** When set, the diff is resolved and rendered collapsed (no action buttons). */
    resolved?: 'accepted' | 'undone';
    /**
     * When false (default), the code has already been inserted and executed —
     * only the Undo button is shown.  When true, execution is gated on approval
     * so both "Apply & Run" and "Undo" are shown.
     */
    requiresApproval?: boolean;
}
export declare const DiffView: React.FC<DiffViewProps>;
//# sourceMappingURL=DiffView.d.ts.map
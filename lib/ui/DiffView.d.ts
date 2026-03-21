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
 * Per-cell decision returned when the user clicks "Apply Selection".
 */
export interface CellDecision {
    cellIndex: number;
    opType: 'insert' | 'modify' | 'delete';
    /** For 'modify': the reconstructed content; for 'insert'/'delete': undefined */
    finalContent?: string;
    /** Whether the whole-cell change is accepted (for insert/delete) */
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
}
export declare const DiffView: React.FC<DiffViewProps>;
//# sourceMappingURL=DiffView.d.ts.map
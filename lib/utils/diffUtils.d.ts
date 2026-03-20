/**
 * diffUtils - LCS-based line-by-line diff computation.
 *
 * Produces a unified diff of two text strings at line granularity.
 * Kept dependency-free and small enough for typical notebook cell sizes.
 */
export type DiffLineType = 'equal' | 'insert' | 'delete';
export interface DiffLine {
    type: DiffLineType;
    text: string;
    /** 1-based line number in the original (for 'equal' / 'delete') */
    origLine?: number;
    /** 1-based line number in the modified (for 'equal' / 'insert') */
    newLine?: number;
}
/**
 * Compute a line-level diff between `original` and `modified`.
 * Returns a flat array of DiffLine items in document order.
 */
export declare function computeLineDiff(original: string, modified: string): DiffLine[];
export interface DiffStats {
    insertions: number;
    deletions: number;
}
/** Count insertions and deletions in a diff. */
export declare function getDiffStats(lines: DiffLine[]): DiffStats;
export interface DiffHunk {
    id: number;
    /** Inclusive start index in the flat DiffLine[] */
    startIdx: number;
    /** Exclusive end index in the flat DiffLine[] */
    endIdx: number;
    /** Original lines that will be restored on Reject */
    deletedLines: string[];
    /** New lines that will be kept on Accept */
    insertedLines: string[];
    /** Lines shown in the UI: context before + change block + context after */
    displayLines: DiffLine[];
}
/**
 * Split a flat diff into independently decidable hunks.
 * Each hunk covers one contiguous block of change lines.
 * `contextLines` equal lines on each side are included in `displayLines`
 * for readability but are NOT part of the hunk's range.
 */
export declare function splitIntoHunks(lines: DiffLine[], contextLines?: number): DiffHunk[];
/**
 * Reconstruct the final cell content by applying per-hunk decisions.
 *  - 'accepted' (default for 'pending') → use the new (inserted) lines
 *  - 'rejected'                         → use the original (deleted) lines
 * Equal lines are always kept verbatim.
 */
export declare function reconstructFromHunks(lines: DiffLine[], hunks: DiffHunk[], decisions: Record<number, 'accepted' | 'rejected'>): string;
/**
 * Trim equal lines around changes, keeping `contextLines` unchanged lines
 * before and after each hunk for readability.
 */
export declare function collapseContext(lines: DiffLine[], contextLines?: number): DiffLine[];
//# sourceMappingURL=diffUtils.d.ts.map
/**
 * FileDiffView - shows a unified diff for a single file change.
 * Used by FileChangeCard to display agent-proposed file edits.
 */
import React from 'react';
export interface FileDiffViewProps {
    filePath: string;
    originalContent: string | null;
    newContent: string | null;
    changeType: 'created' | 'modified' | 'deleted';
    contextLines?: number;
}
export declare const FileDiffView: React.FC<FileDiffViewProps>;
//# sourceMappingURL=FileDiffView.d.ts.map
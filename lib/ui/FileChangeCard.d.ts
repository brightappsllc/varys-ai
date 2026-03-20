/**
 * FileChangeCard — represents one agent-proposed file change.
 *
 * The change has already been written to disk as a preview so the user can
 * inspect it directly in the JupyterLab editor.  This card shows the file
 * name, change type and Accept / Reject controls.  The inline diff is
 * available collapsed for quick reference.
 */
import React from 'react';
export interface FileChangeEvent {
    change_id: string;
    file_path: string;
    change_type: 'created' | 'modified' | 'deleted';
    original_content: string | null;
    new_content: string | null;
    content_deferred: boolean;
    total_changes: number;
    /** 1-based position within the operation's changes */
    index: number;
}
export interface FileChangeCardProps {
    event: FileChangeEvent;
    operationId: string;
    apiBaseUrl: string;
    xsrfToken: string;
    onResolved: (changeId: string, accepted: boolean) => void;
}
export declare const FileChangeCard: React.FC<FileChangeCardProps>;
//# sourceMappingURL=FileChangeCard.d.ts.map
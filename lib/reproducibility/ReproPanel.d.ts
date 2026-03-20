import React from 'react';
import { APIClient } from '../api/client';
import { CellEditor } from '../editor/CellEditor';
import { NotebookReader } from '../context/NotebookReader';
interface ReproPanelProps {
    apiClient: APIClient;
    cellEditor: CellEditor;
    notebookReader: NotebookReader;
}
export declare const ReproPanel: React.FC<ReproPanelProps>;
export {};
//# sourceMappingURL=ReproPanel.d.ts.map
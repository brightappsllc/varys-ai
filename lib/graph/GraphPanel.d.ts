/**
 * GraphPanel — Notebook Dependency Graph, rendered in a JupyterLab main-area panel.
 */
import React from 'react';
import { ReactWidget } from '@jupyterlab/apputils';
import { INotebookTracker } from '@jupyterlab/notebook';
export declare class GraphPanelWidget extends ReactWidget {
    private _tracker;
    private _scrollToCell;
    constructor(tracker: INotebookTracker, scrollToCell: (index: number) => void);
    render(): React.ReactElement;
}
//# sourceMappingURL=GraphPanel.d.ts.map
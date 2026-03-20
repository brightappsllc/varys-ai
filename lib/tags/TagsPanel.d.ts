/**
 * Tags Panel — Tag Zoo
 *
 * Tag JSON shape: { "value": string, "topic": string, "description": string, "color": string }
 *
 * Layout:
 *   1. Create Tag form — two-column:
 *        LEFT  — inputs (value · description · topic dropdown · color swatches)
 *        RIGHT — live JSON preview
 *   2. Tag library — two-column:
 *        LEFT  — tags grouped by topic (click to select)
 *        RIGHT — details of selected tag
 */
import React from 'react';
import { INotebookTracker } from '@jupyterlab/notebook';
export declare const TAG_PALETTE: string[];
export declare function tagColorAuto(tag: string): string;
export declare const BUILT_IN_TAG_DEFS: {
    category: string;
    tags: {
        value: string;
        topic: string;
        description: string;
    }[];
}[];
export declare const BUILT_IN_TOPICS: string[];
/** Tag JSON shape: { "value": string, "topic": string, "description": string, "color": string } */
export interface CustomTagDef {
    value: string;
    topic: string;
    description: string;
    color?: string;
}
export declare function loadCustomTags(): CustomTagDef[];
export interface TagsPanelProps {
    notebookTracker: INotebookTracker;
}
export declare const TagsPanel: React.FC<TagsPanelProps>;
//# sourceMappingURL=TagsPanel.d.ts.map
/**
 * ActionBar - Accept/Undo control for a pending notebook operation.
 */
import React from 'react';
export interface ActionBarProps {
    operationId: string;
    cellIndices: number[];
    description?: string;
    onAccept: (operationId: string) => void;
    onUndo: (operationId: string) => void;
}
export declare const ActionBar: React.FC<ActionBarProps>;

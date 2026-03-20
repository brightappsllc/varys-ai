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

export const ActionBar: React.FC<ActionBarProps> = ({
  operationId,
  cellIndices,
  description,
  onAccept,
  onUndo
}) => {
  const defaultDescription =
    `${cellIndices.length} cell${cellIndices.length !== 1 ? 's' : ''} modified`;

  return (
    <div className="ds-assistant-action-bar">
      <span className="ds-assistant-action-description" title={description ?? defaultDescription}>
        {description ?? defaultDescription}
      </span>
      <div className="ds-assistant-action-buttons">
        <button
          className="ds-assistant-btn ds-assistant-btn-accept"
          onClick={() => onAccept(operationId)}
          title="Accept changes"
        >
          Accept
        </button>
        <button
          className="ds-assistant-btn ds-assistant-btn-undo"
          onClick={() => onUndo(operationId)}
          title="Undo changes"
        >
          Undo
        </button>
      </div>
    </div>
  );
};

/**
 * FileDiffView - shows a unified diff for a single file change.
 * Used by FileChangeCard to display agent-proposed file edits.
 */
import React, { useMemo } from 'react';
import { computeLineDiff, collapseContext, getDiffStats, DiffLine } from '../utils/diffUtils';

export interface FileDiffViewProps {
  filePath: string;
  originalContent: string | null;
  newContent: string | null;
  changeType: 'created' | 'modified' | 'deleted';
  contextLines?: number;
}

const DiffLineRow: React.FC<{ line: DiffLine }> = ({ line }) => {
  if (line.text === '…') {
    return <div className="ds-diff-line ds-diff-line--ellipsis">…</div>;
  }
  const prefix = line.type === 'insert' ? '+' : line.type === 'delete' ? '−' : ' ';
  const cls =
    line.type === 'insert' ? 'ds-diff-line ds-diff-line--insert'
    : line.type === 'delete' ? 'ds-diff-line ds-diff-line--delete'
    : 'ds-diff-line ds-diff-line--equal';
  return (
    <div className={cls}>
      <span className="ds-diff-gutter">{prefix}</span>
      <span className="ds-diff-content">{line.text || '\u00a0'}</span>
    </div>
  );
};

export const FileDiffView: React.FC<FileDiffViewProps> = ({
  filePath,
  originalContent,
  newContent,
  changeType,
  contextLines = 3,
}) => {
  const original = originalContent ?? '';
  const modified = newContent ?? '';

  const diffLines = useMemo(() => computeLineDiff(original, modified), [original, modified]);
  const stats = useMemo(() => getDiffStats(diffLines), [diffLines]);
  const collapsed = useMemo(() => collapseContext(diffLines, contextLines), [diffLines, contextLines]);

  const statsLabel =
    changeType === 'created' ? `+${stats.insertions} lines`
    : changeType === 'deleted' ? `−${stats.deletions} lines`
    : `+${stats.insertions} / −${stats.deletions}`;

  return (
    <div className="ds-file-diff-view">
      <div className="ds-file-diff-header">
        <span className={`ds-file-diff-type-badge ds-file-diff-type-badge--${changeType}`}>
          {changeType}
        </span>
        <span className="ds-file-diff-path">{filePath}</span>
        {(stats.insertions > 0 || stats.deletions > 0) && (
          <span className="ds-file-diff-stats">{statsLabel}</span>
        )}
      </div>
      <div className="ds-diff-lines ds-file-diff-lines">
        {collapsed.length === 0 ? (
          <div className="ds-diff-line ds-diff-line--equal">
            <span className="ds-diff-gutter"> </span>
            <span className="ds-diff-content ds-diff-empty">(no changes)</span>
          </div>
        ) : (
          collapsed.map((line, i) => <DiffLineRow key={i} line={line} />)
        )}
      </div>
    </div>
  );
};

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

import React, { useState, useMemo } from 'react';
import {
  computeLineDiff,
  collapseContext,
  getDiffStats,
  splitIntoHunks,
  DiffLine,
  DiffHunk,
} from '../utils/diffUtils';

// ────────────────────────────────────────────────────────────────
// Public interface
// ────────────────────────────────────────────────────────────────

export interface DiffInfo {
  cellIndex: number;
  opType: 'insert' | 'modify' | 'delete';
  cellType: 'code' | 'markdown';
  original: string;
  modified: string;
  description?: string;
}

/**
 * Per-cell decision shape — used by CellEditor.partialAcceptOperation.
 * The per-cell UI is removed; the type is kept for the backend API.
 */
export interface CellDecision {
  cellIndex: number;
  opType: 'insert' | 'modify' | 'delete';
  finalContent?: string;
  accept: boolean;
}

export interface DiffViewProps {
  operationId: string;
  description?: string;
  diffs: DiffInfo[];
  onAccept: (operationId: string) => void;
  onUndo:   (operationId: string) => void;
  /** When set, the diff is resolved and rendered collapsed (no action buttons). */
  resolved?: 'accepted' | 'undone';
  /**
   * When false (default), the code has already been inserted and executed —
   * only the Undo button is shown.  When true (reorder ops), execution is
   * gated on approval so both Accept and Undo are shown.
   */
  requiresApproval?: boolean;
}

// ────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────

/** A single diff line rendered with gutter prefix + coloured background */
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

// ────────────────────────────────────────────────────────────────
// Per-hunk section inside a modify cell (display only)
// ────────────────────────────────────────────────────────────────

const HunkSection: React.FC<{ hunk: DiffHunk }> = ({ hunk }) => (
  <div className="ds-hunk-section">
    <div className="ds-hunk-bar">
      <span className="ds-hunk-label">
        {hunk.deletedLines.length > 0 && (
          <span className="ds-hunk-del">−{hunk.deletedLines.length}</span>
        )}
        {hunk.insertedLines.length > 0 && (
          <span className="ds-hunk-ins">+{hunk.insertedLines.length}</span>
        )}
        &nbsp;lines
      </span>
    </div>
    <div className="ds-diff-lines ds-diff-lines--hunk">
      {hunk.displayLines.map((line, i) => (
        <DiffLineRow key={i} line={line} />
      ))}
    </div>
  </div>
);

// ────────────────────────────────────────────────────────────────
// Per-cell expandable section (display only — no per-cell decisions)
// ────────────────────────────────────────────────────────────────

const CellDiffSection: React.FC<{
  info: DiffInfo;
  defaultOpen: boolean;
}> = ({ info, defaultOpen }) => {
  const [open, setOpen] = useState(defaultOpen);

  const diffLines = useMemo(
    () => computeLineDiff(info.original, info.modified),
    [info.original, info.modified],
  );
  const stats = useMemo(() => getDiffStats(diffLines), [diffLines]);
  const hunks = useMemo(() => splitIntoHunks(diffLines, 2), [diffLines]);

  const opLabel =
    info.opType === 'insert' ? 'new'
    : info.opType === 'delete' ? 'deleted'
    : 'modified';
  const statsLabel =
    info.opType === 'insert'  ? `+${stats.insertions}`
    : info.opType === 'delete' ? `−${stats.deletions}`
    : `+${stats.insertions} / −${stats.deletions}`;

  const hasChanges = stats.insertions > 0 || stats.deletions > 0;

  return (
    <div className="ds-diff-cell-section">
      <button className="ds-diff-cell-header" onClick={() => setOpen(o => !o)} title={info.description}>
        <span className="ds-diff-cell-toggle">{open ? '▾' : '▸'}</span>
        <span className={`ds-diff-op-badge ds-diff-op-badge--${info.opType}`}>{opLabel}</span>
        <span className="ds-diff-cell-type">{info.cellType}</span>
        <span className="ds-diff-cell-pos">#{info.cellIndex + 1}</span>
        {info.description && <span className="ds-diff-cell-desc">{info.description}</span>}
        {hasChanges && <span className={`ds-diff-stats ds-diff-stats--${info.opType}`}>{statsLabel}</span>}
      </button>

      {open && (
        <div className="ds-diff-cell-body">
          {/* modify: show per-hunk sections */}
          {info.opType === 'modify' && hunks.length === 0 && (
            <div className="ds-diff-line ds-diff-line--equal">
              <span className="ds-diff-gutter"> </span>
              <span className="ds-diff-content ds-diff-empty">(no changes)</span>
            </div>
          )}
          {info.opType === 'modify' && hunks.map(hunk => (
            <HunkSection key={hunk.id} hunk={hunk} />
          ))}

          {/* insert / delete: show full diff */}
          {info.opType !== 'modify' && (
            <div className="ds-diff-lines">
              {collapseContext(diffLines, 3).map((line, i) => (
                <DiffLineRow key={i} line={line} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

// ────────────────────────────────────────────────────────────────
// Main DiffView component
// ────────────────────────────────────────────────────────────────

export const DiffView: React.FC<DiffViewProps> = ({
  operationId,
  description,
  diffs,
  onAccept,
  onUndo,
  resolved,
  requiresApproval = false,
}) => {
  const totalCells   = diffs.length;
  const isReorder    = totalCells === 0;
  const cellLabel    = isReorder
    ? 'Reorder cells'
    : `${totalCells} cell${totalCells !== 1 ? 's' : ''}`;
  const defaultOpen  = diffs.length === 1;

  const totalInsertions = diffs.reduce(
    (s, d) => s + getDiffStats(computeLineDiff(d.original, d.modified)).insertions, 0,
  );
  const totalDeletions = diffs.reduce(
    (s, d) => s + getDiffStats(computeLineDiff(d.original, d.modified)).deletions, 0,
  );
  const statsLabel =
    totalInsertions > 0 && totalDeletions > 0 ? `+${totalInsertions} / −${totalDeletions}`
    : totalInsertions > 0 ? `+${totalInsertions}`
    : totalDeletions  > 0 ? `−${totalDeletions}`
    : '';

  // Unresolved: start expanded. Resolved: always show as collapsed static strip.
  const [expanded, setExpanded] = useState(!resolved);

  // Collapse immediately when resolved prop changes (e.g. just after user clicks Accept).
  React.useEffect(() => {
    if (resolved) setExpanded(false);
  }, [resolved]);

  const resolvedLabel = resolved === 'accepted' ? '✓ Changes accepted' : '↩ Changes undone';
  const resolvedMod   = resolved === 'accepted' ? 'ds-diff-view--accepted' : 'ds-diff-view--undone';

  return (
    <div className={`ds-diff-view${resolved ? ` ds-diff-view--resolved ${resolvedMod}` : ''}`}>
      {/* ── Header ── */}
      <div className="ds-diff-header">
        <div className="ds-diff-header-info">
          {resolved ? (
            <>
              <span className="ds-diff-resolved-label">{resolvedLabel}</span>
              {cellLabel && <span className="ds-diff-header-cells">{cellLabel}</span>}
              {statsLabel && <span className="ds-diff-header-stats">{statsLabel}</span>}
            </>
          ) : (
            <>
              {cellLabel && <span className="ds-diff-header-cells">{cellLabel}</span>}
              {description && (
                <span className="ds-diff-header-desc" title={description}>{description}</span>
              )}
              {statsLabel && <span className="ds-diff-header-stats">{statsLabel}</span>}
            </>
          )}
        </div>

        <div className="ds-diff-header-actions">
          {resolved ? (
            /* Resolved: expand / collapse toggle only — no Accept/Reject */
            <button
              className="ds-diff-expand-btn"
              onClick={() => setExpanded(e => !e)}
              title={expanded ? 'Collapse diff' : 'Expand diff'}
            >{expanded ? '⌃ Hide' : '⌄ Show'}</button>
          ) : (
            <>
              {requiresApproval && (
                <button
                  className="ds-assistant-btn ds-assistant-btn-accept"
                  onClick={() => onAccept(operationId)}
                  title="Accept changes and run cells"
                >✓ Accept</button>
              )}
              <button
                className="ds-assistant-btn ds-assistant-btn-undo"
                onClick={() => onUndo(operationId)}
                title="Reject changes and undo"
              >✕ Undo</button>
            </>
          )}
        </div>
      </div>

      {/* Hint — only shown when active (not yet resolved) */}
      {!resolved && (
        <div className="ds-diff-hint">
          {isReorder
            ? <>Cells have been rearranged in the notebook. Use <strong>✓ Accept</strong> to keep the new order or <strong>✕ Undo</strong> to revert.</>
            : requiresApproval
              ? <>Review the changes below, then use <strong>✓ Accept</strong> to run or <strong>✕ Undo</strong> to revert.</>
              : <>Changes applied. Click <strong>✕ Undo</strong> to revert.</>
          }
        </div>
      )}

      {/* ── Resolved collapsed: 2-line preview ── */}
      {resolved && !expanded && (() => {
        const previewLines: DiffLine[] = [];
        for (const d of diffs) {
          const lines = computeLineDiff(d.original, d.modified)
            .filter(l => l.type !== 'equal');
          previewLines.push(...lines);
          if (previewLines.length >= 2) break;
        }
        return previewLines.length > 0 ? (
          <div className="ds-diff-preview">
            {previewLines.slice(0, 2).map((line, i) => (
              <DiffLineRow key={i} line={line} />
            ))}
            <div className="ds-diff-preview-more">···</div>
          </div>
        ) : null;
      })()}

      {/* ── Per-cell diffs — shown when expanded (both pending and resolved) ── */}
      {expanded && (
        <div className="ds-diff-cells">
          {diffs.map((d, i) => (
            <CellDiffSection
              key={i}
              info={d}
              defaultOpen={defaultOpen}
            />
          ))}
        </div>
      )}
    </div>
  );
};

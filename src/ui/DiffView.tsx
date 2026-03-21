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
  reconstructFromHunks,
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
 * Per-cell decision returned when the user clicks "Apply Selection".
 */
export interface CellDecision {
  cellIndex: number;
  opType: 'insert' | 'modify' | 'delete';
  /** For 'modify': the reconstructed content; for 'insert'/'delete': undefined */
  finalContent?: string;
  /** Whether the whole-cell change is accepted (for insert/delete) */
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
}

// ────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────

type HunkDecision = 'pending' | 'accepted' | 'rejected';
type WholeDecision = 'pending' | 'accepted' | 'rejected';

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
// Per-hunk section inside a modify cell
// ────────────────────────────────────────────────────────────────

const HunkSection: React.FC<{
  hunk: DiffHunk;
  decision: HunkDecision;
  onDecide: (id: number, d: HunkDecision) => void;
}> = ({ hunk, decision, onDecide }) => {
  const hasChanges = hunk.deletedLines.length > 0 || hunk.insertedLines.length > 0;
  const banner =
    decision === 'accepted' ? 'ds-hunk-banner--accepted'
    : decision === 'rejected' ? 'ds-hunk-banner--rejected'
    : '';

  return (
    <div className={`ds-hunk-section ${banner}`}>
      {/* Hunk control bar */}
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
        {hasChanges && (
          <span className="ds-hunk-btns">
            <button
              className={`ds-hunk-btn ds-hunk-btn--accept ${decision === 'accepted' ? 'ds-hunk-btn--active' : ''}`}
              onClick={() => onDecide(hunk.id, decision === 'accepted' ? 'pending' : 'accepted')}
              title="Accept this change"
            >✓ Accept</button>
            <button
              className={`ds-hunk-btn ds-hunk-btn--reject ${decision === 'rejected' ? 'ds-hunk-btn--active' : ''}`}
              onClick={() => onDecide(hunk.id, decision === 'rejected' ? 'pending' : 'rejected')}
              title="Reject this change"
            >✕ Reject</button>
          </span>
        )}
      </div>

      {/* Diff lines for this hunk (with context) */}
      <div className="ds-diff-lines ds-diff-lines--hunk">
        {hunk.displayLines.map((line, i) => (
          <DiffLineRow key={i} line={line} />
        ))}
      </div>
    </div>
  );
};

// ────────────────────────────────────────────────────────────────
// Per-cell expandable section
// ────────────────────────────────────────────────────────────────

const CellDiffSection: React.FC<{
  info: DiffInfo;
  defaultOpen: boolean;
  onCellDecisions: (cellIndex: number, finalContent: string | undefined, accept: boolean) => void;
}> = ({ info, defaultOpen, onCellDecisions }) => {
  const [open, setOpen] = useState(defaultOpen);

  const diffLines = useMemo(
    () => computeLineDiff(info.original, info.modified),
    [info.original, info.modified],
  );
  const stats  = useMemo(() => getDiffStats(diffLines), [diffLines]);
  const hunks  = useMemo(() => splitIntoHunks(diffLines, 2), [diffLines]);

  // For 'modify' ops: per-hunk decisions
  const [hunkDecisions, setHunkDecisions] = useState<Record<number, HunkDecision>>({});
  // For 'insert'/'delete' ops: whole-cell decision
  const [wholeDecision, setWholeDecision] = useState<WholeDecision>('pending');

  const opLabel    = info.opType === 'insert' ? 'new' : info.opType === 'delete' ? 'deleted' : 'modified';
  const statsLabel =
    info.opType === 'insert'  ? `+${stats.insertions}`
    : info.opType === 'delete' ? `−${stats.deletions}`
    : `+${stats.insertions} / −${stats.deletions}`;

  const hasChanges = stats.insertions > 0 || stats.deletions > 0;

  // Determine if any decision has been made in this cell
  const decidedHunks   = Object.values(hunkDecisions).filter(d => d !== 'pending').length;
  const totalHunks     = hunks.length;
  const hasWholeChoice = info.opType !== 'modify' && wholeDecision !== 'pending';

  // Notify parent whenever decisions change for this cell
  const handleHunkDecide = (id: number, d: HunkDecision) => {
    const next = { ...hunkDecisions, [id]: d };
    setHunkDecisions(next);
    // Reconstruct and bubble up
    const finalContent = reconstructFromHunks(
      diffLines, hunks,
      Object.entries(next).reduce<Record<string, 'accepted' | 'rejected'>>((acc, [k, v]) => { acc[k] = v === 'pending' ? 'accepted' : v as 'accepted' | 'rejected'; return acc; }, {}),
    );
    onCellDecisions(info.cellIndex, finalContent, true);
  };

  const handleWholeDecide = (d: WholeDecision) => {
    setWholeDecision(d);
    onCellDecisions(info.cellIndex, undefined, d !== 'rejected');
  };

  return (
    <div className="ds-diff-cell-section">
      {/* Cell header row */}
      <button className="ds-diff-cell-header" onClick={() => setOpen(o => !o)} title={info.description}>
        <span className="ds-diff-cell-toggle">{open ? '▾' : '▸'}</span>
        <span className={`ds-diff-op-badge ds-diff-op-badge--${info.opType}`}>{opLabel}</span>
        <span className="ds-diff-cell-type">{info.cellType}</span>
        <span className="ds-diff-cell-pos">#{info.cellIndex + 1}</span>
        {info.description && <span className="ds-diff-cell-desc">{info.description}</span>}
        {hasChanges && <span className={`ds-diff-stats ds-diff-stats--${info.opType}`}>{statsLabel}</span>}
        {info.opType === 'modify' && totalHunks > 0 && (
          <span className="ds-hunk-progress">
            {decidedHunks}/{totalHunks} decided
          </span>
        )}
      </button>

      {open && (
        <div className="ds-diff-cell-body">
          {/* Whole-cell toggle for insert / delete */}
          {info.opType !== 'modify' && (
            <div className="ds-hunk-bar ds-hunk-bar--whole">
              <span className="ds-hunk-label">
                {info.opType === 'insert' ? 'New cell' : 'Deleted cell'}
              </span>
              <span className="ds-hunk-btns">
                <button
                  className={`ds-hunk-btn ds-hunk-btn--accept ${wholeDecision === 'accepted' ? 'ds-hunk-btn--active' : ''}`}
                  onClick={() => handleWholeDecide(wholeDecision === 'accepted' ? 'pending' : 'accepted')}
                  title="Accept this cell"
                >✓ Accept</button>
                <button
                  className={`ds-hunk-btn ds-hunk-btn--reject ${wholeDecision === 'rejected' ? 'ds-hunk-btn--active' : ''}`}
                  onClick={() => handleWholeDecide(wholeDecision === 'rejected' ? 'pending' : 'rejected')}
                  title="Reject this cell"
                >✕ Reject</button>
              </span>
              {(hasWholeChoice) && (
                <span className={`ds-hunk-status ${wholeDecision === 'accepted' ? 'ds-hunk-status--accepted' : 'ds-hunk-status--rejected'}`}>
                  {wholeDecision === 'accepted' ? '✓ Will keep' : '✕ Will discard'}
                </span>
              )}
            </div>
          )}

          {/* Per-hunk sections for modify */}
          {info.opType === 'modify' && hunks.length === 0 && (
            <div className="ds-diff-line ds-diff-line--equal">
              <span className="ds-diff-gutter"> </span>
              <span className="ds-diff-content ds-diff-empty">(no changes)</span>
            </div>
          )}
          {info.opType === 'modify' && hunks.map(hunk => (
            <HunkSection
              key={hunk.id}
              hunk={hunk}
              decision={hunkDecisions[hunk.id] ?? 'pending'}
              onDecide={handleHunkDecide}
            />
          ))}

          {/* Fallback: show full collapsed diff when there are no discrete hunks */}
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
}) => {
  const totalCells   = diffs.length;
  const cellLabel    = totalCells > 0
    ? `${totalCells} cell${totalCells !== 1 ? 's' : ''}`
    : null;
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

  // When resolved, start collapsed; user can expand to re-read the diff.
  const [expanded, setExpanded] = useState(!resolved);

  // If the resolved prop changes (e.g. after accept/undo), collapse immediately.
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
            <button
              className="ds-diff-expand-btn"
              onClick={() => setExpanded(e => !e)}
              title={expanded ? 'Collapse diff' : 'Expand diff'}
            >{expanded ? '⌃ Hide' : '⌄ Show'}</button>
          ) : (
            <>
              <button
                className="ds-assistant-btn ds-assistant-btn-accept"
                onClick={() => onAccept(operationId)}
                title="Accept all changes in all cells"
              >✓ Accept</button>

              <button
                className="ds-assistant-btn ds-assistant-btn-undo"
                onClick={() => onUndo(operationId)}
                title="Reject all changes"
              >✕ Reject</button>
            </>
          )}
        </div>
      </div>

      {/* Hint — only shown when active (not yet resolved) */}
      {!resolved && totalCells > 0 && (
        <div className="ds-diff-hint">
          Use ✓ / ✕ buttons on each change block to review individual hunks,
          or use <strong>✓ Accept</strong> / <strong>✕ Reject</strong> to act on all changes at once.
        </div>
      )}

      {/* ── Resolved preview: first 2 changed lines, always visible when collapsed ── */}
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
            {previewLines.length > 2 || diffs.some(d =>
              computeLineDiff(d.original, d.modified).filter(l => l.type !== 'equal').length > 0
            ) ? (
              <div className="ds-diff-preview-more">···</div>
            ) : null}
          </div>
        ) : null;
      })()}

      {/* ── Per-cell diffs — shown when expanded ── */}
      {expanded && (
        <div className="ds-diff-cells">
          {diffs.map((d, i) => (
            <CellDiffSection
              key={i}
              info={d}
              defaultOpen={defaultOpen}
              onCellDecisions={() => {}}
            />
          ))}
        </div>
      )}
    </div>
  );
};

/**
 * FileChangeCard — represents one agent-proposed file change.
 *
 * The change has already been written to disk as a preview so the user can
 * inspect it directly in the JupyterLab editor.  This card shows the file
 * name, change type and Accept / Reject controls.  The inline diff is
 * available collapsed for quick reference.
 */
import React, { useState, useEffect, useMemo } from 'react';
import { FileDiffView } from './FileDiffView';
import { computeLineDiff, getDiffStats } from '../utils/diffUtils';

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

type CardState = 'pending' | 'loading' | 'loaded' | 'accepted' | 'rejected' | 'error';

export const FileChangeCard: React.FC<FileChangeCardProps> = ({
  event,
  operationId,
  apiBaseUrl,
  xsrfToken,
  onResolved,
}) => {
  const [expanded, setExpanded] = useState(true);   // start open so diff is visible immediately
  const [state, setState] = useState<CardState>(event.content_deferred ? 'pending' : 'loaded');
  const [loadedOriginal, setLoadedOriginal] = useState<string | null>(event.original_content);
  const [loadedNew, setLoadedNew] = useState<string | null>(event.new_content);
  const [errorMsg, setErrorMsg] = useState('');

  const effectiveOriginal = loadedOriginal;
  const effectiveNew = loadedNew;

  // Auto-load deferred content on mount so the diff is visible immediately.
  useEffect(() => {
    if (event.content_deferred && state === 'pending') {
      void handleLoadDiff();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleLoadDiff = async () => {
    setState('loading');
    try {
      const resp = await fetch(
        `${apiBaseUrl}/varys/agent/change/${encodeURIComponent(event.change_id)}`,
        { method: 'GET', credentials: 'same-origin' }
      );
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      setLoadedOriginal(data.original_content);
      setLoadedNew(data.new_content);
      setState('loaded');
      setExpanded(true);
    } catch (err: unknown) {
      setState('error');
      setErrorMsg(`Failed to load: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const handleAccept = async () => {
    try {
      const resp = await fetch(`${apiBaseUrl}/varys/agent/accept`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
          'X-XSRFToken': xsrfToken,
        },
        body: JSON.stringify({
          operation_id: operationId,
          change_id: event.change_id,
          confirmed_content: null,
          confirmed_path: event.file_path,
        }),
      });
      const data = await resp.json();
      if (data.success) {
        setState('accepted');
        onResolved(event.change_id, true);
      } else {
        setErrorMsg(data.error || 'Accept failed');
      }
    } catch (err: unknown) {
      setErrorMsg(`Accept failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const handleReject = async () => {
    try {
      const resp = await fetch(`${apiBaseUrl}/varys/agent/reject`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
          'X-XSRFToken': xsrfToken,
        },
        body: JSON.stringify({
          operation_id: operationId,
          change_id: event.change_id,
        }),
      });
      const data = await resp.json();
      if (data.success) {
        setState('rejected');
        onResolved(event.change_id, false);
      } else {
        setErrorMsg(data.error || 'Reject failed');
      }
    } catch (err: unknown) {
      setErrorMsg(`Reject failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const isResolved  = state === 'accepted' || state === 'rejected';
  const fname       = event.file_path.split('/').pop() ?? event.file_path;
  const changeTypeBadge =
    event.change_type === 'created' ? 'new'
    : event.change_type === 'deleted' ? 'deleted'
    : 'modified';

  // Compute line-change stats to show in the header (replaces the FileDiffView header).
  const diffStats = useMemo(() => {
    const orig = effectiveOriginal ?? '';
    const next = effectiveNew ?? '';
    return getDiffStats(computeLineDiff(orig, next));
  }, [effectiveOriginal, effectiveNew]);
  const statsLabel =
    event.change_type === 'created' ? `+${diffStats.insertions}`
    : event.change_type === 'deleted' ? `−${diffStats.deletions}`
    : diffStats.insertions > 0 || diffStats.deletions > 0
      ? `+${diffStats.insertions} / −${diffStats.deletions}`
      : '';

  const showDiffBody =
    (state === 'loaded') ||
    (!event.content_deferred && state !== 'error' && state !== 'pending');

  // Resolved header label
  const resolvedLabel =
    state === 'accepted'
      ? `✓ Changes accepted — ${fname}`
      : `✕ Changes rejected — ${fname}`;
  const resolvedMod =
    state === 'accepted' ? 'ds-file-change-card--accepted' : 'ds-file-change-card--rejected';

  if (isResolved) {
    return (
      <div className={`ds-file-change-card ds-file-change-card--resolved ${resolvedMod}`}>
        <div className="ds-file-change-card__header">
          <span className="ds-file-change-card__resolved-label">{resolvedLabel}</span>
          <button
            className="ds-diff-expand-btn"
            onClick={() => setExpanded(e => !e)}
            title={expanded ? 'Collapse' : 'Expand'}
          >{expanded ? '⌃ Hide' : '⌄ Show'}</button>
        </div>
        {expanded && (
          <div className="ds-file-change-card__body">
            <FileDiffView
              filePath={event.file_path}
              originalContent={effectiveOriginal}
              newContent={effectiveNew}
              changeType={event.change_type}
            />
          </div>
        )}
      </div>
    );
  }

  return (
    <div className={`ds-file-change-card ds-file-change-card--${state}`}>
      {/* Card header — toggle + change-type badge + stats (no redundant path) */}
      <div
        className="ds-file-change-card__header"
        onClick={() => setExpanded(e => !e)}
        style={{ cursor: 'pointer' }}
      >
        <span className="ds-file-change-card__toggle">{expanded ? '▾' : '▸'}</span>
        <span className={`ds-file-diff-type-badge ds-file-diff-type-badge--${event.change_type}`}>
          {changeTypeBadge}
        </span>
        <span className="ds-file-change-card__fname" title={event.file_path}>{fname}</span>
        {statsLabel && (
          <span className="ds-file-change-card__stats">{statsLabel}</span>
        )}
        {event.total_changes > 1 && (
          <span className="ds-file-change-card__counter">
            {event.index} of {event.total_changes}
          </span>
        )}
      </div>

      {/* Card body */}
      {expanded && (
        <div className="ds-file-change-card__body">
          {event.content_deferred && state === 'pending' && (
            <button className="ds-file-change-card__load-btn" onClick={handleLoadDiff}>
              File too large to preview inline — click to load diff
            </button>
          )}
          {state === 'loading' && (
            <div className="ds-file-change-card__loading">Loading diff…</div>
          )}
          {showDiffBody && (
            <>
              <FileDiffView
                filePath={event.file_path}
                originalContent={effectiveOriginal}
                newContent={effectiveNew}
                changeType={event.change_type}
              />
              {event.change_type === 'deleted' && (
                <div className="ds-file-change-card__delete-note">
                  ⚠ Accepting will move this file to <code>.varys_deleted/</code> (recoverable).
                </div>
              )}
              <div className="ds-file-change-card__actions">
                <button className="ds-assistant-btn ds-assistant-btn-accept" onClick={handleAccept}>
                  ✓ Accept
                </button>
                <button className="ds-assistant-btn ds-assistant-btn-undo" onClick={handleReject}>
                  ✕ Undo
                </button>
              </div>
            </>
          )}
          {state === 'error' && (
            <div className="ds-file-change-card__error">{errorMsg}</div>
          )}
        </div>
      )}

      {errorMsg && !expanded && (
        <div className="ds-file-change-card__error ds-file-change-card__error--inline">
          {errorMsg}
        </div>
      )}
    </div>
  );
};

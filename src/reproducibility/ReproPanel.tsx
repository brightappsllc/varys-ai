import React, { useCallback, useEffect, useState } from 'react';
import { APIClient } from '../api/client';
import { CellEditor } from '../editor/CellEditor';
import { NotebookReader } from '../context/NotebookReader';
import { reproStore } from './store';
import { ReproIssue, ReproSeverity } from './types';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface ReproPanelProps {
  apiClient:      APIClient;
  cellEditor:     CellEditor;
  notebookReader: NotebookReader;
}

// ---------------------------------------------------------------------------
// IssueCard
// ---------------------------------------------------------------------------

interface IssueCardProps {
  issue:      ReproIssue;
  onFix:      (issue: ReproIssue) => Promise<void>;
  onDismiss:  (issue: ReproIssue) => Promise<void>;
}

const IssueCard: React.FC<IssueCardProps> = ({ issue, onFix, onDismiss }) => {
  const [fixing, setFixing]       = useState(false);
  const [dismissing, setDismissing] = useState(false);

  const handleFix = async () => {
    setFixing(true);
    try { await onFix(issue); } finally { setFixing(false); }
  };
  const handleDismiss = async () => {
    setDismissing(true);
    try { await onDismiss(issue); } finally { setDismissing(false); }
  };

  return (
    <div className={`ds-repro-card ds-repro-card--${issue.severity}`}>
      <div className="ds-repro-card-header">
        <span className="ds-repro-card-title">{issue.title}</span>
        <span className="ds-repro-card-loc">Cell {issue.cell_index}</span>
      </div>
      <div className="ds-repro-card-message">{issue.message}</div>
      <details className="ds-repro-card-details">
        <summary>Why it matters</summary>
        <div className="ds-repro-card-explanation">{issue.explanation}</div>
      </details>
      <div className="ds-repro-card-suggestion">{issue.suggestion}</div>
      <div className="ds-repro-card-actions">
        {issue.fix_code && (
          <button
            className="ds-repro-btn ds-repro-btn--fix"
            disabled={fixing}
            onClick={handleFix}
          >
            {fixing ? '…' : '⚡ Fix'}
          </button>
        )}
        <button
          className="ds-repro-btn ds-repro-btn--dismiss"
          disabled={dismissing}
          onClick={handleDismiss}
        >
          {dismissing ? '…' : 'Dismiss'}
        </button>
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Section
// ---------------------------------------------------------------------------

interface SectionProps {
  severity:    ReproSeverity;
  label:       string;
  icon:        string;
  issues:      ReproIssue[];
  onFix:       (i: ReproIssue) => Promise<void>;
  onDismiss:   (i: ReproIssue) => Promise<void>;
}

const Section: React.FC<SectionProps> = ({ severity, label, icon, issues, onFix, onDismiss }) => {
  if (issues.length === 0) return null;
  return (
    <div className={`ds-repro-section ds-repro-section--${severity}`}>
      <div className="ds-repro-section-title">
        {icon} {label} <span className="ds-repro-section-count">({issues.length})</span>
      </div>
      {issues.map(issue => (
        <IssueCard key={issue.id} issue={issue} onFix={onFix} onDismiss={onDismiss} />
      ))}
    </div>
  );
};

// ---------------------------------------------------------------------------
// ReproPanel
// ---------------------------------------------------------------------------

export const ReproPanel: React.FC<ReproPanelProps> = ({
  apiClient, cellEditor, notebookReader
}) => {
  const [issues, setIssues]       = useState<ReproIssue[]>(reproStore.current);
  const [loading, setLoading]     = useState(false);
  const [lastAnalyzed, setLastAnalyzed] = useState<Date | null>(null);
  const [error, setError]         = useState<string | null>(null);

  // Subscribe to updates pushed from index.ts cell-execution listener
  useEffect(() => {
    const handler = (newIssues: ReproIssue[]) => {
      setIssues(newIssues);
      setLastAnalyzed(new Date());
      setError(null);
    };
    reproStore.subscribe(handler);

    // Load persisted issues for the current notebook on mount
    const ctx = notebookReader.getFullContext();
    if (ctx?.notebookPath) {
      apiClient.getReproIssues(ctx.notebookPath).then(result => {
        if (result.issues.length > 0) {
          setIssues(result.issues);
        }
      }).catch(() => { /* silent — no DB yet */ });
    }

    return () => reproStore.unsubscribe(handler);
  }, []);

  const handleAnalyze = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const ctx = notebookReader.getFullContext();
      const result = await apiClient.analyzeReproducibility({
        notebookPath: ctx?.notebookPath ?? '',
        cells: ctx?.cells ?? [],
      });
      setIssues(result.issues);
      setLastAnalyzed(new Date());
      reproStore.emit(result.issues);
    } catch (err: any) {
      setError(err?.message ?? 'Analysis failed');
    } finally {
      setLoading(false);
    }
  }, [apiClient, notebookReader]);

  const handleFix = useCallback(async (issue: ReproIssue) => {
    if (!issue.fix_code) return;
    // Insert/update the cell at the issue's cell_index with the fix code
    try {
      await cellEditor.updateCell(issue.cell_index, issue.fix_code);
    } catch {
      // If updateCell fails (e.g., insert-type fix), insert a new cell
      cellEditor.insertCell(issue.cell_index + 1, 'code', issue.fix_code);
    }
    // Dismiss from DB so it disappears from the panel
    const ctx = notebookReader.getFullContext();
    await apiClient.dismissReproIssue({
      notebookPath: ctx?.notebookPath ?? '',
      issueId: issue.id,
    });
    setIssues(prev => prev.filter(i => i.id !== issue.id));
  }, [apiClient, cellEditor, notebookReader]);

  const handleDismiss = useCallback(async (issue: ReproIssue) => {
    const ctx = notebookReader.getFullContext();
    await apiClient.dismissReproIssue({
      notebookPath: ctx?.notebookPath ?? '',
      issueId: issue.id,
    });
    setIssues(prev => prev.filter(i => i.id !== issue.id));
  }, [apiClient, notebookReader]);

  const handleFixAll = useCallback(async () => {
    const fixable = issues.filter(i => i.fix_code);
    for (const issue of fixable) {
      await handleFix(issue);
    }
  }, [issues, handleFix]);

  const critical = issues.filter(i => i.severity === 'critical');
  const warnings = issues.filter(i => i.severity === 'warning');
  const info     = issues.filter(i => i.severity === 'info');

  return (
    <div className="ds-repro-panel">
      {/* ── Header ── */}
      <div className="ds-repro-panel-header">
        <span className="ds-repro-panel-title">🛡️ Reproducibility</span>
        {issues.length > 0 && (
          <span className={`ds-repro-badge ds-repro-badge--${critical.length > 0 ? 'critical' : 'warning'}`}>
            {issues.length}
          </span>
        )}
      </div>

      {/* ── Summary counts ── */}
      {issues.length > 0 && (
        <div className="ds-repro-counts">
          {critical.length > 0 && <span className="ds-repro-count ds-repro-count--critical">❌ {critical.length} critical</span>}
          {warnings.length > 0 && <span className="ds-repro-count ds-repro-count--warning">⚠️ {warnings.length} warning{warnings.length !== 1 ? 's' : ''}</span>}
          {info.length    > 0 && <span className="ds-repro-count ds-repro-count--info">ℹ️ {info.length}</span>}
        </div>
      )}

      {/* ── Issues ── */}
      <div className="ds-repro-issues">
        {issues.length === 0 && !loading && (
          <div className="ds-repro-all-ok">
            ✅ No reproducibility issues found
            {lastAnalyzed && (
              <div className="ds-repro-timestamp">Analyzed {lastAnalyzed.toLocaleTimeString()}</div>
            )}
          </div>
        )}
        <Section severity="critical" label="Critical" icon="❌" issues={critical} onFix={handleFix} onDismiss={handleDismiss} />
        <Section severity="warning"  label="Warnings"  icon="⚠️" issues={warnings}  onFix={handleFix} onDismiss={handleDismiss} />
        <Section severity="info"     label="Info"      icon="ℹ️" issues={info}     onFix={handleFix} onDismiss={handleDismiss} />
      </div>

      {error && <div className="ds-repro-error">{error}</div>}

      {/* ── Footer actions ── */}
      <div className="ds-repro-footer">
        <button
          className="ds-repro-btn ds-repro-btn--analyze"
          onClick={handleAnalyze}
          disabled={loading}
        >
          {loading ? '⏳ Analyzing…' : '🔍 Analyze'}
        </button>
        {issues.some(i => i.fix_code) && (
          <button
            className="ds-repro-btn ds-repro-btn--fixall"
            onClick={handleFixAll}
          >
            ⚡ Fix All
          </button>
        )}
        {lastAnalyzed && issues.length > 0 && (
          <span className="ds-repro-timestamp">{lastAnalyzed.toLocaleTimeString()}</span>
        )}
      </div>
    </div>
  );
};

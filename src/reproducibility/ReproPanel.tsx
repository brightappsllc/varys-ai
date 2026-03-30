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
// Helpers
// ---------------------------------------------------------------------------

function formatRelativeTime(date: Date): string {
  const secs = Math.floor((Date.now() - date.getTime()) / 1000);
  if (secs < 10)  return 'just now';
  if (secs < 60)  return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60)  return `${mins}m ago`;
  return date.toLocaleTimeString();
}

const SEVERITY_LABEL: Record<ReproSeverity, string> = {
  critical: 'Critical',
  warning:  'Warning',
  info:     'Info',
};

// ---------------------------------------------------------------------------
// IssueCard
// ---------------------------------------------------------------------------

interface IssueCardProps {
  issue:     ReproIssue;
  onFix:     (issue: ReproIssue) => Promise<void>;
  onDismiss: (issue: ReproIssue) => Promise<void>;
}

const IssueCard: React.FC<IssueCardProps> = ({ issue, onFix, onDismiss }) => {
  const [fixing,     setFixing]     = useState(false);
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
        <span className={`ds-repro-pill ds-repro-pill--${issue.severity}`}>
          {SEVERITY_LABEL[issue.severity]}
        </span>
        <span className="ds-repro-card-title">{issue.title}</span>
        <span className="ds-repro-card-loc">Cell {issue.cell_index + 1}</span>
      </div>
      <div className="ds-repro-card-message">{issue.message}</div>
      {issue.suggestion && (
        <div className="ds-repro-card-suggestion">{issue.suggestion}</div>
      )}
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
  severity:  ReproSeverity;
  label:     string;
  issues:    ReproIssue[];
  onFix:     (i: ReproIssue) => Promise<void>;
  onDismiss: (i: ReproIssue) => Promise<void>;
}

const Section: React.FC<SectionProps> = ({ severity, label, issues, onFix, onDismiss }) => {
  if (issues.length === 0) return null;
  return (
    <div className={`ds-repro-section ds-repro-section--${severity}`}>
      <div className="ds-repro-section-title">
        {label.toUpperCase()}
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
  const [issues,       setIssues]       = useState<ReproIssue[]>(reproStore.current);
  const [loading,      setLoading]      = useState(false);
  const [lastAnalyzed, setLastAnalyzed] = useState<Date | null>(null);
  const [error,        setError]        = useState<string | null>(null);

  useEffect(() => {
    const handler = (newIssues: ReproIssue[]) => {
      setIssues(newIssues);
      setLastAnalyzed(new Date());
      setError(null);
    };
    reproStore.subscribe(handler);

    const ctx = notebookReader.getFullContext();
    if (ctx?.notebookPath) {
      apiClient.getReproIssues(ctx.notebookPath).then(result => {
        if (result.issues.length > 0) {
          setIssues(result.issues);
          reproStore.emit(result.issues);
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
        cells:        ctx?.cells ?? [],
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
    try {
      await cellEditor.updateCell(issue.cell_index, issue.fix_code);
    } catch {
      cellEditor.insertCell(issue.cell_index + 1, 'code', issue.fix_code);
    }
    const ctx = notebookReader.getFullContext();
    await apiClient.dismissReproIssue({
      notebookPath: ctx?.notebookPath ?? '',
      issueId:      issue.id,
    });
    setIssues(prev => prev.filter(i => i.id !== issue.id));
  }, [apiClient, cellEditor, notebookReader]);

  const handleDismiss = useCallback(async (issue: ReproIssue) => {
    const ctx = notebookReader.getFullContext();
    await apiClient.dismissReproIssue({
      notebookPath: ctx?.notebookPath ?? '',
      issueId:      issue.id,
    });
    setIssues(prev => prev.filter(i => i.id !== issue.id));
  }, [apiClient, notebookReader]);

  const handleFixAll = useCallback(async () => {
    for (const issue of issues.filter(i => i.fix_code)) {
      await handleFix(issue);
    }
  }, [issues, handleFix]);

  const critical = issues.filter(i => i.severity === 'critical');
  const warnings = issues.filter(i => i.severity === 'warning');
  const info     = issues.filter(i => i.severity === 'info');
  const fixable  = issues.filter(i => i.fix_code).length;

  return (
    <div className="ds-repro-panel">

      {/* ── Header ── */}
      <div className="ds-repro-panel-header">
        <div className="ds-repro-header-left">
          <span className="ds-repro-panel-title">🛡️ Reproducibility Guardian</span>
          {lastAnalyzed && (
            <span className="ds-repro-last-analyzed">
              Last analyzed · {formatRelativeTime(lastAnalyzed)}
            </span>
          )}
        </div>
        <button
          className="ds-repro-btn ds-repro-btn--analyze"
          onClick={handleAnalyze}
          disabled={loading}
        >
          {loading ? '⏳ Analyzing…' : '⌕ Analyze'}
        </button>
      </div>

      {/* ── Summary counts (tab style) ── */}
      {issues.length > 0 && (
        <div className="ds-repro-counts">
          <div className="ds-repro-count ds-repro-count--critical">
            <span className="ds-repro-count-num">{critical.length}</span>
            <span className="ds-repro-count-label">Critical</span>
          </div>
          <div className="ds-repro-count-sep" />
          <div className="ds-repro-count ds-repro-count--warning">
            <span className="ds-repro-count-num">{warnings.length}</span>
            <span className="ds-repro-count-label">Warning</span>
          </div>
          <div className="ds-repro-count-sep" />
          <div className="ds-repro-count ds-repro-count--info">
            <span className="ds-repro-count-num">{info.length}</span>
            <span className="ds-repro-count-label">Info</span>
          </div>
        </div>
      )}

      {/* ── Issue list ── */}
      <div className="ds-repro-issues">
        {issues.length === 0 && !loading && (
          <div className="ds-repro-all-ok">
            ✅ No reproducibility issues found
            {lastAnalyzed && (
              <div className="ds-repro-timestamp">
                Analyzed {lastAnalyzed.toLocaleTimeString()}
              </div>
            )}
          </div>
        )}
        <Section severity="critical" label="Critical" issues={critical} onFix={handleFix} onDismiss={handleDismiss} />
        <Section severity="warning"  label="Warning"  issues={warnings} onFix={handleFix} onDismiss={handleDismiss} />
        <Section severity="info"     label="Info"     issues={info}     onFix={handleFix} onDismiss={handleDismiss} />
      </div>

      {error && <div className="ds-repro-error">{error}</div>}

      {/* ── Footer ── */}
      <div className="ds-repro-footer">
        <span className="ds-repro-footer-summary">
          {issues.length > 0
            ? `${issues.length} issue${issues.length !== 1 ? 's' : ''} · ${fixable} fixable`
            : ''}
        </span>
        {fixable > 0 && (
          <button className="ds-repro-btn ds-repro-btn--fixall" onClick={handleFixAll}>
            ⚡ Fix All
          </button>
        )}
      </div>

    </div>
  );
};

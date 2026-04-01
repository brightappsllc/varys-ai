import React, { useCallback, useEffect, useState } from 'react';
import { reproStore } from './store';
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function formatRelativeTime(date) {
    const secs = Math.floor((Date.now() - date.getTime()) / 1000);
    if (secs < 10)
        return 'just now';
    if (secs < 60)
        return `${secs}s ago`;
    const mins = Math.floor(secs / 60);
    if (mins < 60)
        return `${mins}m ago`;
    return date.toLocaleTimeString();
}
const SEVERITY_LABEL = {
    critical: 'Critical',
    warning: 'Warning',
    info: 'Info',
};
const IssueCard = ({ issue, onFix, onDismiss }) => {
    const [fixing, setFixing] = useState(false);
    const [dismissing, setDismissing] = useState(false);
    const handleFix = async () => {
        setFixing(true);
        try {
            await onFix(issue);
        }
        finally {
            setFixing(false);
        }
    };
    const handleDismiss = async () => {
        setDismissing(true);
        try {
            await onDismiss(issue);
        }
        finally {
            setDismissing(false);
        }
    };
    return (React.createElement("div", { className: `ds-repro-card ds-repro-card--${issue.severity}` },
        React.createElement("div", { className: "ds-repro-card-header" },
            React.createElement("span", { className: `ds-repro-pill ds-repro-pill--${issue.severity}` }, SEVERITY_LABEL[issue.severity]),
            React.createElement("span", { className: "ds-repro-card-title" }, issue.title),
            React.createElement("span", { className: "ds-repro-card-loc" },
                "Cell ",
                issue.cell_index + 1)),
        React.createElement("div", { className: "ds-repro-card-message" }, issue.message),
        issue.suggestion && (React.createElement("div", { className: "ds-repro-card-suggestion" }, issue.suggestion)),
        React.createElement("div", { className: "ds-repro-card-actions" },
            issue.fix_code && (React.createElement("button", { className: "ds-repro-btn ds-repro-btn--fix", disabled: fixing, onClick: handleFix }, fixing ? '…' : '⚡ Fix')),
            React.createElement("button", { className: "ds-repro-btn ds-repro-btn--dismiss", disabled: dismissing, onClick: handleDismiss }, dismissing ? '…' : 'Dismiss'))));
};
const Section = ({ severity, label, issues, onFix, onDismiss }) => {
    if (issues.length === 0)
        return null;
    return (React.createElement("div", { className: `ds-repro-section ds-repro-section--${severity}` },
        React.createElement("div", { className: "ds-repro-section-title" }, label.toUpperCase()),
        issues.map(issue => (React.createElement(IssueCard, { key: issue.id, issue: issue, onFix: onFix, onDismiss: onDismiss })))));
};
// ---------------------------------------------------------------------------
// ReproPanel
// ---------------------------------------------------------------------------
export const ReproPanel = ({ apiClient, cellEditor, notebookReader }) => {
    const [issues, setIssues] = useState(reproStore.current);
    const [loading, setLoading] = useState(false);
    const [lastAnalyzed, setLastAnalyzed] = useState(null);
    const [error, setError] = useState(null);
    useEffect(() => {
        const handler = (newIssues) => {
            setIssues(newIssues);
            setLastAnalyzed(new Date());
            setError(null);
        };
        reproStore.subscribe(handler);
        const ctx = notebookReader.getFullContext();
        if (ctx === null || ctx === void 0 ? void 0 : ctx.notebookPath) {
            apiClient.getReproIssues(ctx.notebookPath).then(result => {
                if (result.issues.length > 0) {
                    setIssues(result.issues);
                    reproStore.emit(result.issues);
                }
            }).catch(() => { });
        }
        return () => reproStore.unsubscribe(handler);
    }, []);
    const handleAnalyze = useCallback(async () => {
        var _a, _b, _c;
        setLoading(true);
        setError(null);
        try {
            const ctx = notebookReader.getFullContext();
            const result = await apiClient.analyzeReproducibility({
                notebookPath: (_a = ctx === null || ctx === void 0 ? void 0 : ctx.notebookPath) !== null && _a !== void 0 ? _a : '',
                cells: (_b = ctx === null || ctx === void 0 ? void 0 : ctx.cells) !== null && _b !== void 0 ? _b : [],
            });
            setIssues(result.issues);
            setLastAnalyzed(new Date());
            reproStore.emit(result.issues);
        }
        catch (err) {
            setError((_c = err === null || err === void 0 ? void 0 : err.message) !== null && _c !== void 0 ? _c : 'Analysis failed');
        }
        finally {
            setLoading(false);
        }
    }, [apiClient, notebookReader]);
    const handleFix = useCallback(async (issue) => {
        var _a;
        if (!issue.fix_code)
            return;
        try {
            await cellEditor.updateCell(issue.cell_index, issue.fix_code);
        }
        catch (_b) {
            cellEditor.insertCell(issue.cell_index + 1, 'code', issue.fix_code);
        }
        const ctx = notebookReader.getFullContext();
        await apiClient.dismissReproIssue({
            notebookPath: (_a = ctx === null || ctx === void 0 ? void 0 : ctx.notebookPath) !== null && _a !== void 0 ? _a : '',
            issueId: issue.id,
        });
        setIssues(prev => prev.filter(i => i.id !== issue.id));
    }, [apiClient, cellEditor, notebookReader]);
    const handleDismiss = useCallback(async (issue) => {
        var _a;
        const ctx = notebookReader.getFullContext();
        await apiClient.dismissReproIssue({
            notebookPath: (_a = ctx === null || ctx === void 0 ? void 0 : ctx.notebookPath) !== null && _a !== void 0 ? _a : '',
            issueId: issue.id,
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
    const info = issues.filter(i => i.severity === 'info');
    const fixable = issues.filter(i => i.fix_code).length;
    return (React.createElement("div", { className: "ds-repro-panel" },
        React.createElement("div", { className: "ds-repro-panel-header" },
            React.createElement("div", { className: "ds-repro-header-left" },
                React.createElement("span", { className: "ds-repro-panel-title" }, "\uD83D\uDEE1\uFE0F Reproducibility Guardian"),
                lastAnalyzed && (React.createElement("span", { className: "ds-repro-last-analyzed" },
                    "Last analyzed \u00B7 ",
                    formatRelativeTime(lastAnalyzed)))),
            React.createElement("button", { className: "ds-repro-btn ds-repro-btn--analyze", onClick: handleAnalyze, disabled: loading }, loading ? React.createElement(React.Fragment, null,
                React.createElement("span", { className: "ds-repro-btn-icon" }, "\u23F3"),
                " Analyzing\u2026") : React.createElement(React.Fragment, null,
                React.createElement("span", { className: "ds-repro-btn-icon" }, "\uD83D\uDD0D"),
                " Analyze"))),
        issues.length > 0 && (React.createElement("div", { className: "ds-repro-counts" },
            React.createElement("div", { className: "ds-repro-count ds-repro-count--critical" },
                React.createElement("span", { className: "ds-repro-count-num" }, critical.length),
                React.createElement("span", { className: "ds-repro-count-label" }, "Critical")),
            React.createElement("div", { className: "ds-repro-count-sep" }),
            React.createElement("div", { className: "ds-repro-count ds-repro-count--warning" },
                React.createElement("span", { className: "ds-repro-count-num" }, warnings.length),
                React.createElement("span", { className: "ds-repro-count-label" }, "Warning")),
            React.createElement("div", { className: "ds-repro-count-sep" }),
            React.createElement("div", { className: "ds-repro-count ds-repro-count--info" },
                React.createElement("span", { className: "ds-repro-count-num" }, info.length),
                React.createElement("span", { className: "ds-repro-count-label" }, "Info")))),
        React.createElement("div", { className: "ds-repro-issues" },
            issues.length === 0 && !loading && (React.createElement("div", { className: "ds-repro-all-ok" },
                "\u2705 No reproducibility issues found",
                lastAnalyzed && (React.createElement("div", { className: "ds-repro-timestamp" },
                    "Analyzed ",
                    lastAnalyzed.toLocaleTimeString())))),
            React.createElement(Section, { severity: "critical", label: "Critical", issues: critical, onFix: handleFix, onDismiss: handleDismiss }),
            React.createElement(Section, { severity: "warning", label: "Warning", issues: warnings, onFix: handleFix, onDismiss: handleDismiss }),
            React.createElement(Section, { severity: "info", label: "Info", issues: info, onFix: handleFix, onDismiss: handleDismiss })),
        error && React.createElement("div", { className: "ds-repro-error" }, error),
        React.createElement("div", { className: "ds-repro-footer" },
            React.createElement("span", { className: "ds-repro-footer-summary" }, issues.length > 0
                ? `${issues.length} issue${issues.length !== 1 ? 's' : ''} · ${fixable} fixable`
                : ''),
            fixable > 0 && (React.createElement("button", { className: "ds-repro-btn ds-repro-btn--fixall", onClick: handleFixAll }, "\u26A1 Fix All")))));
};

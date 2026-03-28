import React, { useCallback, useEffect, useState } from 'react';
import { reproStore } from './store';
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
            React.createElement("span", { className: "ds-repro-card-title" }, issue.title),
            React.createElement("span", { className: "ds-repro-card-loc" },
                "Cell ",
                issue.cell_index)),
        React.createElement("div", { className: "ds-repro-card-message" }, issue.message),
        React.createElement("details", { className: "ds-repro-card-details" },
            React.createElement("summary", null, "Why it matters"),
            React.createElement("div", { className: "ds-repro-card-explanation" }, issue.explanation)),
        React.createElement("div", { className: "ds-repro-card-suggestion" }, issue.suggestion),
        React.createElement("div", { className: "ds-repro-card-actions" },
            issue.fix_code && (React.createElement("button", { className: "ds-repro-btn ds-repro-btn--fix", disabled: fixing, onClick: handleFix }, fixing ? '…' : '⚡ Fix')),
            React.createElement("button", { className: "ds-repro-btn ds-repro-btn--dismiss", disabled: dismissing, onClick: handleDismiss }, dismissing ? '…' : 'Dismiss'))));
};
const Section = ({ severity, label, icon, issues, onFix, onDismiss }) => {
    if (issues.length === 0)
        return null;
    return (React.createElement("div", { className: `ds-repro-section ds-repro-section--${severity}` },
        React.createElement("div", { className: "ds-repro-section-title" },
            icon,
            " ",
            label,
            " ",
            React.createElement("span", { className: "ds-repro-section-count" },
                "(",
                issues.length,
                ")")),
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
    // Subscribe to updates pushed from index.ts cell-execution listener
    useEffect(() => {
        const handler = (newIssues) => {
            setIssues(newIssues);
            setLastAnalyzed(new Date());
            setError(null);
        };
        reproStore.subscribe(handler);
        // Load persisted issues for the current notebook on mount.
        // Always emit into reproStore so the badge in SidebarWidget stays in sync.
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
        // Insert/update the cell at the issue's cell_index with the fix code
        try {
            await cellEditor.updateCell(issue.cell_index, issue.fix_code);
        }
        catch (_b) {
            // If updateCell fails (e.g., insert-type fix), insert a new cell
            cellEditor.insertCell(issue.cell_index + 1, 'code', issue.fix_code);
        }
        // Dismiss from DB so it disappears from the panel
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
        const fixable = issues.filter(i => i.fix_code);
        for (const issue of fixable) {
            await handleFix(issue);
        }
    }, [issues, handleFix]);
    const critical = issues.filter(i => i.severity === 'critical');
    const warnings = issues.filter(i => i.severity === 'warning');
    const info = issues.filter(i => i.severity === 'info');
    return (React.createElement("div", { className: "ds-repro-panel" },
        React.createElement("div", { className: "ds-repro-panel-header" },
            React.createElement("span", { className: "ds-repro-panel-title" }, "\uD83D\uDEE1\uFE0F Reproducibility"),
            issues.length > 0 && (React.createElement("span", { className: `ds-repro-badge ds-repro-badge--${critical.length > 0 ? 'critical' : 'warning'}` }, issues.length))),
        issues.length > 0 && (React.createElement("div", { className: "ds-repro-counts" },
            critical.length > 0 && React.createElement("span", { className: "ds-repro-count ds-repro-count--critical" },
                "\u274C ",
                critical.length,
                " critical"),
            warnings.length > 0 && React.createElement("span", { className: "ds-repro-count ds-repro-count--warning" },
                "\u26A0\uFE0F ",
                warnings.length,
                " warning",
                warnings.length !== 1 ? 's' : ''),
            info.length > 0 && React.createElement("span", { className: "ds-repro-count ds-repro-count--info" },
                "\u2139\uFE0F ",
                info.length))),
        React.createElement("div", { className: "ds-repro-issues" },
            issues.length === 0 && !loading && (React.createElement("div", { className: "ds-repro-all-ok" },
                "\u2705 No reproducibility issues found",
                lastAnalyzed && (React.createElement("div", { className: "ds-repro-timestamp" },
                    "Analyzed ",
                    lastAnalyzed.toLocaleTimeString())))),
            React.createElement(Section, { severity: "critical", label: "Critical", icon: "\u274C", issues: critical, onFix: handleFix, onDismiss: handleDismiss }),
            React.createElement(Section, { severity: "warning", label: "Warnings", icon: "\u26A0\uFE0F", issues: warnings, onFix: handleFix, onDismiss: handleDismiss }),
            React.createElement(Section, { severity: "info", label: "Info", icon: "\u2139\uFE0F", issues: info, onFix: handleFix, onDismiss: handleDismiss })),
        error && React.createElement("div", { className: "ds-repro-error" }, error),
        React.createElement("div", { className: "ds-repro-footer" },
            React.createElement("button", { className: "ds-repro-btn ds-repro-btn--analyze", onClick: handleAnalyze, disabled: loading }, loading ? '⏳ Analyzing…' : '🔍 Analyze'),
            issues.some(i => i.fix_code) && (React.createElement("button", { className: "ds-repro-btn ds-repro-btn--fixall", onClick: handleFixAll }, "\u26A1 Fix All")),
            lastAnalyzed && issues.length > 0 && (React.createElement("span", { className: "ds-repro-timestamp" }, lastAnalyzed.toLocaleTimeString())))));
};

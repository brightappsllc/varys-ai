/**
 * FileDiffView - shows a unified diff for a single file change.
 * Used by FileChangeCard to display agent-proposed file edits.
 */
import React, { useMemo } from 'react';
import { computeLineDiff, collapseContext } from '../utils/diffUtils';
const DiffLineRow = ({ line }) => {
    if (line.text === '…') {
        return React.createElement("div", { className: "ds-diff-line ds-diff-line--ellipsis" }, "\u2026");
    }
    const prefix = line.type === 'insert' ? '+' : line.type === 'delete' ? '−' : ' ';
    const cls = line.type === 'insert' ? 'ds-diff-line ds-diff-line--insert'
        : line.type === 'delete' ? 'ds-diff-line ds-diff-line--delete'
            : 'ds-diff-line ds-diff-line--equal';
    return (React.createElement("div", { className: cls },
        React.createElement("span", { className: "ds-diff-gutter" }, prefix),
        React.createElement("span", { className: "ds-diff-content" }, line.text || '\u00a0')));
};
export const FileDiffView = ({ originalContent, newContent, contextLines = 3, }) => {
    const original = originalContent !== null && originalContent !== void 0 ? originalContent : '';
    const modified = newContent !== null && newContent !== void 0 ? newContent : '';
    const diffLines = useMemo(() => computeLineDiff(original, modified), [original, modified]);
    const collapsed = useMemo(() => collapseContext(diffLines, contextLines), [diffLines, contextLines]);
    return (React.createElement("div", { className: "ds-file-diff-view" },
        React.createElement("div", { className: "ds-diff-lines ds-file-diff-lines" }, collapsed.length === 0 ? (React.createElement("div", { className: "ds-diff-line ds-diff-line--equal" },
            React.createElement("span", { className: "ds-diff-gutter" }, " "),
            React.createElement("span", { className: "ds-diff-content ds-diff-empty" }, "(no changes)"))) : (collapsed.map((line, i) => React.createElement(DiffLineRow, { key: i, line: line }))))));
};

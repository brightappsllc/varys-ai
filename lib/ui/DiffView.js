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
import { computeLineDiff, collapseContext, getDiffStats, splitIntoHunks, } from '../utils/diffUtils';
// ────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────
/** A single diff line rendered with gutter prefix + coloured background */
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
// ────────────────────────────────────────────────────────────────
// Per-hunk section inside a modify cell (display only)
// ────────────────────────────────────────────────────────────────
const HunkSection = ({ hunk }) => (React.createElement("div", { className: "ds-hunk-section" },
    React.createElement("div", { className: "ds-hunk-bar" },
        React.createElement("span", { className: "ds-hunk-label" },
            hunk.deletedLines.length > 0 && (React.createElement("span", { className: "ds-hunk-del" },
                "\u2212",
                hunk.deletedLines.length)),
            hunk.insertedLines.length > 0 && (React.createElement("span", { className: "ds-hunk-ins" },
                "+",
                hunk.insertedLines.length)),
            "\u00A0lines")),
    React.createElement("div", { className: "ds-diff-lines ds-diff-lines--hunk" }, hunk.displayLines.map((line, i) => (React.createElement(DiffLineRow, { key: i, line: line }))))));
// ────────────────────────────────────────────────────────────────
// Per-cell expandable section (display only — no per-cell decisions)
// ────────────────────────────────────────────────────────────────
const CellDiffSection = ({ info, defaultOpen }) => {
    const [open, setOpen] = useState(defaultOpen);
    const diffLines = useMemo(() => computeLineDiff(info.original, info.modified), [info.original, info.modified]);
    const stats = useMemo(() => getDiffStats(diffLines), [diffLines]);
    const hunks = useMemo(() => splitIntoHunks(diffLines, 2), [diffLines]);
    const opLabel = info.opType === 'insert' ? 'new'
        : info.opType === 'delete' ? 'deleted'
            : 'modified';
    const statsLabel = info.opType === 'insert' ? `+${stats.insertions}`
        : info.opType === 'delete' ? `−${stats.deletions}`
            : `+${stats.insertions} / −${stats.deletions}`;
    const hasChanges = stats.insertions > 0 || stats.deletions > 0;
    return (React.createElement("div", { className: "ds-diff-cell-section" },
        React.createElement("button", { className: "ds-diff-cell-header", onClick: () => setOpen(o => !o), title: info.description },
            React.createElement("span", { className: "ds-diff-cell-toggle" }, open ? '▾' : '▸'),
            React.createElement("span", { className: `ds-diff-op-badge ds-diff-op-badge--${info.opType}` }, opLabel),
            React.createElement("span", { className: "ds-diff-cell-type" }, info.cellType),
            React.createElement("span", { className: "ds-diff-cell-pos" },
                "#",
                info.cellIndex + 1),
            info.description && React.createElement("span", { className: "ds-diff-cell-desc" }, info.description),
            hasChanges && React.createElement("span", { className: `ds-diff-stats ds-diff-stats--${info.opType}` }, statsLabel)),
        open && (React.createElement("div", { className: "ds-diff-cell-body" },
            info.opType === 'modify' && hunks.length === 0 && (React.createElement("div", { className: "ds-diff-line ds-diff-line--equal" },
                React.createElement("span", { className: "ds-diff-gutter" }, " "),
                React.createElement("span", { className: "ds-diff-content ds-diff-empty" }, "(no changes)"))),
            info.opType === 'modify' && hunks.map(hunk => (React.createElement(HunkSection, { key: hunk.id, hunk: hunk }))),
            info.opType !== 'modify' && (React.createElement("div", { className: "ds-diff-lines" }, collapseContext(diffLines, 3).map((line, i) => (React.createElement(DiffLineRow, { key: i, line: line })))))))));
};
// ────────────────────────────────────────────────────────────────
// Main DiffView component
// ────────────────────────────────────────────────────────────────
export const DiffView = ({ operationId, description, diffs, onAccept, onUndo, resolved, requiresApproval = false, }) => {
    const totalCells = diffs.length;
    const isReorder = totalCells === 0;
    const cellLabel = isReorder
        ? 'Reorder cells'
        : `${totalCells} cell${totalCells !== 1 ? 's' : ''}`;
    const defaultOpen = diffs.length === 1;
    const totalInsertions = diffs.reduce((s, d) => s + getDiffStats(computeLineDiff(d.original, d.modified)).insertions, 0);
    const totalDeletions = diffs.reduce((s, d) => s + getDiffStats(computeLineDiff(d.original, d.modified)).deletions, 0);
    const statsLabel = totalInsertions > 0 && totalDeletions > 0 ? `+${totalInsertions} / −${totalDeletions}`
        : totalInsertions > 0 ? `+${totalInsertions}`
            : totalDeletions > 0 ? `−${totalDeletions}`
                : '';
    // Unresolved: start expanded. Resolved: always show as collapsed static strip.
    const [expanded, setExpanded] = useState(!resolved);
    // Collapse immediately when resolved prop changes (e.g. just after user clicks Accept).
    React.useEffect(() => {
        if (resolved)
            setExpanded(false);
    }, [resolved]);
    const resolvedLabel = resolved === 'accepted' ? '✓ Changes accepted' : '↩ Changes undone';
    const resolvedMod = resolved === 'accepted' ? 'ds-diff-view--accepted' : 'ds-diff-view--undone';
    return (React.createElement("div", { className: `ds-diff-view${resolved ? ` ds-diff-view--resolved ${resolvedMod}` : ''}` },
        React.createElement("div", { className: "ds-diff-header" },
            React.createElement("div", { className: "ds-diff-header-info" }, resolved ? (React.createElement(React.Fragment, null,
                React.createElement("span", { className: "ds-diff-resolved-label" }, resolvedLabel),
                cellLabel && React.createElement("span", { className: "ds-diff-header-cells" }, cellLabel),
                statsLabel && React.createElement("span", { className: "ds-diff-header-stats" }, statsLabel))) : (React.createElement(React.Fragment, null,
                cellLabel && React.createElement("span", { className: "ds-diff-header-cells" }, cellLabel),
                description && (React.createElement("span", { className: "ds-diff-header-desc", title: description }, description)),
                statsLabel && React.createElement("span", { className: "ds-diff-header-stats" }, statsLabel)))),
            React.createElement("div", { className: "ds-diff-header-actions" }, resolved ? (
            /* Resolved: expand / collapse toggle only — no Accept/Reject */
            React.createElement("button", { className: "ds-diff-expand-btn", onClick: () => setExpanded(e => !e), title: expanded ? 'Collapse diff' : 'Expand diff' }, expanded ? '⌃ Hide' : '⌄ Show')) : (React.createElement(React.Fragment, null,
                requiresApproval && (React.createElement("button", { className: "ds-assistant-btn ds-assistant-btn-accept", onClick: () => onAccept(operationId), title: "Accept changes" }, "\u2713 Apply")),
                React.createElement("button", { className: "ds-assistant-btn ds-assistant-btn-undo", onClick: () => onUndo(operationId), title: "Undo changes" }, "\u21BA"))))),
        !resolved && (React.createElement("div", { className: "ds-diff-hint" }, isReorder
            ? React.createElement(React.Fragment, null,
                "Cells have been rearranged in the notebook. Use ",
                React.createElement("strong", null, "\u2713 Apply"),
                " to keep the new order or ",
                React.createElement("strong", null, "\u21BA"),
                " to revert.")
            : requiresApproval
                ? React.createElement(React.Fragment, null,
                    "Cell populated. Use ",
                    React.createElement("strong", null, "\u2713 Apply"),
                    " to accept or ",
                    React.createElement("strong", null, "\u21BA"),
                    " to revert. Run the cell manually when ready.")
                : React.createElement(React.Fragment, null,
                    "Changes applied. Click ",
                    React.createElement("strong", null, "\u21BA"),
                    " to revert."))),
        resolved && !expanded && (() => {
            const previewLines = [];
            for (const d of diffs) {
                const lines = computeLineDiff(d.original, d.modified)
                    .filter(l => l.type !== 'equal');
                previewLines.push(...lines);
                if (previewLines.length >= 2)
                    break;
            }
            return previewLines.length > 0 ? (React.createElement("div", { className: "ds-diff-preview" },
                previewLines.slice(0, 2).map((line, i) => (React.createElement(DiffLineRow, { key: i, line: line }))),
                React.createElement("div", { className: "ds-diff-preview-more" }, "\u00B7\u00B7\u00B7"))) : null;
        })(),
        expanded && (React.createElement("div", { className: "ds-diff-cells" }, diffs.map((d, i) => (React.createElement(CellDiffSection, { key: i, info: d, defaultOpen: defaultOpen })))))));
};

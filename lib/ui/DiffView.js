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
import { computeLineDiff, collapseContext, getDiffStats, splitIntoHunks, reconstructFromHunks, } from '../utils/diffUtils';
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
// Per-hunk section inside a modify cell
// ────────────────────────────────────────────────────────────────
const HunkSection = ({ hunk, decision, onDecide }) => {
    const hasChanges = hunk.deletedLines.length > 0 || hunk.insertedLines.length > 0;
    const banner = decision === 'accepted' ? 'ds-hunk-banner--accepted'
        : decision === 'rejected' ? 'ds-hunk-banner--rejected'
            : '';
    return (React.createElement("div", { className: `ds-hunk-section ${banner}` },
        React.createElement("div", { className: "ds-hunk-bar" },
            React.createElement("span", { className: "ds-hunk-label" },
                hunk.deletedLines.length > 0 && (React.createElement("span", { className: "ds-hunk-del" },
                    "\u2212",
                    hunk.deletedLines.length)),
                hunk.insertedLines.length > 0 && (React.createElement("span", { className: "ds-hunk-ins" },
                    "+",
                    hunk.insertedLines.length)),
                "\u00A0lines"),
            hasChanges && (React.createElement("span", { className: "ds-hunk-btns" },
                React.createElement("button", { className: `ds-hunk-btn ds-hunk-btn--accept ${decision === 'accepted' ? 'ds-hunk-btn--active' : ''}`, onClick: () => onDecide(hunk.id, decision === 'accepted' ? 'pending' : 'accepted'), title: "Accept this change" }, "\u2713 Accept"),
                React.createElement("button", { className: `ds-hunk-btn ds-hunk-btn--reject ${decision === 'rejected' ? 'ds-hunk-btn--active' : ''}`, onClick: () => onDecide(hunk.id, decision === 'rejected' ? 'pending' : 'rejected'), title: "Reject this change" }, "\u2715 Reject")))),
        React.createElement("div", { className: "ds-diff-lines ds-diff-lines--hunk" }, hunk.displayLines.map((line, i) => (React.createElement(DiffLineRow, { key: i, line: line }))))));
};
// ────────────────────────────────────────────────────────────────
// Per-cell expandable section
// ────────────────────────────────────────────────────────────────
const CellDiffSection = ({ info, defaultOpen, onCellDecisions }) => {
    const [open, setOpen] = useState(defaultOpen);
    const diffLines = useMemo(() => computeLineDiff(info.original, info.modified), [info.original, info.modified]);
    const stats = useMemo(() => getDiffStats(diffLines), [diffLines]);
    const hunks = useMemo(() => splitIntoHunks(diffLines, 2), [diffLines]);
    // For 'modify' ops: per-hunk decisions
    const [hunkDecisions, setHunkDecisions] = useState({});
    // For 'insert'/'delete' ops: whole-cell decision
    const [wholeDecision, setWholeDecision] = useState('pending');
    const opLabel = info.opType === 'insert' ? 'new' : info.opType === 'delete' ? 'deleted' : 'modified';
    const statsLabel = info.opType === 'insert' ? `+${stats.insertions}`
        : info.opType === 'delete' ? `−${stats.deletions}`
            : `+${stats.insertions} / −${stats.deletions}`;
    const hasChanges = stats.insertions > 0 || stats.deletions > 0;
    // Determine if any decision has been made in this cell
    const decidedHunks = Object.values(hunkDecisions).filter(d => d !== 'pending').length;
    const totalHunks = hunks.length;
    const hasWholeChoice = info.opType !== 'modify' && wholeDecision !== 'pending';
    // Notify parent whenever decisions change for this cell
    const handleHunkDecide = (id, d) => {
        const next = Object.assign(Object.assign({}, hunkDecisions), { [id]: d });
        setHunkDecisions(next);
        // Reconstruct and bubble up
        const finalContent = reconstructFromHunks(diffLines, hunks, Object.entries(next).reduce((acc, [k, v]) => { acc[k] = v === 'pending' ? 'accepted' : v; return acc; }, {}));
        onCellDecisions(info.cellIndex, finalContent, true);
    };
    const handleWholeDecide = (d) => {
        setWholeDecision(d);
        onCellDecisions(info.cellIndex, undefined, d !== 'rejected');
    };
    return (React.createElement("div", { className: "ds-diff-cell-section" },
        React.createElement("button", { className: "ds-diff-cell-header", onClick: () => setOpen(o => !o), title: info.description },
            React.createElement("span", { className: "ds-diff-cell-toggle" }, open ? '▾' : '▸'),
            React.createElement("span", { className: `ds-diff-op-badge ds-diff-op-badge--${info.opType}` }, opLabel),
            React.createElement("span", { className: "ds-diff-cell-type" }, info.cellType),
            React.createElement("span", { className: "ds-diff-cell-pos" },
                "#",
                info.cellIndex + 1),
            info.description && React.createElement("span", { className: "ds-diff-cell-desc" }, info.description),
            hasChanges && React.createElement("span", { className: `ds-diff-stats ds-diff-stats--${info.opType}` }, statsLabel),
            info.opType === 'modify' && totalHunks > 0 && (React.createElement("span", { className: "ds-hunk-progress" },
                decidedHunks,
                "/",
                totalHunks,
                " decided"))),
        open && (React.createElement("div", { className: "ds-diff-cell-body" },
            info.opType !== 'modify' && (React.createElement("div", { className: "ds-hunk-bar ds-hunk-bar--whole" },
                React.createElement("span", { className: "ds-hunk-label" }, info.opType === 'insert' ? 'New cell' : 'Deleted cell'),
                React.createElement("span", { className: "ds-hunk-btns" },
                    React.createElement("button", { className: `ds-hunk-btn ds-hunk-btn--accept ${wholeDecision === 'accepted' ? 'ds-hunk-btn--active' : ''}`, onClick: () => handleWholeDecide(wholeDecision === 'accepted' ? 'pending' : 'accepted'), title: "Accept this cell" }, "\u2713 Accept"),
                    React.createElement("button", { className: `ds-hunk-btn ds-hunk-btn--reject ${wholeDecision === 'rejected' ? 'ds-hunk-btn--active' : ''}`, onClick: () => handleWholeDecide(wholeDecision === 'rejected' ? 'pending' : 'rejected'), title: "Reject this cell" }, "\u2715 Reject")),
                (hasWholeChoice) && (React.createElement("span", { className: `ds-hunk-status ${wholeDecision === 'accepted' ? 'ds-hunk-status--accepted' : 'ds-hunk-status--rejected'}` }, wholeDecision === 'accepted' ? '✓ Will keep' : '✕ Will discard')))),
            info.opType === 'modify' && hunks.length === 0 && (React.createElement("div", { className: "ds-diff-line ds-diff-line--equal" },
                React.createElement("span", { className: "ds-diff-gutter" }, " "),
                React.createElement("span", { className: "ds-diff-content ds-diff-empty" }, "(no changes)"))),
            info.opType === 'modify' && hunks.map(hunk => {
                var _a;
                return (React.createElement(HunkSection, { key: hunk.id, hunk: hunk, decision: (_a = hunkDecisions[hunk.id]) !== null && _a !== void 0 ? _a : 'pending', onDecide: handleHunkDecide }));
            }),
            info.opType !== 'modify' && (React.createElement("div", { className: "ds-diff-lines" }, collapseContext(diffLines, 3).map((line, i) => (React.createElement(DiffLineRow, { key: i, line: line })))))))));
};
// ────────────────────────────────────────────────────────────────
// Main DiffView component
// ────────────────────────────────────────────────────────────────
export const DiffView = ({ operationId, description, diffs, onAccept, onUndo, resolved, }) => {
    const totalCells = diffs.length;
    const cellLabel = totalCells > 0
        ? `${totalCells} cell${totalCells !== 1 ? 's' : ''}`
        : null;
    const defaultOpen = diffs.length === 1;
    const totalInsertions = diffs.reduce((s, d) => s + getDiffStats(computeLineDiff(d.original, d.modified)).insertions, 0);
    const totalDeletions = diffs.reduce((s, d) => s + getDiffStats(computeLineDiff(d.original, d.modified)).deletions, 0);
    const statsLabel = totalInsertions > 0 && totalDeletions > 0 ? `+${totalInsertions} / −${totalDeletions}`
        : totalInsertions > 0 ? `+${totalInsertions}`
            : totalDeletions > 0 ? `−${totalDeletions}`
                : '';
    // When resolved, start collapsed; user can expand to re-read the diff.
    const [expanded, setExpanded] = useState(!resolved);
    // If the resolved prop changes (e.g. after accept/undo), collapse immediately.
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
            React.createElement("div", { className: "ds-diff-header-actions" }, resolved ? (React.createElement("button", { className: "ds-diff-expand-btn", onClick: () => setExpanded(e => !e), title: expanded ? 'Collapse diff' : 'Expand diff' }, expanded ? '⌃ Hide' : '⌄ Show')) : (React.createElement(React.Fragment, null,
                React.createElement("button", { className: "ds-assistant-btn ds-assistant-btn-accept", onClick: () => onAccept(operationId), title: "Accept all changes in all cells" }, "\u2713 Accept"),
                React.createElement("button", { className: "ds-assistant-btn ds-assistant-btn-undo", onClick: () => onUndo(operationId), title: "Reject all changes" }, "\u2715 Reject"))))),
        !resolved && totalCells > 0 && (React.createElement("div", { className: "ds-diff-hint" },
            "Use \u2713 / \u2715 buttons on each change block to review individual hunks, or use ",
            React.createElement("strong", null, "\u2713 Accept"),
            " / ",
            React.createElement("strong", null, "\u2715 Reject"),
            " to act on all changes at once.")),
        expanded && (React.createElement("div", { className: "ds-diff-cells" }, diffs.map((d, i) => (React.createElement(CellDiffSection, { key: i, info: d, defaultOpen: defaultOpen, onCellDecisions: () => { } })))))));
};

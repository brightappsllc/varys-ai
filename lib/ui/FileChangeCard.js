/**
 * FileChangeCard — represents one agent-proposed file change.
 *
 * The change has already been written to disk as a preview so the user can
 * inspect it directly in the JupyterLab editor.  This card shows the file
 * name, change type and Accept / Reject controls.  The inline diff is
 * available collapsed for quick reference.
 */
import React, { useState } from 'react';
import { FileDiffView } from './FileDiffView';
export const FileChangeCard = ({ event, operationId, apiBaseUrl, xsrfToken, onResolved, }) => {
    const [expanded, setExpanded] = useState(false);
    const [state, setState] = useState(event.content_deferred ? 'pending' : 'loaded');
    const [loadedOriginal, setLoadedOriginal] = useState(event.original_content);
    const [loadedNew, setLoadedNew] = useState(event.new_content);
    const [errorMsg, setErrorMsg] = useState('');
    const effectiveOriginal = loadedOriginal;
    const effectiveNew = loadedNew;
    const handleLoadDiff = async () => {
        setState('loading');
        try {
            const resp = await fetch(`${apiBaseUrl}/varys/agent/change/${encodeURIComponent(event.change_id)}`, { method: 'GET', credentials: 'same-origin' });
            if (!resp.ok)
                throw new Error(`HTTP ${resp.status}`);
            const data = await resp.json();
            setLoadedOriginal(data.original_content);
            setLoadedNew(data.new_content);
            setState('loaded');
            setExpanded(true);
        }
        catch (err) {
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
            }
            else {
                setErrorMsg(data.error || 'Accept failed');
            }
        }
        catch (err) {
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
            }
            else {
                setErrorMsg(data.error || 'Reject failed');
            }
        }
        catch (err) {
            setErrorMsg(`Reject failed: ${err instanceof Error ? err.message : String(err)}`);
        }
    };
    const isResolved = state === 'accepted' || state === 'rejected';
    const changeTypeBadge = event.change_type === 'created' ? 'new'
        : event.change_type === 'deleted' ? 'deleted'
            : 'modified';
    const showDiffBody = (state === 'loaded') ||
        (!event.content_deferred && state !== 'error' && state !== 'pending');
    return (React.createElement("div", { className: `ds-file-change-card ds-file-change-card--${state}` },
        React.createElement("div", { className: "ds-file-change-card__header", onClick: () => !isResolved && setExpanded(e => !e), style: { cursor: isResolved ? 'default' : 'pointer' } },
            React.createElement("span", { className: "ds-file-change-card__toggle" }, expanded ? '▾' : '▸'),
            React.createElement("span", { className: `ds-file-diff-type-badge ds-file-diff-type-badge--${event.change_type}` }, changeTypeBadge),
            React.createElement("span", { className: "ds-file-change-card__path", title: event.file_path }, event.file_path),
            React.createElement("span", { className: "ds-file-change-card__counter" },
                event.index,
                " of ",
                event.total_changes),
            state === 'accepted' && (React.createElement("span", { className: "ds-file-change-card__resolved ds-file-change-card__resolved--accepted" }, "Accepted \u2713")),
            state === 'rejected' && (React.createElement("span", { className: "ds-file-change-card__resolved ds-file-change-card__resolved--rejected" }, "Rejected \u2715"))),
        expanded && !isResolved && (React.createElement("div", { className: "ds-file-change-card__body" },
            event.content_deferred && state === 'pending' && (React.createElement("button", { className: "ds-file-change-card__load-btn", onClick: handleLoadDiff }, "File too large to preview inline \u2014 click to load diff")),
            state === 'loading' && (React.createElement("div", { className: "ds-file-change-card__loading" }, "Loading diff\u2026")),
            showDiffBody && (React.createElement(React.Fragment, null,
                React.createElement(FileDiffView, { filePath: event.file_path, originalContent: effectiveOriginal, newContent: effectiveNew, changeType: event.change_type }),
                event.change_type === 'deleted' && (React.createElement("div", { className: "ds-file-change-card__delete-note" },
                    "\u26A0 Accepting will move this file to ",
                    React.createElement("code", null, ".varys_deleted/"),
                    " (recoverable).")))),
            state === 'error' && (React.createElement("div", { className: "ds-file-change-card__error" }, errorMsg)),
            showDiffBody && (React.createElement("div", { className: "ds-file-change-card__actions" },
                React.createElement("button", { className: "ds-assistant-btn ds-assistant-btn-accept", onClick: handleAccept }, "\u2713 Accept"),
                React.createElement("button", { className: "ds-assistant-btn ds-assistant-btn-undo", onClick: handleReject }, "\u2715 Reject"))))),
        errorMsg && !expanded && (React.createElement("div", { className: "ds-file-change-card__error ds-file-change-card__error--inline" }, errorMsg))));
};

/**
 * Tags Panel — Tag Zoo
 *
 * Tag JSON shape: { "value": string, "topic": string, "description": string, "color": string }
 *
 * Layout:
 *   1. Create Tag form — two-column:
 *        LEFT  — inputs (value · description · topic dropdown · color swatches)
 *        RIGHT — live JSON preview
 *   2. Tag library — two-column:
 *        LEFT  — tags grouped by topic (click to select)
 *        RIGHT — details of selected tag
 */
import React, { useState, useEffect, useCallback, Fragment } from 'react';
// ── JSON syntax highlighter (Python/One-Dark palette) ─────────────────────────
const J = {
    brace: '#abb2bf',
    key: '#61afef',
    str: '#98c379',
    num: '#d19a66',
    kw: '#c678dd', // true / false / null
};
function JsonHighlight({ value }) {
    const json = JSON.stringify(value, null, 2);
    // Token regex: captures keys (string + colon), plain strings, keywords, numbers, punctuation
    const TOKEN = /("(?:[^"\\]|\\.)*")(\s*:)|("(?:[^"\\]|\\.)*")|(true|false|null)|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|([{}\[\],])/g;
    const nodes = [];
    let last = 0;
    let m;
    let idx = 0;
    while ((m = TOKEN.exec(json)) !== null) {
        // Plain text between tokens (whitespace / newlines)
        if (m.index > last) {
            nodes.push(React.createElement(Fragment, { key: `t${idx++}` }, json.slice(last, m.index)));
        }
        if (m[1] && m[2] !== undefined) {
            // "key":
            nodes.push(React.createElement("span", { key: `k${idx++}`, style: { color: J.key } }, m[1]));
            nodes.push(React.createElement("span", { key: `c${idx++}`, style: { color: J.brace } }, m[2]));
        }
        else if (m[3]) {
            nodes.push(React.createElement("span", { key: `s${idx++}`, style: { color: J.str } }, m[3]));
        }
        else if (m[4]) {
            nodes.push(React.createElement("span", { key: `kw${idx++}`, style: { color: J.kw } }, m[4]));
        }
        else if (m[5]) {
            nodes.push(React.createElement("span", { key: `n${idx++}`, style: { color: J.num } }, m[5]));
        }
        else if (m[6]) {
            nodes.push(React.createElement("span", { key: `p${idx++}`, style: { color: J.brace } }, m[6]));
        }
        last = m.index + m[0].length;
    }
    if (last < json.length)
        nodes.push(React.createElement(Fragment, { key: `e${idx}` }, json.slice(last)));
    return React.createElement("pre", { className: "ds-tp-json-hl" }, nodes);
}
// ── Palette & colour helpers ──────────────────────────────────────────────────
export const TAG_PALETTE = [
    '#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6',
    '#06b6d4', '#f97316', '#ec4899', '#14b8a6', '#6366f1',
];
export function tagColorAuto(tag) {
    let h = 0;
    for (let i = 0; i < tag.length; i++)
        h = (h * 31 + tag.charCodeAt(i)) >>> 0;
    return TAG_PALETTE[h % TAG_PALETTE.length];
}
// ── Built-in tag library (each tag carries an explicit topic key) ─────────────
export const BUILT_IN_TAG_DEFS = [
    { category: 'ML Pipeline', tags: [
            { value: 'data-loading', topic: 'ML Pipeline', description: 'Cells that load data from files, databases, or APIs.' },
            { value: 'preprocessing', topic: 'ML Pipeline', description: 'Data cleaning, normalization, and transformation steps.' },
            { value: 'feature-engineering', topic: 'ML Pipeline', description: 'Feature creation, selection, and encoding.' },
            { value: 'training', topic: 'ML Pipeline', description: 'Model training and fitting.' },
            { value: 'evaluation', topic: 'ML Pipeline', description: 'Metrics, validation, and model assessment.' },
            { value: 'inference', topic: 'ML Pipeline', description: 'Prediction or scoring on new data.' },
        ] },
    { category: 'Quality', tags: [
            { value: 'todo', topic: 'Quality', description: 'Cell needs attention or further work.' },
            { value: 'reviewed', topic: 'Quality', description: 'Cell has been reviewed and approved.' },
            { value: 'needs-refactor', topic: 'Quality', description: 'Works but the implementation should be improved.' },
            { value: 'slow', topic: 'Quality', description: 'Computationally slow — candidate for optimization.' },
            { value: 'broken', topic: 'Quality', description: 'Cell is broken or produces errors.' },
            { value: 'tested', topic: 'Quality', description: 'Cell has been verified to produce correct output.' },
        ] },
    { category: 'Report', tags: [
            { value: 'report', topic: 'Report', description: 'Output to include in an exported report.' },
            { value: 'figure', topic: 'Report', description: 'Cell that generates a figure or chart.' },
            { value: 'table', topic: 'Report', description: 'Cell that generates a table.' },
            { value: 'key-finding', topic: 'Report', description: 'Contains an important result or insight.' },
            { value: 'report-exclude', topic: 'Report', description: 'Explicitly exclude from report output.' },
        ] },
    { category: 'Status', tags: [
            { value: 'draft', topic: 'Status', description: 'Work in progress — not finalized.' },
            { value: 'stable', topic: 'Status', description: 'Unlikely to change; safe dependency for other cells.' },
            { value: 'deprecated', topic: 'Status', description: 'No longer needed; kept for reference.' },
            { value: 'sensitive', topic: 'Status', description: 'Contains sensitive data, credentials, or PII.' },
        ] },
];
export const BUILT_IN_TOPICS = BUILT_IN_TAG_DEFS.map(g => g.category);
// ── Custom tag store (localStorage) ──────────────────────────────────────────
const CUSTOM_TAGS_KEY = 'varys_custom_tag_definitions';
export function loadCustomTags() {
    try {
        const raw = localStorage.getItem(CUSTOM_TAGS_KEY);
        if (!raw)
            return [];
        const parsed = JSON.parse(raw);
        return parsed.map(r => {
            var _a, _b, _c, _d;
            return ({
                value: (_b = (_a = r['value']) !== null && _a !== void 0 ? _a : r['name']) !== null && _b !== void 0 ? _b : '',
                topic: (_c = r['topic']) !== null && _c !== void 0 ? _c : 'Custom',
                description: (_d = r['description']) !== null && _d !== void 0 ? _d : '',
                color: r['color'],
            });
        }).filter(t => t.value);
    }
    catch (_a) {
        return [];
    }
}
function saveCustomTagsToStorage(tags) {
    localStorage.setItem(CUSTOM_TAGS_KEY, JSON.stringify(tags));
}
function resolveColor(tagValue, customTags) {
    var _a;
    const custom = customTags.find(t => t.value === tagValue);
    return (_a = custom === null || custom === void 0 ? void 0 : custom.color) !== null && _a !== void 0 ? _a : tagColorAuto(tagValue);
}
function findMeta(tagValue, customTags) {
    const custom = customTags.find(t => t.value === tagValue);
    if (custom)
        return { description: custom.description, topic: custom.topic };
    for (const group of BUILT_IN_TAG_DEFS) {
        const found = group.tags.find(t => t.value === tagValue);
        if (found)
            return { description: found.description, topic: found.topic };
    }
    return { description: '', topic: '' };
}
// ── ColorPicker ───────────────────────────────────────────────────────────────
const ColorPicker = ({ value, onChange }) => (React.createElement("div", { className: "ds-tp-color-picker" }, TAG_PALETTE.map(c => (React.createElement("button", { key: c, className: `ds-tp-color-swatch${value === c ? ' ds-tp-color-swatch--active' : ''}`, style: { background: c }, onClick: () => onChange(c), title: c, type: "button" })))));
// ── TagPill ───────────────────────────────────────────────────────────────────
const TagPill = ({ tagValue, color, selected, onClick }) => (React.createElement("button", { className: `ds-tp-pill${selected ? ' ds-tp-pill--selected' : ''}`, style: { '--pill-color': color }, onClick: onClick, title: tagValue }, tagValue));
export const TagsPanel = ({ notebookTracker }) => {
    const [customTags, setCustomTags] = useState(loadCustomTags);
    const [selectedTag, setSelectedTag] = useState(null);
    // Create form
    const [newValue, setNewValue] = useState('');
    const [newDesc, setNewDesc] = useState('');
    const [newTopic, setNewTopic] = useState('');
    const [newColor, setNewColor] = useState(TAG_PALETTE[0]);
    const [nameErr, setNameErr] = useState('');
    // Edit mode (details panel)
    const [editMode, setEditMode] = useState(false);
    const [editDesc, setEditDesc] = useState('');
    const [editTopic, setEditTopic] = useState('');
    const [editColor, setEditColor] = useState(TAG_PALETTE[0]);
    // Keep in sync if Settings panel also writes custom tags
    const syncFromStorage = useCallback(() => { setCustomTags(loadCustomTags()); }, []);
    useEffect(() => {
        window.addEventListener('storage', syncFromStorage);
        return () => window.removeEventListener('storage', syncFromStorage);
    }, [syncFromStorage]);
    useEffect(() => {
        const noop = () => { };
        notebookTracker.currentChanged.connect(noop);
        return () => { notebookTracker.currentChanged.disconnect(noop); };
    }, [notebookTracker]);
    // ── All built-in values for duplicate check ───────────────────────────────
    const allBuiltInValues = [].concat(...BUILT_IN_TAG_DEFS.map(g => g.tags.map(t => t.value)));
    // ── Create ────────────────────────────────────────────────────────────────
    const createTag = () => {
        const raw = newValue.trim().toLowerCase().replace(/\s+/g, '-');
        if (!raw) {
            setNameErr('Value is required.');
            return;
        }
        if (!/^[a-z0-9][\w\-.]*$/.test(raw)) {
            setNameErr('Only a-z, 0-9, - or _ allowed.');
            return;
        }
        if (!newTopic) {
            setNameErr('Topic is required.');
            return;
        }
        if (allBuiltInValues.includes(raw)) {
            setNameErr('Already a built-in tag.');
            return;
        }
        if (customTags.some(t => t.value === raw)) {
            setNameErr('Custom tag already exists.');
            return;
        }
        const tag = { value: raw, topic: newTopic, description: newDesc.trim(), color: newColor };
        const updated = [...customTags, tag];
        setCustomTags(updated);
        saveCustomTagsToStorage(updated);
        setNewValue('');
        setNewDesc('');
        setNewTopic('');
        setNewColor(TAG_PALETTE[0]);
        setNameErr('');
        setSelectedTag(raw);
    };
    // ── Delete ────────────────────────────────────────────────────────────────
    const deleteCustomTag = (tagValue) => {
        const updated = customTags.filter(t => t.value !== tagValue);
        setCustomTags(updated);
        saveCustomTagsToStorage(updated);
        if (selectedTag === tagValue)
            setSelectedTag(null);
        setEditMode(false);
    };
    // ── Edit ──────────────────────────────────────────────────────────────────
    const beginEdit = (tag) => {
        var _a;
        setEditDesc(tag.description);
        setEditTopic(tag.topic);
        setEditColor((_a = tag.color) !== null && _a !== void 0 ? _a : tagColorAuto(tag.value));
        setEditMode(true);
    };
    const saveEdit = () => {
        if (!selectedTag)
            return;
        const updated = customTags.map(t => t.value === selectedTag
            ? Object.assign(Object.assign({}, t), { description: editDesc.trim(), topic: editTopic, color: editColor }) : t);
        setCustomTags(updated);
        saveCustomTagsToStorage(updated);
        setEditMode(false);
    };
    const cancelEdit = () => setEditMode(false);
    // Exit edit mode whenever selection changes
    useEffect(() => { setEditMode(false); }, [selectedTag]);
    // ── Selected tag meta ─────────────────────────────────────────────────────
    const isCustom = selectedTag ? customTags.some(t => t.value === selectedTag) : false;
    const selColor = selectedTag ? resolveColor(selectedTag, customTags) : TAG_PALETTE[0];
    const { description: selDesc, topic: selTopic } = selectedTag
        ? findMeta(selectedTag, customTags)
        : { description: '', topic: '' };
    // ── Render ────────────────────────────────────────────────────────────────
    return (React.createElement("div", { className: "ds-tags-panel ds-tags-panel-v2" },
        React.createElement("div", { className: "ds-tp-create-section" },
            React.createElement("div", { className: "ds-tp-create-header" }, "New Tag"),
            React.createElement("div", { className: "ds-tp-create-body" },
                React.createElement("div", { className: "ds-tp-create-inputs" },
                    React.createElement("input", { className: "ds-tp-name-input", placeholder: "tag-value", value: newValue, onChange: e => { setNewValue(e.target.value); setNameErr(''); }, onKeyDown: e => { if (e.key === 'Enter')
                            createTag(); } }),
                    React.createElement("textarea", { className: "ds-tp-desc-input", placeholder: "Description", value: newDesc, rows: 2, onChange: e => setNewDesc(e.target.value) }),
                    React.createElement("select", { className: "ds-tp-topic-select", value: newTopic, onChange: e => setNewTopic(e.target.value) },
                        React.createElement("option", { value: "" }, "\u2014 Topic \u2014"),
                        BUILT_IN_TOPICS.map(t => (React.createElement("option", { key: t, value: t }, t)))),
                    React.createElement(ColorPicker, { value: newColor, onChange: setNewColor }),
                    nameErr && React.createElement("p", { className: "ds-tp-error" }, nameErr),
                    React.createElement("button", { className: "ds-tp-create-btn", onClick: createTag, disabled: !newValue.trim() || !newTopic }, "+ Create")),
                React.createElement("div", { className: "ds-tp-create-preview" },
                    React.createElement("div", { className: "ds-tp-preview-label" }, "Preview"),
                    React.createElement("div", { className: "ds-tp-preview-json" },
                        React.createElement(JsonHighlight, { value: {
                                value: newValue.trim() || '…',
                                topic: newTopic || '…',
                                description: newDesc.trim() || '…',
                                color: newColor,
                            } }))))),
        React.createElement("div", { className: "ds-tp-library-header" }, "Tag Library"),
        React.createElement("div", { className: "ds-tp-body" },
            React.createElement("div", { className: "ds-tp-list" },
                customTags.length > 0 && (React.createElement("div", { className: "ds-tp-group" },
                    React.createElement("div", { className: "ds-tp-group-label" }, "Custom"),
                    React.createElement("div", { className: "ds-tp-group-pills" }, customTags.map(t => {
                        var _a;
                        return (React.createElement(TagPill, { key: t.value, tagValue: t.value, color: (_a = t.color) !== null && _a !== void 0 ? _a : tagColorAuto(t.value), selected: selectedTag === t.value, onClick: () => setSelectedTag(t.value) }));
                    })))),
                BUILT_IN_TAG_DEFS.map(group => (React.createElement("div", { key: group.category, className: "ds-tp-group" },
                    React.createElement("div", { className: "ds-tp-group-label" }, group.category),
                    React.createElement("div", { className: "ds-tp-group-pills" }, group.tags.map(t => (React.createElement(TagPill, { key: t.value, tagValue: t.value, color: tagColorAuto(t.value), selected: selectedTag === t.value, onClick: () => setSelectedTag(t.value) })))))))),
            React.createElement("div", { className: "ds-tp-details" }, selectedTag ? (React.createElement(React.Fragment, null,
                React.createElement("span", { className: "ds-tp-details-pill", style: { '--pill-color': editMode ? editColor : selColor } }, selectedTag),
                editMode ? (
                /* ── Edit mode ──────────────────────────────────────── */
                React.createElement(React.Fragment, null,
                    React.createElement(ColorPicker, { value: editColor, onChange: setEditColor }),
                    React.createElement("input", { className: "ds-tp-edit-input", placeholder: "Description", value: editDesc, onChange: e => setEditDesc(e.target.value) }),
                    React.createElement("select", { className: "ds-tp-edit-select", value: editTopic, onChange: e => setEditTopic(e.target.value) },
                        React.createElement("option", { value: "" }, "\u2014 Topic \u2014"),
                        BUILT_IN_TOPICS.map(t => (React.createElement("option", { key: t, value: t }, t)))),
                    React.createElement("div", { className: "ds-tp-edit-actions" },
                        React.createElement("button", { className: "ds-tp-edit-save-btn", onClick: saveEdit }, "\u2713 Save"),
                        React.createElement("button", { className: "ds-tp-edit-cancel-btn", onClick: cancelEdit }, "\u2715")))) : (
                /* ── View mode ──────────────────────────────────────── */
                React.createElement(React.Fragment, null,
                    React.createElement("div", { className: "ds-tp-details-color-row" },
                        React.createElement("span", { className: "ds-tp-details-swatch", style: { background: selColor } }),
                        React.createElement("span", { className: "ds-tp-details-hex" }, selColor)),
                    React.createElement("div", { className: "ds-tp-details-json" },
                        React.createElement(JsonHighlight, { value: { value: selectedTag, topic: selTopic, description: selDesc, color: selColor } })),
                    selDesc ? (React.createElement("p", { className: "ds-tp-details-desc" }, selDesc)) : (React.createElement("p", { className: "ds-tp-details-desc ds-tp-details-desc--empty" }, "No description.")),
                    isCustom && (React.createElement("div", { className: "ds-tp-details-actions" },
                        React.createElement("button", { className: "ds-tp-details-edit-btn", onClick: () => beginEdit(customTags.find(t => t.value === selectedTag)) }, "\u270E Edit"),
                        React.createElement("button", { className: "ds-tp-details-del-btn", onClick: () => deleteCustomTag(selectedTag) }, "\uD83D\uDDD1"))))))) : (React.createElement("p", { className: "ds-tp-details-hint" }, "\u2190 Select a tag"))))));
};

/**
 * Cell Tag & Position Overlay
 *
 * Injects a thin bar at the top of every notebook cell that shows:
 *   • LEFT  — coloured tag pills + a [+] button to add tags inline
 *   • RIGHT — a small "#N" position badge (always, on every cell)
 *
 * Clicking a tag pill enters "delete mode" — the pill expands to show an ×
 * button. Clicking × removes the tag from cell metadata and re-renders.
 *
 * Clicking [+] opens a floating dropdown with:
 *   • A text input to type/create a new custom tag
 *   • Tags already used elsewhere in the notebook (quick-add)
 *   • Built-in preset groups (ML Pipeline, Quality, Report, Status)
 *   Only tags NOT already applied to the cell are shown.
 *
 * Re-renders are suppressed while the dropdown or a pending-delete pill is
 * open so the user can interact without the DOM being destroyed under them.
 */
const OVERLAY_CLASS = 'ds-cell-tag-overlay';
const INTERVAL_MS = 1500;
/**
 * Resolve the stable JupyterLab UUID and current notebook path for a cell
 * at *cellIndex*, then call *onTagsChanged* with the new *tags* list.
 * Safe to call with a null/undefined callback — becomes a no-op.
 */
function fireTagsChanged(tracker, cellIndex, tags, onTagsChanged) {
    var _a, _b, _c, _d, _e, _f, _g, _h;
    if (!onTagsChanged)
        return;
    const nb = (_a = tracker.currentWidget) === null || _a === void 0 ? void 0 : _a.content;
    const cellModel = (_b = nb === null || nb === void 0 ? void 0 : nb.model) === null || _b === void 0 ? void 0 : _b.cells.get(cellIndex);
    const cellId = (_e = (_c = cellModel === null || cellModel === void 0 ? void 0 : cellModel.id) !== null && _c !== void 0 ? _c : (_d = cellModel === null || cellModel === void 0 ? void 0 : cellModel.sharedModel) === null || _d === void 0 ? void 0 : _d.id) !== null && _e !== void 0 ? _e : '';
    const notebookPath = (_h = (_g = (_f = tracker.currentWidget) === null || _f === void 0 ? void 0 : _f.context) === null || _g === void 0 ? void 0 : _g.path) !== null && _h !== void 0 ? _h : '';
    if (cellId && notebookPath) {
        onTagsChanged(cellId, notebookPath, tags);
    }
}
/** Cells currently waiting for an auto-tag response (by cell index). */
const _autoTagPending = new Set();
const TAG_PALETTE = [
    '#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6',
    '#06b6d4', '#f97316', '#ec4899', '#14b8a6', '#6366f1',
];
const BUILT_IN_PRESETS = [
    { category: 'ML Pipeline', tags: ['data-loading', 'preprocessing', 'feature-engineering', 'training', 'evaluation', 'inference'] },
    { category: 'Quality', tags: ['todo', 'reviewed', 'needs-refactor', 'slow', 'broken', 'tested'] },
    { category: 'Report', tags: ['report', 'figure', 'table', 'key-finding', 'report-exclude'] },
    { category: 'Status', tags: ['draft', 'stable', 'deprecated', 'sensitive'] },
];
function tagColor(tag) {
    let h = 0;
    for (let i = 0; i < tag.length; i++)
        h = (h * 31 + tag.charCodeAt(i)) >>> 0;
    return TAG_PALETTE[h % TAG_PALETTE.length];
}
// ── Cell output extraction ─────────────────────────────────────────────────
/**
 * Extract a plain-text summary of a code cell's outputs (max ~2 000 chars).
 * Returns null for non-code cells or cells with no outputs.
 */
function extractCellOutputText(cellWidget) {
    var _a, _b, _c, _d, _e, _f;
    const model = cellWidget === null || cellWidget === void 0 ? void 0 : cellWidget.model;
    if ((model === null || model === void 0 ? void 0 : model.type) !== 'code')
        return null;
    const outputs = model.outputs;
    if (!outputs || outputs.length === 0)
        return null;
    const parts = [];
    for (let i = 0; i < outputs.length; i++) {
        const out = outputs.get ? outputs.get(i) : outputs[i];
        if (!out)
            continue;
        const raw = typeof out.toJSON === 'function' ? out.toJSON() : out;
        const otype = (_a = raw === null || raw === void 0 ? void 0 : raw.output_type) !== null && _a !== void 0 ? _a : '';
        if (otype === 'stream') {
            const t = (_b = raw.text) !== null && _b !== void 0 ? _b : '';
            parts.push(Array.isArray(t) ? t.join('') : String(t));
        }
        else if (otype === 'execute_result' || otype === 'display_data') {
            const plain = (_d = (_c = raw.data) === null || _c === void 0 ? void 0 : _c['text/plain']) !== null && _d !== void 0 ? _d : '';
            parts.push(Array.isArray(plain) ? plain.join('') : String(plain));
        }
        else if (otype === 'error') {
            parts.push(`${(_e = raw.ename) !== null && _e !== void 0 ? _e : 'Error'}: ${(_f = raw.evalue) !== null && _f !== void 0 ? _f : ''}`);
        }
    }
    const full = parts.join('\n').trim();
    return full ? full.slice(0, 2000) : null;
}
// ── Dropdown state ─────────────────────────────────────────────────────────
let _activeDropdown = null;
function closeDropdown() {
    if (_activeDropdown) {
        _activeDropdown.remove();
        _activeDropdown = null;
    }
}
function isDropdownOpen() {
    return _activeDropdown !== null;
}
// ── Overlay helpers ────────────────────────────────────────────────────────
/** Remove all existing overlays from the page. */
function clearOverlays() {
    document.querySelectorAll(`.${OVERLAY_CLASS}`).forEach(el => el.remove());
}
/** Collect every unique tag used anywhere in the current notebook. */
function getAllNotebookTags(tracker) {
    var _a, _b;
    const nb = (_a = tracker.currentWidget) === null || _a === void 0 ? void 0 : _a.content;
    if (!(nb === null || nb === void 0 ? void 0 : nb.model))
        return [];
    const seen = new Set();
    for (let i = 0; i < nb.model.cells.length; i++) {
        const t = (_b = nb.model.cells.get(i).metadata['tags']) !== null && _b !== void 0 ? _b : [];
        t.forEach(tag => seen.add(tag));
    }
    return [...seen].sort();
}
/** Write a new tags array to a cell model, removing the key when empty. */
function writeTags(cellModel, tags) {
    var _a, _b;
    if (tags.length > 0) {
        cellModel.setMetadata('tags', tags);
    }
    else {
        try {
            (_b = (_a = cellModel.deleteMetadata) === null || _a === void 0 ? void 0 : _a.call(cellModel, 'tags')) !== null && _b !== void 0 ? _b : cellModel.setMetadata('tags', undefined);
        }
        catch (_c) {
            cellModel.setMetadata('tags', []);
        }
    }
}
// ── [+] dropdown ───────────────────────────────────────────────────────────
function showAddTagDropdown(anchor, tracker, cellIndex, currentTags, refresh, onTagsChanged) {
    closeDropdown();
    const applyTag = (tag) => {
        var _a;
        const nb = (_a = tracker.currentWidget) === null || _a === void 0 ? void 0 : _a.content;
        if (!(nb === null || nb === void 0 ? void 0 : nb.model))
            return;
        const cm = nb.model.cells.get(cellIndex);
        if (!cm)
            return;
        const newTags = [...currentTags, tag];
        writeTags(cm, newTags);
        fireTagsChanged(tracker, cellIndex, newTags, onTagsChanged);
        closeDropdown();
        refresh();
    };
    const rect = anchor.getBoundingClientRect();
    const dropdown = document.createElement('div');
    dropdown.className = 'ds-tag-add-dropdown';
    // Position just below the + button, left-aligned with it
    dropdown.style.top = `${rect.bottom + 3}px`;
    dropdown.style.left = `${rect.left}px`;
    // ── Custom input ──────────────────────────────────────────────────────────
    const inputRow = document.createElement('div');
    inputRow.className = 'ds-tag-add-input-row';
    const input = document.createElement('input');
    input.className = 'ds-tag-add-input';
    input.placeholder = 'Type tag name…';
    input.autocomplete = 'off';
    input.spellcheck = false;
    const addBtn = document.createElement('button');
    addBtn.className = 'ds-tag-add-confirm-btn';
    addBtn.textContent = '+ Add';
    addBtn.disabled = true;
    const errorMsg = document.createElement('p');
    errorMsg.className = 'ds-tag-add-error';
    const validateAndApply = () => {
        const raw = input.value.trim().toLowerCase().replace(/\s+/g, '-');
        if (!raw)
            return;
        if (!/^[a-z0-9][\w\-.]*$/.test(raw)) {
            errorMsg.textContent = 'Only a-z, 0-9, - or _ allowed.';
            return;
        }
        if (currentTags.includes(raw)) {
            errorMsg.textContent = 'Tag already on this cell.';
            return;
        }
        applyTag(raw);
    };
    input.addEventListener('input', () => {
        const raw = input.value.trim().toLowerCase().replace(/\s+/g, '-');
        addBtn.disabled = !raw || currentTags.includes(raw);
        errorMsg.textContent = '';
    });
    input.addEventListener('keydown', e => {
        if (e.key === 'Enter') {
            e.preventDefault();
            validateAndApply();
        }
        if (e.key === 'Escape') {
            e.preventDefault();
            closeDropdown();
        }
        e.stopPropagation();
    });
    addBtn.addEventListener('click', e => { e.stopPropagation(); validateAndApply(); });
    inputRow.appendChild(input);
    inputRow.appendChild(addBtn);
    dropdown.appendChild(inputRow);
    dropdown.appendChild(errorMsg);
    // ── Notebook tags (quick-add) ─────────────────────────────────────────────
    const notebookTags = getAllNotebookTags(tracker).filter(t => !currentTags.includes(t));
    if (notebookTags.length > 0) {
        dropdown.appendChild(buildTagSection('In notebook', notebookTags, applyTag));
    }
    // ── Preset groups ─────────────────────────────────────────────────────────
    for (const preset of BUILT_IN_PRESETS) {
        const available = preset.tags.filter(t => !currentTags.includes(t));
        if (available.length > 0) {
            dropdown.appendChild(buildTagSection(preset.category, available, applyTag));
        }
    }
    // Apply night-mode class when Varys sidebar is in night mode
    if (document.querySelector('.ds-chat-night')) {
        dropdown.classList.add('ds-tag-add-dropdown--night');
    }
    document.body.appendChild(dropdown);
    _activeDropdown = dropdown;
    // Auto-focus the input so user can type immediately
    requestAnimationFrame(() => input.focus());
    // Close on outside click
    const onOutside = (ev) => {
        if (!dropdown.contains(ev.target) && ev.target !== anchor) {
            closeDropdown();
            document.removeEventListener('mousedown', onOutside, true);
        }
    };
    document.addEventListener('mousedown', onOutside, true);
}
function buildTagSection(title, tags, onSelect) {
    const section = document.createElement('div');
    section.className = 'ds-tag-add-section';
    const heading = document.createElement('div');
    heading.className = 'ds-tag-add-section-title';
    heading.textContent = title;
    section.appendChild(heading);
    const chips = document.createElement('div');
    chips.className = 'ds-tag-add-chips';
    for (const tag of tags) {
        const chip = document.createElement('button');
        chip.className = 'ds-tag-add-chip';
        chip.textContent = tag;
        chip.style.setProperty('--pill-color', tagColor(tag));
        chip.addEventListener('click', e => { e.stopPropagation(); onSelect(tag); });
        chips.appendChild(chip);
    }
    section.appendChild(chips);
    return section;
}
// ── Tag deletion helpers ───────────────────────────────────────────────────
function deleteTag(tracker, cellIndex, tagToRemove, refresh, onTagsChanged) {
    var _a, _b;
    const nb = (_a = tracker.currentWidget) === null || _a === void 0 ? void 0 : _a.content;
    if (!(nb === null || nb === void 0 ? void 0 : nb.model))
        return;
    const cm = nb.model.cells.get(cellIndex);
    if (!cm)
        return;
    const current = (_b = cm.metadata['tags']) !== null && _b !== void 0 ? _b : [];
    const newTags = current.filter(t => t !== tagToRemove);
    writeTags(cm, newTags);
    fireTagsChanged(tracker, cellIndex, newTags, onTagsChanged);
    refresh();
}
// ── Main render ────────────────────────────────────────────────────────────
function renderOverlays(tracker, refresh, onAutoTag, onTagsChanged) {
    var _a, _b;
    // Suppress re-render while user is interacting (dropdown open or pill pending)
    if (isDropdownOpen())
        return;
    if (document.querySelector('.ds-cell-tag-pill--pending'))
        return;
    clearOverlays();
    const nb = (_a = tracker.currentWidget) === null || _a === void 0 ? void 0 : _a.content;
    if (!(nb === null || nb === void 0 ? void 0 : nb.model))
        return;
    const total = nb.model.cells.length;
    for (let i = 0; i < total; i++) {
        const cellModel = nb.model.cells.get(i);
        const cellWidget = nb.widgets[i];
        if (!cellWidget)
            continue;
        const tags = (_b = cellModel.metadata['tags']) !== null && _b !== void 0 ? _b : [];
        const inputWrapper = cellWidget.node.querySelector('.jp-Cell-inputWrapper');
        if (!inputWrapper)
            continue;
        const bar = document.createElement('div');
        bar.className = OVERLAY_CLASS;
        // ── Left group: existing pills + [+] button + [✨] button ────────────
        const leftGroup = document.createElement('span');
        leftGroup.className = 'ds-overlay-tags';
        // Existing tag pills
        for (const tag of tags) {
            const cellIdx = i;
            const pill = document.createElement('span');
            pill.className = 'ds-cell-tag-pill';
            pill.style.setProperty('--pill-color', tagColor(tag));
            pill.style.pointerEvents = 'auto';
            pill.style.cursor = 'pointer';
            pill.title = `Click to remove "${tag}"`;
            const label = document.createElement('span');
            label.className = 'ds-cell-tag-pill-label';
            label.textContent = tag;
            const removeBtn = document.createElement('span');
            removeBtn.className = 'ds-cell-tag-pill-remove';
            removeBtn.textContent = '×';
            removeBtn.title = `Remove "${tag}"`;
            pill.appendChild(label);
            pill.appendChild(removeBtn);
            let pending = false;
            pill.addEventListener('click', e => {
                e.stopPropagation();
                closeDropdown();
                if (pending) {
                    pending = false;
                    pill.classList.remove('ds-cell-tag-pill--pending');
                }
                else {
                    pending = true;
                    pill.classList.add('ds-cell-tag-pill--pending');
                    const onOutside = (ev) => {
                        if (!pill.contains(ev.target)) {
                            pending = false;
                            pill.classList.remove('ds-cell-tag-pill--pending');
                            document.removeEventListener('click', onOutside, true);
                        }
                    };
                    document.addEventListener('click', onOutside, true);
                }
            });
            removeBtn.addEventListener('click', e => {
                e.stopPropagation();
                // Clear pending state first so the renderOverlays guard does not
                // suppress the re-render that follows deleteTag → refresh().
                pending = false;
                pill.classList.remove('ds-cell-tag-pill--pending');
                deleteTag(tracker, cellIdx, tag, refresh, onTagsChanged);
            });
            leftGroup.appendChild(pill);
        }
        // [+] add button — always shown, moves right as pills accumulate
        const addBtn = document.createElement('button');
        addBtn.className = 'ds-overlay-add-btn';
        addBtn.textContent = '+';
        addBtn.title = 'Add tag';
        addBtn.style.pointerEvents = 'auto';
        const cellIdx = i;
        addBtn.addEventListener('click', e => {
            e.stopPropagation();
            showAddTagDropdown(addBtn, tracker, cellIdx, [...tags], refresh, onTagsChanged);
        });
        leftGroup.appendChild(addBtn);
        // [✨] auto-tag button — only shown when a callback is registered
        if (onAutoTag) {
            const isPending = _autoTagPending.has(cellIdx);
            const autoBtn = document.createElement('button');
            autoBtn.className = 'ds-overlay-autotag-btn' + (isPending ? ' ds-overlay-autotag-btn--loading' : '');
            autoBtn.title = isPending ? 'Suggesting tags…' : 'Auto-suggest tags (AI)';
            if (isPending) {
                autoBtn.textContent = '⋯';
            }
            else {
                autoBtn.innerHTML = `<svg width="9" height="9" viewBox="0 0 24 24" fill="none"
          stroke="currentColor" stroke-width="2.5"
          stroke-linecap="round" stroke-linejoin="round">
          <path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/>
          <line x1="7" y1="7" x2="7.01" y2="7"/>
        </svg>`;
            }
            autoBtn.disabled = isPending;
            autoBtn.style.pointerEvents = 'auto';
            autoBtn.addEventListener('click', async (e) => {
                var _a, _b, _c, _d;
                e.stopPropagation();
                if (_autoTagPending.has(cellIdx))
                    return;
                _autoTagPending.add(cellIdx);
                refresh(); // show spinner immediately
                try {
                    const source = ((_c = (_b = (_a = cellModel.sharedModel) === null || _a === void 0 ? void 0 : _a.getSource) === null || _b === void 0 ? void 0 : _b.call(_a)) !== null && _c !== void 0 ? _c : '');
                    const output = extractCellOutputText(cellWidget);
                    const suggested = await onAutoTag(source, output);
                    if (suggested.length > 0) {
                        const current = (_d = cellModel.metadata['tags']) !== null && _d !== void 0 ? _d : [];
                        const merged = [...new Set([...current, ...suggested])];
                        writeTags(cellModel, merged);
                        fireTagsChanged(tracker, cellIdx, merged, onTagsChanged);
                    }
                }
                catch (err) {
                    console.warn('[Varys] auto-tag failed:', err);
                }
                finally {
                    _autoTagPending.delete(cellIdx);
                    refresh();
                }
            });
            leftGroup.appendChild(autoBtn);
        }
        bar.appendChild(leftGroup);
        // ── Right: position badge "#N" ────────────────────────────────────────
        const badge = document.createElement('span');
        badge.className = 'ds-cell-position-badge';
        badge.textContent = `#${i + 1}`;
        bar.appendChild(badge);
        cellWidget.node.insertBefore(bar, inputWrapper);
    }
}
// ── Signal wiring ──────────────────────────────────────────────────────────
let _disconnectModelSignal = null;
function connectModelSignal(tracker, refresh) {
    var _a, _b;
    _disconnectModelSignal === null || _disconnectModelSignal === void 0 ? void 0 : _disconnectModelSignal();
    _disconnectModelSignal = null;
    const model = (_b = (_a = tracker.currentWidget) === null || _a === void 0 ? void 0 : _a.content) === null || _b === void 0 ? void 0 : _b.model;
    if (!model)
        return;
    const handler = (_, __) => refresh();
    model.cells.changed.connect(handler);
    _disconnectModelSignal = () => model.cells.changed.disconnect(handler);
}
/**
 * Initialise the cell tag + position overlay system.
 * Call once from the main plugin activate() function.
 *
 * @param tracker       JupyterLab notebook tracker
 * @param onAutoTag     Optional callback that calls the backend auto-tag API.
 *                      When provided, a ⚡ button is rendered on every cell.
 * @returns Cleanup function to remove overlays and disconnect signals.
 */
export function initCellTagOverlay(tracker, onAutoTag, onTagsChanged) {
    const refresh = () => renderOverlays(tracker, refresh, onAutoTag, onTagsChanged);
    const onNotebookChanged = () => {
        closeDropdown();
        connectModelSignal(tracker, refresh);
        refresh();
    };
    tracker.activeCellChanged.connect(refresh);
    tracker.currentChanged.connect(onNotebookChanged);
    connectModelSignal(tracker, refresh);
    const timer = setInterval(refresh, INTERVAL_MS);
    refresh();
    return () => {
        tracker.activeCellChanged.disconnect(refresh);
        tracker.currentChanged.disconnect(onNotebookChanged);
        _disconnectModelSignal === null || _disconnectModelSignal === void 0 ? void 0 : _disconnectModelSignal();
        _disconnectModelSignal = null;
        clearInterval(timer);
        closeDropdown();
        clearOverlays();
    };
}

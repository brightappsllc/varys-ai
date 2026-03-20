// ─── C: Semantic label extraction from source code ───────────────────────────
/**
 * Split cell source into "plot segments" by detecting plt.show() / plt.close()
 * calls, then extract a semantic label for each segment.
 *
 * Returns an array of labels — one per image output, in order.
 * Labels fall back to '' when nothing useful can be extracted.
 */
export function extractPlotLabels(source) {
    // Patterns that signal the end of one plot and the start of the next
    const showSplit = /plt\s*\.\s*(?:show|close|figure)\s*\(/g;
    const segments = [];
    let last = 0;
    let m;
    while ((m = showSplit.exec(source)) !== null) {
        segments.push(source.slice(last, m.index));
        last = m.index + m[0].length;
    }
    // Don't push the trailing segment (it's after the last plt.show)
    return segments.map(seg => {
        // 1. plt.title('…') or plt.suptitle('…')
        let match = seg.match(/plt\s*\.\s*(?:title|suptitle)\s*\(\s*['"`]([^'"`\n]+)['"`]/);
        if (match)
            return match[1].trim();
        // 2. ax.set_title('…') or axes.set_title('…')
        match = seg.match(/\.\s*set_title\s*\(\s*['"`]([^'"`\n]+)['"`]/);
        if (match)
            return match[1].trim();
        // 3. seaborn title= keyword
        match = seg.match(/\btitle\s*=\s*['"`]([^'"`\n]+)['"`]/);
        if (match)
            return match[1].trim();
        // 4. f-string or variable title: title=f'…'  (simplified)
        match = seg.match(/\btitle\s*=\s*f['"`]([^'"`\n]+)['"`]/);
        if (match)
            return match[1].replace(/\{[^}]+\}/g, '…').trim();
        // 5. df['col'].hist/plot/bar/scatter → "col histogram"
        match = seg.match(/\[['"`]([^'"`]+)['"`]\]\s*\.\s*(hist|plot|bar|scatter|boxplot|violinplot|kde)/);
        if (match)
            return `${match[1]} ${match[2]}`;
        // 6. sns.xxx(…, y='col', …) or sns.xxx(…, x='col', …)
        match = seg.match(/sns\s*\.\s*\w+\s*\([^)]*?[yx]\s*=\s*['"`]([^'"`]+)['"`]/);
        if (match)
            return match[1].trim();
        // 7. Well-known function name → humanise it
        match = seg.match(/\b(plot_\w+|draw_\w+|show_\w+|visualize_\w+|display_\w+)\s*\(/);
        if (match)
            return match[1].replace(/_/g, ' ');
        return '';
    });
}
/** Determine the dominant MIME type for a single output model object. */
function dominantMime(output) {
    var _a, _b, _c, _d, _e, _f;
    // JupyterLab wraps nbformat dicts in IOutputModel objects.
    // toJSON() returns the underlying plain nbformat dict with all fields intact.
    const raw = typeof output.toJSON === 'function' ? output.toJSON() : output;
    const type = (_d = (_c = (_b = (_a = raw.output_type) !== null && _a !== void 0 ? _a : raw.type) !== null && _b !== void 0 ? _b : output.output_type) !== null && _c !== void 0 ? _c : output.type) !== null && _d !== void 0 ? _d : '';
    if (type === 'stream')
        return 'text/plain';
    if (type === 'error')
        return 'error';
    const data = (_f = (_e = raw.data) !== null && _e !== void 0 ? _e : output.data) !== null && _f !== void 0 ? _f : {};
    if (data['image/png'])
        return 'image/png';
    if (data['image/jpeg'])
        return 'image/jpeg';
    if (data['image/svg+xml'])
        return 'image/svg+xml';
    if (data['text/html'])
        return 'text/html';
    if (data['application/vnd.plotly.v1+json'])
        return 'application/vnd.plotly.v1+json';
    if (data['text/plain'])
        return 'text/plain';
    return 'unknown';
}
/** Extract a plain-text representation of a table/HTML output for the LLM. */
function tableToText(output) {
    var _a, _b;
    const data = (_a = output.data) !== null && _a !== void 0 ? _a : {};
    const html = data['text/html'];
    if (html) {
        const raw = Array.isArray(html) ? html.join('') : String(html);
        // Strip HTML tags, collapse whitespace
        return raw
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s+/g, ' ')
            .slice(0, 3000)
            .trim();
    }
    const plain = (_b = data['text/plain']) !== null && _b !== void 0 ? _b : '';
    const text = Array.isArray(plain) ? plain.join('') : String(plain);
    return text.slice(0, 3000).trim();
}
/** Extract raw base64 from an image output (strips data-URI prefix). */
function extractBase64(output) {
    var _a, _b;
    // JupyterLab wraps nbformat dicts in IOutputModel objects whose .data
    // property may not be a plain dict.  toJSON() returns the raw nbformat
    // dict reliably — same pattern used in NotebookReader._extractOutputImpl.
    const raw = typeof output.toJSON === 'function' ? output.toJSON() : output;
    const data = (_b = (_a = raw.data) !== null && _a !== void 0 ? _a : output.data) !== null && _b !== void 0 ? _b : {};
    const png = data['image/png'];
    const jpeg = data['image/jpeg'];
    const src = png !== null && png !== void 0 ? png : jpeg;
    if (!src)
        return undefined;
    const str = Array.isArray(src) ? src.join('') : String(src);
    return str.replace(/^data:image\/[^;]+;base64,/, '').trim();
}
// ─── E: Badge injection ───────────────────────────────────────────────────────
const BADGE_ATTR = 'data-ds-output-idx';
const MENU_CLASS = 'ds-output-ctx-menu';
function makeBadge(idx, label, mime) {
    const badge = document.createElement('div');
    badge.className = mime === 'error'
        ? 'ds-output-badge ds-output-badge--error'
        : 'ds-output-badge';
    badge.setAttribute(BADGE_ATTR, String(idx));
    const typeIcon = mime.startsWith('image') ? '📊'
        : mime === 'text/html' ? '📋'
            : mime === 'error' ? '🔴'
                : '📝';
    badge.innerHTML =
        `<span class="ds-output-badge-num">[${idx + 1}]</span>` +
            `<span class="ds-output-badge-icon">${typeIcon}</span>` +
            (label ? `<span class="ds-output-badge-label">${label}</span>` : '');
    return badge;
}
// ─── D: Context menu ─────────────────────────────────────────────────────────
let _activeMenu = null;
function closeActiveMenu() {
    _activeMenu === null || _activeMenu === void 0 ? void 0 : _activeMenu.remove();
    _activeMenu = null;
}
function showOutputContextMenu(x, y, outputInfo, onSend) {
    closeActiveMenu();
    const isNight = !!document.querySelector('.ds-chat-night');
    const menu = document.createElement('div');
    menu.className = isNight ? `${MENU_CLASS} ${MENU_CLASS}--night` : MENU_CLASS;
    menu.style.cssText = `position:fixed;left:${x}px;top:${y}px;z-index:9999`;
    const title = document.createElement('div');
    title.className = 'ds-output-ctx-menu-title';
    title.textContent = outputInfo.label;
    menu.appendChild(title);
    const btn = document.createElement('div');
    btn.className = 'ds-output-ctx-menu-item';
    btn.textContent = '🤖 Ask Varys about this output';
    btn.onclick = () => {
        closeActiveMenu();
        onSend(outputInfo);
    };
    menu.appendChild(btn);
    document.body.appendChild(menu);
    _activeMenu = menu;
    // Close on any click outside
    const close = (e) => {
        if (!menu.contains(e.target)) {
            closeActiveMenu();
            document.removeEventListener('mousedown', close);
        }
    };
    setTimeout(() => document.addEventListener('mousedown', close), 10);
}
// ─── Core: per-cell setup ─────────────────────────────────────────────────────
/**
 * Inject output badges and context-menu handlers for every output element in
 * a single code cell.
 *
 * @param cell        The JupyterLab Cell widget (or its DOM node).
 * @param cellModel   The raw cell model (for output data access).
 * @param cellIndex   0-based index of this cell in the notebook.
 * @param onSend      Called when the user triggers "Ask Varys".
 */
function setupCellOutputs(cellNode, cellModel, cellIndex, onSend) {
    var _a, _b, _c;
    const outputArea = cellNode.querySelector('.jp-Cell-outputWrapper .jp-OutputArea');
    if (!outputArea)
        return;
    const children = outputArea.querySelectorAll(':scope > .jp-OutputArea-child');
    if (!children.length)
        return;
    // Collect outputs from model
    const rawOutputs = [];
    const modelOutputs = cellModel === null || cellModel === void 0 ? void 0 : cellModel.outputs;
    if (modelOutputs) {
        const len = typeof modelOutputs.length === 'number' ? modelOutputs.length : 0;
        for (let i = 0; i < len; i++) {
            const o = modelOutputs.get ? modelOutputs.get(i) : modelOutputs[i];
            if (o)
                rawOutputs.push(o);
        }
    }
    // Derive semantic labels for image outputs
    const source = (_c = (_b = (_a = cellModel === null || cellModel === void 0 ? void 0 : cellModel.value) === null || _a === void 0 ? void 0 : _a.text) !== null && _b !== void 0 ? _b : cellModel === null || cellModel === void 0 ? void 0 : cellModel.source) !== null && _c !== void 0 ? _c : '';
    const plotLabels = extractPlotLabels(source);
    let imageCount = 0;
    children.forEach((child, domIdx) => {
        var _a;
        const el = child;
        // Skip if already decorated
        if (el.querySelector('.ds-output-badge'))
            return;
        const rawOutput = rawOutputs[domIdx];
        const mime = rawOutput ? dominantMime(rawOutput) : 'unknown';
        // Skip completely unknown outputs (no data to send)
        if (mime === 'unknown')
            return;
        // Derive label
        let semanticLabel = '';
        if (mime.startsWith('image')) {
            semanticLabel = (_a = plotLabels[imageCount]) !== null && _a !== void 0 ? _a : '';
            imageCount++;
        }
        else if (mime === 'text/html') {
            semanticLabel = 'DataFrame';
        }
        else if (mime === 'error') {
            semanticLabel = 'Error';
        }
        const fullLabel = semanticLabel && semanticLabel !== 'Error'
            ? `${semanticLabel} — cell ${cellIndex + 1}, output ${domIdx + 1}`
            : mime === 'error'
                ? `Error — cell #${cellIndex + 1}, output ${domIdx + 1}`
                : `Output ${domIdx + 1} — cell ${cellIndex + 1}`;
        // Inject badge
        const badge = makeBadge(domIdx, semanticLabel === 'Error' ? '' : (semanticLabel || (mime === 'text/html' ? 'DataFrame' : '')), mime);
        el.style.position = 'relative';
        el.insertBefore(badge, el.firstChild);
        // Build the SelectedOutput payload
        const buildPayload = () => {
            var _a, _b;
            if (mime === 'error') {
                // Extract error text from the raw output model
                const raw = rawOutput && typeof rawOutput.toJSON === 'function'
                    ? rawOutput.toJSON() : (rawOutput !== null && rawOutput !== void 0 ? rawOutput : {});
                const ename = (_a = raw.ename) !== null && _a !== void 0 ? _a : 'Error';
                const evalue = (_b = raw.evalue) !== null && _b !== void 0 ? _b : '';
                const rawTb = raw.traceback;
                // eslint-disable-next-line no-control-regex
                const tbClean = Array.isArray(rawTb)
                    ? rawTb.join('\n').replace(/\x1b\[[0-9;]*m/g, '')
                    : '';
                const errorText = `${ename}: ${evalue}\n${tbClean}`.trim();
                return {
                    label: fullLabel,
                    preview: `${ename}: ${evalue}`.slice(0, 80),
                    mimeType: mime,
                    textData: errorText,
                    cellIndex,
                    outputIndex: domIdx,
                };
            }
            else if (mime.startsWith('image')) {
                const imgData = rawOutput ? extractBase64(rawOutput) : undefined;
                return {
                    label: fullLabel,
                    preview: semanticLabel ? `[${mime === 'image/png' ? 'PNG' : 'Image'}: ${semanticLabel}]` : `[Image]`,
                    mimeType: mime,
                    imageData: imgData,
                    cellIndex,
                    outputIndex: domIdx,
                };
            }
            else {
                const text = rawOutput ? tableToText(rawOutput) : '';
                const firstLine = text.split('\n')[0].slice(0, 80);
                return {
                    label: fullLabel,
                    preview: firstLine || '[table/text output]',
                    mimeType: mime,
                    textData: text,
                    cellIndex,
                    outputIndex: domIdx,
                };
            }
        };
        // Hover highlight
        el.addEventListener('mouseenter', () => el.classList.add('ds-output-child--hover'));
        el.addEventListener('mouseleave', () => el.classList.remove('ds-output-child--hover'));
        // Badge click → Varys menu (native right-click is intentionally
        // NOT intercepted so the browser's Copy / Save options remain accessible)
        badge.addEventListener('click', (e) => {
            e.stopPropagation();
            showOutputContextMenu(e.clientX, e.clientY, buildPayload(), onSend);
        });
    });
}
// ─── Public API ───────────────────────────────────────────────────────────────
/**
 * Initialise the output overlay system for all notebooks managed by
 * `tracker`.  Re-decorates cells whenever:
 *   - A new notebook is opened
 *   - A cell is executed (outputs change)
 *   - Cells are added or removed
 */
export function initOutputOverlay(tracker, onSend) {
    // Observers per cell node, keyed by node identity
    const cellObservers = new WeakMap();
    function decorateCell(cellWidget, cellIndex) {
        const node = cellWidget.node;
        const model = cellWidget.model;
        // Only decorate code cells that have outputs
        if ((model === null || model === void 0 ? void 0 : model.type) !== 'code')
            return;
        setupCellOutputs(node, model, cellIndex, onSend);
        // Watch for output changes (re-execution) on this cell's output area
        const outputArea = node.querySelector('.jp-Cell-outputWrapper');
        if (!outputArea)
            return;
        let existing = cellObservers.get(outputArea);
        if (!existing) {
            const obs = new MutationObserver(() => {
                // Re-decorate after a small delay to let JupyterLab finish rendering
                setTimeout(() => setupCellOutputs(node, model, cellIndex, onSend), 100);
            });
            obs.observe(outputArea, { childList: true, subtree: true });
            cellObservers.set(outputArea, obs);
            existing = obs;
        }
    }
    function decorateNotebook(notebook) {
        var _a, _b, _c;
        if (!(notebook === null || notebook === void 0 ? void 0 : notebook.widgets))
            return;
        notebook.widgets.forEach((cell, idx) => decorateCell(cell, idx));
        // Watch for cell additions/deletions
        (_c = (_b = (_a = notebook.model) === null || _a === void 0 ? void 0 : _a.cells) === null || _b === void 0 ? void 0 : _b.changed) === null || _c === void 0 ? void 0 : _c.connect(() => {
            setTimeout(() => {
                if (!notebook.widgets)
                    return;
                notebook.widgets.forEach((cell, idx) => decorateCell(cell, idx));
            }, 200);
        });
    }
    // Current notebook
    if (tracker.currentWidget) {
        decorateNotebook(tracker.currentWidget.content);
    }
    // Notebook switches / new notebooks
    tracker.currentChanged.connect((_, widget) => {
        if (!widget)
            return;
        widget.context.ready.then(() => {
            decorateNotebook(widget.content);
            // Also re-decorate when any cell is executed
            widget.content.activeCellChanged.connect(() => {
                if (!widget.content.widgets)
                    return;
                widget.content.widgets.forEach((cell, idx) => decorateCell(cell, idx));
            });
        });
    });
}

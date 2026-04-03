/**
 * Varys — your DS assistant for Jupyter Notebook
 * Two plugins:
 *  1. Main plugin  — sidebar chat widget
 *  2. Completion plugin — inline AI completion (ghost text)
 */
import { ILayoutRestorer } from '@jupyterlab/application';
import { ICommandPalette } from '@jupyterlab/apputils';
import { ICompletionProviderManager } from '@jupyterlab/completer';
import { NotebookActions, INotebookTracker } from '@jupyterlab/notebook';
import { ISettingRegistry } from '@jupyterlab/settingregistry';
import { Menu } from '@lumino/widgets';
import { DSAssistantSidebar, dispatchNonNotebookFocus, dispatchNotebookActivated } from './sidebar/SidebarWidget';
import { GraphPanelWidget } from './graph/GraphPanel';
import { NotebookReader } from './context/NotebookReader';
import { CellEditor } from './editor/CellEditor';
import { APIClient } from './api/client';
import { DSAssistantInlineProvider } from './completion';
import { reproStore } from './reproducibility/store';
import { dsAssistantIcon } from './icon';
import { initCellTagOverlay } from './tags/cellTagOverlay';
import { initOutputOverlay } from './outputs/outputOverlay';
import { extractAssignedNames, buildKernelSnapshot } from './context/kernelSnapshot';
const PLUGIN_ID = 'varys:plugin';
const COMPLETION_PLUGIN_ID = 'varys:inline-completion';
function getCookie(name) {
    const match = document.cookie.match(new RegExp('(?:^|;)\\s*' + name + '=([^;]*)'));
    return match ? decodeURIComponent(match[1]) : null;
}
// ---------------------------------------------------------------------------
// Plugin 1 — Sidebar chat
// ---------------------------------------------------------------------------
const plugin = {
    id: PLUGIN_ID,
    description: 'AI-powered data science assistant for JupyterLab',
    autoStart: true,
    requires: [INotebookTracker],
    optional: [ICommandPalette, ILayoutRestorer],
    activate: (app, notebookTracker, palette, restorer) => {
        var _a, _b;
        console.log('Varys extension activated!');
        const apiClient = new APIClient();
        const notebookReader = new NotebookReader(notebookTracker);
        const cellEditor = new CellEditor(notebookTracker);
        // ── Graph panel — created once, shown on demand ──────────────────────────
        const graphPanel = new GraphPanelWidget(notebookTracker, (cellIndex) => {
            const panel = notebookTracker.currentWidget;
            if (!panel)
                return;
            void app.commands.execute('notebook:scroll-to-cell', { index: cellIndex });
        });
        const openGraphPanel = () => {
            if (!graphPanel.isAttached) {
                app.shell.add(graphPanel, 'main', { mode: 'split-right' });
            }
            app.shell.activateById(graphPanel.id);
        };
        const sidebar = new DSAssistantSidebar({
            apiClient,
            notebookReader,
            cellEditor,
            notebookTracker,
            openFile: (path) => {
                void app.commands.execute('docmanager:open', { path });
            },
            reloadFile: async (_path) => {
                // Reload the currently active document from disk.
                // Do NOT call docmanager:open first — that triggers app.shell.activeChanged
                // for the same file, which would fire dispatchNonNotebookFocus and wipe
                // the agent panel that was just shown to the user.
                // The file is already open and active (it was the focused document when
                // the agent ran), so docmanager:reload is sufficient.
                try {
                    await app.commands.execute('docmanager:reload');
                }
                catch ( /* no-op if not reloadable */_a) { /* no-op if not reloadable */ }
            },
            onOpenGraph: openGraphPanel,
        });
        sidebar.id = 'varys-sidebar';
        sidebar.title.caption = 'Varys';
        sidebar.title.label = '';
        sidebar.title.icon = dsAssistantIcon;
        app.shell.add(sidebar, 'right', { rank: 500 });
        if (restorer) {
            restorer.add(sidebar, PLUGIN_ID);
        }
        // ── Track which document is active in the main area ─────────────────────
        // INotebookTracker.currentChanged does NOT fire when:
        //   (a) focus moves from a notebook to a non-notebook file (.py, .md, …)
        //   (b) the user returns to a notebook that was already the "current" one
        //       (e.g., after visiting a .py file — the tracker's currentWidget
        //        never changed, so currentChanged is a no-op)
        // app.shell.activeChanged fires for every main-area tab/widget change, so
        // we use it as the reliable source-of-truth for document switching.
        // Prefer activeChanged (tab switch); fall back to currentChanged (keyboard focus).
        const labShell = app.shell;
        const shellSignal = typeof ((_a = labShell.activeChanged) === null || _a === void 0 ? void 0 : _a.connect) === 'function' ? labShell.activeChanged :
            typeof ((_b = labShell.currentChanged) === null || _b === void 0 ? void 0 : _b.connect) === 'function' ? labShell.currentChanged :
                null;
        if (shellSignal) {
            shellSignal.connect((_, args) => {
                var _a, _b, _c, _d;
                const newWidget = args === null || args === void 0 ? void 0 : args.newValue;
                // Ignore null and widgets without context.path (side panels, toolbars,
                // the Varys sidebar itself, Settings, Extensions Manager…).
                // activeChanged fires with null whenever the DockPanel loses keyboard
                // focus — e.g. when the user clicks the chat textarea. We must NOT
                // treat that as "all documents closed". Notebook closure is already
                // handled by notebookTracker.currentChanged.
                if (!newWidget)
                    return;
                if (notebookTracker.has(newWidget)) {
                    const path = (_b = (_a = newWidget.context) === null || _a === void 0 ? void 0 : _a.path) !== null && _b !== void 0 ? _b : '';
                    if (path)
                        dispatchNotebookActivated(path);
                    return;
                }
                const filePath = (_d = (_c = newWidget === null || newWidget === void 0 ? void 0 : newWidget.context) === null || _c === void 0 ? void 0 : _c.path) !== null && _d !== void 0 ? _d : '';
                if (filePath) {
                    // A non-notebook document (Python/Markdown/etc.) is now active.
                    dispatchNonNotebookFocus(filePath);
                }
                // No context.path → side panel or non-document widget → ignore.
            });
        }
        // ── Commands ────────────────────────────────────────────────────────────
        const commandOpen = 'varys:open';
        app.commands.addCommand(commandOpen, {
            label: 'Open Varys',
            icon: dsAssistantIcon,
            execute: () => app.shell.activateById(sidebar.id)
        });
        const commandAnalyze = 'varys:check-reproducibility';
        app.commands.addCommand(commandAnalyze, {
            label: 'Varys: Check Reproducibility',
            execute: async () => {
                var _a;
                app.shell.activateById(sidebar.id);
                const ctx = notebookReader.getFullContext();
                if (!ctx || !ctx.cells.length)
                    return;
                try {
                    const result = await apiClient.analyzeReproducibility({
                        notebookPath: (_a = ctx.notebookPath) !== null && _a !== void 0 ? _a : '',
                        cells: ctx.cells,
                    });
                    reproStore.emit(result.issues);
                }
                catch (err) {
                    console.warn('Varys: reproducibility check failed', err);
                }
            }
        });
        const commandGraph = 'varys:open-graph';
        app.commands.addCommand(commandGraph, {
            label: 'Varys: Open Dependency Graph',
            execute: openGraphPanel,
        });
        if (palette) {
            palette.addItem({ command: commandOpen, category: 'Varys' });
            palette.addItem({ command: commandAnalyze, category: 'Varys' });
            palette.addItem({ command: commandGraph, category: 'Varys' });
        }
        // ── AI cell actions — context menu + palette ─────────────────────────────
        /**
         * Return a short description of the currently active cell.
         * Uses the execution count (the [N] shown beside code cells) so the
         * message matches what the user sees on screen; falls back to the
         * 0-based index if no execution count is available.
         */
        /**
         * Extract the text the user has selected in the active cell's CodeMirror
         * editor.  Returns null when nothing is selected (cursor only).
         */
        const getEditorSelection = () => {
            var _a, _b, _c, _d, _e, _f, _g, _h;
            const cell = (_a = notebookTracker.currentWidget) === null || _a === void 0 ? void 0 : _a.content.activeCell;
            if (!(cell === null || cell === void 0 ? void 0 : cell.editor))
                return null;
            const sel = cell.editor.getSelection();
            const { start, end } = sel;
            // A collapsed range means no selection.
            if (start.line === end.line && start.column === end.column)
                return null;
            const lines = cell.model.sharedModel.source.split('\n');
            if (start.line === end.line) {
                return (_c = (_b = lines[start.line]) === null || _b === void 0 ? void 0 : _b.slice(start.column, end.column)) !== null && _c !== void 0 ? _c : null;
            }
            const parts = [];
            parts.push((_e = (_d = lines[start.line]) === null || _d === void 0 ? void 0 : _d.slice(start.column)) !== null && _e !== void 0 ? _e : '');
            for (let l = start.line + 1; l < end.line; l++)
                parts.push((_f = lines[l]) !== null && _f !== void 0 ? _f : '');
            parts.push((_h = (_g = lines[end.line]) === null || _g === void 0 ? void 0 : _g.slice(0, end.column)) !== null && _h !== void 0 ? _h : '');
            return parts.join('\n') || null;
        };
        const getActiveCellRef = () => {
            var _a;
            const nb = (_a = notebookTracker.currentWidget) === null || _a === void 0 ? void 0 : _a.content;
            if (!nb)
                return null;
            const cell = nb.activeCell;
            if (!cell)
                return null;
            const source = cell.model.sharedModel.source.trim();
            const type = cell.model.type;
            const ref = `#${nb.activeCellIndex + 1}`;
            const selection = getEditorSelection();
            return { ref, source, type, selection };
        };
        /**
         * Wraps any action prompt with a selection-scope fence when text is highlighted.
         * The fence explicitly tells the LLM: only touch the selected snippet and
         * return the full cell with only that part changed.
         */
        function withSelectionScope(base) {
            return (ref, src, selection) => {
                if (!selection)
                    return base(ref, src);
                return (`In ${ref}, you MUST limit your changes to ONLY the selected snippet shown below.\n` +
                    `Do NOT modify any other lines — keep everything else in the cell exactly as-is.\n\n` +
                    `**Selected snippet to work on:**\n\`\`\`\n${selection}\n\`\`\`\n\n` +
                    `**Full cell for context (do not change lines outside the snippet):**\n\`\`\`\n${src}\n\`\`\`\n\n` +
                    `IMPORTANT: the \`content\` field in your modify step MUST contain the COMPLETE cell source ` +
                    `— copy every line outside the snippet verbatim and insert only the changed snippet in its place. ` +
                    `Do NOT drop any trailing statements, calls, or unrelated code.\n\n` +
                    `Task: ${base(ref, src)}`);
            };
        }
        const AI_ACTIONS = [
            {
                id: 'varys:explain-cell',
                label: 'Explain this cell',
                icon: '🔍',
                selector: '.jp-Notebook .jp-Cell',
                autoSend: true,
                prompt: withSelectionScope((ref, src) => `Explain what ${ref} does in plain language:\n\`\`\`\n${src}\n\`\`\``),
            },
            {
                id: 'varys:fix-errors',
                label: 'Fix errors',
                icon: '🔧',
                selector: '.jp-Notebook .jp-CodeCell',
                autoSend: true,
                prompt: withSelectionScope((ref, _src) => `Fix any bugs or errors in ${ref} and explain what was wrong.`),
            },
            {
                id: 'varys:optimize-code',
                label: 'Optimize code',
                icon: '⚡',
                selector: '.jp-Notebook .jp-CodeCell',
                autoSend: true,
                prompt: withSelectionScope((ref, _src) => `Optimize ${ref} for better performance and readability. Show the changes as a diff.`),
            },
            {
                id: 'varys:add-documentation',
                label: 'Add documentation',
                icon: '📝',
                selector: '.jp-Notebook .jp-CodeCell',
                autoSend: true,
                prompt: withSelectionScope((ref, _src) => `Add a docstring and clear inline comments to ${ref}.`),
            },
            {
                id: 'varys:generate-tests',
                label: 'Generate tests',
                icon: '🧪',
                selector: '.jp-Notebook .jp-CodeCell',
                autoSend: true,
                prompt: withSelectionScope((ref, _src) => `Generate pytest unit tests for the functions defined in ${ref}. Insert the tests in a new cell after it.`),
            },
            {
                id: 'varys:refactor-cell',
                label: 'Refactor cell',
                icon: '♻️',
                selector: '.jp-Notebook .jp-CodeCell',
                autoSend: true,
                prompt: withSelectionScope((ref, _src) => `Refactor ${ref} to improve code quality, separation of concerns, and readability.`),
            },
            {
                id: 'varys:edit-with-ai',
                label: 'Edit with AI…',
                icon: '✏️',
                selector: '.jp-Notebook .jp-Cell',
                autoSend: false,
                useContextPrefix: true,
                prompt: (ref, src, selection) => {
                    // This entire string becomes the hidden contextPrefix.
                    // The user's typed instruction is appended to it at send time.
                    if (selection) {
                        return (`Edit the selected snippet in ${ref}.\n` +
                            `**IMPORTANT: only change the selected lines — keep ALL other lines exactly as-is, ` +
                            `including any trailing calls or statements outside the selection.**\n\n` +
                            `Selected snippet:\n\`\`\`\n${selection}\n\`\`\`\n\n` +
                            `Full cell for context:\n\`\`\`\n${src}\n\`\`\`\n\n` +
                            `Your modify step MUST return the COMPLETE cell (every line), with only the selected ` +
                            `snippet replaced. Do NOT drop any lines outside the selection.\n\n` +
                            `User instruction: `);
                    }
                    return (`Edit ${ref}.\n` +
                        `Full cell source:\n\`\`\`\n${src}\n\`\`\`\n\n` +
                        `Your modify step MUST return the COMPLETE cell — copy every line you are NOT changing ` +
                        `verbatim (including trailing calls, global statements, etc.).\n\n` +
                        `User instruction: `);
                },
                display: (ref, sel) => sel ? `✏️ Edit selected snippet in ${ref}` : `✏️ Edit ${ref}`,
            },
        ];
        /**
         * Returns a short human-readable label for the chat bubble.
         * Uses the action's `display()` fn if defined, otherwise builds a default.
         */
        function chatLabel(action, ref, sel) {
            if (action.display)
                return action.display(ref, sel);
            const scope = sel ? `selected snippet in ${ref}` : ref;
            return `${action.icon} ${action.label} — ${scope}`;
        }
        // Register each command
        for (const action of AI_ACTIONS) {
            const { id, label, icon, autoSend, prompt } = action;
            app.commands.addCommand(id, {
                label: `${icon} ${label}`,
                caption: `Varys: ${label}`,
                execute: () => {
                    var _a;
                    const cell = getActiveCellRef();
                    if (!cell)
                        return;
                    app.shell.activateById(sidebar.id);
                    const fullPrompt = prompt(cell.ref, cell.source, cell.selection);
                    const displayText = chatLabel(action, cell.ref, cell.selection);
                    if (action.useContextPrefix) {
                        // The large code context goes as a hidden prefix; textarea is empty
                        // so the user just types a short instruction.
                        // Build a concise chip label + preview for the visible chip.
                        const previewText = (_a = cell.selection) !== null && _a !== void 0 ? _a : cell.source;
                        const firstLine = previewText.split('\n')[0].trim();
                        const chipLabel = `${cell.ref}${firstLine ? ' — ' + firstLine.slice(0, 48) + (firstLine.length > 48 ? '…' : '') : ''}`;
                        const chip = { label: chipLabel, preview: previewText };
                        sidebar.sendMessage('', false, displayText, fullPrompt, chip);
                    }
                    else {
                        sidebar.sendMessage(fullPrompt, autoSend, displayText);
                    }
                },
                isEnabled: () => { var _a; return !!((_a = notebookTracker.currentWidget) === null || _a === void 0 ? void 0 : _a.content.activeCell); },
            });
            if (palette) {
                palette.addItem({ command: id, category: 'Varys — AI Cell Actions' });
            }
        }
        // Build a "🤖 AI Actions" submenu so the context menu stays tidy
        const aiSubmenu = new Menu({ commands: app.commands });
        aiSubmenu.title.label = '🤖 Varys';
        for (const action of AI_ACTIONS) {
            // Insert a separator before the last item ("Edit with AI…")
            if (action.id === 'varys:edit-with-ai') {
                aiSubmenu.addItem({ type: 'separator' });
            }
            aiSubmenu.addItem({ command: action.id });
        }
        // Attach the submenu to the cell context menu
        // rank 100 puts it after standard JupyterLab items (Cut/Copy/Paste at ~1)
        // but before extension items that typically use 500+
        app.contextMenu.addItem({
            type: 'submenu',
            submenu: aiSubmenu,
            selector: '.jp-Notebook .jp-Cell',
            rank: 100,
        });
        // ── Auto-inject %%ai magic into every new kernel ─────────────────────────
        // When a notebook is opened (or its kernel is restarted), silently execute
        // `%load_ext varys.magic` so %%ai is available without
        // any manual setup.
        //
        // If loading fails (e.g. the package is not installed in the kernel env)
        // a console.warn is emitted with the exact error and the manual fallback
        // command, so the user can diagnose the issue from the browser console.
        const _injectMagic = (panel) => {
            const session = panel.sessionContext;
            const doInject = async () => {
                var _a;
                const kernel = (_a = session.session) === null || _a === void 0 ? void 0 : _a.kernel;
                if (!kernel)
                    return;
                // DIAGNOSTIC: skip the actual kernel.requestExecute — if cells run
                // fast with this guard, magic injection is the root cause.
                if (true)
                    return;
                // Resolve the server URL and token from JupyterLab's own service
                // manager so we don't rely on env vars that may not be set in the
                // kernel process.
                const { baseUrl, token } = app.serviceManager.serverSettings;
                const serverUrl = baseUrl.replace(/\/$/, '') || 'http://localhost:8888';
                // Inject server info as env vars before loading the extension, so
                // _server_url() / _token() in magic.py always find the right values.
                const code = [
                    'import os as _ds_os',
                    `_ds_os.environ['JUPYTER_SERVER_URL'] = '${serverUrl}'`,
                    ...(token ? [`_ds_os.environ['JUPYTER_TOKEN'] = '${token}'`] : []),
                    'del _ds_os',
                    '%load_ext varys.magic',
                ].join('\n');
                try {
                    const future = kernel.requestExecute({
                        code,
                        silent: false,
                        store_history: false,
                        allow_stdin: false,
                        stop_on_error: false,
                    });
                    // Watch for Python-level errors (ImportError, etc.)
                    let errorSeen = false;
                    future.onIOPub = (msg) => {
                        if (msg.header.msg_type === 'error') {
                            errorSeen = true;
                            const { ename, evalue } = msg.content;
                            console.warn(`[Varys] %%ai magic auto-load failed — ${ename}: ${evalue}\n` +
                                `To enable manually, run this in a notebook cell:\n` +
                                `  %load_ext varys.magic`);
                        }
                    };
                    await future.done;
                    if (!errorSeen) {
                        console.log('[Varys] %%ai magic loaded into kernel');
                    }
                }
                catch (err) {
                    console.warn('[Varys] %%ai magic auto-load skipped (kernel not available):', err);
                }
            };
            // Fire on first kernel ready, and again after every kernel restart
            void session.ready.then(doInject);
            session.kernelChanged.connect(doInject);
        };
        notebookTracker.widgetAdded.connect((_tracker, panel) => {
            _injectMagic(panel);
        });
        // Also cover already-open panels (e.g. restored from a previous session)
        notebookTracker.forEach(panel => _injectMagic(panel));
        // ── Tag panel command ────────────────────────────────────────────────────
        const commandTags = 'varys:open-tags';
        app.commands.addCommand(commandTags, {
            label: '🏷️ Varys: Open Tags Panel',
            caption: 'Open the Cell Tags & Metadata panel',
            execute: () => {
                app.shell.activateById(sidebar.id);
                sidebar.openTagsPanel();
            },
        });
        // Context-menu shortcut: right-click any cell → "🏷️ Edit Tags"
        app.contextMenu.addItem({
            command: commandTags,
            selector: '.jp-Notebook .jp-Cell',
            rank: 99, // just before the AI Actions submenu
        });
        if (palette) {
            palette.addItem({ command: commandTags, category: 'Varys' });
        }
        // ── Cell tag overlay (tag pills rendered directly on cells) ──────────────
        initCellTagOverlay(notebookTracker, 
        // ⚡ auto-tag callback — calls POST /varys/auto-tag
        async (src, out) => {
            const result = await apiClient.autoTagCell(src, out);
            return result.tags;
        }, 
        // tag-change callback — patches summary_store.json in place (no new version)
        (cellId, notebookPath, tags) => {
            apiClient.cellLifecycle({ cell_id: cellId, notebook_path: notebookPath, action: 'tags_changed', tags });
        });
        // ── Output overlay: badges + context menu (D + C + E) ────────────────────
        initOutputOverlay(notebookTracker, output => {
            sidebar.sendOutputToChat(output);
        });
        // ── Cell execution listener ──────────────────────────────────────────────
        // After every cell execution:
        //  1. Run reproducibility rules (fire-and-forget, never awaited).
        //  2. Notify the Smart Cell Context backend to update the SummaryStore.
        NotebookActions.executed.connect((_sender, { notebook: _nb, cell }) => {
            var _a;
            const panel = notebookTracker.currentWidget;
            if (!panel)
                return;
            // ── Reproducibility check — fully fire-and-forget ──
            // Must NOT use await here: any await in this synchronous signal handler
            // delays the microtask queue that resolves NotebookActions.run(), causing
            // programmatic cell execution (Varys run_cell) to appear to hang.
            try {
                const ctx = notebookReader.getFullContext();
                if (ctx && ctx.cells.length) {
                    // Always send ALL cells so notebook-level rules (especially
                    // execution_order_violation) see the complete execution count
                    // sequence.  Filtering to "cells up to the executed index" caused
                    // false-clean results: when cell #1 (index 0) ran, only that one
                    // cell was sent, so the order check never had enough data.
                    apiClient.analyzeReproducibility({
                        notebookPath: (_a = ctx.notebookPath) !== null && _a !== void 0 ? _a : '',
                        cells: ctx.cells,
                    }).then(result => reproStore.emit(result.issues)).catch(() => { });
                }
            }
            catch (_b) {
                // Non-fatal
            }
            // ── Smart Cell Context — fire-and-forget SummaryStore update ──
            // Wrapped in an async IIFE so we can await kernel introspection before
            // posting, without blocking the synchronous signal handler.
            (async () => {
                var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l;
                try {
                    if (!cell)
                        return;
                    const model = cell.model;
                    const cellId = (_c = (_a = model.id) !== null && _a !== void 0 ? _a : (_b = model.sharedModel) === null || _b === void 0 ? void 0 : _b.id) !== null && _c !== void 0 ? _c : '';
                    if (!cellId)
                        return;
                    const notebookPath = panel.context.path;
                    const source = model.sharedModel.getSource();
                    const cellType = model.type;
                    let output = null;
                    let hadError = false;
                    let errorText = null;
                    const execCount = cellType === 'code' ? ((_d = model.executionCount) !== null && _d !== void 0 ? _d : null) : null;
                    if (cellType === 'code') {
                        const outputs = model.outputs;
                        if (outputs && outputs.length > 0) {
                            const parts = [];
                            for (let i = 0; i < outputs.length; i++) {
                                const out = outputs.get ? outputs.get(i) : outputs[i];
                                if (!out)
                                    continue;
                                const raw = typeof out.toJSON === 'function' ? out.toJSON() : out;
                                const otype = (_e = raw.output_type) !== null && _e !== void 0 ? _e : '';
                                if (otype === 'error') {
                                    hadError = true;
                                    errorText = `${(_f = raw.ename) !== null && _f !== void 0 ? _f : 'Error'}: ${(_g = raw.evalue) !== null && _g !== void 0 ? _g : ''}`;
                                }
                                else if (otype === 'stream') {
                                    const t = (_h = raw.text) !== null && _h !== void 0 ? _h : '';
                                    parts.push(Array.isArray(t) ? t.join('') : String(t));
                                }
                                else if (otype === 'execute_result' || otype === 'display_data') {
                                    const plain = (_k = ((_j = raw.data) !== null && _j !== void 0 ? _j : {})['text/plain']) !== null && _k !== void 0 ? _k : '';
                                    parts.push(Array.isArray(plain) ? plain.join('') : String(plain));
                                }
                            }
                            output = parts.join('\n').trim() || null;
                        }
                    }
                    // ── Kernel snapshot — introspect variables assigned in this cell ──
                    let kernelSnapshot = {};
                    if (cellType === 'code' && !hadError) {
                        const kernel = (_l = panel.sessionContext.session) === null || _l === void 0 ? void 0 : _l.kernel;
                        if (kernel) {
                            const names = extractAssignedNames(source);
                            if (names.length > 0) {
                                kernelSnapshot = await buildKernelSnapshot(kernel, names);
                            }
                        }
                    }
                    apiClient.cellExecuted({
                        cell_id: cellId,
                        notebook_path: notebookPath,
                        source,
                        output,
                        execution_count: execCount,
                        had_error: hadError,
                        error_text: errorText,
                        cell_type: cellType,
                        kernel_snapshot: kernelSnapshot,
                    });
                }
                catch (_m) {
                    // Non-fatal: SummaryStore update is best-effort
                }
            })();
        });
        // ── Cell lifecycle listener — delete / restore ────────────────────────────
        // When cells are removed from or re-added to the notebook model, notify
        // the SummaryStore so it can mark entries as deleted / restored.
        const _wireCellLifecycle = (panel) => {
            var _a;
            const notebookModel = panel.content.model;
            if (!notebookModel)
                return;
            const cellList = notebookModel.cells;
            if (!cellList || typeof ((_a = cellList.changed) === null || _a === void 0 ? void 0 : _a.connect) !== 'function')
                return;
            cellList.changed.connect((_list, args) => {
                var _a, _b, _c, _d, _e, _f, _g, _h;
                const notebookPath = panel.context.path;
                if (!notebookPath)
                    return;
                if (args.type === 'remove') {
                    for (const removedCell of ((_a = args.oldValues) !== null && _a !== void 0 ? _a : [])) {
                        if (!removedCell)
                            continue;
                        const cellId = (_d = (_b = removedCell.id) !== null && _b !== void 0 ? _b : (_c = removedCell.sharedModel) === null || _c === void 0 ? void 0 : _c.id) !== null && _d !== void 0 ? _d : '';
                        if (cellId) {
                            apiClient.cellLifecycle({ cell_id: cellId, notebook_path: notebookPath, action: 'deleted' });
                        }
                    }
                }
                else if (args.type === 'add') {
                    for (const addedCell of ((_e = args.newValues) !== null && _e !== void 0 ? _e : [])) {
                        if (!addedCell)
                            continue;
                        const cellId = (_h = (_f = addedCell.id) !== null && _f !== void 0 ? _f : (_g = addedCell.sharedModel) === null || _g === void 0 ? void 0 : _g.id) !== null && _h !== void 0 ? _h : '';
                        if (cellId) {
                            // Only notify restore if the backend has seen this cell before.
                            // We send it unconditionally — the backend ignores unknown IDs.
                            apiClient.cellLifecycle({ cell_id: cellId, notebook_path: notebookPath, action: 'restored' });
                        }
                    }
                }
            });
        };
        notebookTracker.widgetAdded.connect((_tracker, panel) => {
            _wireCellLifecycle(panel);
        });
        notebookTracker.forEach(panel => _wireCellLifecycle(panel));
        // ── Background repo scan on notebook open ────────────────────────────────
        notebookTracker.currentChanged.connect(async (_, widget) => {
            var _a, _b, _c;
            if (!widget)
                return;
            const notebookPath = (_b = (_a = widget.context) === null || _a === void 0 ? void 0 : _a.localPath) !== null && _b !== void 0 ? _b : '';
            if (!notebookPath)
                return;
            try {
                const resp = await fetch('/varys/notebook-opened', {
                    method: 'POST',
                    credentials: 'same-origin',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-XSRFToken': (_c = getCookie('_xsrf')) !== null && _c !== void 0 ? _c : '',
                    },
                    body: JSON.stringify({ notebook_path: notebookPath }),
                });
                const data = await resp.json();
                if (data.scan_status === 'queued') {
                    console.log('[Varys] Background scan queued for', notebookPath);
                }
                else if (data.scan_status === 'fresh') {
                    console.log('[Varys] Project context is fresh for', notebookPath);
                }
            }
            catch (err) {
                console.debug('[Varys] notebook-opened ping failed:', err);
            }
        });
    }
};
// ---------------------------------------------------------------------------
// Plugin 2 — Inline completion (ghost text)
// ---------------------------------------------------------------------------
const completionPlugin = {
    id: COMPLETION_PLUGIN_ID,
    description: 'Inline AI code completion for Varys',
    autoStart: true,
    requires: [INotebookTracker, ICompletionProviderManager],
    optional: [ISettingRegistry],
    activate: (_app, notebookTracker, completionManager, settingRegistry) => {
        console.log('Varys: completion plugin activating...');
        try {
            const apiClient = new APIClient();
            const provider = new DSAssistantInlineProvider(apiClient, notebookTracker);
            console.log('Varys: calling registerInlineProvider...');
            completionManager.registerInlineProvider(provider);
            console.log('Varys: registerInlineProvider succeeded');
            // Expose provider on window so we can test from browser console
            window.__dsAssistantProvider = provider;
            console.log('Varys: provider exposed as window.__dsAssistantProvider');
            // Sync our plugin.json toggle → provider enabled state
            if (settingRegistry) {
                settingRegistry
                    .load(PLUGIN_ID)
                    .then(settings => {
                    const apply = () => {
                        var _a;
                        const enabled = (_a = settings.get('inlineCompletion').composite) !== null && _a !== void 0 ? _a : true;
                        console.log(`Varys: inline completion ${enabled ? 'enabled' : 'disabled'} (from settings)`);
                        provider.configure({ enabled });
                    };
                    settings.changed.connect(apply);
                    apply();
                })
                    .catch(err => {
                    console.warn('Varys: could not load settings, defaulting to enabled', err);
                    provider.configure({ enabled: true });
                });
            }
            else {
                console.log('Varys: no settings registry, defaulting to enabled');
                provider.configure({ enabled: true });
            }
        }
        catch (err) {
            console.error('Varys: completion plugin activation FAILED:', err);
        }
    }
};
export default [plugin, completionPlugin];

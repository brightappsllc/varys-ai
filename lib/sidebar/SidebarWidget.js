/**
 * SidebarWidget - Main chat interface for Varys.
 * Renders as a ReactWidget in the JupyterLab right sidebar.
 */
import React, { useState, useRef, useEffect } from 'react';
import { ReactWidget } from '@jupyterlab/apputils';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { VariableResolver, parseVariableRefs } from '../context/VariableResolver';
import { DiffView } from '../ui/DiffView';
import { FileChangeCard } from '../ui/FileChangeCard';
import { ReproPanel } from '../reproducibility/ReproPanel';
import { reproStore } from '../reproducibility/store';
import { TagsPanel } from '../tags/TagsPanel';
// ---------------------------------------------------------------------------
// XSRF token helper (mirrors APIClient.getXSRFToken for direct fetch calls)
// ---------------------------------------------------------------------------
function getXsrfToken() {
    const cookies = document.cookie.split(';');
    for (const cookie of cookies) {
        const trimmed = cookie.trim();
        const sep = trimmed.indexOf('=');
        if (sep === -1)
            continue;
        if (trimmed.slice(0, sep) === '_xsrf') {
            return decodeURIComponent(trimmed.slice(sep + 1));
        }
    }
    return '';
}
// ---------------------------------------------------------------------------
// Markdown renderer (shared by assistant, system, code-review messages)
// ---------------------------------------------------------------------------
// Configure marked once: GFM (tables, task lists, etc.) with line breaks.
marked.setOptions({ breaks: true, gfm: true });
// Custom marked renderer: wraps fenced code blocks in a container div so the
// delegated click handler can locate the copy button and its code sibling.
const _markedRenderer = new marked.Renderer();
_markedRenderer.code = function ({ text, lang }) {
    const escaped = text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
    const langAttr = lang ? ` class="language-${lang}"` : '';
    return (`<div class="ds-code-block-wrapper">` +
        `<button class="ds-copy-code-btn" aria-label="Copy code">Copy</button>` +
        `<pre><code${langAttr}>${escaped}</code></pre>` +
        `</div>`);
};
function renderMarkdown(text) {
    // Guard against null/undefined during streaming
    if (!text)
        return '';
    try {
        const raw = marked.parse(text, { renderer: _markedRenderer });
        // Sanitize to prevent XSS while keeping all formatting elements.
        // 'button' is added so copy buttons survive the sanitizer.
        return DOMPurify.sanitize(raw, {
            ALLOWED_TAGS: [
                'p', 'br', 'b', 'i', 'strong', 'em', 's', 'code', 'pre', 'blockquote',
                'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
                'table', 'thead', 'tbody', 'tr', 'th', 'td',
                'a', 'hr', 'span', 'div', 'button',
            ],
            ALLOWED_ATTR: ['href', 'target', 'rel', 'class', 'aria-label'],
        });
    }
    catch (_a) {
        return text;
    }
}
// ---------------------------------------------------------------------------
// User-bubble content renderer
// ---------------------------------------------------------------------------
/** Escape HTML special characters in a plain-text segment. */
function _escHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
/**
 * Extracts unique "cell #N" tokens from the user's input for display as
 * context-row chips.  A token is only collected once a non-digit character
 * follows the number (i.e. the user has "closed off" the number by typing a
 * separator).  Returns tokens in order of first appearance, de-duplicated by
 * their normalised form ("Cell  # 3" and "cell #3" both yield "cell #3").
 */
function extractCellRefs(text) {
    const re = /\b(cell\s*#\s*\d+)(?=\D)/gi;
    const seen = new Set();
    const result = [];
    let m;
    while ((m = re.exec(text)) !== null) {
        const normalised = m[1].replace(/\s+/g, ' ').toLowerCase().trim();
        if (!seen.has(normalised)) {
            seen.add(normalised);
            result.push(normalised);
        }
        if (m[0].length === 0)
            re.lastIndex++;
    }
    return result;
}
/**
 * Returns all @varName tokens in `text` whose name exists in `symbols`.
 * Matches anywhere in the text; a confirmed mention is one followed by a
 * non-word character or end of string.
 */
function extractAtMentions(text, symbols) {
    if (!symbols.length)
        return [];
    const symbolMap = new Map(symbols.map(s => [s.name, s]));
    const seen = new Set();
    const result = [];
    const re = /@([A-Za-z_]\w*)(?=\W|$)/g;
    let m;
    while ((m = re.exec(text + ' ')) !== null) { // append space so end-of-input matches
        const name = m[1];
        if (!seen.has(name) && symbolMap.has(name)) {
            seen.add(name);
            result.push(symbolMap.get(name));
        }
    }
    return result;
}
// ── Contenteditable rich-text input helpers ───────────────────────────────
/**
 * Builds the innerHTML to set on the contenteditable input div.
 * • "cell #N" tokens (followed by a non-digit) → ds-cell-ref-inline (blue italic)
 * • "@varName" tokens → ds-at-ref-inline (same blue italic, monospace)
 * All other text is HTML-escaped; newlines become <br>.
 *
 * @param validSymbols  Optional set of kernel variable names.  When provided,
 *                      only @names in the set are highlighted; otherwise ALL
 *                      @identifier tokens are highlighted.
 */
function buildHighlightHtml(text, validSymbols) {
    // Combined pattern — group 1: cell ref, group 2: @mention
    const re = /\b(cell\s*#\s*\d+)(?=\D)|(@[A-Za-z_]\w*)(?=\W|$)/g;
    const parts = [];
    let lastIdx = 0;
    let m;
    // Append a space so end-of-string @mentions are matched by the lookahead
    const src = text + ' ';
    while ((m = re.exec(src)) !== null) {
        if (m.index >= text.length)
            break; // skip the appended space
        const token = m[0];
        const isCellRef = !!m[1];
        const isAtMention = !!m[2];
        // For @mentions, only highlight if it's a known symbol (or no filter given)
        if (isAtMention && validSymbols && !validSymbols.has(token.slice(1))) {
            continue;
        }
        parts.push(_escHtml(text.slice(lastIdx, m.index)).replace(/\n/g, '<br>'));
        const cls = isCellRef ? 'ds-cell-ref-inline' : 'ds-at-ref-inline';
        parts.push(`<span class="${cls}">${_escHtml(token)}</span>`);
        lastIdx = m.index + token.length;
        if (token.length === 0)
            re.lastIndex++;
    }
    parts.push(_escHtml(text.slice(lastIdx)).replace(/\n/g, '<br>'));
    return parts.join('');
}
/**
 * Returns the cursor's character offset within the element's plain text.
 *
 * Walks the DOM tree and counts both text-node characters AND <br> elements
 * (each <br> = 1 '\n' in the `input` string).  The old Range.toString()
 * approach silently ignored <br> nodes, causing an off-by-N displacement when
 * the user pressed Shift+Enter more than once.
 */
function getCursorCharOffset(el) {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0)
        return 0;
    const range = sel.getRangeAt(0);
    const endNode = range.endContainer;
    const endOff = range.endOffset;
    let count = 0;
    let done = false;
    // Walk the entire subtree of `node`, adding all chars (text + <br>=\n).
    function countAll(node) {
        var _a;
        if (node.nodeType === Node.TEXT_NODE) {
            count += ((_a = node.textContent) !== null && _a !== void 0 ? _a : '').length;
        }
        else if (node.tagName === 'BR') {
            count += 1;
        }
        else {
            for (let i = 0; i < node.childNodes.length; i++)
                countAll(node.childNodes[i]);
        }
    }
    // Walk until we hit `endNode`, counting chars along the way.
    function countUpto(node) {
        var _a;
        if (done)
            return;
        if (node === endNode) {
            if (node.nodeType === Node.TEXT_NODE) {
                count += endOff;
            }
            else {
                // Element endContainer: endOff = number of children before cursor
                for (let i = 0; i < endOff && !done; i++)
                    countAll(node.childNodes[i]);
            }
            done = true;
            return;
        }
        if (node.nodeType === Node.TEXT_NODE) {
            count += ((_a = node.textContent) !== null && _a !== void 0 ? _a : '').length;
        }
        else if (node.tagName === 'BR') {
            count += 1;
        }
        else {
            for (let i = 0; i < node.childNodes.length && !done; i++)
                countUpto(node.childNodes[i]);
        }
    }
    // Special case: cursor anchored to el itself (between block children)
    if (el === endNode) {
        for (let i = 0; i < endOff; i++)
            countAll(el.childNodes[i]);
        return count;
    }
    for (let i = 0; i < el.childNodes.length && !done; i++)
        countUpto(el.childNodes[i]);
    return count;
}
/**
 * Moves the cursor to `offset` characters into the element's plain text.
 *
 * Counts text-node characters AND <br> elements (each = 1 '\n') so the
 * offset matches the `input` string representation.
 */
function setCursorCharOffset(el, offset) {
    const selRaw = window.getSelection();
    if (!selRaw)
        return;
    const sel = selRaw; // non-null alias for use inside closures
    let count = 0;
    function walk(node) {
        var _a;
        if (node.nodeType === Node.TEXT_NODE) {
            const len = ((_a = node.textContent) !== null && _a !== void 0 ? _a : '').length;
            if (count + len >= offset) {
                const r = document.createRange();
                r.setStart(node, offset - count);
                r.collapse(true);
                sel.removeAllRanges();
                sel.addRange(r);
                return true;
            }
            count += len;
        }
        else if (node.nodeType === Node.ELEMENT_NODE && node.tagName === 'BR') {
            // Check before incrementing: cursor may land right before this <br>
            if (count >= offset) {
                const r = document.createRange();
                r.setStartBefore(node);
                r.collapse(true);
                sel.removeAllRanges();
                sel.addRange(r);
                return true;
            }
            count += 1; // <br> = '\n'
            if (count >= offset) {
                const r = document.createRange();
                r.setStartAfter(node);
                r.collapse(true);
                sel.removeAllRanges();
                sel.addRange(r);
                return true;
            }
        }
        else if (node.nodeType === Node.ELEMENT_NODE) {
            for (let i = 0; i < node.childNodes.length; i++) {
                if (walk(node.childNodes[i]))
                    return true;
            }
        }
        return false;
    }
    for (let i = 0; i < el.childNodes.length; i++) {
        if (walk(el.childNodes[i]))
            return;
    }
    // Fallback: cursor to end
    const r = document.createRange();
    r.selectNodeContents(el);
    r.collapse(false);
    sel.removeAllRanges();
    sel.addRange(r);
}
/** Moves the cursor to the very end of the element's content. */
function moveCECursorToEnd(el) {
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    const sel = window.getSelection();
    if (sel) {
        sel.removeAllRanges();
        sel.addRange(range);
    }
}
/**
 * Renders a user message:
 *  - Fenced code blocks (```lang\n…```) → styled <pre><code> with copy button
 *  - Inline backticks (`code`) → <code>
 *  - Everything else → escaped plain text with pre-wrap
 *
 * Deliberately does NOT parse full markdown so that patterns like "#5" or
 * "**bold**" in a user's question are never silently reinterpreted.
 */
function renderUserContent(text) {
    if (!text)
        return '';
    // Split on triple-backtick blocks.  The lazy [\s\S]*? matches the shortest
    // possible run, so adjacent code blocks are split correctly.  We do NOT
    // require a newline after the opening fence here — that lets us handle
    // "```code on same line as fence```" as well as the standard
    // "```lang\ncode\n```" format.
    const segments = text.split(/(```[\s\S]*?```)/g);
    let html = '';
    for (const seg of segments) {
        // Identify a triple-backtick block: starts AND ends with ```, has content
        if (seg.startsWith('```') && seg.endsWith('```') && seg.length > 6) {
            const inner = seg.slice(3, -3);
            // If the first line looks like a language tag (only word chars / dots /
            // hyphens), treat it as such.  Otherwise the first line is code.
            const nlIdx = inner.indexOf('\n');
            let lang = '', code = '';
            if (nlIdx >= 0) {
                const firstLine = inner.slice(0, nlIdx).trim();
                if (firstLine === '' || /^[\w.-]+$/.test(firstLine)) {
                    lang = firstLine;
                    code = inner.slice(nlIdx + 1);
                }
                else {
                    code = inner; // first line is code, not a language tag
                }
            }
            else {
                code = inner; // single-line code block, no newline at all
            }
            const langAttr = lang ? ` class="language-${_escHtml(lang)}"` : '';
            html +=
                `<div class="ds-code-block-wrapper">` +
                    `<button class="ds-copy-code-btn" aria-label="Copy code">Copy</button>` +
                    `<pre><code${langAttr}>${_escHtml(code)}</code></pre>` +
                    `</div>`;
        }
        else if (seg) {
            // 1. HTML-escape
            let part = _escHtml(seg);
            // 2. cell #N → styled span (same highlight used in the input box)
            part = part.replace(/\b(cell\s*#\s*\d+)(?=[^\d]|$)/gi, '<span class="ds-cell-ref-inline">$1</span>');
            // 3. inline `backtick` → <code>
            part = part.replace(/`([^`\r\n]+)`/g, '<code>$1</code>');
            html += `<span class="ds-user-text">${part}</span>`;
        }
    }
    return DOMPurify.sanitize(html, {
        ALLOWED_TAGS: ['span', 'div', 'pre', 'code', 'button'],
        ALLOWED_ATTR: ['class', 'aria-label'],
    });
}
function readAnswerDefault() {
    try {
        const v = localStorage.getItem('ds-assistant-answer-default');
        if (v === 'auto' || v === 'always_chat' || v === 'always_notebook' || v === 'ask')
            return v;
    }
    catch ( /* fall through */_a) { /* fall through */ }
    return 'auto';
}
// ---------------------------------------------------------------------------
// Advisory disambiguation — phrases that suggest a discussion/question intent
// In legacy "ask" mode this triggers the disambiguation card; in "auto" mode
// it routes the prompt to /chat instead of running the notebook agent flow.
// ---------------------------------------------------------------------------
const _ADVISORY_STARTS = [
    'what ', 'how ', 'why ', 'when ', 'where ', 'who ', 'which ',
    'explain ', 'describe ', 'tell me', 'can you tell',
    'summarize ', 'summarise ', 'give me a summary', 'give me an overview',
    'what is ', 'what are ', 'what does ', 'what do ',
    'how does ', 'how do ', 'how can ', 'how would ',
    'is there ', 'are there ',
    'interpret ', 'analyse ', 'analyze ',
    'look at ',
];
function looksAdvisory(message, phrases = _ADVISORY_STARTS) {
    const low = message.toLowerCase().trim();
    if (low.endsWith('?'))
        return true;
    return phrases.some(p => low.startsWith(p.toLowerCase()));
}
const ImageRecoveryPrompt = ({ originalMessage, provider, onFill, }) => {
    const [open, setOpen] = useState(false);
    const [showCustom, setShowCustom] = useState(false);
    const [customDim, setCustomDim] = useState('');
    const [flipUp, setFlipUp] = useState(false);
    const dropRef = useRef(null);
    const triggerRef = useRef(null);
    // Build provider-aware resize options
    const resizeOptions = provider.includes('anthropic')
        ? [['/resize(7800)', 'Resize to 7800 px']]
        : provider.includes('openai')
            ? [['/resize(6000)', 'Resize to 6000 px']]
            : [['/resize(7800)', 'Resize to 7800 px (Anthropic)'], ['/resize(6000)', 'Resize to 6000 px (OpenAI)']];
    const staticOptions = [
        ['/no_figures', 'Exclude all figures'],
        ...resizeOptions,
    ];
    // Decide whether to open the menu upward based on available space below
    useEffect(() => {
        if (!open || !triggerRef.current)
            return;
        const rect = triggerRef.current.getBoundingClientRect();
        setFlipUp(rect.bottom > window.innerHeight * 0.55);
    }, [open]);
    // Close on outside click
    useEffect(() => {
        if (!open)
            return;
        const handler = (e) => {
            if (dropRef.current && !dropRef.current.contains(e.target)) {
                setOpen(false);
                setShowCustom(false);
            }
        };
        document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, [open]);
    const pick = (cmd) => {
        setOpen(false);
        setShowCustom(false);
        setCustomDim('');
        onFill(cmd, originalMessage);
    };
    const submitCustom = () => {
        const d = parseInt(customDim, 10);
        if (isNaN(d) || d < 10)
            return;
        pick(`/resize(${d})`);
    };
    return (React.createElement("div", { className: "ds-img-rec" },
        React.createElement("span", { className: "ds-img-rec-msg" }, "\u26A0\uFE0F One or more figures exceed the provider's image size limit."),
        React.createElement("div", { className: "ds-img-rec-wrap", ref: dropRef },
            React.createElement("button", { ref: triggerRef, className: `ds-img-rec-trigger${open ? ' ds-img-rec-trigger--open' : ''}`, onClick: () => { setOpen(o => !o); setShowCustom(false); } },
                "Choose action ",
                React.createElement("span", { className: "ds-img-rec-caret" }, open ? '▲' : '▼')),
            open && (React.createElement("div", { className: `ds-img-rec-menu${flipUp ? ' ds-img-rec-menu--up' : ''}` },
                staticOptions.map(([cmd, desc]) => (React.createElement("button", { key: cmd, className: "ds-img-rec-item", onClick: () => pick(cmd) },
                    React.createElement("code", { className: "ds-img-rec-cmd" }, cmd),
                    React.createElement("span", { className: "ds-img-rec-desc" }, desc)))),
                !showCustom ? (React.createElement("button", { className: "ds-img-rec-item", onClick: () => setShowCustom(true) },
                    React.createElement("code", { className: "ds-img-rec-cmd" }, "/resize(\u2026)"),
                    React.createElement("span", { className: "ds-img-rec-desc" }, "Custom dimension"))) : (React.createElement("div", { className: "ds-img-rec-custom" },
                    React.createElement("code", { className: "ds-img-rec-cmd" }, "/resize("),
                    React.createElement("input", { className: "ds-img-rec-dim-input", type: "number", min: 10, placeholder: "e.g. 4000", value: customDim, autoFocus: true, onChange: e => setCustomDim(e.target.value), onKeyDown: e => {
                            if (e.key === 'Enter')
                                submitCustom();
                            if (e.key === 'Escape') {
                                setShowCustom(false);
                                setCustomDim('');
                            }
                        } }),
                    React.createElement("code", { className: "ds-img-rec-cmd" }, ")"),
                    React.createElement("button", { className: "ds-img-rec-ok", onClick: submitCustom, disabled: !customDim || parseInt(customDim, 10) < 10 }, "OK"))))))));
};
const DisambiguationCard = ({ originalMessage, msgId, onChoice, }) => {
    const preview = originalMessage.length > 55
        ? originalMessage.slice(0, 55) + '…'
        : originalMessage;
    const cmdPreview = originalMessage.length > 40
        ? originalMessage.slice(0, 40) + '…'
        : originalMessage;
    return (React.createElement("div", { className: "ds-disambig-card" },
        React.createElement("div", { className: "ds-disambig-header" },
            React.createElement("span", { className: "ds-disambig-icon" }, "\u2753"),
            React.createElement("span", { className: "ds-disambig-title" }, "Where should the answer go?")),
        React.createElement("div", { className: "ds-disambig-hint" },
            React.createElement("em", null,
                "\"",
                preview,
                "\"")),
        React.createElement("div", { className: "ds-disambig-options" },
            React.createElement("button", { className: "ds-disambig-btn ds-disambig-btn--chat", onClick: () => onChoice('chat', msgId), title: `/chat ${originalMessage}` },
                React.createElement("span", { className: "ds-disambig-btn-icon" }, "\uD83D\uDCAC"),
                React.createElement("span", { className: "ds-disambig-btn-body" },
                    React.createElement("strong", null, "Answer in chat"),
                    React.createElement("code", null,
                        "/chat ",
                        cmdPreview))),
            React.createElement("button", { className: "ds-disambig-btn ds-disambig-btn--cell", onClick: () => onChoice('cell', msgId), title: originalMessage },
                React.createElement("span", { className: "ds-disambig-btn-icon" }, "\uD83D\uDCDD"),
                React.createElement("span", { className: "ds-disambig-btn-body" },
                    React.createElement("strong", null, "Write to notebook"),
                    React.createElement("code", null, cmdPreview))))));
};
let _extMsgListener = null;
/** Called by the React component on mount to subscribe. */
export function setExternalMessageListener(fn) {
    _extMsgListener = fn;
}
/** Called by the widget's sendMessage() method. */
function _dispatchExternalMessage(msg) {
    _extMsgListener === null || _extMsgListener === void 0 ? void 0 : _extMsgListener(msg);
}
let _nonNbFocusCb = null;
export function setNonNotebookFocusCallback(fn) {
    _nonNbFocusCb = fn;
}
export function dispatchNonNotebookFocus(filePath = '') {
    void (_nonNbFocusCb === null || _nonNbFocusCb === void 0 ? void 0 : _nonNbFocusCb(filePath));
}
let _notebookActivatedCb = null;
export function setNotebookActivatedCallback(fn) {
    _notebookActivatedCb = fn;
}
export function dispatchNotebookActivated(path) {
    _notebookActivatedCb === null || _notebookActivatedCb === void 0 ? void 0 : _notebookActivatedCb(path);
}
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function generateId() {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}
// ---------------------------------------------------------------------------
// Chat component
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Settings panel
// ---------------------------------------------------------------------------
const PROVIDER_LIST = ['ANTHROPIC', 'OPENAI', 'GOOGLE', 'BEDROCK', 'AZURE', 'OPENROUTER', 'OLLAMA'];
/** Default model zoo per provider — shown if the user has nothing in .env yet. */
const DEFAULT_ZOO = {
    ANTHROPIC_MODELS: [
        'claude-sonnet-4-6',
        'claude-haiku-4-5-20251001',
        'claude-opus-4',
        'claude-3-5-sonnet-20241022',
        'claude-3-5-haiku-20241022',
    ],
    OPENAI_MODELS: ['gpt-4o', 'gpt-4o-mini', 'o1', 'o1-mini', 'o3-mini'],
    GOOGLE_MODELS: [
        'gemini-2.0-flash',
        'gemini-2.0-flash-lite',
        'gemini-1.5-pro',
        'gemini-1.5-flash',
    ],
    BEDROCK_MODELS: [
        'anthropic.claude-3-5-sonnet-20241022-v2:0',
        'anthropic.claude-3-5-haiku-20241022-v1:0',
        'anthropic.claude-3-haiku-20240307-v1:0',
        'meta.llama3-70b-instruct-v1:0',
        'mistral.mistral-large-2402-v1:0',
    ],
    AZURE_MODELS: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo'],
    OPENROUTER_MODELS: [
        'anthropic/claude-sonnet-4-6',
        'anthropic/claude-haiku-4-5',
        'openai/gpt-4o',
        'openai/gpt-4o-mini',
        'google/gemini-2.0-flash',
        'google/gemini-2.0-flash-lite',
        'meta-llama/llama-3.3-70b-instruct',
        'mistralai/mistral-large-2',
        'deepseek/deepseek-r1',
        'qwen/qwen-2.5-72b-instruct',
    ],
    OLLAMA_MODELS: [
        'qwen2.5-coder:7b-instruct',
        'qwen2.5-coder:1.5b-instruct',
        'llama3.2:3b',
        'mistral:7b',
        'deepseek-coder-v2',
    ],
};
const parseZoo = (raw) => raw.split(',').map(s => s.trim()).filter(Boolean);
const serializeZoo = (models) => models.join(',');
/** Return models from the zoo value, falling back to built-in defaults. */
const getZooModels = (zooKey, values) => {
    var _a, _b;
    const raw = (_a = values[zooKey]) !== null && _a !== void 0 ? _a : '';
    return raw.trim() ? parseZoo(raw) : (_b = DEFAULT_ZOO[zooKey]) !== null && _b !== void 0 ? _b : [];
};
const TAB_GROUPS = [
    {
        id: 'routing',
        label: 'Routing',
        providerKey: null,
        zooKey: null,
        fields: [
            { key: 'DS_CHAT_PROVIDER', label: 'Chat', type: 'select' },
            { key: 'DS_COMPLETION_PROVIDER', label: 'Completion', type: 'select' },
            { key: 'DS_BG_TASK_PROVIDER', label: 'Background Task', type: 'select' },
            { key: 'VARYS_PROMPT_CACHING', label: 'Prompt caching', type: 'toggle', sectionHeader: 'Features',
                description: 'Cache the static portion of the system prompt between requests. Reduces token cost ~70% on long sessions. Applies to Anthropic and Bedrock (explicit cache markers); OpenAI and Google cache automatically.' },
        ]
    },
    {
        id: 'anthropic',
        label: 'Anthropic',
        providerKey: 'ANTHROPIC',
        zooKey: 'ANTHROPIC_MODELS',
        fields: [
            { key: 'ANTHROPIC_API_KEY', label: 'API key', type: 'password', sectionHeader: 'Credentials' },
            { key: 'ANTHROPIC_CHAT_MODEL', label: 'Chat & Agent model', type: 'model-select', sectionHeader: 'Models' },
            { key: 'ANTHROPIC_COMPLETION_MODEL', label: 'Completion model', type: 'model-select' },
            { key: 'ANTHROPIC_BG_TASK_MODEL', label: 'Background model', type: 'model-select' },
            { key: 'ANTHROPIC_EXTENDED_THINKING', label: 'Extended thinking', type: 'toggle',
                description: 'Enable Anthropic native extended thinking (claude-3-7+ / claude-4+). The LLM reasons internally before answering — visible in the 🧠 panel. Higher token cost.' },
        ]
    },
    {
        id: 'openai',
        label: 'OpenAI',
        providerKey: 'OPENAI',
        zooKey: 'OPENAI_MODELS',
        fields: [
            { key: 'OPENAI_API_KEY', label: 'API key', type: 'password', sectionHeader: 'Credentials' },
            { key: 'OPENAI_CHAT_MODEL', label: 'Chat & Agent model', type: 'model-select', sectionHeader: 'Models' },
            { key: 'OPENAI_COMPLETION_MODEL', label: 'Completion model', type: 'model-select' },
            { key: 'OPENAI_BG_TASK_MODEL', label: 'Background model', type: 'model-select' },
        ]
    },
    {
        id: 'google',
        label: 'Google',
        providerKey: 'GOOGLE',
        zooKey: 'GOOGLE_MODELS',
        fields: [
            { key: 'GOOGLE_API_KEY', label: 'API key', type: 'password', sectionHeader: 'Credentials',
                description: 'For individual developers using the Gemini API directly.' },
            { key: 'GOOGLE_SERVICE_ACCOUNT_JSON', label: 'Service account JSON', type: 'text',
                placeholder: '/path/to/service_account.json',
                description: 'Path to a GCP service-account JSON file (project_id, private_key, client_email…). When set, takes precedence over the API key.' },
            { key: 'GOOGLE_CHAT_MODEL', label: 'Chat & Agent model', type: 'model-select', sectionHeader: 'Models' },
            { key: 'GOOGLE_ENABLE_THINKING', label: 'Enable thinking', type: 'toggle', sectionHeader: 'Features',
                description: 'Allow Gemini 2.5+ models to use extended reasoning (thinkingBudget). The reasoning trace appears as a collapsible thinking bubble in chat.' },
            { key: 'GOOGLE_THINKING_BUDGET', label: 'Thinking token budget', type: 'text', disabledWhen: 'GOOGLE_ENABLE_THINKING',
                placeholder: '8192  (use -1 for dynamic)',
                description: 'Max tokens the model may use for internal reasoning. Set to -1 to let the model decide. Only effective when Enable thinking is on and a Gemini 2.5+ model is selected.' },
            { key: 'GOOGLE_COMPLETION_MODEL', label: 'Completion model', type: 'model-select' },
            { key: 'GOOGLE_BG_TASK_MODEL', label: 'Background model', type: 'model-select' },
        ]
    },
    {
        id: 'bedrock',
        label: 'Bedrock',
        providerKey: 'BEDROCK',
        zooKey: 'BEDROCK_MODELS',
        fields: [
            { key: 'AWS_PROFILE', label: 'AWS profile', type: 'text', sectionHeader: 'Authentication', placeholder: 'e.g. default, np  (leave blank for explicit keys)' },
            { key: 'AWS_AUTH_REFRESH', label: 'Auth refresh command', type: 'text', placeholder: 'e.g. aws-azure-login --profile ITOSS --no-prompt  (runs only when token is expired)' },
            { key: 'AWS_ACCESS_KEY_ID', label: 'Access key ID', type: 'password', placeholder: '(leave blank when using AWS_PROFILE)' },
            { key: 'AWS_SECRET_ACCESS_KEY', label: 'Secret access key', type: 'password', placeholder: '(leave blank when using AWS_PROFILE)' },
            { key: 'AWS_SESSION_TOKEN', label: 'Session token', type: 'password', placeholder: '(optional)' },
            { key: 'AWS_REGION', label: 'Region', type: 'text', placeholder: 'us-east-1' },
            { key: 'BEDROCK_CHAT_MODEL', label: 'Chat & Agent model', type: 'model-select', sectionHeader: 'Models' },
            { key: 'BEDROCK_PROMPT_CACHING', label: 'Prompt caching', type: 'toggle', sectionHeader: 'Features',
                description: 'Prompt caching for Anthropic Claude models on Bedrock. Reduces cost on long multi-turn sessions.' },
            { key: 'BEDROCK_COMPLETION_MODEL', label: 'Completion model', type: 'model-select' },
            { key: 'BEDROCK_BG_TASK_MODEL', label: 'Background model', type: 'model-select' },
            { key: 'BEDROCK_ENABLE_THINKING', label: 'Extended thinking', type: 'toggle',
                description: 'Enable extended thinking for Anthropic Claude Sonnet and Opus models. Improves reasoning on complex tasks at the cost of higher latency and token usage.' },
            { key: 'BEDROCK_THINKING_BUDGET', label: 'Thinking token budget', type: 'text', disabledWhen: 'BEDROCK_ENABLE_THINKING',
                placeholder: '8000  (min 1024)' },
            { key: 'BEDROCK_MAX_TOKENS', label: 'Max output tokens', type: 'text',
                placeholder: 'leave blank for auto (4096 Haiku 4.5 · 8192 others)' },
        ]
    },
    {
        id: 'azure',
        label: 'Azure',
        providerKey: 'AZURE',
        zooKey: 'AZURE_MODELS',
        fields: [
            { key: 'AZURE_OPENAI_API_KEY', label: 'API key', type: 'password', sectionHeader: 'Credentials' },
            { key: 'AZURE_OPENAI_ENDPOINT', label: 'Endpoint URL', type: 'text', placeholder: 'https://YOUR-RESOURCE.openai.azure.com/' },
            { key: 'AZURE_OPENAI_API_VERSION', label: 'API version', type: 'text', placeholder: '2024-02-01' },
            { key: 'AZURE_CHAT_MODEL', label: 'Chat & Agent deployment', type: 'model-select', sectionHeader: 'Models' },
            { key: 'AZURE_PROMPT_CACHING', label: 'Prompt caching', type: 'toggle', sectionHeader: 'Features',
                description: 'Enable prompt prefix caching for deployments that support it.' },
            { key: 'AZURE_COMPLETION_MODEL', label: 'Completion deployment', type: 'model-select' },
            { key: 'AZURE_BG_TASK_MODEL', label: 'Background model', type: 'model-select' },
        ]
    },
    {
        id: 'openrouter',
        label: 'OpenRouter',
        providerKey: 'OPENROUTER',
        zooKey: 'OPENROUTER_MODELS',
        fields: [
            { key: 'OPENROUTER_API_KEY', label: 'API key', type: 'password', sectionHeader: 'Credentials' },
            { key: 'OPENROUTER_SITE_URL', label: 'Site URL (optional)', type: 'text', placeholder: 'https://your-app.com' },
            { key: 'OPENROUTER_SITE_NAME', label: 'Site name (optional)', type: 'text', placeholder: 'Varys' },
            { key: 'OPENROUTER_CHAT_MODEL', label: 'Chat & Agent model', type: 'model-select', sectionHeader: 'Models' },
            { key: 'OPENROUTER_PROMPT_CACHING', label: 'Prompt caching', type: 'toggle', sectionHeader: 'Features',
                description: 'Pass caching hints to providers that support it (e.g., Anthropic models via OpenRouter).' },
            { key: 'OPENROUTER_COMPLETION_MODEL', label: 'Completion model', type: 'model-select' },
            { key: 'OPENROUTER_BG_TASK_MODEL', label: 'Background model', type: 'model-select' },
        ]
    },
    {
        id: 'ollama',
        label: 'Ollama',
        providerKey: 'OLLAMA',
        zooKey: 'OLLAMA_MODELS',
        fields: [
            { key: 'OLLAMA_URL', label: 'Server URL', type: 'text', sectionHeader: 'Connection', placeholder: 'http://localhost:11434' },
            { key: 'OLLAMA_CHAT_MODEL', label: 'Chat & Agent model', type: 'model-select', sectionHeader: 'Models' },
            { key: 'OLLAMA_PROMPT_CACHING', label: 'Prompt caching', type: 'toggle', sectionHeader: 'Features',
                description: 'Ollama caches KV context natively. Enable to keep the system prompt resident between requests.' },
            { key: 'OLLAMA_COMPLETION_MODEL', label: 'Completion model', type: 'model-select' },
            { key: 'OLLAMA_BG_TASK_MODEL', label: 'Background model', type: 'model-select' },
        ]
    },
];
const MCPPanel = ({ apiClient }) => {
    const [servers, setServers] = useState({});
    const [totalTools, setTotalTools] = useState(0);
    const [configRaw, setConfigRaw] = useState('');
    const [loading, setLoading] = useState(false);
    const [toggling, setToggling] = useState(null);
    const [adding, setAdding] = useState(false);
    const [pasteJson, setPasteJson] = useState('');
    const [pasteError, setPasteError] = useState('');
    const [expandedTools, setExpandedTools] = useState({});
    const [statusMsg, setStatusMsg] = useState(null);
    const [configOpen, setConfigOpen] = useState(false);
    const refresh = async () => {
        var _a;
        setLoading(true);
        try {
            const s = await apiClient.getMCPStatus();
            setServers(s.servers);
            setTotalTools(s.totalTools);
            setConfigRaw((_a = s.configRaw) !== null && _a !== void 0 ? _a : '');
        }
        catch (e) {
            setStatusMsg({ type: 'err', text: `Load failed: ${e instanceof Error ? e.message : String(e)}` });
        }
        finally {
            setLoading(false);
        }
    };
    useEffect(() => { void refresh(); }, []);
    const handleReload = async () => {
        setLoading(true);
        setStatusMsg(null);
        try {
            await apiClient.reloadMCP();
            await refresh();
            setStatusMsg({ type: 'ok', text: 'Servers reloaded from config.' });
        }
        catch (e) {
            setStatusMsg({ type: 'err', text: `Reload failed: ${e instanceof Error ? e.message : String(e)}` });
        }
        finally {
            setLoading(false);
        }
    };
    const handleToggle = async (name, currentlyDisabled) => {
        setToggling(name);
        setStatusMsg(null);
        try {
            await apiClient.toggleMCPServer(name, !currentlyDisabled);
            await refresh();
            setStatusMsg({
                type: 'ok',
                text: `Server "${name}" ${currentlyDisabled ? 'enabled' : 'disabled'}.`,
            });
        }
        catch (e) {
            setStatusMsg({ type: 'err', text: `Toggle failed: ${e instanceof Error ? e.message : String(e)}` });
        }
        finally {
            setToggling(null);
        }
    };
    const handleRetry = async (name) => {
        var _a;
        setToggling(name);
        setStatusMsg(null);
        try {
            // Re-run connect() by going disabled→enabled
            await apiClient.toggleMCPServer(name, false);
            await refresh();
            const updated = await apiClient.getMCPStatus();
            const srv = updated.servers[name];
            if ((srv === null || srv === void 0 ? void 0 : srv.status) === 'connected') {
                setStatusMsg({ type: 'ok', text: `"${name}" connected.` });
            }
            else {
                setStatusMsg({ type: 'err', text: `"${name}" retry failed: ${(_a = srv === null || srv === void 0 ? void 0 : srv.error) !== null && _a !== void 0 ? _a : 'unknown error'}` });
            }
        }
        catch (e) {
            setStatusMsg({ type: 'err', text: `Retry failed: ${e instanceof Error ? e.message : String(e)}` });
        }
        finally {
            setToggling(null);
        }
    };
    /**
     * Parse and add servers from a pasted JSON blob.
     * Accepts both the canonical Cursor/Claude Desktop format:
     *   { "mcpServers": { "Name": { "command": ..., "args": [...], "env": {}, "disabled": false } } }
     * and the bare format (each top-level key is a server name):
     *   { "Name": { "command": ..., ... } }
     */
    const handleAddFromJson = async () => {
        var _a;
        setPasteError('');
        setStatusMsg(null);
        const raw = pasteJson.trim();
        if (!raw)
            return;
        let parsed;
        try {
            parsed = JSON.parse(raw);
        }
        catch (e) {
            setPasteError(`Invalid JSON: ${e instanceof Error ? e.message : String(e)}`);
            return;
        }
        // Normalise to { name -> config } regardless of wrapper key
        const entries = ('mcpServers' in parsed && typeof parsed['mcpServers'] === 'object' && parsed['mcpServers'] !== null)
            ? parsed['mcpServers']
            : parsed;
        const names = Object.keys(entries);
        if (names.length === 0) {
            setPasteError('No servers found. Expected at least one entry under "mcpServers".');
            return;
        }
        setAdding(true);
        const added = [];
        const errors = [];
        for (const name of names) {
            const cfg = entries[name];
            if (!cfg || typeof cfg !== 'object') {
                errors.push(`${name}: not an object`);
                continue;
            }
            const command = ((_a = cfg['command']) !== null && _a !== void 0 ? _a : '').trim();
            const args = Array.isArray(cfg['args']) ? cfg['args'] : [];
            const env = (typeof cfg['env'] === 'object' && cfg['env'] !== null)
                ? cfg['env'] : {};
            const disabled = Boolean(cfg['disabled']);
            if (!command) {
                errors.push(`${name}: missing "command"`);
                continue;
            }
            try {
                await apiClient.addMCPServer(name, command, args, env);
                if (disabled) {
                    // Newly-added servers default to enabled; disable if the config says so
                    await apiClient.toggleMCPServer(name, true);
                }
                added.push(name);
            }
            catch (e) {
                errors.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
            }
        }
        await refresh();
        setAdding(false);
        if (errors.length === 0) {
            setPasteJson('');
            setStatusMsg({ type: 'ok', text: `Added: ${added.join(', ')}` });
        }
        else {
            const okPart = added.length ? `Added: ${added.join(', ')}. ` : '';
            const errPart = `Errors: ${errors.join('; ')}`;
            setStatusMsg({ type: 'err', text: okPart + errPart });
        }
    };
    const handleRemove = async (name) => {
        try {
            await apiClient.removeMCPServer(name);
            await refresh();
            setStatusMsg({ type: 'ok', text: `Server "${name}" removed.` });
        }
        catch (e) {
            setStatusMsg({ type: 'err', text: `Remove failed: ${e instanceof Error ? e.message : String(e)}` });
        }
    };
    const STATUS_DOT = {
        connected: '🟢', connecting: '🟡', disconnected: '⚫', error: '🔴', disabled: '⬜',
    };
    return (React.createElement("div", { className: "ds-mcp-panel" },
        React.createElement("div", { className: "ds-mcp-header" },
            React.createElement("span", { className: "ds-mcp-summary" },
                React.createElement("span", { className: "ds-mcp-count" }, Object.keys(servers).length),
                " servers",
                ' · ',
                React.createElement("span", { className: "ds-mcp-count" }, totalTools),
                " tools"),
            React.createElement("button", { className: "ds-mcp-reload-btn", onClick: () => void handleReload(), disabled: loading }, loading ? '…' : '↺ Reload')),
        statusMsg && (React.createElement("div", { className: `ds-mcp-status ds-mcp-status--${statusMsg.type}` }, statusMsg.text)),
        Object.keys(servers).length === 0 && !loading && (React.createElement("p", { className: "ds-mcp-empty" },
            "No servers configured. Add one below or edit",
            ' ',
            React.createElement("code", null, "~/.jupyter/varys-mcp.json"),
            " directly.")),
        Object.entries(servers).map(([name, info]) => {
            var _a;
            const isDisabled = info.config.disabled;
            const isToggling = toggling === name;
            return (React.createElement("div", { key: name, className: `ds-mcp-server ds-mcp-server--${info.status}${isDisabled ? ' ds-mcp-server--dim' : ''}` },
                React.createElement("div", { className: "ds-mcp-server-header" },
                    React.createElement("span", { className: "ds-mcp-server-dot", title: info.status }, (_a = STATUS_DOT[info.status]) !== null && _a !== void 0 ? _a : '⚫'),
                    React.createElement("div", { className: "ds-mcp-server-info" },
                        React.createElement("span", { className: `ds-mcp-server-name${isDisabled ? ' ds-mcp-server-name--disabled' : ''}` }, name),
                        React.createElement("span", { className: "ds-mcp-server-cmd", title: `${info.config.command} ${info.config.args.join(' ')}` },
                            info.config.command,
                            " ",
                            info.config.args.join(' '))),
                    React.createElement("label", { className: "ds-mcp-server-toggle", title: isDisabled ? 'Enable server' : 'Disable server (keeps config)' },
                        React.createElement("input", { type: "checkbox", checked: !isDisabled, disabled: isToggling, onChange: () => void handleToggle(name, isDisabled) }),
                        React.createElement("span", { className: "ds-mcp-server-toggle-slider" })),
                    React.createElement("button", { className: "ds-mcp-server-remove", onClick: () => void handleRemove(name), title: "Remove server" }, "\u2715")),
                info.error && (React.createElement("div", { className: "ds-mcp-server-error" },
                    React.createElement("pre", { className: "ds-mcp-server-error-pre" }, info.error),
                    React.createElement("button", { className: "ds-mcp-retry-btn", disabled: isToggling, onClick: () => void handleRetry(name), title: "Retry connection" }, isToggling ? '…' : '↺ Retry'))),
                info.tools.length > 0 && (React.createElement("div", { className: "ds-mcp-tools" },
                    React.createElement("button", { className: "ds-mcp-tools-toggle", onClick: () => setExpandedTools(p => (Object.assign(Object.assign({}, p), { [name]: !p[name] }))) },
                        expandedTools[name] ? '▾' : '▸',
                        " ",
                        info.tools.length,
                        " tool",
                        info.tools.length !== 1 ? 's' : ''),
                    expandedTools[name] && (React.createElement("div", { className: "ds-mcp-tools-chips" }, info.tools.map(t => (React.createElement("span", { key: t, className: "ds-mcp-tool-chip" }, t.replace(`${name}__`, ''))))))))));
        }),
        React.createElement("div", { className: "ds-mcp-add" },
            React.createElement("div", { className: "ds-mcp-add-title" }, "Add server"),
            React.createElement("p", { className: "ds-mcp-hint ds-mcp-hint--top" },
                "Paste the JSON block exactly as provided by Cursor, Claude Desktop, or any MCP resource. Both the ",
                React.createElement("code", null,
                    "{",
                    "\"mcpServers\":",
                    "{",
                    "\u2026",
                    "}",
                    "}"),
                " wrapper and bare",
                ' ',
                React.createElement("code", null,
                    "{",
                    "\"Name\":",
                    "{",
                    "\u2026",
                    "}",
                    "}"),
                " formats are accepted. Multiple servers in one paste are all added at once."),
            React.createElement("textarea", { className: "ds-mcp-input ds-mcp-paste-textarea", placeholder: `{\n  "mcpServers": {\n    "Filesystem": {\n      "command": "npx",\n      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],\n      "env": {},\n      "disabled": false\n    }\n  }\n}`, value: pasteJson, rows: 7, spellCheck: false, onChange: e => { setPasteJson(e.target.value); setPasteError(''); } }),
            pasteError && (React.createElement("div", { className: "ds-mcp-paste-error" }, pasteError)),
            React.createElement("button", { className: "ds-mcp-add-btn", onClick: () => void handleAddFromJson(), disabled: adding || !pasteJson.trim() }, adding ? 'Connecting…' : '+ Add server(s)'),
            React.createElement("p", { className: "ds-mcp-hint" },
                "Config persisted to ",
                React.createElement("code", null, "~/.jupyter/varys-mcp.json"),
                ". Disable servers to keep their config without running the subprocess.")),
        configRaw && (React.createElement("div", { className: "ds-mcp-config-viewer" },
            React.createElement("button", { className: "ds-mcp-config-toggle", onClick: () => setConfigOpen(o => !o) },
                configOpen ? '▾' : '▸',
                " Raw config",
                React.createElement("span", { className: "ds-mcp-config-toggle-path" }, "~/.jupyter/varys-mcp.json")),
            configOpen && (React.createElement("textarea", { className: "ds-mcp-config-textarea", value: configRaw, readOnly: true, rows: Math.min(configRaw.split('\n').length + 1, 20), spellCheck: false }))))));
};
const ModelZooSection = ({ zooKey, values, onChange }) => {
    const [newModel, setNewModel] = useState('');
    const models = getZooModels(zooKey, values);
    const commit = (updated) => onChange(zooKey, serializeZoo(updated));
    const handleAdd = () => {
        const name = newModel.trim();
        if (!name || models.includes(name))
            return;
        commit([...models, name]);
        setNewModel('');
    };
    const handleRemove = (name) => commit(models.filter(m => m !== name));
    const handleKeyDown = (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            handleAdd();
        }
    };
    return (React.createElement("div", { className: "ds-settings-zoo" },
        React.createElement("div", { className: "ds-settings-zoo-header" },
            React.createElement("span", { className: "ds-settings-zoo-title" }, "Model Zoo"),
            React.createElement("span", { className: "ds-settings-zoo-count" }, models.length)),
        React.createElement("div", { className: "ds-settings-zoo-chips" },
            models.map(m => (React.createElement("span", { key: m, className: "ds-settings-zoo-chip", title: m },
                React.createElement("span", { className: "ds-settings-zoo-chip-name" }, m),
                React.createElement("button", { className: "ds-settings-zoo-chip-remove", onClick: () => handleRemove(m), title: `Remove ${m}` }, "\u00D7")))),
            models.length === 0 && (React.createElement("span", { className: "ds-settings-zoo-empty" }, "No models yet \u2014 add one below."))),
        React.createElement("div", { className: "ds-settings-zoo-add" },
            React.createElement("input", { className: "ds-settings-zoo-add-input", value: newModel, onChange: e => setNewModel(e.target.value), onKeyDown: handleKeyDown, placeholder: "Type model name and press Enter\u2026", autoComplete: "off", spellCheck: false }),
            React.createElement("button", { className: "ds-settings-zoo-add-btn", onClick: handleAdd, disabled: !newModel.trim() || models.includes(newModel.trim()), title: "Add to zoo" }, "+ Add"))));
};
const SETTINGS_NAV_GROUPS = [
    {
        label: 'LLM',
        items: [
            {
                id: 'model-providers',
                label: 'Model Providers',
                icon: (React.createElement("svg", { width: "15", height: "15", viewBox: "0 0 15 15", fill: "none", stroke: "currentColor", strokeWidth: "1.3" },
                    React.createElement("rect", { x: "1.5", y: "1.5", width: "5", height: "5", rx: "1" }),
                    React.createElement("rect", { x: "8.5", y: "1.5", width: "5", height: "5", rx: "1" }),
                    React.createElement("rect", { x: "1.5", y: "8.5", width: "5", height: "5", rx: "1" }),
                    React.createElement("rect", { x: "8.5", y: "8.5", width: "5", height: "5", rx: "1" }))),
                subItems: [
                    { id: 'anthropic', label: 'Anthropic' },
                    { id: 'openai', label: 'OpenAI' },
                    { id: 'google', label: 'Google' },
                    { id: 'bedrock', label: 'Bedrock' },
                    { id: 'azure', label: 'Azure' },
                    { id: 'ollama', label: 'Ollama' },
                    { id: 'openrouter', label: 'OpenRouter' },
                ],
            },
            {
                id: 'model-routing',
                label: 'Model Routing',
                icon: (React.createElement("svg", { width: "15", height: "15", viewBox: "0 0 15 15", fill: "none", stroke: "currentColor", strokeWidth: "1.3" },
                    React.createElement("path", { d: "M1 7.5h4M13 4l-4 3.5L13 11M9 4h2a2 2 0 012 2v0M9 11h2a2 2 0 002-2v0" }))),
            },
            {
                id: 'mcp',
                label: 'MCP',
                icon: (React.createElement("svg", { width: "15", height: "15", viewBox: "0 0 15 15", fill: "none", stroke: "currentColor", strokeWidth: "1.3" },
                    React.createElement("circle", { cx: "7.5", cy: "7.5", r: "2" }),
                    React.createElement("path", { d: "M7.5 1v2M7.5 12v2M1 7.5h2M12 7.5h2M2.9 2.9l1.4 1.4M10.7 10.7l1.4 1.4M2.9 12.1l1.4-1.4M10.7 4.3l1.4-1.4" }))),
            },
        ],
    },
    {
        label: 'Workspace',
        items: [
            {
                id: 'context',
                label: 'Context',
                icon: (React.createElement("svg", { width: "15", height: "15", viewBox: "0 0 15 15", fill: "none", stroke: "currentColor", strokeWidth: "1.3" },
                    React.createElement("rect", { x: "1.5", y: "2.5", width: "12", height: "10", rx: "1.2" }),
                    React.createElement("path", { d: "M4 5.5h7M4 8h7M4 10.5h4" }))),
            },
            {
                id: 'skills',
                label: 'Skills',
                icon: (React.createElement("svg", { width: "15", height: "15", viewBox: "0 0 15 15", fill: "none", stroke: "currentColor", strokeWidth: "1.3" },
                    React.createElement("path", { d: "M7.5 1L9.5 5.5H14L10.5 8.5L11.5 13L7.5 10.5L3.5 13L4.5 8.5L1 5.5H5.5L7.5 1Z" }))),
            },
            {
                id: 'commands',
                label: 'Commands',
                icon: (React.createElement("svg", { width: "15", height: "15", viewBox: "0 0 15 15", fill: "none", stroke: "currentColor", strokeWidth: "1.3" },
                    React.createElement("path", { d: "M3 5l2 2-2 2M7 9h4" }))),
            },
            {
                id: 'tags',
                label: 'Tags',
                icon: (React.createElement("svg", { width: "15", height: "15", viewBox: "0 0 15 15", fill: "none", stroke: "currentColor", strokeWidth: "1.3" },
                    React.createElement("path", { d: "M1.5 1.5h5.5l6 6a1 1 0 010 1.4l-4 4a1 1 0 01-1.4 0l-6-6V1.5z" }),
                    React.createElement("circle", { cx: "5", cy: "5", r: "1", fill: "currentColor", stroke: "none" }))),
            },
        ],
    },
    {
        label: 'Memory',
        items: [
            {
                id: 'memory',
                label: 'Long-term memory',
                icon: (React.createElement("svg", { width: "15", height: "15", viewBox: "0 0 15 15", fill: "none", stroke: "currentColor", strokeWidth: "1.3" },
                    React.createElement("rect", { x: "1.5", y: "4", width: "12", height: "7", rx: "1.5" }),
                    React.createElement("path", { d: "M5 4V2.5M10 4V2.5M5 11v1.5M10 11v1.5" }))),
            },
        ],
    },
    {
        label: 'Analytics',
        items: [
            {
                id: 'usage',
                label: 'Usage',
                icon: (React.createElement("svg", { width: "15", height: "15", viewBox: "0 0 15 15", fill: "none", stroke: "currentColor", strokeWidth: "1.3" },
                    React.createElement("rect", { x: "1", y: "9", width: "3", height: "5", rx: "0.5" }),
                    React.createElement("rect", { x: "6", y: "5", width: "3", height: "9", rx: "0.5" }),
                    React.createElement("rect", { x: "11", y: "1", width: "3", height: "13", rx: "0.5" }))),
            },
        ],
    },
    {
        label: 'Maintenance',
        items: [
            {
                id: 'maintenance',
                label: 'Notebooks',
                icon: (React.createElement("svg", { width: "15", height: "15", viewBox: "0 0 15 15", fill: "none", stroke: "currentColor", strokeWidth: "1.3" },
                    React.createElement("path", { d: "M7.5 1L9.18 5.27L13.78 5.64L10.28 8.63L11.39 13.09L7.5 10.7L3.61 13.09L4.72 8.63L1.22 5.64L5.82 5.27L7.5 1Z", strokeLinejoin: "round" }),
                    React.createElement("line", { x1: "7.5", y1: "5", x2: "7.5", y2: "10" }),
                    React.createElement("line", { x1: "5", y1: "7.5", x2: "10", y2: "7.5" }))),
            },
        ],
    },
];
const SECTION_HEADING_MAP = {
    'model-routing': 'Model Routing',
    'model-providers': 'Model Providers',
    'mcp': 'MCP',
    'context': 'Context',
    'skills': 'Skills',
    'commands': 'Commands',
    'tags': 'Tags',
    'memory': 'Long-term memory',
    'usage': 'Usage',
    'maintenance': 'Notebooks',
};
const SUB_SECTION_LABEL_MAP = {
    anthropic: 'Anthropic',
    openai: 'OpenAI',
    google: 'Google',
    bedrock: 'Bedrock',
    azure: 'Azure',
    ollama: 'Ollama',
    openrouter: 'OpenRouter',
};
const SettingsSidebar = ({ activeSection, activeSubSection, providerStatuses, onNavigate }) => (React.createElement("div", { className: "ds-settings-nav-sidebar" },
    React.createElement("div", { className: "ds-settings-nav-title" }, "Settings"),
    SETTINGS_NAV_GROUPS.map((group, gi) => (React.createElement(React.Fragment, { key: group.label },
        gi > 0 && React.createElement("div", { className: "ds-settings-nav-divider" }),
        React.createElement("div", { className: `ds-settings-nav-group-label${gi === 0 ? ' ds-settings-nav-group-label--first' : ''}` }, group.label),
        group.items.map(item => {
            var _a;
            const isActive = activeSection === item.id;
            const handleClick = () => {
                var _a, _b, _c;
                const defaultSub = (_c = (_b = (_a = item.subItems) === null || _a === void 0 ? void 0 : _a[0]) === null || _b === void 0 ? void 0 : _b.id) !== null && _c !== void 0 ? _c : null;
                const sub = isActive && activeSubSection ? activeSubSection : defaultSub;
                onNavigate(item.id, sub);
            };
            return (React.createElement(React.Fragment, { key: item.id },
                React.createElement("button", { className: `ds-settings-nav-item${isActive ? ' ds-settings-nav-item--active' : ''}`, onClick: handleClick, tabIndex: 0, onKeyDown: e => { if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        handleClick();
                    } } },
                    React.createElement("span", { className: "ds-settings-nav-item-icon" }, item.icon),
                    React.createElement("span", { className: "ds-settings-nav-item-label" }, item.label)),
                isActive && ((_a = item.subItems) === null || _a === void 0 ? void 0 : _a.map(sub => {
                    const isSubActive = activeSubSection === sub.id;
                    const connected = providerStatuses[sub.id] === true;
                    return (React.createElement("button", { key: sub.id, className: `ds-settings-nav-sub-item${isSubActive ? ' ds-settings-nav-sub-item--active' : ''}`, onClick: () => onNavigate(item.id, sub.id), tabIndex: 0, onKeyDown: e => { if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            onNavigate(item.id, sub.id);
                        } } },
                        React.createElement("span", { className: "ds-settings-nav-dot", style: { background: connected ? '#1D9E75' : 'var(--ds-border)' } }),
                        sub.label));
                }))));
        }))))));
const SectionHeading = ({ section, subSection }) => {
    var _a, _b;
    const heading = (_a = SECTION_HEADING_MAP[section]) !== null && _a !== void 0 ? _a : section;
    const sub = subSection ? ((_b = SUB_SECTION_LABEL_MAP[subSection]) !== null && _b !== void 0 ? _b : subSection) : null;
    return (React.createElement("div", { className: "ds-settings-section-heading" },
        React.createElement("span", { className: "ds-settings-section-heading-main" }, heading),
        sub && (React.createElement(React.Fragment, null,
            React.createElement("span", { className: "ds-settings-section-heading-sep" }, " \u00B7 "),
            React.createElement("span", { className: "ds-settings-section-heading-sub" }, sub)))));
};
// ---------------------------------------------------------------------------
// SettingsPanel
// ---------------------------------------------------------------------------
const ROUTING_KEYS = [
    'DS_CHAT_PROVIDER',
    'DS_COMPLETION_PROVIDER',
    'DS_BG_TASK_PROVIDER',
];
const ModelsPanel = ({ apiClient, onClose, onSaved, notebookPath = '', section = 'model-routing', subSection = null, onProviderStatusChange, }) => {
    var _a, _b, _c, _d;
    const [values, setValues] = useState({});
    const [masked, setMasked] = useState({});
    const [envPath, setEnvPath] = useState('');
    const [envExists, setEnvExists] = useState(false);
    const [envPathIsCustom, setEnvPathIsCustom] = useState(false);
    const [newEnvPath, setNewEnvPath] = useState('');
    const [editingEnvPath, setEditingEnvPath] = useState(false);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [status, setStatus] = useState(null);
    const [toolSupport, setToolSupport] = useState(null);
    const [checkingToolSupport, setCheckingToolSupport] = useState(false);
    const [saveTried, setSaveTried] = useState(false);
    const [revealed, setRevealed] = useState({});
    useEffect(() => {
        apiClient
            .getSettings()
            .then(data => {
            var _a, _b, _c;
            const v = {};
            const m = {};
            for (const [k, entry] of Object.entries(data)) {
                if (k.startsWith('_'))
                    continue;
                const e = entry;
                v[k] = (_a = e.value) !== null && _a !== void 0 ? _a : '';
                m[k] = (_b = e.masked) !== null && _b !== void 0 ? _b : false;
            }
            // Pre-seed zoo defaults so dropdowns always have options
            for (const zooKey of Object.keys(DEFAULT_ZOO)) {
                if (!v[zooKey])
                    v[zooKey] = DEFAULT_ZOO[zooKey].join(',');
            }
            setValues(v);
            setMasked(m);
            setEnvPath(String((_c = data._env_path) !== null && _c !== void 0 ? _c : ''));
            setEnvExists(Boolean(data._env_exists));
            setEnvPathIsCustom(Boolean(data._env_path_is_custom));
            setLoading(false);
        })
            .catch(err => {
            setStatus({ type: 'error', text: `Failed to load: ${err}` });
            setLoading(false);
        });
    }, [apiClient]);
    // Report active routing providers to the sidebar so status dots stay current
    useEffect(() => {
        var _a;
        if (!onProviderStatusChange)
            return;
        const statuses = {};
        for (const key of ROUTING_KEYS) {
            const val = ((_a = values[key]) !== null && _a !== void 0 ? _a : '').trim().toLowerCase();
            if (val)
                statuses[val] = true;
        }
        onProviderStatusChange(statuses);
    }, [values, onProviderStatusChange]);
    // Derive the chat model key for the currently-displayed provider tab
    const CHAT_MODEL_KEYS = {
        anthropic: 'ANTHROPIC_CHAT_MODEL',
        openai: 'OPENAI_CHAT_MODEL',
        google: 'GOOGLE_CHAT_MODEL',
        bedrock: 'BEDROCK_CHAT_MODEL',
        azure: 'AZURE_CHAT_MODEL',
        ollama: 'OLLAMA_CHAT_MODEL',
        openrouter: 'OPENROUTER_CHAT_MODEL',
    };
    const chatModelKey = section !== 'model-routing' ? ((_a = CHAT_MODEL_KEYS[subSection !== null && subSection !== void 0 ? subSection : 'anthropic']) !== null && _a !== void 0 ? _a : null) : null;
    const chatModelValue = chatModelKey ? ((_b = values[chatModelKey]) !== null && _b !== void 0 ? _b : '').trim() : '';
    // Check tool calling support whenever the provider's chat model changes
    useEffect(() => {
        if (!chatModelKey || !chatModelValue) {
            setToolSupport(null);
            setCheckingToolSupport(false);
            return;
        }
        let cancelled = false;
        setCheckingToolSupport(true);
        setToolSupport(null);
        apiClient.checkToolSupport(subSection !== null && subSection !== void 0 ? subSection : 'anthropic', chatModelValue)
            .then(r => { if (!cancelled) {
            setToolSupport(r);
            setCheckingToolSupport(false);
        } })
            .catch(() => { if (!cancelled) {
            setToolSupport(null);
            setCheckingToolSupport(false);
        } });
        return () => { cancelled = true; };
    }, [chatModelKey, chatModelValue, subSection, apiClient]);
    const handleChange = (key, value) => {
        setValues(v => (Object.assign(Object.assign({}, v), { [key]: value })));
        if (masked[key])
            setMasked(m => (Object.assign(Object.assign({}, m), { [key]: false })));
    };
    const _validateBeforeSave = () => {
        var _a, _b, _c, _d, _e, _f, _g, _h;
        const PROVIDER_API_KEYS = {
            ANTHROPIC: 'ANTHROPIC_API_KEY',
            OPENAI: 'OPENAI_API_KEY',
            GOOGLE: 'GOOGLE_API_KEY',
            AZURE: 'AZURE_OPENAI_API_KEY',
            OPENROUTER: 'OPENROUTER_API_KEY',
            // BEDROCK is intentionally absent: it supports profile-based auth via
            // AWS_PROFILE / ~/.aws/credentials with no explicit key required.
        };
        const PROVIDER_MODEL_KEYS = {
            ANTHROPIC: { chat: 'ANTHROPIC_CHAT_MODEL', completion: 'ANTHROPIC_COMPLETION_MODEL' },
            OPENAI: { chat: 'OPENAI_CHAT_MODEL', completion: 'OPENAI_COMPLETION_MODEL' },
            GOOGLE: { chat: 'GOOGLE_CHAT_MODEL', completion: 'GOOGLE_COMPLETION_MODEL' },
            AZURE: { chat: 'AZURE_CHAT_MODEL', completion: 'AZURE_COMPLETION_MODEL' },
            OPENROUTER: { chat: 'OPENROUTER_CHAT_MODEL', completion: 'OPENROUTER_COMPLETION_MODEL' },
            BEDROCK: { chat: 'BEDROCK_CHAT_MODEL', completion: 'BEDROCK_COMPLETION_MODEL' },
            OLLAMA: { chat: 'OLLAMA_CHAT_MODEL', completion: 'OLLAMA_COMPLETION_MODEL' },
        };
        const chatProvider = ((_a = values['DS_CHAT_PROVIDER']) !== null && _a !== void 0 ? _a : '').toUpperCase();
        const completionProvider = ((_b = values['DS_COMPLETION_PROVIDER']) !== null && _b !== void 0 ? _b : '').toUpperCase();
        // Check that chat provider is set
        if (!chatProvider) {
            return 'DS_CHAT_PROVIDER is empty. Select a provider for Chat in the Routing tab.';
        }
        // Check API key for chat provider (skip Ollama — no key needed)
        if (chatProvider in PROVIDER_API_KEYS) {
            const keyField = PROVIDER_API_KEYS[chatProvider];
            const keyVal = ((_c = values[keyField]) !== null && _c !== void 0 ? _c : '').trim();
            if (!keyVal || keyVal === '••••••••') {
                return `${keyField} is empty. Set the API key for ${chatProvider} in its tab.`;
            }
        }
        // Check chat model
        const chatModelKey = (_d = PROVIDER_MODEL_KEYS[chatProvider]) === null || _d === void 0 ? void 0 : _d['chat'];
        if (chatModelKey && !((_e = values[chatModelKey]) !== null && _e !== void 0 ? _e : '').trim()) {
            return `${chatModelKey} is empty. Select a chat model for ${chatProvider}.`;
        }
        // If a completion provider is set, validate it too
        if (completionProvider) {
            if (completionProvider in PROVIDER_API_KEYS) {
                const keyField = PROVIDER_API_KEYS[completionProvider];
                const keyVal = ((_f = values[keyField]) !== null && _f !== void 0 ? _f : '').trim();
                if (!keyVal || keyVal === '••••••••') {
                    return `${keyField} is empty. Set the API key for ${completionProvider} in its tab.`;
                }
            }
            const completionModelKey = (_g = PROVIDER_MODEL_KEYS[completionProvider]) === null || _g === void 0 ? void 0 : _g['completion'];
            if (completionModelKey && !((_h = values[completionModelKey]) !== null && _h !== void 0 ? _h : '').trim()) {
                return `${completionModelKey} is empty. Select a completion model for ${completionProvider}.`;
            }
        }
        return null;
    };
    const handleSave = async () => {
        var _a;
        setSaveTried(true);
        setStatus(null);
        const validationError = _validateBeforeSave();
        if (validationError) {
            setStatus({ type: 'error', text: validationError });
            return;
        }
        setSaving(true);
        try {
            const payload = Object.assign({}, values);
            // Normalize toggle fields before saving.  An untouched toggle has value ''
            // (loaded from a varys.env line like KEY=).  The UI renders '' as ON because
            // ('' ?? 'true') !== 'false' === true.  Without this step the backend
            // receives '' and treats it as OFF, creating a visual/backend mismatch.
            for (const group of TAB_GROUPS) {
                for (const field of group.fields) {
                    if (field.type === 'toggle' && !payload[field.key]) {
                        // Preserve the visual state: empty → ON → write 'true'
                        payload[field.key] = 'true';
                    }
                }
            }
            if (editingEnvPath && newEnvPath.trim()) {
                payload['_new_env_path'] = newEnvPath.trim();
            }
            const result = await apiClient.saveSettings(payload);
            if (result.error) {
                setStatus({ type: 'error', text: result.error });
            }
            else {
                if (editingEnvPath && newEnvPath.trim()) {
                    setEnvPath(newEnvPath.trim());
                    setEnvPathIsCustom(true);
                    setEnvExists(true);
                    setEditingEnvPath(false);
                    setNewEnvPath('');
                }
                setStatus({
                    type: 'success',
                    text: `Saved ${((_a = result.updated) !== null && _a !== void 0 ? _a : []).length} setting(s). Active immediately.`
                });
                onSaved === null || onSaved === void 0 ? void 0 : onSaved();
            }
        }
        catch (err) {
            setStatus({ type: 'error', text: `Save failed: ${err}` });
        }
        finally {
            setSaving(false);
        }
    };
    if (loading) {
        return React.createElement("div", { className: "ds-settings-loading" }, "Loading settings\u2026");
    }
    const currentGroup = section === 'model-routing'
        ? ((_c = TAB_GROUPS.find(g => g.id === 'routing')) !== null && _c !== void 0 ? _c : TAB_GROUPS[0])
        : ((_d = TAB_GROUPS.find(g => g.id === (subSection !== null && subSection !== void 0 ? subSection : 'anthropic'))) !== null && _d !== void 0 ? _d : TAB_GROUPS[1]);
    const TASK_LABELS = {
        DS_CHAT_PROVIDER: 'Chat / Agent',
        DS_COMPLETION_PROVIDER: 'Completion',
        DS_BG_TASK_PROVIDER: 'Background Task',
    };
    return (React.createElement("div", { className: "ds-settings-panel" },
        React.createElement("div", { className: "ds-settings-tab-content" }, section === 'model-routing' ? (React.createElement(React.Fragment, null,
            React.createElement("div", { className: "ds-settings-routing-grid" }, currentGroup.fields.map(field => {
                var _a, _b, _c, _d, _e;
                const label = (_a = TASK_LABELS[field.key]) !== null && _a !== void 0 ? _a : field.label;
                if (field.type === 'toggle') {
                    const isOn = ((_b = values[field.key]) !== null && _b !== void 0 ? _b : 'true') !== 'false';
                    return (React.createElement(React.Fragment, { key: field.key },
                        field.sectionHeader && (React.createElement("div", { className: "ds-settings-routing-section-header" }, field.sectionHeader)),
                        React.createElement("label", { className: "ds-settings-label" }, label),
                        React.createElement("div", { className: "ds-settings-routing-toggle-row" },
                            React.createElement("label", { className: "ds-settings-toggle-switch" },
                                React.createElement("input", { type: "checkbox", checked: isOn, onChange: () => handleChange(field.key, isOn ? 'false' : 'true') }),
                                React.createElement("span", { className: "ds-settings-toggle-slider" })),
                            field.description && (React.createElement("span", { className: "ds-settings-routing-toggle-desc" }, field.description)))));
                }
                if (field.key === 'DS_COMPLETION_PROVIDER') {
                    return (React.createElement(React.Fragment, { key: field.key },
                        React.createElement("label", { className: "ds-settings-label" }, label),
                        React.createElement("div", { className: "ds-settings-routing-controls" },
                            React.createElement("select", { className: "ds-settings-select", value: (_c = values[field.key]) !== null && _c !== void 0 ? _c : '', onChange: e => handleChange(field.key, e.target.value) },
                                React.createElement("option", { value: "" }, "\u2014 select provider \u2014"),
                                PROVIDER_LIST.map(p => (React.createElement("option", { key: p, value: p }, p)))),
                            React.createElement("label", { className: "ds-settings-token-label", title: "Max tokens returned per completion" },
                                "Tokens",
                                React.createElement("input", { className: "ds-settings-token-input", type: "number", min: 16, max: 2048, step: 16, value: (_d = values['COMPLETION_MAX_TOKENS']) !== null && _d !== void 0 ? _d : '128', onChange: e => handleChange('COMPLETION_MAX_TOKENS', e.target.value), title: "Max tokens returned per completion (default: 128)" })))));
                }
                // Default: provider select + optional inline info bubble
                const bubble = field.key === 'DS_BG_TASK_PROVIDER' ? (React.createElement("span", { key: `bubble-${field.key}`, className: "ds-settings-routing-bubble-desc" },
                    "Powers background work independently of your chat model: long-term memory inference, preference extraction, and LLM summarization of large markdown cells (>2 000 chars). Without a configured Background model, large markdown cells are",
                    ' ',
                    React.createElement("em", null, "truncated at a sentence boundary"),
                    " rather than summarized.")) : null;
                return (React.createElement(React.Fragment, { key: field.key },
                    React.createElement("label", { className: "ds-settings-label" }, label),
                    React.createElement("select", { className: "ds-settings-select", value: (_e = values[field.key]) !== null && _e !== void 0 ? _e : '', onChange: e => handleChange(field.key, e.target.value) },
                        React.createElement("option", { value: "" }, "\u2014 select provider \u2014"),
                        PROVIDER_LIST.map(p => (React.createElement("option", { key: p, value: p }, p)))),
                    bubble));
            })))) : (React.createElement(React.Fragment, null,
            currentGroup.fields.map(field => {
                var _a, _b, _c, _d, _e, _f;
                const sectionHeaderEl = field.sectionHeader ? (React.createElement("div", { key: `sh-${field.key}`, className: "ds-settings-form-section-header" }, field.sectionHeader)) : null;
                if (field.type === 'model-select') {
                    const zoo = currentGroup.zooKey ? getZooModels(currentGroup.zooKey, values) : [];
                    const cur = (_a = values[field.key]) !== null && _a !== void 0 ? _a : '';
                    const options = cur && !zoo.includes(cur) ? [cur, ...zoo] : zoo;
                    const isEmpty = !cur;
                    const showValidation = saveTried && isEmpty;
                    const isChatModel = field.key === chatModelKey;
                    return (React.createElement(React.Fragment, { key: field.key },
                        sectionHeaderEl,
                        React.createElement("div", { className: "ds-settings-row" },
                            React.createElement("label", { className: "ds-settings-label" },
                                field.label,
                                showValidation && React.createElement("span", { className: "ds-settings-required", title: "Required" }, " *")),
                            React.createElement("select", { className: `ds-settings-select${showValidation ? ' ds-settings-select--empty' : ''}`, value: cur, onChange: e => handleChange(field.key, e.target.value) },
                                React.createElement("option", { value: "" }, options.length === 0 ? '— add models to zoo below —' : '— select model —'),
                                options.map(m => (React.createElement("option", { key: m, value: m }, m))))),
                        isChatModel && cur && (React.createElement("div", { className: "ds-settings-tool-indicator" }, checkingToolSupport ? (React.createElement("span", { className: "ds-agent-prov-tool-checking" }, "Checking\u2026")) : toolSupport === null ? null : toolSupport.supported ? (React.createElement("span", { className: "ds-agent-prov-tool-ok" }, "\u2713 Tool calling supported")) : (React.createElement("span", { className: "ds-agent-prov-tool-warn" },
                            "\u26A0 Not supported",
                            toolSupport.reason ? ` — ${toolSupport.reason}` : ''))))));
                }
                if (field.type === 'toggle') {
                    const isOn = ((_b = values[field.key]) !== null && _b !== void 0 ? _b : 'true') !== 'false';
                    return (React.createElement(React.Fragment, { key: field.key },
                        sectionHeaderEl,
                        React.createElement("div", { className: "ds-settings-row ds-settings-row--toggle" },
                            React.createElement("div", { className: "ds-settings-toggle-label-group" },
                                React.createElement("span", { className: "ds-settings-label" }, field.label),
                                field.description && (React.createElement("span", { className: "ds-settings-toggle-desc" }, field.description))),
                            React.createElement("label", { className: "ds-settings-toggle-switch", title: isOn ? 'Click to disable' : 'Click to enable' },
                                React.createElement("input", { type: "checkbox", checked: isOn, onChange: e => handleChange(field.key, e.target.checked ? 'true' : 'false') }),
                                React.createElement("span", { className: "ds-settings-toggle-slider" })))));
                }
                const isDisabled = field.disabledWhen
                    ? ((_c = values[field.disabledWhen]) !== null && _c !== void 0 ? _c : 'true') === 'false'
                    : false;
                const isPassword = field.type === 'password';
                const fieldValue = (_d = values[field.key]) !== null && _d !== void 0 ? _d : '';
                const isRevealed = (_e = revealed[field.key]) !== null && _e !== void 0 ? _e : false;
                return (React.createElement(React.Fragment, { key: field.key },
                    sectionHeaderEl,
                    React.createElement("div", { className: "ds-settings-row" },
                        React.createElement("label", { className: "ds-settings-label" }, field.label),
                        React.createElement("div", { className: `ds-settings-input-wrapper${isPassword ? ' ds-settings-input-wrapper--password' : ''}` },
                            React.createElement("input", { className: `ds-settings-input${isDisabled ? ' ds-settings-input--disabled' : ''}`, type: isPassword && !isRevealed ? 'password' : 'text', value: fieldValue, onChange: e => handleChange(field.key, e.target.value), placeholder: isPassword ? '(unchanged)' : ((_f = field.placeholder) !== null && _f !== void 0 ? _f : ''), autoComplete: "off", disabled: isDisabled }),
                            isPassword && fieldValue !== '' && (React.createElement("button", { className: "ds-settings-input-reveal-btn", type: "button", onClick: () => setRevealed(r => (Object.assign(Object.assign({}, r), { [field.key]: !r[field.key] }))), title: isRevealed ? 'Hide' : 'Reveal' }, isRevealed ? '⊘' : '◎'))),
                        field.description && (React.createElement("span", { className: "ds-settings-field-desc" }, field.description)))));
            }),
            currentGroup.zooKey && (React.createElement(ModelZooSection, { zooKey: currentGroup.zooKey, values: values, onChange: handleChange }))))),
        React.createElement("div", { className: "ds-settings-footer" },
            status && (React.createElement("div", { className: `ds-settings-status ds-settings-status-${status.type}` }, status.text)),
            React.createElement("div", { className: "ds-settings-path" }, editingEnvPath ? (React.createElement("div", { className: "ds-settings-path-edit" },
                React.createElement("input", { className: "ds-settings-path-input", type: "text", value: newEnvPath, placeholder: envPath, onChange: e => setNewEnvPath(e.target.value), autoFocus: true }),
                React.createElement("button", { className: "ds-settings-path-cancel-btn", onClick: () => { setEditingEnvPath(false); setNewEnvPath(''); }, title: "Cancel" }, "\u2715"))) : (React.createElement("span", { className: `ds-settings-path-text${envPathIsCustom ? ' ds-settings-path-custom' : ''}`, title: envExists ? envPath : `Will be created: ${envPath}` },
                React.createElement("span", { className: "ds-settings-path-label" }, "Config file:"),
                envExists ? envPath : `Will create: ${envPath}`,
                React.createElement("button", { className: "ds-settings-path-edit-btn", onClick: () => { setEditingEnvPath(true); setNewEnvPath(envPath); }, title: "Change .env file location" }, "\u270E")))),
            React.createElement("div", { className: "ds-settings-actions" },
                React.createElement("button", { className: "ds-settings-save-btn", onClick: () => void handleSave(), disabled: saving }, saving ? 'Saving…' : 'Save & Apply'),
                React.createElement("button", { className: "ds-settings-cancel-btn", onClick: onClose }, "Cancel")))));
};
const SkillsPanel = ({ apiClient, notebookPath = '' }) => {
    const [skills, setSkills] = useState([]);
    const [skillsDir, setSkillsDir] = useState('');
    const [loading, setLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(false);
    const [selectedName, setSelectedName] = useState(null);
    const [editorTab, setEditorTab] = useState('skill');
    const [editContent, setEditContent] = useState('');
    const [editReadme, setEditReadme] = useState('');
    const [dirty, setDirty] = useState(false);
    const [saving, setSaving] = useState(false);
    const [saveStatus, setSaveStatus] = useState(null);
    const [saveError, setSaveError] = useState('');
    const [newName, setNewName] = useState('');
    const [creatingNew, setCreatingNew] = useState(false);
    // Bundled skill library
    const [libraryOpen, setLibraryOpen] = useState(false);
    const [library, setLibrary] = useState([]);
    const [libraryLoading, setLibraryLoading] = useState(false);
    const [importing, setImporting] = useState(null);
    const [skillError, setSkillError] = useState(null);
    // Resizable splitter
    const [listWidth, setListWidth] = useState(160);
    const panelRef = useRef(null);
    const dragging = useRef(false);
    const dragMoveRef = useRef(null);
    const dragUpRef = useRef(null);
    // Clean up drag listeners if the component unmounts mid-drag.
    useEffect(() => {
        return () => {
            if (dragMoveRef.current)
                window.removeEventListener('mousemove', dragMoveRef.current);
            if (dragUpRef.current)
                window.removeEventListener('mouseup', dragUpRef.current);
        };
    }, []);
    const onSplitterMouseDown = (e) => {
        e.preventDefault();
        dragging.current = true;
        const onMove = (ev) => {
            if (!dragging.current || !panelRef.current)
                return;
            const rect = panelRef.current.getBoundingClientRect();
            const newW = Math.min(Math.max(ev.clientX - rect.left, 80), rect.width - 80);
            setListWidth(newW);
        };
        const onUp = () => {
            dragging.current = false;
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
            dragMoveRef.current = null;
            dragUpRef.current = null;
        };
        dragMoveRef.current = onMove;
        dragUpRef.current = onUp;
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
    };
    useEffect(() => {
        apiClient.getSkills(notebookPath)
            .then(d => { setSkills(d.skills); setSkillsDir(d.skills_dir); setLoading(false); })
            .catch(() => setLoading(false));
    }, [apiClient, notebookPath]);
    const handleRefresh = async () => {
        setRefreshing(true);
        try {
            const d = await apiClient.refreshSkills(notebookPath);
            setSkills(d.skills);
            setSkillsDir(d.skills_dir);
        }
        catch ( /* ignore */_a) { /* ignore */ }
        finally {
            setRefreshing(false);
        }
    };
    const handleEdit = async (name) => {
        var _a;
        try {
            const d = await apiClient.getSkillContent(name, notebookPath);
            setSelectedName(name);
            setEditContent(d.content);
            setEditReadme((_a = d.readme) !== null && _a !== void 0 ? _a : '');
            setEditorTab('skill');
            setDirty(false);
            setSaveStatus(null);
        }
        catch ( /* ignore */_b) { /* ignore */ }
    };
    const handleToggle = async (name, enabled) => {
        setSkills(prev => prev.map(s => s.name === name ? Object.assign(Object.assign({}, s), { enabled }) : s));
        try {
            await apiClient.saveSkill(name, { enabled }, notebookPath);
        }
        catch (_a) {
            setSkills(prev => prev.map(s => s.name === name ? Object.assign(Object.assign({}, s), { enabled: !enabled }) : s));
        }
    };
    const handleSaveContent = async () => {
        if (!selectedName)
            return;
        setSaving(true);
        setSaveStatus(null);
        setSaveError('');
        try {
            const updates = editorTab === 'skill'
                ? { content: editContent }
                : { readme: editReadme };
            await apiClient.saveSkill(selectedName, updates, notebookPath);
            setDirty(false);
            setSaveStatus('ok');
            setTimeout(() => setSaveStatus(null), 2000);
        }
        catch (e) {
            setSaveStatus('err');
            setSaveError((e === null || e === void 0 ? void 0 : e.message) || 'Save failed');
        }
        finally {
            setSaving(false);
        }
    };
    const handleCreateNew = async () => {
        const name = newName.trim().replace(/\s+/g, '_').replace(/[^\w\-]/g, '');
        if (!name)
            return;
        const starter = `# ${name.replace(/_/g, ' ')}\n\nDescribe this skill here.\n`;
        const readme = `# ${name.replace(/_/g, ' ')}\n\nDocumentation for the **${name}** skill.\n\n## Purpose\n\n...\n`;
        try {
            await apiClient.saveSkill(name, { content: starter, readme, enabled: true }, notebookPath);
            setSkills(prev => [...prev, { name, enabled: true }]);
            setNewName('');
            setCreatingNew(false);
            await handleEdit(name);
        }
        catch ( /* ignore */_a) { /* ignore */ }
    };
    const handleToggleLibrary = async () => {
        const willOpen = !libraryOpen;
        setLibraryOpen(willOpen);
        if (willOpen && library.length === 0) {
            setLibraryLoading(true);
            try {
                const d = await apiClient.getBundledSkills(notebookPath);
                setLibrary(d.bundled);
            }
            catch ( /* ignore */_a) { /* ignore */ }
            finally {
                setLibraryLoading(false);
            }
        }
    };
    const handleImport = async (name) => {
        setImporting(name);
        try {
            const result = await apiClient.importBundledSkill(name, notebookPath);
            if (result.status === 'ok' || result.status === 'already_exists') {
                // Re-fetch the authoritative list from the backend so the checkmark
                // reflects the actual on-disk state rather than optimistic local state.
                try {
                    const fresh = await apiClient.getBundledSkills(notebookPath);
                    setLibrary(fresh.bundled);
                }
                catch (_a) {
                    // Fallback: update locally if the re-fetch fails.
                    setLibrary(prev => prev.map(b => b.name === name ? Object.assign(Object.assign({}, b), { imported: true }) : b));
                }
                setSkills(prev => prev.some(s => s.name === name) ? prev : [...prev, { name, enabled: true }]);
            }
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            setSkillError(`Import of "${name}" failed: ${msg}`);
        }
        finally {
            setImporting(null);
        }
    };
    return (React.createElement("div", { className: "ds-skills-panel", ref: panelRef },
        React.createElement("div", { className: "ds-skills-list", style: { width: listWidth, minWidth: 80, maxWidth: undefined, flexShrink: 0 } },
            React.createElement("div", { className: "ds-skills-list-header" },
                React.createElement("span", { className: "ds-skills-list-title" }, "Skills"),
                React.createElement("button", { className: `ds-skills-refresh-btn${refreshing ? ' ds-skills-refresh-btn--spinning' : ''}`, onClick: () => void handleRefresh(), disabled: refreshing, title: "Reload all skill files from disk" }, "\u21BA")),
            loading ? (React.createElement("div", { className: "ds-skills-empty" }, "Loading\u2026")) : skills.length === 0 ? (React.createElement("div", { className: "ds-skills-empty" },
                "No skills yet.",
                '\n',
                skillsDir)) : (skills.map(skill => (React.createElement("div", { key: skill.name, className: `ds-skill-row${selectedName === skill.name ? ' ds-skill-row--active' : ''}`, onClick: () => void handleEdit(skill.name), title: "Click to edit" },
                React.createElement("span", { className: "ds-skill-name", title: skill.name }, skill.name),
                React.createElement("button", { role: "switch", "aria-checked": skill.enabled, className: `ds-skill-toggle${skill.enabled ? ' ds-skill-toggle--on' : ''}`, onClick: e => { e.stopPropagation(); void handleToggle(skill.name, !skill.enabled); }, title: skill.enabled ? 'Enabled — click to disable' : 'Disabled — click to enable' }))))),
            creatingNew ? (React.createElement("div", { className: "ds-skill-new-row" },
                React.createElement("input", { className: "ds-skill-new-input", value: newName, onChange: e => setNewName(e.target.value), onKeyDown: e => { if (e.key === 'Enter')
                        void handleCreateNew(); if (e.key === 'Escape')
                        setCreatingNew(false); }, placeholder: "skill_name", autoFocus: true, spellCheck: false }),
                React.createElement("button", { className: "ds-skill-new-ok", onClick: () => void handleCreateNew(), title: "Create" }, "\u2713"),
                React.createElement("button", { className: "ds-skill-new-cancel", onClick: () => setCreatingNew(false), title: "Cancel" }, "\u2715"))) : (React.createElement("button", { className: "ds-skill-add-btn", onClick: () => setCreatingNew(true) }, "+ New skill")),
            React.createElement("div", { className: "ds-skill-library" },
                React.createElement("button", { className: "ds-skill-library-header", onClick: () => void handleToggleLibrary(), title: "Browse factory-default skills bundled with the extension" },
                    React.createElement("span", { className: "ds-skill-library-chevron" }, libraryOpen ? '▾' : '▸'),
                    React.createElement("span", null, "Skill Library")),
                libraryOpen && (React.createElement("div", { className: "ds-skill-library-body" },
                    skillError && (React.createElement("div", { className: "ds-skill-library-error", role: "alert" },
                        React.createElement("span", null,
                            "\u26A0 ",
                            skillError),
                        React.createElement("button", { className: "ds-skill-library-error-close", onClick: () => setSkillError(null), title: "Dismiss" }, "\u2715"))),
                    libraryLoading ? (React.createElement("div", { className: "ds-skill-library-msg" }, "Loading\u2026")) : library.length === 0 ? (React.createElement("div", { className: "ds-skill-library-msg" }, "No bundled skills found.")) : (library.map(b => (React.createElement("div", { key: b.name, className: `ds-skill-library-row${b.imported ? ' ds-skill-library-row--imported' : ''}` },
                        React.createElement("div", { className: "ds-skill-library-info" },
                            React.createElement("span", { className: "ds-skill-library-name" }, b.name),
                            b.command && React.createElement("span", { className: "ds-skill-library-cmd" }, b.command),
                            b.description && React.createElement("span", { className: "ds-skill-library-desc" }, b.description)),
                        b.imported ? (React.createElement("span", { className: "ds-skill-library-installed", title: "Already in your skills" }, "Installed")) : (React.createElement("button", { className: "ds-skill-library-import-btn", onClick: () => void handleImport(b.name), disabled: importing === b.name, title: `Import ${b.name} into this project` }, importing === b.name ? '…' : '↓ Import')))))))))),
        React.createElement("div", { className: "ds-skills-splitter", onMouseDown: onSplitterMouseDown, title: "Drag to resize" }),
        React.createElement("div", { className: "ds-skill-editor" }, !selectedName ? (React.createElement("div", { className: "ds-skill-editor-placeholder" },
            React.createElement("span", null, "Click a skill to edit it"))) : (React.createElement(React.Fragment, null,
            React.createElement("div", { className: "ds-skill-editor-tabs" },
                React.createElement("button", { className: `ds-skill-editor-tab${editorTab === 'skill' ? ' ds-skill-editor-tab--active' : ''}`, onClick: () => {
                        if (dirty && !window.confirm('Discard unsaved changes?'))
                            return;
                        setEditorTab('skill');
                        setDirty(false);
                        setSaveStatus(null);
                        setSaveError('');
                    } },
                    "SKILL.md",
                    dirty && editorTab === 'skill' && React.createElement("span", { className: "ds-skill-tab-dot" }, "\u25CF")),
                React.createElement("button", { className: `ds-skill-editor-tab${editorTab === 'readme' ? ' ds-skill-editor-tab--active' : ''}`, onClick: () => {
                        if (dirty && !window.confirm('Discard unsaved changes?'))
                            return;
                        setEditorTab('readme');
                        setDirty(false);
                        setSaveStatus(null);
                        setSaveError('');
                    } },
                    "README.md",
                    dirty && editorTab === 'readme' && React.createElement("span", { className: "ds-skill-tab-dot" }, "\u25CF")),
                React.createElement("div", { className: "ds-skill-editor-tabs-spacer" }),
                saveStatus === 'ok' && React.createElement("span", { className: "ds-skill-editor-saved" }, "\u2713 Saved"),
                saveStatus === 'err' && React.createElement("span", { className: "ds-skill-editor-error", title: saveError },
                    "\u2717 ",
                    saveError || 'Error'),
                React.createElement("button", { className: "ds-skill-editor-save-btn", onClick: () => void handleSaveContent(), disabled: saving || !dirty, title: "Save (Ctrl+S)" }, saving ? '…' : 'Save')),
            React.createElement("div", { className: "ds-skill-editor-filepath" },
                React.createElement("span", { className: "ds-skill-editor-filepath-dir" }, selectedName),
                React.createElement("span", { className: "ds-skill-editor-filepath-sep" }, "/"),
                editorTab === 'skill' ? 'SKILL.md' : 'README.md'),
            React.createElement("textarea", { key: `${selectedName}-${editorTab}`, className: "ds-skill-editor-textarea", value: editorTab === 'skill' ? editContent : editReadme, onChange: e => {
                    if (editorTab === 'skill')
                        setEditContent(e.target.value);
                    else
                        setEditReadme(e.target.value);
                    setDirty(true);
                    setSaveStatus(null);
                }, spellCheck: false, placeholder: editorTab === 'readme' ? 'No README.md yet — start writing user documentation here…' : '', onKeyDown: e => {
                    if (e.key === 's' && (e.ctrlKey || e.metaKey)) {
                        e.preventDefault();
                        void handleSaveContent();
                    }
                } }))))));
};
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// CommandsPanel — live list of all slash commands (builtins + skills)
// ---------------------------------------------------------------------------
const CommandsPanel = ({ apiClient }) => {
    const [cmds, setCmds] = useState([]);
    const [loading, setLoading] = useState(true);
    const refresh = () => {
        setLoading(true);
        apiClient.getCommands()
            .then(list => { setCmds(list); setLoading(false); })
            .catch(() => { setLoading(false); });
    };
    useEffect(() => { refresh(); }, [apiClient]);
    const byCmd = (a, b) => a.command.localeCompare(b.command);
    const builtins = cmds.filter(c => c.type === 'builtin').sort(byCmd);
    const skills = cmds.filter(c => c.type === 'skill').sort(byCmd);
    return (React.createElement("div", { className: "ds-commands-panel" },
        React.createElement("div", { className: "ds-commands-toolbar" },
            React.createElement("span", { className: "ds-commands-count" },
                React.createElement("span", { className: "ds-commands-count-num" }, cmds.length),
                " commands"),
            React.createElement("button", { className: "ds-commands-refresh-btn", onClick: refresh, title: "Reload commands" }, loading ? '…' : '↻')),
        React.createElement("div", { className: "ds-commands-section" },
            React.createElement("div", { className: "ds-commands-section-title" }, "Built-in"),
            builtins.map(c => (React.createElement("div", { key: c.command, className: "ds-commands-row" },
                React.createElement("code", { className: "ds-commands-name" }, c.command),
                React.createElement("span", { className: "ds-commands-desc" }, c.description))))),
        skills.length > 0 && (React.createElement("div", { className: "ds-commands-section" },
            React.createElement("div", { className: "ds-commands-section-title" }, "Skills"),
            skills.map(c => (React.createElement("div", { key: c.command, className: "ds-commands-row" },
                React.createElement("code", { className: "ds-commands-name" }, c.command),
                React.createElement("span", { className: "ds-commands-desc" }, c.description),
                c.skill_name && (React.createElement("span", { className: "ds-commands-skill-badge", title: `From skill: ${c.skill_name}` }, c.skill_name))))))),
        !loading && skills.length === 0 && (React.createElement("p", { className: "ds-commands-empty" },
            "No skill commands loaded yet. Import or create a skill with a ",
            React.createElement("code", null, "/command"),
            " in its front matter."))));
};
// ---------------------------------------------------------------------------
// TagsSettingsPanel — tag library: definitions + create/delete custom tags
// ---------------------------------------------------------------------------
const BUILT_IN_TAG_DEFS = [
    { category: 'ML Pipeline', tags: [
            { value: 'data-loading', topic: 'ML Pipeline', description: 'Cells that load data from files, databases, or APIs' },
            { value: 'preprocessing', topic: 'ML Pipeline', description: 'Data cleaning, normalization, and transformation steps' },
            { value: 'feature-engineering', topic: 'ML Pipeline', description: 'Feature creation, selection, and encoding' },
            { value: 'training', topic: 'ML Pipeline', description: 'Model training and fitting' },
            { value: 'evaluation', topic: 'ML Pipeline', description: 'Metrics, validation, and model assessment' },
            { value: 'inference', topic: 'ML Pipeline', description: 'Prediction or scoring on new data' },
        ] },
    { category: 'Quality', tags: [
            { value: 'todo', topic: 'Quality', description: 'Cell needs attention or further work' },
            { value: 'reviewed', topic: 'Quality', description: 'Cell has been reviewed and approved' },
            { value: 'needs-refactor', topic: 'Quality', description: 'Works but the implementation should be improved' },
            { value: 'slow', topic: 'Quality', description: 'Computationally slow — candidate for optimization' },
            { value: 'broken', topic: 'Quality', description: 'Cell is broken or produces errors' },
            { value: 'tested', topic: 'Quality', description: 'Cell has been verified to produce correct output' },
        ] },
    { category: 'Report', tags: [
            { value: 'report', topic: 'Report', description: 'Output to include in an exported report' },
            { value: 'figure', topic: 'Report', description: 'Cell that generates a figure or chart' },
            { value: 'table', topic: 'Report', description: 'Cell that generates a table' },
            { value: 'key-finding', topic: 'Report', description: 'Contains an important result or insight' },
            { value: 'report-exclude', topic: 'Report', description: 'Explicitly exclude from report output' },
        ] },
    { category: 'Status', tags: [
            { value: 'draft', topic: 'Status', description: 'Work in progress — not finalized' },
            { value: 'stable', topic: 'Status', description: 'Unlikely to change; safe dependency for other cells' },
            { value: 'deprecated', topic: 'Status', description: 'No longer needed; kept for reference' },
            { value: 'sensitive', topic: 'Status', description: 'Contains sensitive data, credentials, or PII' },
        ] },
];
const CUSTOM_TAGS_KEY = 'varys_custom_tag_definitions';
function loadCustomTags() {
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
            });
        }).filter(t => t.value);
    }
    catch (_a) {
        return [];
    }
}
function saveCustomTags(tags) {
    localStorage.setItem(CUSTOM_TAGS_KEY, JSON.stringify(tags));
}
const TAG_PALETTE_TS = [
    '#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6',
    '#06b6d4', '#f97316', '#ec4899', '#14b8a6', '#6366f1',
];
function tagColorTs(tag) {
    let h = 0;
    for (let i = 0; i < tag.length; i++)
        h = (h * 31 + tag.charCodeAt(i)) >>> 0;
    return TAG_PALETTE_TS[h % TAG_PALETTE_TS.length];
}
// ---------------------------------------------------------------------------
// ContextPanel — Settings → Workspace → Context
// Lets the user toggle the focal-cell context cutoff. Source of truth is
// localStorage 'ds-assistant-limit-to-focal'; the chat input reads it fresh
// at submit time, so this panel doesn't need to push state anywhere.
// ---------------------------------------------------------------------------
const ContextPanel = () => {
    const [limitToFocal, setLimitToFocalState] = useState(() => {
        try {
            return localStorage.getItem('ds-assistant-limit-to-focal') === '1';
        }
        catch (_a) {
            return false;
        }
    });
    const setLimit = (next) => {
        setLimitToFocalState(next);
        try {
            localStorage.setItem('ds-assistant-limit-to-focal', next ? '1' : '0');
        }
        catch ( /* ignore */_a) { /* ignore */ }
    };
    // ── Answer-destination default ───────────────────────────────────────────
    // Controls how Varys decides between chat vs. notebook for plain (non-slash)
    // prompts.  The disambiguation card used to fire on every advisory-shaped
    // message in Agent mode; users found it inconsistent (sometimes the same
    // prompt routed differently depending on hidden state) and asked for a
    // single predictable default.  See CHANGELOG [0.8.7].
    const [answerDefault, setAnswerDefaultState] = useState(() => {
        try {
            const v = localStorage.getItem('ds-assistant-answer-default');
            if (v === 'auto' || v === 'always_chat' || v === 'always_notebook' || v === 'ask')
                return v;
        }
        catch ( /* fall through */_a) { /* fall through */ }
        return 'auto';
    });
    const setAnswerDefault = (next) => {
        setAnswerDefaultState(next);
        try {
            localStorage.setItem('ds-assistant-answer-default', next);
        }
        catch ( /* ignore */_a) { /* ignore */ }
        // Notify the chat component to pick up the change immediately.
        window.dispatchEvent(new CustomEvent('varys-answer-default-changed', { detail: next }));
    };
    return (React.createElement("div", { className: "ds-settings-section-body" },
        React.createElement("div", { className: "ds-settings-row" },
            React.createElement("div", { className: "ds-settings-row-label" },
                React.createElement("span", { className: "ds-settings-row-title" },
                    "Where to send answers",
                    React.createElement("span", { className: "ds-info-bubble", tabIndex: 0, role: "img", "aria-label": "What does this do?", "data-tip": "How Varys routes your plain (non-slash) prompts:\n\n"
                            + "• Auto (recommended) — questions like 'what does this do?' "
                            + "go to chat; commands like 'refactor this loop' write to a "
                            + "notebook cell.\n\n"
                            + "• Always chat — answer in the sidebar; never modify the "
                            + "notebook unless you explicitly type a slash command.\n\n"
                            + "• Always notebook — always run the agent flow; useful if "
                            + "you almost never want chat-only answers.\n\n"
                            + "• Ask each time — show a 'Where should the answer go?' "
                            + "card before responding (the pre-0.8.7 behavior).\n\n"
                            + "Override on a per-prompt basis by prefixing with /chat." }, "i")),
                React.createElement("span", { className: "ds-settings-row-sub" }, "Question shape (auto) routes to chat; command shape routes to the notebook. Override with /chat <prompt>.")),
            React.createElement("select", { className: "ds-settings-input", value: answerDefault, onChange: e => setAnswerDefault(e.target.value), style: { minWidth: 160 } },
                React.createElement("option", { value: "auto" }, "Auto (recommended)"),
                React.createElement("option", { value: "always_chat" }, "Always chat"),
                React.createElement("option", { value: "always_notebook" }, "Always notebook"),
                React.createElement("option", { value: "ask" }, "Ask each time"))),
        React.createElement("div", { className: "ds-settings-row" },
            React.createElement("div", { className: "ds-settings-row-label" },
                React.createElement("span", { className: "ds-settings-row-title" },
                    "Limit context to active cell",
                    React.createElement("span", { className: "ds-info-bubble", tabIndex: 0, role: "img", "aria-label": "What does this do?", "data-tip": "When ON (Agent mode only): the assistant only sees cells from "
                            + "the top of the notebook through the active (focused) cell. "
                            + "Cells past the active cell are hidden — the agent can still "
                            + "see their existence as a one-line skeleton, but cannot read "
                            + "or edit their contents.\n\n"
                            + "Use this for tasks that act on a single cell and where you "
                            + "don't want the agent to make 'helpful' edits to unrelated "
                            + "downstream cells.\n\n"
                            + "Leave OFF for cross-cell refactors (rename across the whole "
                            + "notebook, insert above a downstream header, etc.) — the "
                            + "agent needs full visibility for those.\n\n"
                            + "No effect in Chat mode — chat already cuts off at the "
                            + "active cell." }, "i")),
                React.createElement("span", { className: "ds-settings-row-sub" }, "Agent mode only. Hides cells past the focused cell so the agent stays focused on all cells up to and including the focused cell.")),
            React.createElement("button", { type: "button", className: `ds-toggle-pill${limitToFocal ? ' active' : ''}`, "aria-pressed": limitToFocal, onClick: () => setLimit(!limitToFocal) }, limitToFocal ? '🔒 On' : '🌐 Off'))));
};
const TagsSettingsPanel = () => {
    const [customTags, setCustomTags] = useState(loadCustomTags);
    const [newValue, setNewValue] = useState('');
    const [newDesc, setNewDesc] = useState('');
    const [nameErr, setNameErr] = useState('');
    const [editIdx, setEditIdx] = useState(null);
    // collapsible: top-level sections + each category group
    const allGroupKeys = ['__custom__', '__builtin__', ...BUILT_IN_TAG_DEFS.map(g => g.category)];
    const [openSections, setOpenSections] = useState(new Set(allGroupKeys));
    const toggleSection = (key) => setOpenSections(prev => { const s = new Set(prev); s.has(key) ? s.delete(key) : s.add(key); return s; });
    const allBuiltInValues = [].concat(...BUILT_IN_TAG_DEFS.map((g) => g.tags.map((t) => t.value)));
    const addCustomTag = () => {
        const raw = newValue.trim().toLowerCase().replace(/\s+/g, '-');
        if (!raw) {
            setNameErr('Value is required.');
            return;
        }
        if (!/^[a-z0-9][\w\-.]*$/.test(raw)) {
            setNameErr('Only a-z, 0-9, - or _ allowed.');
            return;
        }
        if (allBuiltInValues.includes(raw)) {
            setNameErr('This value is already a built-in tag.');
            return;
        }
        if (customTags.some(t => t.value === raw)) {
            setNameErr('Tag already exists.');
            return;
        }
        const updated = [...customTags, { value: raw, topic: 'Custom', description: newDesc.trim() }];
        setCustomTags(updated);
        saveCustomTags(updated);
        setNewValue('');
        setNewDesc('');
        setNameErr('');
    };
    const deleteCustomTag = (idx) => {
        const updated = customTags.filter((_, i) => i !== idx);
        setCustomTags(updated);
        saveCustomTags(updated);
        if (editIdx === idx)
            setEditIdx(null);
    };
    const saveEdit = (idx, desc) => {
        const updated = customTags.map((t, i) => i === idx ? Object.assign(Object.assign({}, t), { description: desc }) : t);
        setCustomTags(updated);
        saveCustomTags(updated);
        setEditIdx(null);
    };
    return (React.createElement("div", { className: "ds-tags-settings-panel" },
        React.createElement("div", { className: "ds-tags-settings-about" },
            React.createElement("div", { className: "ds-tags-settings-about-title" }, "\uD83C\uDFF7\uFE0F What are tags?"),
            React.createElement("p", null, "Tags let you label notebook cells with their role or status. They appear as coloured pills in the thin bar above each cell and can be added, removed, and browsed without leaving the notebook."),
            React.createElement("div", { className: "ds-tags-settings-usecases" },
                React.createElement("div", { className: "ds-tags-settings-usecase" },
                    React.createElement("span", { className: "ds-tags-settings-usecase-icon" }, "\uD83D\uDD2C"),
                    React.createElement("span", null,
                        React.createElement("strong", null, "Pipeline stages"),
                        " \u2014 mark cells as ",
                        React.createElement("em", null, "data-loading"),
                        ", ",
                        React.createElement("em", null, "training"),
                        ", or ",
                        React.createElement("em", null, "evaluation"),
                        " to navigate large notebooks at a glance.")),
                React.createElement("div", { className: "ds-tags-settings-usecase" },
                    React.createElement("span", { className: "ds-tags-settings-usecase-icon" }, "\u2705"),
                    React.createElement("span", null,
                        React.createElement("strong", null, "Quality tracking"),
                        " \u2014 use ",
                        React.createElement("em", null, "reviewed"),
                        ", ",
                        React.createElement("em", null, "todo"),
                        ", or ",
                        React.createElement("em", null, "needs-refactor"),
                        " in code reviews or collaborative work.")),
                React.createElement("div", { className: "ds-tags-settings-usecase" },
                    React.createElement("span", { className: "ds-tags-settings-usecase-icon" }, "\uD83D\uDCC4"),
                    React.createElement("span", null,
                        React.createElement("strong", null, "Report control"),
                        " \u2014 tag cells as ",
                        React.createElement("em", null, "report"),
                        " or ",
                        React.createElement("em", null, "report-exclude"),
                        " to control what gets exported.")),
                React.createElement("div", { className: "ds-tags-settings-usecase" },
                    React.createElement("span", { className: "ds-tags-settings-usecase-icon" }, "\uD83C\uDFD7\uFE0F"),
                    React.createElement("span", null,
                        React.createElement("strong", null, "Custom workflows"),
                        " \u2014 create your own tags below to match your team's conventions."))),
            React.createElement("p", { className: "ds-tags-settings-how" },
                "Add tags from the ",
                React.createElement("strong", null, "[+] button"),
                " above any cell, or use the ",
                React.createElement("strong", null, "\uD83C\uDFF7\uFE0F panel"),
                " in the sidebar to browse all tagged cells and jump between them.")),
        React.createElement("div", { className: "ds-tags-settings-section" },
            React.createElement("div", { className: "ds-tags-settings-section-header ds-tags-settings-section-header--toggle", onClick: () => toggleSection('__custom__') },
                React.createElement("span", { className: `ds-tags-settings-chevron${openSections.has('__custom__') ? ' ds-tags-settings-chevron--open' : ''}` }, "\u203A"),
                React.createElement("span", { className: "ds-tags-settings-section-title" }, "Custom Tags"),
                React.createElement("span", { className: "ds-tags-settings-section-count" }, customTags.length)),
            openSections.has('__custom__') && (React.createElement(React.Fragment, null,
                customTags.length === 0 && (React.createElement("p", { className: "ds-tags-settings-empty" }, "No custom tags yet. Create one below.")),
                customTags.map((tag, idx) => (React.createElement("div", { key: tag.value, className: "ds-tags-settings-row" },
                    React.createElement("span", { className: "ds-tags-settings-pill", style: { '--pill-color': tagColorTs(tag.value) } }, tag.value),
                    editIdx === idx ? (React.createElement(EditDescRow, { initial: tag.description, onSave: desc => saveEdit(idx, desc), onCancel: () => setEditIdx(null) })) : (React.createElement(React.Fragment, null,
                        React.createElement("span", { className: "ds-tags-settings-desc", onClick: () => setEditIdx(idx) }, tag.description || React.createElement("em", { className: "ds-tags-settings-desc-empty" }, "no description \u2014 click to add")),
                        React.createElement("button", { className: "ds-tags-settings-edit-btn", onClick: () => setEditIdx(idx), title: "Edit description" }, "\u270E"),
                        React.createElement("button", { className: "ds-tags-settings-del-btn", onClick: () => deleteCustomTag(idx), title: "Delete tag" }, "\uD83D\uDDD1")))))),
                React.createElement("div", { className: "ds-tags-settings-new-form" },
                    React.createElement("div", { className: "ds-tags-settings-new-row" },
                        React.createElement("input", { className: "ds-tags-settings-name-input", placeholder: "tag-value", value: newValue, onChange: e => { setNewValue(e.target.value); setNameErr(''); }, onKeyDown: e => { if (e.key === 'Enter')
                                addCustomTag(); } }),
                        React.createElement("input", { className: "ds-tags-settings-desc-input", placeholder: "Description (optional)", value: newDesc, onChange: e => setNewDesc(e.target.value), onKeyDown: e => { if (e.key === 'Enter')
                                addCustomTag(); } }),
                        React.createElement("button", { className: "ds-tags-settings-add-btn", onClick: addCustomTag, disabled: !newValue.trim() }, "+ Add")),
                    nameErr && React.createElement("p", { className: "ds-tags-settings-error" }, nameErr))))),
        React.createElement("div", { className: "ds-tags-settings-section" },
            React.createElement("div", { className: "ds-tags-settings-section-header ds-tags-settings-section-header--toggle", onClick: () => toggleSection('__builtin__') },
                React.createElement("span", { className: `ds-tags-settings-chevron${openSections.has('__builtin__') ? ' ds-tags-settings-chevron--open' : ''}` }, "\u203A"),
                React.createElement("span", { className: "ds-tags-settings-section-title" }, "Built-in Tags"),
                React.createElement("span", { className: "ds-tags-settings-section-count" }, allBuiltInValues.length)),
            openSections.has('__builtin__') && BUILT_IN_TAG_DEFS.map(group => (React.createElement("div", { key: group.category, className: "ds-tags-settings-group" },
                React.createElement("div", { className: "ds-tags-settings-group-label ds-tags-settings-group-label--toggle", onClick: () => toggleSection(group.category) },
                    React.createElement("span", { className: `ds-tags-settings-chevron ds-tags-settings-chevron--sm${openSections.has(group.category) ? ' ds-tags-settings-chevron--open' : ''}` }, "\u203A"),
                    group.category,
                    React.createElement("span", { className: "ds-tags-settings-group-count" }, group.tags.length)),
                openSections.has(group.category) && group.tags.map(tag => (React.createElement("div", { key: tag.value, className: "ds-tags-settings-row" },
                    React.createElement("span", { className: "ds-tags-settings-pill", style: { '--pill-color': tagColorTs(tag.value) } }, tag.value),
                    React.createElement("span", { className: "ds-tags-settings-desc" }, tag.description))))))))));
};
const EditDescRow = ({ initial, onSave, onCancel }) => {
    const [val, setVal] = useState(initial);
    return (React.createElement("div", { className: "ds-tags-settings-edit-row" },
        React.createElement("input", { className: "ds-tags-settings-desc-input", autoFocus: true, value: val, onChange: e => setVal(e.target.value), onKeyDown: e => {
                if (e.key === 'Enter') {
                    onSave(val);
                }
                if (e.key === 'Escape') {
                    onCancel();
                }
            } }),
        React.createElement("button", { className: "ds-tags-settings-save-btn", onClick: () => onSave(val) }, "Save"),
        React.createElement("button", { className: "ds-tags-settings-cancel-btn-sm", onClick: onCancel }, "\u2715")));
};
// ---------------------------------------------------------------------------
// FileAgentConfigPanel — inline project-local config for Varys File Agent
// ---------------------------------------------------------------------------
const FILE_AGENT_CONFIG_KEYS = [
    'VARYS_AGENT_ENABLED',
    'VARYS_AGENT_WORKING_DIR',
    'VARYS_AGENT_MAX_TURNS',
    'VARYS_AGENT_ALLOWED_TOOLS',
    'VARYS_AGENT_BACKGROUND_SCAN',
    'VARYS_AGENT_PROVIDER',
];
export const FileAgentConfigPanel = ({ notebookPath, apiClient, onClose }) => {
    var _a, _b, _c;
    const [values, setValues] = useState({});
    const [configPath, setConfigPath] = useState('');
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [status, setStatus] = useState(null);
    useEffect(() => {
        if (!notebookPath) {
            setLoading(false);
            return;
        }
        apiClient
            .getAgentSettings(notebookPath)
            .then(data => {
            var _a, _b;
            const v = {};
            for (const k of FILE_AGENT_CONFIG_KEYS)
                v[k] = (_a = data[k]) !== null && _a !== void 0 ? _a : '';
            setValues(v);
            setConfigPath((_b = data._config_path) !== null && _b !== void 0 ? _b : '');
            setLoading(false);
        })
            .catch(err => {
            setStatus({ type: 'error', text: `Failed to load: ${err}` });
            setLoading(false);
        });
    }, [notebookPath, apiClient]);
    const handleChange = (key, value) => setValues(v => (Object.assign(Object.assign({}, v), { [key]: value })));
    const boolVal = (key, defaultOn) => {
        const v = values[key];
        if (!v)
            return defaultOn;
        return v.toLowerCase() !== 'false';
    };
    const handleSave = async () => {
        var _a;
        setSaving(true);
        setStatus(null);
        try {
            const payload = {};
            for (const k of FILE_AGENT_CONFIG_KEYS)
                payload[k] = (_a = values[k]) !== null && _a !== void 0 ? _a : '';
            await apiClient.saveAgentSettings(notebookPath, payload);
            setStatus({ type: 'success', text: '✓ Saved to project' });
            setTimeout(() => setStatus(null), 2500);
        }
        catch (err) {
            setStatus({ type: 'error', text: `Save failed: ${err}` });
        }
        finally {
            setSaving(false);
        }
    };
    if (!notebookPath) {
        return (React.createElement("div", { className: "ds-agent-config-panel" },
            React.createElement("p", { className: "ds-agent-config-no-nb" }, "No active notebook \u2014 open a notebook to configure project settings.")));
    }
    return (React.createElement("div", { className: "ds-agent-config-panel" },
        configPath && (React.createElement("div", { className: "ds-agent-config-path", title: configPath },
            "\uD83D\uDCC1 ",
            configPath)),
        loading ? (React.createElement("div", { className: "ds-agent-config-loading" }, "Loading\u2026")) : (React.createElement(React.Fragment, null,
            React.createElement("div", { className: "ds-settings-row ds-settings-row--toggle" },
                React.createElement("div", { className: "ds-settings-toggle-label-group" },
                    React.createElement("span", { className: "ds-settings-label" }, "Enable for this project")),
                React.createElement("label", { className: "ds-settings-toggle-switch", title: boolVal('VARYS_AGENT_ENABLED', false) ? 'Click to disable' : 'Click to enable' },
                    React.createElement("input", { type: "checkbox", checked: boolVal('VARYS_AGENT_ENABLED', false), onChange: e => handleChange('VARYS_AGENT_ENABLED', e.target.checked ? 'true' : 'false') }),
                    React.createElement("span", { className: "ds-settings-toggle-slider" }))),
            React.createElement("div", { className: "ds-settings-row" },
                React.createElement("label", { className: "ds-settings-label" }, "Working directory"),
                React.createElement("input", { className: "ds-settings-input", type: "text", value: (_a = values['VARYS_AGENT_WORKING_DIR']) !== null && _a !== void 0 ? _a : '', onChange: e => handleChange('VARYS_AGENT_WORKING_DIR', e.target.value), placeholder: "Leave empty \u2014 uses notebook's parent directory", autoComplete: "off" })),
            React.createElement("div", { className: "ds-settings-row" },
                React.createElement("label", { className: "ds-settings-label" }, "Max agent turns"),
                React.createElement("input", { className: "ds-settings-input ds-agent-input--narrow", type: "text", inputMode: "numeric", value: (_b = values['VARYS_AGENT_MAX_TURNS']) !== null && _b !== void 0 ? _b : '', onChange: e => handleChange('VARYS_AGENT_MAX_TURNS', e.target.value), placeholder: "10", autoComplete: "off" })),
            React.createElement("div", { className: "ds-settings-row" },
                React.createElement("label", { className: "ds-settings-label" }, "Allowed tools"),
                React.createElement("input", { className: "ds-settings-input", type: "text", value: (_c = values['VARYS_AGENT_ALLOWED_TOOLS']) !== null && _c !== void 0 ? _c : '', onChange: e => handleChange('VARYS_AGENT_ALLOWED_TOOLS', e.target.value), placeholder: "Read,Write,Edit", autoComplete: "off" })),
            React.createElement("div", { className: "ds-settings-row ds-settings-row--toggle" },
                React.createElement("div", { className: "ds-settings-toggle-label-group" },
                    React.createElement("span", { className: "ds-settings-label" }, "Background project scan")),
                React.createElement("label", { className: "ds-settings-toggle-switch", title: boolVal('VARYS_AGENT_BACKGROUND_SCAN', true) ? 'Click to disable' : 'Click to enable' },
                    React.createElement("input", { type: "checkbox", checked: boolVal('VARYS_AGENT_BACKGROUND_SCAN', true), onChange: e => handleChange('VARYS_AGENT_BACKGROUND_SCAN', e.target.checked ? 'true' : 'false') }),
                    React.createElement("span", { className: "ds-settings-toggle-slider" }))),
            React.createElement("div", { className: "ds-settings-row" },
                React.createElement("label", { className: "ds-settings-label" }, "Provider override"),
                React.createElement("select", { className: "ds-settings-select", value: values['VARYS_AGENT_PROVIDER'] || '', onChange: e => handleChange('VARYS_AGENT_PROVIDER', e.target.value) },
                    React.createElement("option", { value: "" }, "\u2014 use global default \u2014"),
                    React.createElement("option", { value: "anthropic" }, "Anthropic"),
                    React.createElement("option", { value: "openai" }, "OpenAI"),
                    React.createElement("option", { value: "azure" }, "Azure OpenAI"),
                    React.createElement("option", { value: "bedrock" }, "AWS Bedrock"),
                    React.createElement("option", { value: "ollama" }, "Ollama"))),
            status && (React.createElement("div", { className: `ds-agent-config-status ds-agent-config-status--${status.type}` }, status.text)),
            React.createElement("div", { className: "ds-agent-config-actions" },
                React.createElement("button", { className: "ds-settings-cancel-btn", onClick: onClose }, "Close"),
                React.createElement("button", { className: "ds-settings-save-btn", onClick: handleSave, disabled: saving }, saving ? 'Saving…' : 'Save'))))));
};
const AgentToolErrorBanner = ({ error, onOpenAgentSettings }) => (React.createElement("div", { className: "ds-agent-tool-error-banner" },
    React.createElement("div", { className: "ds-agent-tool-error-heading" }, "This model does not support tool calling"),
    React.createElement("div", { className: "ds-agent-tool-error-meta" },
        "Provider: ",
        React.createElement("strong", null, error.provider),
        " \u00B7 Model: ",
        React.createElement("strong", null, error.model)),
    React.createElement("div", { className: "ds-agent-tool-error-suggestion" }, error.suggestion),
    onOpenAgentSettings && (React.createElement("button", { className: "ds-agent-tool-error-link", onClick: onOpenAgentSettings }, "Change the agent provider \u2192"))));
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// UsageTab — LLM token usage heatmap + summary
// ---------------------------------------------------------------------------
const USAGE_BASE = '/varys/usage';
const PERIODS = ['Day', 'Week', 'Month', 'Year', 'All'];
function _usageFetch(action, params = {}) {
    const qs = new URLSearchParams(Object.assign({ action }, params)).toString();
    return fetch(`${USAGE_BASE}?${qs}`);
}
function _buildHeatmapGrid(data) {
    var _a;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const start = new Date(today);
    start.setDate(today.getDate() - 364);
    // Build week columns. Each column = 7 slots (Sun–Sat), null = padding.
    const startDow = start.getDay(); // 0=Sun
    const columns = [];
    let col = Array.from({ length: startDow }, () => ({ date: null, value: 0 }));
    const cur = new Date(start);
    while (cur <= today) {
        const iso = cur.toISOString().slice(0, 10);
        const value = (_a = data[iso]) !== null && _a !== void 0 ? _a : 0;
        col.push({ date: iso, value });
        if (col.length === 7) {
            columns.push(col);
            col = [];
        }
        cur.setDate(cur.getDate() + 1);
    }
    if (col.length > 0) {
        while (col.length < 7)
            col.push({ date: null, value: 0 });
        columns.push(col);
    }
    return columns;
}
function _heatmapColor(value, max) {
    if (value === 0 || max === 0)
        return 'var(--ds-heatmap-0)';
    const ratio = value / max;
    if (ratio <= 0.20)
        return 'var(--ds-heatmap-1)';
    if (ratio <= 0.40)
        return 'var(--ds-heatmap-2)';
    if (ratio <= 0.65)
        return 'var(--ds-heatmap-3)';
    if (ratio <= 0.85)
        return 'var(--ds-heatmap-4)';
    return 'var(--ds-heatmap-5)';
}
function _monthLabel(columns, colIdx) {
    const firstCell = columns[colIdx].find(c => c.date !== null);
    if (!firstCell || !firstCell.date)
        return null;
    const d = new Date(firstCell.date + 'T00:00:00');
    if (colIdx === 0)
        return d.toLocaleString('default', { month: 'short' });
    const prevCell = columns[colIdx - 1].find(c => c.date !== null);
    if (!prevCell || !prevCell.date)
        return null;
    const prev = new Date(prevCell.date + 'T00:00:00');
    return d.getMonth() !== prev.getMonth() ? d.toLocaleString('default', { month: 'short' }) : null;
}
const DOW_LABELS = { 1: 'M', 3: 'W', 5: 'F' };
const UsageTab = ({ apiClient }) => {
    const [models, setModels] = React.useState([]);
    const [selectedModel, setSelectedModel] = React.useState('');
    const [period, setPeriod] = React.useState('Month');
    const [totals, setTotals] = React.useState({ in: 0, out: 0, total: 0 });
    const [heatmap, setHeatmap] = React.useState({});
    const [loading, setLoading] = React.useState(true);
    const fetchHeatmap = React.useCallback(async (model) => {
        var _a;
        const params = {};
        if (model)
            params.model = model;
        try {
            const r = await _usageFetch('heatmap', params);
            const j = await r.json();
            setHeatmap((_a = j.data) !== null && _a !== void 0 ? _a : {});
        }
        catch ( /* swallowed */_b) { /* swallowed */ }
    }, []);
    const fetchTotals = React.useCallback(async (model, p) => {
        var _a;
        const params = { period: p.toLowerCase() };
        if (model)
            params.model = model;
        try {
            const r = await _usageFetch('totals', params);
            const j = await r.json();
            setTotals((_a = j.data) !== null && _a !== void 0 ? _a : { in: 0, out: 0, total: 0 });
        }
        catch ( /* swallowed */_b) { /* swallowed */ }
    }, []);
    React.useEffect(() => {
        let cancelled = false;
        (async () => {
            var _a, _b, _c;
            setLoading(true);
            try {
                const [rModels, rHeatmap, rTotals] = await Promise.all([
                    _usageFetch('models'),
                    _usageFetch('heatmap'),
                    _usageFetch('totals', { period: 'month' }),
                ]);
                if (cancelled)
                    return;
                const [jM, jH, jT] = await Promise.all([rModels.json(), rHeatmap.json(), rTotals.json()]);
                if (cancelled)
                    return;
                setModels((_a = jM.data) !== null && _a !== void 0 ? _a : []);
                setHeatmap((_b = jH.data) !== null && _b !== void 0 ? _b : {});
                setTotals((_c = jT.data) !== null && _c !== void 0 ? _c : { in: 0, out: 0, total: 0 });
            }
            catch ( /* swallowed */_d) { /* swallowed */ }
            finally {
                if (!cancelled)
                    setLoading(false);
            }
        })();
        return () => { cancelled = true; };
    }, []);
    const handleModelChange = async (model) => {
        setSelectedModel(model);
        await Promise.all([fetchHeatmap(model), fetchTotals(model, period)]);
    };
    const handlePeriodChange = async (p) => {
        setPeriod(p);
        await fetchTotals(selectedModel, p);
    };
    const handleExport = async () => {
        var _a;
        try {
            const r = await _usageFetch('export');
            const blob = await r.blob();
            const cd = (_a = r.headers.get('Content-Disposition')) !== null && _a !== void 0 ? _a : '';
            const match = /filename="([^"]+)"/.exec(cd);
            const fname = match ? match[1] : `varys_usage_export_${new Date().toISOString().slice(0, 10)}.jsonl`;
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = fname;
            a.click();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
        }
        catch ( /* swallowed */_b) { /* swallowed */ }
    };
    const columns = _buildHeatmapGrid(heatmap);
    const maxValue = Math.max(...Object.values(heatmap), 0);
    if (loading) {
        return React.createElement("div", { className: "ds-usage-loading" }, "Loading usage data\u2026");
    }
    return (React.createElement("div", { className: "ds-usage-tab" },
        React.createElement("div", { className: "ds-usage-filter-bar" },
            React.createElement("div", { className: "ds-usage-filter-left" },
                React.createElement("label", { className: "ds-usage-filter-label" }, "Model"),
                React.createElement("select", { className: "ds-settings-select ds-usage-model-select", value: selectedModel, onChange: e => handleModelChange(e.target.value) },
                    React.createElement("option", { value: "" }, "All"),
                    models.map(m => React.createElement("option", { key: m, value: m }, m)))),
            React.createElement("button", { className: "ds-usage-export-btn", onClick: handleExport }, "Export")),
        React.createElement("div", { className: "ds-usage-cards" },
            React.createElement("div", { className: "ds-usage-card" },
                React.createElement("span", { className: "ds-usage-card-label" }, "Tokens in"),
                React.createElement("span", { className: "ds-usage-card-value" }, totals.in.toLocaleString())),
            React.createElement("div", { className: "ds-usage-card" },
                React.createElement("span", { className: "ds-usage-card-label" }, "Tokens out"),
                React.createElement("span", { className: "ds-usage-card-value" }, totals.out.toLocaleString())),
            React.createElement("div", { className: "ds-usage-card" },
                React.createElement("span", { className: "ds-usage-card-label" }, "Total"),
                React.createElement("span", { className: "ds-usage-card-value" }, totals.total.toLocaleString()))),
        React.createElement("div", { className: "ds-usage-period-pills" }, PERIODS.map(p => (React.createElement("button", { key: p, className: `ds-usage-pill${period === p ? ' ds-usage-pill--active' : ''}`, onClick: () => handlePeriodChange(p) }, p)))),
        React.createElement("div", { className: "ds-usage-heatmap-wrap" },
            React.createElement("div", { className: "ds-usage-heatmap" },
                React.createElement("div", { className: "ds-usage-heatmap-months" },
                    React.createElement("div", { className: "ds-usage-heatmap-dow-spacer" }),
                    columns.map((_, ci) => (React.createElement("div", { key: ci, className: "ds-usage-heatmap-month-cell" }, _monthLabel(columns, ci) && (React.createElement("span", { className: "ds-usage-heatmap-month-label" }, _monthLabel(columns, ci))))))),
                React.createElement("div", { className: "ds-usage-heatmap-grid" },
                    React.createElement("div", { className: "ds-usage-heatmap-dow-col" }, [0, 1, 2, 3, 4, 5, 6].map(row => {
                        var _a;
                        return (React.createElement("div", { key: row, className: "ds-usage-heatmap-dow-label" }, (_a = DOW_LABELS[row]) !== null && _a !== void 0 ? _a : ''));
                    })),
                    columns.map((week, ci) => (React.createElement("div", { key: ci, className: "ds-usage-heatmap-week" }, week.map((cell, row) => (React.createElement("div", { key: row, className: "ds-usage-heatmap-cell", style: { background: cell.date ? _heatmapColor(cell.value, maxValue) : 'transparent' }, title: cell.date
                            ? `${cell.date} — ${cell.value.toLocaleString()} tokens`
                            : undefined })))))))))));
};
// MemoryTab — placeholder for long-term memory configuration
// ---------------------------------------------------------------------------
const MemoryTab = () => (React.createElement("div", { className: "ds-settings-section-body" },
    React.createElement("p", { className: "ds-settings-section-placeholder" }, "Long-term memory configuration coming soon.")));
const MaintenancePanel = ({ apiClient }) => {
    var _a, _b;
    const [scanning, setScanning] = useState(false);
    const [applying, setApplying] = useState(false);
    const [scanResult, setScanResult] = useState(null);
    const [applyResult, setApplyResult] = useState(null);
    const [error, setError] = useState(null);
    const handleScan = async () => {
        setScanning(true);
        setError(null);
        setApplyResult(null);
        try {
            const r = await apiClient.scanOrphans();
            setScanResult(r);
        }
        catch (e) {
            setError(e instanceof Error ? e.message : 'Scan failed');
        }
        finally {
            setScanning(false);
        }
    };
    const handleRelink = async () => {
        setApplying(true);
        setError(null);
        try {
            const r = await apiClient.applyOrphanMigration();
            setApplyResult(r.results);
            // Refresh scan so counts update
            const refreshed = await apiClient.scanOrphans();
            setScanResult(refreshed);
        }
        catch (e) {
            setError(e instanceof Error ? e.message : 'Relink failed');
        }
        finally {
            setApplying(false);
        }
    };
    const needsMigration = (_a = scanResult === null || scanResult === void 0 ? void 0 : scanResult.orphaned.filter(o => o.needs_migration)) !== null && _a !== void 0 ? _a : [];
    const missing = (_b = scanResult === null || scanResult === void 0 ? void 0 : scanResult.orphaned.filter(o => o.notebook_missing)) !== null && _b !== void 0 ? _b : [];
    return (React.createElement("div", { className: "ds-settings-section-body ds-maintenance-panel" },
        React.createElement("p", { className: "ds-maintenance-desc" }, "Scan for notebook chat history that became unlinked after an upgrade or schema change. Varys will rename the data directories to match each notebook's current ID so history is restored automatically."),
        React.createElement("div", { className: "ds-maintenance-actions" },
            React.createElement("button", { className: "ds-settings-save-btn", onClick: handleScan, disabled: scanning || applying }, scanning ? 'Scanning…' : 'Scan'),
            needsMigration.length > 0 && (React.createElement("button", { className: "ds-settings-save-btn", onClick: handleRelink, disabled: applying, style: { marginLeft: 8 } }, applying ? 'Relinking…' : `Relink ${needsMigration.length} notebook${needsMigration.length !== 1 ? 's' : ''}`))),
        error && React.createElement("div", { className: "ds-maintenance-error" }, error),
        scanResult && (React.createElement("div", { className: "ds-maintenance-results" },
            React.createElement("div", { className: "ds-maintenance-summary" }, scanResult.total_scanned === 0
                ? 'No notebook data directories found.'
                : React.createElement(React.Fragment, null,
                    "Scanned ",
                    React.createElement("strong", null, scanResult.total_scanned),
                    " data ",
                    scanResult.total_scanned === 1 ? 'dir' : 'dirs',
                    ".",
                    ' ',
                    React.createElement("strong", null, scanResult.already_linked),
                    " already linked.",
                    needsMigration.length > 0
                        ? React.createElement(React.Fragment, null,
                            " ",
                            React.createElement("strong", null, needsMigration.length),
                            " need relinking.")
                        : ' All up to date.')),
            needsMigration.map(item => (React.createElement("div", { key: item.uuid, className: "ds-maintenance-item ds-maintenance-item--needs" },
                React.createElement("div", { className: "ds-maintenance-item-path", title: item.notebook_path }, item.notebook_path.split('/').pop()),
                React.createElement("div", { className: "ds-maintenance-item-meta" },
                    item.message_count,
                    " msg",
                    item.message_count !== 1 ? 's' : '',
                    item.conflict && React.createElement("span", { className: "ds-maintenance-warn" }, " \u00B7 conflict"))))),
            missing.length > 0 && (React.createElement("div", { className: "ds-maintenance-missing" },
                React.createElement("span", { className: "ds-maintenance-missing-label" },
                    missing.length,
                    " notebook",
                    missing.length !== 1 ? 's' : '',
                    " not found on disk"),
                missing.map(item => (React.createElement("div", { key: item.uuid, className: "ds-maintenance-item ds-maintenance-item--missing", title: item.notebook_path },
                    item.notebook_path.split('/').pop(),
                    " \u00B7 ",
                    item.message_count,
                    " msg",
                    item.message_count !== 1 ? 's' : ''))))))),
        applyResult && applyResult.length > 0 && (React.createElement("div", { className: "ds-maintenance-apply-results" },
            applyResult.filter(r => r.status === 'migrated').map(r => (React.createElement("div", { key: r.uuid, className: "ds-maintenance-result ds-maintenance-result--ok" },
                "\u2713 Relinked: ",
                r.notebook_path.split('/').pop()))),
            applyResult.filter(r => r.status !== 'migrated' && r.status !== 'skipped').map(r => (React.createElement("div", { key: r.uuid, className: "ds-maintenance-result ds-maintenance-result--err" },
                "\u2717 ",
                r.notebook_path.split('/').pop(),
                ": ",
                r.error)))))));
};
// ---------------------------------------------------------------------------
// SettingsPanel — vertical sidebar nav + content pane
// ---------------------------------------------------------------------------
const SettingsPanel = ({ apiClient, onClose, onSaved, notebookPath = '', initialTab }) => {
    const initSection = (() => {
        switch (initialTab) {
            case 'mcp': return 'mcp';
            case 'skills': return 'skills';
            case 'commands': return 'commands';
            case 'tags': return 'tags';
            default: return 'model-routing';
        }
    })();
    const [activeSection, setActiveSection] = useState(initSection);
    const [activeSubSection, setActiveSubSection] = useState(null);
    const [providerStatuses, setProviderStatuses] = useState({});
    const handleNavigate = (section, subSection) => {
        setActiveSection(section);
        setActiveSubSection(subSection);
    };
    const renderContent = (section, subSection) => {
        switch (section) {
            case 'model-routing':
            case 'model-providers':
                return (React.createElement(ModelsPanel, { apiClient: apiClient, onClose: onClose, onSaved: onSaved, notebookPath: notebookPath, section: section, subSection: subSection, onProviderStatusChange: setProviderStatuses }));
            case 'mcp':
                return (React.createElement("div", { className: "ds-settings-section-body" },
                    React.createElement(MCPPanel, { apiClient: apiClient })));
            case 'context':
                return React.createElement(ContextPanel, null);
            case 'skills':
                return React.createElement(SkillsPanel, { apiClient: apiClient, notebookPath: notebookPath });
            case 'commands':
                return (React.createElement("div", { className: "ds-settings-section-body" },
                    React.createElement(CommandsPanel, { apiClient: apiClient })));
            case 'tags':
                return (React.createElement("div", { className: "ds-settings-section-body" },
                    React.createElement(TagsSettingsPanel, null)));
            case 'memory':
                return React.createElement(MemoryTab, null);
            case 'usage':
                return (React.createElement("div", { className: "ds-settings-section-body" },
                    React.createElement(UsageTab, { apiClient: apiClient })));
            case 'maintenance':
                return React.createElement(MaintenancePanel, { apiClient: apiClient });
            default:
                return null;
        }
    };
    return (React.createElement("div", { className: "ds-settings-outer" },
        React.createElement(SettingsSidebar, { activeSection: activeSection, activeSubSection: activeSubSection, providerStatuses: providerStatuses, onNavigate: handleNavigate }),
        React.createElement("div", { className: "ds-settings-content" },
            React.createElement(SectionHeading, { section: activeSection, subSection: activeSubSection }),
            renderContent(activeSection, activeSubSection))));
};
// ---------------------------------------------------------------------------
// ModelSwitcher — inline model picker at the bottom of the chat textarea
// ---------------------------------------------------------------------------
const shortModelName = (model) => model.includes('/') ? model.split('/').slice(1).join('/') : model;
const PROVIDER_COLORS = {
    ANTHROPIC: '#d97757',
    OPENAI: '#10a37f',
    GOOGLE: '#4285f4',
    BEDROCK: '#ff9900',
    AZURE: '#0078d4',
    OPENROUTER: '#7c3aed',
    OLLAMA: '#0ea5e9',
};
const providerColor = (p) => { var _a; return (_a = PROVIDER_COLORS[p.toUpperCase()]) !== null && _a !== void 0 ? _a : '#1976d2'; };
const ModelSwitcher = ({ provider, model, zoo, saving, onSelect }) => {
    const [open, setOpen] = useState(false);
    const wrapperRef = useRef(null);
    const color = providerColor(provider);
    useEffect(() => {
        if (!open)
            return;
        const onDown = (e) => {
            if (wrapperRef.current && !wrapperRef.current.contains(e.target))
                setOpen(false);
        };
        document.addEventListener('mousedown', onDown);
        return () => document.removeEventListener('mousedown', onDown);
    }, [open]);
    const noProvider = !provider;
    const displayName = noProvider ? 'No provider set — open Settings' : (shortModelName(model) || '—');
    const displayProvider = (!provider || provider === 'unknown') ? '?' : provider.toUpperCase();
    return (React.createElement("div", { className: "ds-model-switcher", ref: wrapperRef },
        open && (React.createElement("div", { className: "ds-model-switcher-popup" },
            React.createElement("div", { className: "ds-model-switcher-popup-header", style: { borderLeftColor: color, color } },
                React.createElement("span", { className: "ds-model-switcher-popup-provider" }, displayProvider),
                React.createElement("span", { className: "ds-model-switcher-popup-label" }, "Chat model")),
            zoo.length === 0 ? (React.createElement("div", { className: "ds-model-switcher-empty" },
                "No models in zoo.",
                '\n',
                "Go to \u2699 Settings \u2192 ",
                displayProvider,
                " tab.")) : (React.createElement("div", { className: "ds-model-switcher-list" }, zoo.map(m => {
                const isActive = m === model;
                return (React.createElement("button", { key: m, className: `ds-model-switcher-option${isActive ? ' ds-model-switcher-option--active' : ''}`, style: isActive ? { borderLeftColor: color } : undefined, onClick: () => { onSelect(m); setOpen(false); }, title: m },
                    React.createElement("span", { className: "ds-model-switcher-option-name" }, m),
                    isActive && React.createElement("span", { className: "ds-model-switcher-check", style: { color } }, "\u2713")));
            }))))),
        React.createElement("button", { className: `ds-model-switcher-btn${open ? ' ds-model-switcher-btn--open' : ''}${saving ? ' ds-model-switcher-btn--saving' : ''}${noProvider ? ' ds-model-switcher-btn--unconfigured' : ''}`, onClick: () => !saving && setOpen(o => !o), "data-tip": noProvider ? 'No provider configured — open Settings' : `${displayProvider} · ${model}`, disabled: saving },
            React.createElement("span", { className: "ds-model-switcher-model-name" }, saving ? 'Switching…' : displayName),
            React.createElement("span", { className: "ds-model-switcher-chevron" }))));
};
// ---------------------------------------------------------------------------
// Slash-command helpers
// ---------------------------------------------------------------------------
/** Parse a /command prefix from the start of a message.
 *  Returns { command: "/eda", rest: "rest of message" } or null if no command. */
function parseSlashCommand(input) {
    var _a;
    const m = input.match(/^(\/[\w-]+)(?:\s+(.*))?$/s);
    if (!m)
        return null;
    return { command: m[1].toLowerCase(), rest: ((_a = m[2]) !== null && _a !== void 0 ? _a : '').trim() };
}
const CommandAutocomplete = ({ commands, query, onSelect, onClose, }) => {
    const filtered = React.useMemo(() => {
        const q = query.toLowerCase();
        return commands.filter(c => c.command.startsWith(q) || c.description.toLowerCase().includes(q));
    }, [commands, query]);
    const popupRef = useRef(null);
    const [activeIdx, setActiveIdx] = useState(0);
    // Reset active index when filter changes
    useEffect(() => { setActiveIdx(0); }, [filtered.length]);
    // Close on outside click
    useEffect(() => {
        const handler = (e) => {
            if (popupRef.current && !popupRef.current.contains(e.target))
                onClose();
        };
        document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, [onClose]);
    // Keyboard navigation — exposed via a global keydown handler attached to
    // the textarea when this component is visible.
    useEffect(() => {
        const handler = (e) => {
            if (!filtered.length)
                return;
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                setActiveIdx(i => Math.min(i + 1, filtered.length - 1));
            }
            else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setActiveIdx(i => Math.max(i - 1, 0));
            }
            else if (e.key === 'Tab' || e.key === 'Enter') {
                e.preventDefault();
                if (filtered[activeIdx])
                    onSelect(filtered[activeIdx]);
            }
            else if (e.key === 'Escape') {
                onClose();
            }
        };
        document.addEventListener('keydown', handler, true);
        return () => document.removeEventListener('keydown', handler, true);
    }, [filtered, activeIdx, onSelect, onClose]);
    if (!filtered.length)
        return null;
    return (React.createElement("div", { className: "ds-cmd-popup", ref: popupRef }, filtered.map((cmd, i) => (React.createElement("div", { key: cmd.command, className: `ds-cmd-item${i === activeIdx ? ' ds-cmd-item-active' : ''}`, onMouseEnter: () => setActiveIdx(i), onClick: () => onSelect(cmd) },
        React.createElement("span", { className: "ds-cmd-name" }, cmd.command),
        React.createElement("span", { className: `ds-cmd-badge ds-cmd-badge-${cmd.type}` }, cmd.type),
        React.createElement("span", { className: "ds-cmd-desc" }, cmd.description))))));
};
// ---------------------------------------------------------------------------
// Thread helpers
// ---------------------------------------------------------------------------
function makeNewThread(name) {
    const now = new Date().toISOString();
    return {
        id: `t_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`,
        name,
        createdAt: now,
        updatedAt: now,
        messages: [],
        notebookAware: true,
    };
}
// ---------------------------------------------------------------------------
// Cell identity helpers
// ---------------------------------------------------------------------------
/**
 * Rewrite stale `#N [id:XXXXXXXX]` references inside a history message so
 * they always reflect the *current* notebook position for that cell.
 *
 * The LLM is instructed (via the system prompt) to always include `[id:X]`
 * when citing a cell.  When cells are inserted or deleted between turns,
 * the number N may drift.  This pass corrects N before the history is sent
 * to the LLM so it never sees conflicting positions.
 *
 * @param text    The raw message content (user or assistant).
 * @param idMap   Map from 8-char id-prefix → current 1-based cell number.
 */
function translateCellRefs(text, idMap) {
    // Matches "#7 [id:a3f7b2c1]" or "#7  [id:a3f7b2c1]" (one or two spaces)
    return text.replace(/#(\d+)\s{1,2}\[id:([0-9a-f]{8})\]/g, (_m, numStr, prefix) => {
        const oldNum = parseInt(numStr, 10);
        if (!idMap.has(prefix)) {
            // Cell was deleted from the notebook entirely
            return `#${oldNum} [id:${prefix}] [cell no longer exists]`;
        }
        const currentNum = idMap.get(prefix);
        if (currentNum !== oldNum) {
            return `#${currentNum} [id:${prefix}] (was #${oldNum})`;
        }
        return `#${oldNum} [id:${prefix}]`;
    });
}
const ThreadBar = ({ threads, currentId, notebookName: _notebookName, onSwitch, onNew, onRename, onDuplicate, onDelete, rightSlot, }) => {
    const [editingId, setEditingId] = useState('');
    const [editValue, setEditValue] = useState('');
    const [renameError, setRenameError] = useState('');
    const tryRename = (id, name) => {
        const trimmed = name.trim();
        if (!trimmed)
            return false;
        const collision = threads.some(t => t.id !== id && t.name === trimmed);
        if (collision) {
            setRenameError(`"${trimmed}" already exists`);
            return false;
        }
        onRename(id, trimmed);
        setRenameError('');
        return true;
    };
    return (React.createElement("div", { className: "ds-thread-bar" },
        React.createElement("div", { className: "ds-thread-pills" },
            threads.map(t => (React.createElement("div", { key: t.id, className: `ds-thread-pill${t.id === currentId ? ' ds-thread-pill--active' : ''}${editingId === t.id ? ' ds-thread-pill--editing' : ''}` }, editingId === t.id ? (
            /* Inline rename input */
            React.createElement("div", { className: "ds-thread-rename-wrap" },
                React.createElement("input", { className: `ds-thread-rename-input${renameError ? ' ds-thread-rename-error' : ''}`, value: editValue, autoFocus: true, onChange: e => { setEditValue(e.target.value); setRenameError(''); }, onBlur: () => { tryRename(t.id, editValue); setEditingId(''); }, onKeyDown: e => {
                        if (e.key === 'Enter') {
                            if (tryRename(t.id, editValue))
                                setEditingId('');
                        }
                        if (e.key === 'Escape') {
                            setEditingId('');
                            setRenameError('');
                        }
                    } }),
                renameError && React.createElement("span", { className: "ds-thread-rename-msg" }, renameError))) : (React.createElement(React.Fragment, null,
                React.createElement("span", { className: "ds-thread-pill-name", onClick: () => onSwitch(t.id), title: t.name }, t.name),
                React.createElement("span", { className: "ds-thread-pill-actions" },
                    React.createElement("span", { className: "ds-thread-pill-btn", onClick: e => { e.stopPropagation(); setEditingId(t.id); setEditValue(t.name); }, title: "Rename" },
                        React.createElement("svg", { viewBox: "0 0 14 14", width: "11", height: "11", fill: "none", xmlns: "http://www.w3.org/2000/svg" },
                            React.createElement("path", { d: "M9.5 1.5l3 3L4 13H1v-3L9.5 1.5z", stroke: "currentColor", strokeWidth: "1.4", strokeLinejoin: "round" }))),
                    React.createElement("span", { className: "ds-thread-pill-btn", onClick: e => { e.stopPropagation(); onDuplicate(t.id); }, title: "Duplicate" },
                        React.createElement("svg", { viewBox: "0 0 14 14", width: "11", height: "11", fill: "none", xmlns: "http://www.w3.org/2000/svg" },
                            React.createElement("rect", { x: "4", y: "4", width: "8", height: "9", rx: "1.2", stroke: "currentColor", strokeWidth: "1.4" }),
                            React.createElement("path", { d: "M2 10V2a1 1 0 011-1h7", stroke: "currentColor", strokeWidth: "1.4", strokeLinecap: "round" }))),
                    threads.length > 1 && (React.createElement("span", { className: "ds-thread-pill-btn ds-thread-pill-btn--delete", onClick: e => { e.stopPropagation(); onDelete(t.id); }, title: "Delete" },
                        React.createElement("svg", { viewBox: "0 0 14 14", width: "11", height: "11", fill: "none", xmlns: "http://www.w3.org/2000/svg" },
                            React.createElement("path", { d: "M2 4h10M5 4V2.5a.5.5 0 01.5-.5h3a.5.5 0 01.5.5V4M6 7v3.5M8 7v3.5", stroke: "currentColor", strokeWidth: "1.4", strokeLinecap: "round" }),
                            React.createElement("path", { d: "M3 4l.8 7.2a1 1 0 001 .8h4.4a1 1 0 001-.8L11 4", stroke: "currentColor", strokeWidth: "1.4", strokeLinecap: "round" })))))))))),
            React.createElement("button", { className: "ds-thread-add-btn", onClick: onNew, title: "New thread", "aria-label": "New thread" }, "+")),
        rightSlot && (React.createElement(React.Fragment, null,
            React.createElement("span", { className: "ds-thread-bar-sep" }, "|"),
            React.createElement("div", { className: "ds-thread-bar-right" }, rightSlot)))));
};
// ---------------------------------------------------------------------------
// ContextChipBubble — collapsible code-context chip shown in sent user bubbles
// ---------------------------------------------------------------------------
const ContextChipBubble = ({ chip }) => {
    const [expanded, setExpanded] = React.useState(false);
    return (React.createElement("div", { className: "ds-ctx-chip ds-ctx-chip--bubble" },
        React.createElement("div", { className: "ds-ctx-chip-header" },
            React.createElement("span", { className: "ds-ctx-chip-icon" }, "\uD83D\uDCCE"),
            React.createElement("span", { className: "ds-ctx-chip-label" }, chip.label),
            React.createElement("button", { className: "ds-ctx-chip-toggle", onClick: () => setExpanded(x => !x), title: expanded ? 'Collapse' : 'Expand context', "aria-label": expanded ? 'Collapse context' : 'Expand context' }, expanded ? '▲' : '▼')),
        expanded && (React.createElement("pre", { className: "ds-ctx-chip-preview" }, chip.preview))));
};
// ---------------------------------------------------------------------------
// Chat component
// ---------------------------------------------------------------------------
const DSAssistantChat = (props) => {
    var _a, _b, _c, _d;
    const { apiClient, notebookReader, cellEditor, notebookTracker, openFile, reloadFile, } = props;
    // Resolves @variable_name references typed in the chat input
    const variableResolver = React.useMemo(() => new VariableResolver(notebookTracker), [notebookTracker]);
    const [messages, setMessages] = useState([
        {
            id: '0',
            role: 'system',
            content: 'Varys ready. Open a notebook and ask me anything!',
            timestamp: new Date()
        }
    ]);
    const [input, setInput] = useState('');
    const [isLoading, setIsLoading] = useState(false);
    // ── Collapsible long messages ───────────────────────────────────────────
    // Messages whose content length exceeds this threshold start collapsed.
    const COLLAPSE_THRESHOLD = 800;
    const [collapsedMsgs, setCollapsedMsgs] = useState(new Set());
    const toggleCollapse = (id) => setCollapsedMsgs(prev => {
        const next = new Set(prev);
        next.has(id) ? next.delete(id) : next.add(id);
        return next;
    });
    // ── Streaming animation queue ──────────────────────────────────────────
    // Chunks from the SSE stream are pushed here and drained by a setInterval
    // at 30 ms, decoupling rendering from React 18 automatic batching and from
    // Tornado's TCP flush timing. This guarantees visible token-by-token
    // streaming regardless of how the backend sends the events.
    const streamQueueRef = useRef([]);
    const streamMsgIdRef = useRef('');
    const streamTimerRef = useRef(null);
    // ── Tool-call JSON delta content extractor ────────────────────────────
    // The Anthropic/OpenAI APIs stream the tool-call JSON payload character by
    // character as `input_json_delta` events.  We parse out the "content" field
    // values so the user can watch the cell content being written in real time,
    // eliminating the silent gap while the LLM generates the operation plan.
    //
    // State machine: scan the accumulated JSON for the last `"content": "` and
    // extract the unescaped chars that follow it up to the current position.
    // When a new "content" field begins (unescaped length shrinks), reset the
    // cursor and start streaming the new field.
    const jsonExtractorRef = useRef({
        accumulated: '',
        lastLen: 0,
        headerEmitted: false,
        feed(partial) {
            this.accumulated += partial;
            // Match from the last "content": " to the current end of string.
            // The regex intentionally anchors to $ so it tracks the LATEST field.
            const match = this.accumulated.match(/"content"\s*:\s*"((?:[^"\\]|\\[\s\S])*)$/);
            if (!match)
                return '';
            // Unescape JSON string escapes so we show readable text
            const unescaped = match[1]
                .replace(/\\n/g, '\n')
                .replace(/\\t/g, '\t')
                .replace(/\\r/g, '')
                .replace(/\\"/g, '"')
                .replace(/\\\\/g, '\\');
            if (unescaped.length < this.lastLen) {
                // A new content field has started — reset cursor
                this.lastLen = 0;
            }
            const delta = unescaped.slice(this.lastLen);
            this.lastLen = unescaped.length;
            return delta;
        },
        reset() {
            this.accumulated = '';
            this.lastLen = 0;
            this.headerEmitted = false;
        },
    });
    const startStreamQueue = (msgId) => {
        streamMsgIdRef.current = msgId;
        streamQueueRef.current = [];
        setActiveStreamId(msgId);
        if (streamTimerRef.current)
            clearInterval(streamTimerRef.current);
        streamTimerRef.current = setInterval(() => {
            if (streamQueueRef.current.length === 0)
                return;
            // Collapse all buffered tokens into one character string so we can
            // drip by character count rather than token count.  LLM tokens range
            // from 1 to 20+ chars; token-based draining produces irregular jumps.
            const pending = streamQueueRef.current.splice(0).join('');
            // Adaptive character drip:
            //   ≤ 50 chars backlog  → 8  chars/tick  (~267 chars/s) — smooth typewriter
            //   ≤ 200 chars backlog → 16 chars/tick  (~533 chars/s) — normal pace
            //   > 200 chars backlog → 32 chars/tick  (~1066 chars/s) — catch-up mode
            const charsPerTick = pending.length > 200 ? 32 : pending.length > 50 ? 16 : 8;
            const toReveal = pending.slice(0, charsPerTick);
            const leftover = pending.slice(charsPerTick);
            // Put the unshown remainder back so the next tick continues from here.
            if (leftover)
                streamQueueRef.current.unshift(leftover);
            setMessages(prev => prev.map(m => m.id === streamMsgIdRef.current
                ? Object.assign(Object.assign({}, m), { content: m.content + toReveal }) : m));
        }, 30);
    };
    const pushToStreamQueue = (text) => {
        if (text)
            streamQueueRef.current.push(text);
    };
    // ── "Writing code" indicator — dual-trigger with elapsed-time fallback ─────
    //
    // Two independent ways to activate isWritingCode:
    //
    //  1. json_delta events (precise, requires updated Python server):
    //     The first json_delta byte immediately calls startJsonCodeCounter(),
    //     which shows a live "· N chars" byte counter via a 200 ms timer.
    //
    //  2. Chunk-silence detector (fallback, always active):
    //     Records every onChunk timestamp and a minimum char count.  Triggers
    //     only when BOTH conditions hold simultaneously:
    //       • ≥1 500 ms since the last chunk arrived (long enough that CoT
    //         step-to-step gaps of 300–600 ms never fire it falsely)
    //       • ≥100 chars accumulated (avoids misfires at stream start)
    //     When activated this way, shows an elapsed-seconds counter ("· 3 s")
    //     instead of a byte count so the user still sees live progress.
    //
    // stopJsonCodeCounter() tears down both timers and all state.
    const jsonCodeCharsRef = useRef(0);
    const chunkCharsRef = useRef(0); // total chars received via onChunk
    const isWritingCodeRef = useRef(false); // sync mirror of isWritingCode state
    const [isWritingCode, setIsWritingCode] = useState(false);
    const [elapsedSecs, setElapsedSecs] = useState(0);
    const elapsedTimerRef = useRef(null);
    const writeStartRef = useRef(0);
    // Silence detector state
    const lastChunkTimeRef = useRef(0);
    const silenceTimerRef = useRef(null);
    // Mark the writing phase as active (idempotent).  Always call through here
    // so the ref and state stay in sync.
    const beginWritingPhase = () => {
        if (isWritingCodeRef.current)
            return;
        isWritingCodeRef.current = true;
        setIsWritingCode(true);
        writeStartRef.current = Date.now();
        setElapsedSecs(0);
        if (elapsedTimerRef.current)
            clearInterval(elapsedTimerRef.current);
        elapsedTimerRef.current = setInterval(() => {
            setElapsedSecs(Math.floor((Date.now() - writeStartRef.current) / 1000));
        }, 1000);
    };
    // Start polling for chunk silence.  Called once streaming begins.
    const startSilenceDetector = () => {
        lastChunkTimeRef.current = Date.now();
        chunkCharsRef.current = 0;
        if (silenceTimerRef.current)
            clearInterval(silenceTimerRef.current);
        silenceTimerRef.current = setInterval(() => {
            const silentMs = Date.now() - lastChunkTimeRef.current;
            if (!isWritingCodeRef.current &&
                lastChunkTimeRef.current > 0 &&
                silentMs > 1500 && // long enough to skip CoT step gaps
                chunkCharsRef.current >= 100) { // at least ~20 words already shown
                beginWritingPhase();
            }
        }, 100);
    };
    const stopSilenceDetector = () => {
        if (silenceTimerRef.current) {
            clearInterval(silenceTimerRef.current);
            silenceTimerRef.current = null;
        }
        lastChunkTimeRef.current = 0;
    };
    // Called on the first json_delta byte — more precise than silence detection.
    const startJsonCodeCounter = () => {
        stopSilenceDetector(); // hand off from silence path to elapsed-time path
        beginWritingPhase();
        jsonCodeCharsRef.current = 0;
    };
    const stopJsonCodeCounter = () => {
        stopSilenceDetector();
        if (elapsedTimerRef.current) {
            clearInterval(elapsedTimerRef.current);
            elapsedTimerRef.current = null;
        }
        isWritingCodeRef.current = false;
        setIsWritingCode(false);
        setElapsedSecs(0);
        jsonCodeCharsRef.current = 0;
        chunkCharsRef.current = 0;
        writeStartRef.current = 0;
    };
    const stopStreamQueue = () => {
        if (streamTimerRef.current) {
            clearInterval(streamTimerRef.current);
            streamTimerRef.current = null;
        }
        // Flush any remaining items immediately
        if (streamQueueRef.current.length > 0) {
            const remaining = streamQueueRef.current.splice(0).join('');
            setMessages(prev => prev.map(m => m.id === streamMsgIdRef.current
                ? Object.assign(Object.assign({}, m), { content: m.content + remaining }) : m));
        }
        setActiveStreamId('');
    };
    // Clean up the animation timer when the component unmounts
    useEffect(() => () => {
        if (streamTimerRef.current)
            clearInterval(streamTimerRef.current);
    }, []);
    const [showSettings, setShowSettings] = useState(false);
    const [showRepro, setShowRepro] = useState(false);
    const [showTags, setShowTags] = useState(false);
    const [reproIssues, setReproIssues] = useState(reproStore.current);
    // Keep the dot badge in sync with reproStore updates.
    // Also seed the store from the backend on mount so the badge shows
    // even before the user ever opens the Reproducibility panel.
    useEffect(() => {
        const handler = (issues) => setReproIssues(issues);
        reproStore.subscribe(handler);
        const ctx = notebookReader.getFullContext();
        if (ctx === null || ctx === void 0 ? void 0 : ctx.notebookPath) {
            apiClient.getReproIssues(ctx.notebookPath).then(result => {
                if (result.issues.length > 0) {
                    reproStore.emit(result.issues);
                }
            }).catch(() => { });
        }
        return () => reproStore.unsubscribe(handler);
    }, []);
    const REASONING_CYCLE = ['off', 'cot', 'sequential'];
    const [reasoningMode, setReasoningMode] = useState(() => {
        try {
            const stored = localStorage.getItem('ds-varys-reasoning-mode');
            // Migrate legacy boolean flag
            if (!stored && localStorage.getItem('ds-varys-thinking') === 'true')
                return 'sequential';
            return REASONING_CYCLE.includes(stored) ? stored : 'cot';
        }
        catch (_a) {
            return 'cot';
        }
    });
    // Tracks which message IDs have their thinking section collapsed (true = collapsed)
    const [thinkCollapsed, setThinkCollapsed] = useState(new Map());
    const toggleThinkCollapsed = (id) => setThinkCollapsed(prev => new Map(prev).set(id, !prev.get(id)));
    // Ref mirrors state so async callbacks (handleSend) always read the live value
    // even if captured in a stale closure.
    const reasoningModeRef = useRef(reasoningMode);
    useEffect(() => { reasoningModeRef.current = reasoningMode; }, [reasoningMode]);
    const [reasoningDropdownOpen, setReasoningDropdownOpen] = useState(false);
    const reasoningDropdownRef = useRef(null);
    useEffect(() => {
        if (!reasoningDropdownOpen)
            return;
        const close = (e) => {
            if (reasoningDropdownRef.current && !reasoningDropdownRef.current.contains(e.target)) {
                setReasoningDropdownOpen(false);
            }
        };
        document.addEventListener('mousedown', close);
        return () => document.removeEventListener('mousedown', close);
    }, [reasoningDropdownOpen]);
    // ── Image mode — per-notebook, persisted in localStorage ──────────────────
    // Set by /no_figures (strip all figures) or /resize(DIM) (downscale figures).
    // Sent with every task request until changed.
    const _imageModeKey = (path) => `ds-varys-image-mode:${path || '_default'}`;
    const [imageMode, setImageModeState] = useState(null);
    const imageModeRef = useRef(null);
    const setImageMode = (mode) => {
        imageModeRef.current = mode;
        setImageModeState(mode);
        try {
            const k = _imageModeKey(currentNotebookPathRef.current);
            if (mode)
                localStorage.setItem(k, JSON.stringify(mode));
            else
                localStorage.removeItem(k);
        }
        catch ( /* ignore */_a) { /* ignore */ }
    };
    // Chat window theme toggle: 'day' (light) or 'night' (dark), persisted in
    // localStorage so it survives JupyterLab restarts independently of the
    // global IDE theme.
    const [chatTheme, setChatTheme] = useState(() => {
        try {
            return localStorage.getItem('ds-assistant-chat-theme') || 'day';
        }
        catch (_a) {
            return 'day';
        }
    });
    const toggleChatTheme = () => {
        setChatTheme(prev => {
            const next = prev === 'day' ? 'night' : 'day';
            try {
                localStorage.setItem('ds-assistant-chat-theme', next);
            }
            catch ( /* ignore */_a) { /* ignore */ }
            return next;
        });
    };
    const [cellMode, setCellMode] = useState(() => {
        try {
            const stored = localStorage.getItem('ds-assistant-cell-mode');
            // Migrate legacy values: never→chat, auto/always/doc→agent
            if (stored === 'never')
                return 'chat';
            if (stored === 'auto' || stored === 'always' || stored === 'doc')
                return 'agent';
            if (stored === 'chat' || stored === 'agent')
                return stored;
            return 'agent';
        }
        catch (_a) {
            return 'agent';
        }
    });
    // Ref so closures (e.g. _saveThread) always read the latest mode.
    const cellModeRef = useRef(cellMode);
    useEffect(() => { cellModeRef.current = cellMode; }, [cellMode]);
    // "Focus on active cell" lives in Settings → Context now. The chat
    // request reads it fresh from localStorage at submit time so changes
    // there take effect on the next message without prop drilling.
    // Per-thread mode map — the authoritative in-session source.
    // Updated synchronously on every explicit mode change and on thread load,
    // so handleSwitchThread always sees the correct mode regardless of render timing
    // or async _saveThread lag.
    const threadModeMapRef = useRef(new Map());
    // Per-thread reasoning map — same pattern as threadModeMapRef.
    const threadReasoningMapRef = useRef(new Map());
    // ── Input area resize (drag from top) ─────────────────────────────────────
    const MIN_INPUT_HEIGHT = 56;
    const MAX_INPUT_HEIGHT = 400;
    const [inputHeight, setInputHeight] = useState(() => {
        try {
            const saved = localStorage.getItem('ds-assistant-input-height');
            return saved ? Math.max(MIN_INPUT_HEIGHT, parseInt(saved, 10)) : 80;
        }
        catch (_a) {
            return 80;
        }
    });
    const dragStateRef = useRef(null);
    const textareaRef = useRef(null);
    // Tracks the last innerHTML we explicitly set so we can skip redundant updates.
    const ceHtmlRef = useRef('');
    // Tracks the plain text last read from the CE div in handleCEInput, so the
    // external-input sync useEffect can distinguish user typing from code-driven
    // setInput() calls (e.g. after send, command autocomplete, etc.).
    const lastCEText = useRef('');
    // ── @-mention autocomplete ─────────────────────────────────────────────────
    // atAnchorPos: index of the triggering '@' in `input` (-1 = closed)
    // atQuery:     partial text the user typed after '@' (used to filter)
    // atSymbols:   full list fetched from /varys/symbols (cached until notebook changes)
    // atFocusIdx:  keyboard-selected row index in the dropdown
    const [atAnchorPos, setAtAnchorPos] = useState(-1);
    const [atQuery, setAtQuery] = useState('');
    const [atSymbols, setAtSymbols] = useState([]);
    const [atFocusIdx, setAtFocusIdx] = useState(0);
    const atDropdownRef = useRef(null);
    // Auto-resize contenteditable div to fit content, capped at the user-configured
    // max height.  Runs whenever `input` changes and when `inputHeight` changes.
    useEffect(() => {
        const el = textareaRef.current;
        if (!el)
            return;
        if (!input) {
            el.style.height = ''; // let min-height CSS take over
        }
        else {
            el.style.height = 'auto';
            el.style.height = `${Math.min(el.scrollHeight, inputHeight)}px`;
        }
    }, [input, inputHeight]);
    // Sync the CE div's innerHTML when `input` is changed by code (not by the
    // user typing).  When the user types, lastCEText.current === input so we
    // skip the update and avoid disrupting the cursor.
    useEffect(() => {
        const el = textareaRef.current;
        if (!el)
            return;
        if (input === lastCEText.current)
            return; // user's own typing, already handled
        const newHtml = buildHighlightHtml(input, new Set(atSymbols.map(s => s.name)));
        el.innerHTML = newHtml;
        ceHtmlRef.current = newHtml;
        if (input)
            moveCECursorToEnd(el);
    }, [input]);
    const handleResizeMouseDown = (e) => {
        e.preventDefault();
        dragStateRef.current = { startY: e.clientY, startH: inputHeight };
        const onMove = (mv) => {
            if (!dragStateRef.current)
                return;
            // Dragging UP (negative delta) → increase height
            const delta = dragStateRef.current.startY - mv.clientY;
            const next = Math.min(MAX_INPUT_HEIGHT, Math.max(MIN_INPUT_HEIGHT, dragStateRef.current.startH + delta));
            setInputHeight(next);
        };
        const onUp = () => {
            dragStateRef.current = null;
            setInputHeight(h => {
                try {
                    localStorage.setItem('ds-assistant-input-height', String(h));
                }
                catch ( /* */_a) { /* */ }
                return h;
            });
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
        };
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
    };
    const CELL_MODE_TITLE = {
        chat: 'Chat — assistant responds in the chat panel only',
        agent: 'Agent — assistant decides when to write code or content directly into cells',
    };
    const [pendingOps, setPendingOps] = useState([]);
    // diffStoreRef removed — inline DiffViews now read directly from pendingOps
    // Tracks which fix indices have been applied per code-review message id
    const [appliedFixes, setAppliedFixes] = useState(new Map());
    const [progressText, setProgressText] = useState('');
    // ID of the assistant message currently being streamed — used to render a
    // typing cursor and to append step results without creating a new bubble.
    const [activeStreamId, setActiveStreamId] = useState('');
    const [editingMsgId, setEditingMsgId] = useState(null);
    const [editingText, setEditingText] = useState('');
    // Refs for the contenteditable edit-bubble (mirrors the main input CE pattern)
    const editCeRef = useRef(null);
    const editCeHtmlRef = useRef('');
    // Cancel edit when the user clicks outside the editing bubble
    useEffect(() => {
        if (!editingMsgId)
            return;
        const handler = (e) => {
            const el = document.querySelector('.ds-assistant-message-user--editing');
            if (el && !el.contains(e.target))
                setEditingMsgId(null);
        };
        document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, [editingMsgId]);
    // When editing starts: seed the contenteditable with highlighted HTML and focus it.
    // editingText is intentionally excluded from deps — we only need to initialise once
    // per activation; onInput keeps editingText in sync thereafter.
    useEffect(() => {
        if (!editingMsgId) {
            editCeHtmlRef.current = '';
            return;
        }
        const el = editCeRef.current;
        if (!el)
            return;
        const html = buildHighlightHtml(editingText);
        el.innerHTML = html;
        editCeHtmlRef.current = html;
        moveCECursorToEnd(el);
        el.focus();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [editingMsgId]);
    // ── Chat thread state ──────────────────────────────────────────────────────
    const [threads, setThreads] = useState([]);
    const [currentThreadId, setCurrentThreadId] = useState('');
    const [currentNotebookPath, setCurrentNotebookPath] = useState('');
    // Non-notebook file currently active (e.g. utils.py). Empty when a notebook
    // or no document is active. Used to auto-include the file as LLM context.
    const [currentFilePath, setCurrentFilePath] = useState('');
    const currentFilePathRef = useRef('');
    useEffect(() => { currentFilePathRef.current = currentFilePath; }, [currentFilePath]);
    // Derived: does the current thread have notebook context enabled?
    // When no notebook is active (currentNotebookPath is empty — e.g. a Python
    // file is focused) we force false so the chip switches to [+notebook].
    // Old threads without the field default to true (preserves existing behaviour).
    const notebookAware = currentNotebookPath
        ? ((_b = (_a = threads.find(t => t.id === currentThreadId)) === null || _a === void 0 ? void 0 : _a.notebookAware) !== null && _b !== void 0 ? _b : true)
        : false;
    const handleToggleNotebookAware = () => {
        setThreads(prev => prev.map(t => {
            var _a;
            return t.id === currentThreadId
                ? Object.assign(Object.assign({}, t), { notebookAware: !((_a = t.notebookAware) !== null && _a !== void 0 ? _a : true) }) : t;
        }));
    };
    // AbortController for the current streaming request — allows the user to
    // cancel mid-stream by clicking the stop button.
    const abortControllerRef = useRef(null);
    // Refs mirror the state above so that async callbacks (handleSend, auto-save)
    // always see the latest values without stale closures.
    const threadsRef = useRef([]);
    const currentThreadIdRef = useRef('');
    const currentNotebookPathRef = useRef('');
    // Tracks the operationId whose cells are currently being auto-executed so
    // handleUndo can interrupt the kernel if the user rejects mid-execution.
    const executingOpIdRef = useRef(null);
    // Holds a stable reference to loadForNotebook so the shell-focus callbacks
    // (registered once at mount) can invoke it without stale closures.
    const loadForNotebookRef = useRef(null);
    useEffect(() => { threadsRef.current = threads; }, [threads]);
    useEffect(() => { currentThreadIdRef.current = currentThreadId; }, [currentThreadId]);
    useEffect(() => { currentNotebookPathRef.current = currentNotebookPath; }, [currentNotebookPath]);
    // Restore image mode when the active notebook changes.
    useEffect(() => {
        try {
            const stored = localStorage.getItem(_imageModeKey(currentNotebookPath));
            const m = stored ? JSON.parse(stored) : null;
            imageModeRef.current = m;
            setImageModeState(m);
        }
        catch (_a) {
            imageModeRef.current = null;
            setImageModeState(null);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [currentNotebookPath]);
    // Proactively load kernel symbols when the notebook changes so that
    // @-mention context chips can resolve variable names even before the
    // user types "@".
    useEffect(() => {
        if (!currentNotebookPath)
            return;
        apiClient.fetchSymbols(currentNotebookPath, [])
            .then(syms => { if (syms.length > 0)
            setAtSymbols(syms); })
            .catch(() => { });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [currentNotebookPath]);
    // ── Thread persistence helpers ─────────────────────────────────────────────
    const _saveThread = async (threadId, threadName, msgs, 
    /** Explicit notebook path — pass this to avoid reading a stale ref when
     *  the save fires after a notebook switch. */
    explicitPath) => {
        var _a, _b;
        const nbPath = explicitPath
            || currentNotebookPathRef.current
            || currentFilePathRef.current
            || ((_a = notebookTracker.currentWidget) === null || _a === void 0 ? void 0 : _a.context.path)
            || '';
        if (!nbPath || !threadId)
            return;
        // Guard against the delete-race: if this thread was already removed from
        // threadsRef (e.g. handleDeleteThread ran concurrently), do not re-save it.
        // Without this check, void _saveThread() calls fired from handleSwitchThread
        // can complete AFTER the DELETE API call, silently re-creating the thread.
        if (!threadsRef.current.some(t => t.id === threadId))
            return;
        const saved = msgs
            .filter(m => m.role === 'user' ||
            m.role === 'assistant' ||
            m.role === 'warning' ||
            // Persist system messages that are errors or have a special subtype so
            // they survive page refreshes.  Transient info messages (e.g. "Skill
            // activated", "@var resolved") are intentionally not persisted.
            (m.role === 'system' && (m.subtype != null ||
                /^[❌⛔]|^Error:/i.test(m.content))))
            .map(m => (Object.assign(Object.assign(Object.assign(Object.assign(Object.assign(Object.assign(Object.assign({ id: m.id, role: m.role, content: m.content, timestamp: m.timestamp.toISOString() }, (m.thoughts ? { thoughts: m.thoughts } : {})), (m.operationId ? { operationId: m.operationId } : {})), (m.diffs && m.diffs.length > 0 ? { diffs: m.diffs } : {})), (m.diffResolved ? { diffResolved: m.diffResolved } : {})), (m.subtype ? { subtype: m.subtype } : {})), (m.errorProvider ? { errorProvider: m.errorProvider } : {})), (m.errorHasImages !== undefined ? { errorHasImages: m.errorHasImages } : {}))));
        const now = new Date().toISOString();
        const existing = threadsRef.current.find(t => t.id === threadId);
        const savedThread = {
            id: threadId,
            name: threadName || (existing === null || existing === void 0 ? void 0 : existing.name) || 'Thread',
            createdAt: (_b = existing === null || existing === void 0 ? void 0 : existing.createdAt) !== null && _b !== void 0 ? _b : now,
            updatedAt: now,
            messages: saved,
            tokenUsage: existing === null || existing === void 0 ? void 0 : existing.tokenUsage,
            notebookAware: existing === null || existing === void 0 ? void 0 : existing.notebookAware,
            cellMode: cellModeRef.current,
            reasoningMode: reasoningModeRef.current,
        };
        // Retry up to 3 times with back-off for transient network failures
        // (e.g. server restarting).  Each attempt is independent of React state.
        for (let attempt = 0; attempt < 3; attempt++) {
            try {
                await apiClient.saveChatThread(nbPath, savedThread);
                // Keep the in-memory cache fresh so switching back is instant.
                const cached = historyCacheRef.current.get(nbPath);
                if (cached) {
                    const updatedThreads = cached.threads.some(t => t.id === threadId)
                        ? cached.threads.map(t => t.id === threadId ? savedThread : t)
                        : [...cached.threads, savedThread];
                    _updateCache(nbPath, updatedThreads, threadId);
                }
                // Keep threadsRef (and threads state) in sync so switching back to
                // this thread restores the correct messages without a disk round-trip.
                // Without this, threadsRef retains the stale initial-load snapshot and
                // handleSwitchThread restores an empty / outdated message list.
                if (threadsRef.current.some(t => t.id === threadId)) {
                    const synced = threadsRef.current.map(t => t.id === threadId ? savedThread : t);
                    threadsRef.current = synced;
                    setThreads(synced);
                }
                return; // success
            }
            catch (err) {
                const isNetwork = err instanceof TypeError;
                if (isNetwork && attempt < 2) {
                    // 2 s, then 4 s before giving up.
                    await new Promise(r => setTimeout(r, (attempt + 1) * 2000));
                    continue;
                }
                console.warn('[DSAssistant] Could not save chat thread:', err);
                return;
            }
        }
    };
    const historyCacheRef = useRef(new Map());
    const _updateCache = (path, threads, lastThreadId) => {
        if (!path)
            return;
        const existing = historyCacheRef.current.get(path);
        historyCacheRef.current.set(path, { threads, lastThreadId, agentPanel: existing === null || existing === void 0 ? void 0 : existing.agentPanel });
        // Keep the cache bounded — evict the oldest entry when it grows past 10.
        if (historyCacheRef.current.size > 10) {
            const oldest = historyCacheRef.current.keys().next().value;
            historyCacheRef.current.delete(oldest);
        }
    };
    /** Snapshot the current agent panel state into the cache for the given path.
     *  Reads from agentPanelRef (always current) rather than React state
     *  (which would be stale inside useEffect([], []) callbacks). */
    const _saveAgentStateToCache = (path) => {
        if (!path)
            return;
        const snapshot = agentPanelRef.current; // null when panel is closed
        const entry = historyCacheRef.current.get(path);
        if (entry) {
            historyCacheRef.current.set(path, Object.assign(Object.assign({}, entry), { agentPanel: snapshot !== null && snapshot !== void 0 ? snapshot : undefined }));
        }
        // Don't create a new entry just for an empty snapshot — only update existing ones.
    };
    /** Restore state from the in-memory cache.  Returns true if a cache hit was found. */
    /** Restore the per-thread cell mode when switching to a different thread.
     *
     * Resolution order:
     *  1. threadModeMapRef (in-session explicit changes — always up-to-date)
     *  2. thread.cellMode  (persisted to disk, loaded on session start)
     *  3. 'agent'          (default)
     */
    const _restoreThreadMode = (thread) => {
        if (!thread)
            return;
        const mapped = threadModeMapRef.current.get(thread.id);
        const mode = mapped !== undefined ? mapped :
            (thread.cellMode === 'chat' ? 'chat' : 'agent');
        setCellMode(mode);
        cellModeRef.current = mode;
        // Record so subsequent reads from the map are correct even if the user
        // never explicitly toggles this thread in the current session.
        threadModeMapRef.current.set(thread.id, mode);
        try {
            localStorage.setItem('ds-assistant-cell-mode', mode);
        }
        catch ( /* ignore */_a) { /* ignore */ }
    };
    const _restoreThreadReasoning = (thread) => {
        if (!thread)
            return;
        const mapped = threadReasoningMapRef.current.get(thread.id);
        const mode = mapped !== undefined ? mapped :
            (REASONING_CYCLE.includes(thread.reasoningMode)
                ? thread.reasoningMode
                : 'cot');
        setReasoningMode(mode);
        reasoningModeRef.current = mode;
        threadReasoningMapRef.current.set(thread.id, mode);
        try {
            localStorage.setItem('ds-varys-reasoning-mode', mode);
        }
        catch ( /* ignore */_a) { /* ignore */ }
    };
    const _restoreFromCache = (path) => {
        var _a, _b, _c, _d;
        const cached = historyCacheRef.current.get(path);
        if (!cached || cached.threads.length === 0)
            return false;
        const lastId = (_c = (_a = cached.lastThreadId) !== null && _a !== void 0 ? _a : (_b = cached.threads[0]) === null || _b === void 0 ? void 0 : _b.id) !== null && _c !== void 0 ? _c : '';
        const lastThread = cached.threads.find(t => t.id === lastId);
        setThreads(cached.threads);
        threadsRef.current = cached.threads;
        setCurrentThreadId(lastId);
        currentThreadIdRef.current = lastId;
        const _restoredMsgs = lastThread && lastThread.messages.length > 0
            ? lastThread.messages.map(m => (Object.assign(Object.assign(Object.assign(Object.assign(Object.assign(Object.assign(Object.assign({ id: m.id, role: m.role, content: m.content, timestamp: new Date(m.timestamp), fromHistory: true }, (m.thoughts ? { thoughts: m.thoughts } : {})), (m.operationId ? { operationId: m.operationId } : {})), (m.diffs && m.diffs.length > 0 ? { diffs: m.diffs } : {})), (m.diffResolved ? { diffResolved: m.diffResolved } : {})), (m.subtype ? { subtype: m.subtype } : {})), (m.errorProvider ? { errorProvider: m.errorProvider } : {})), (m.errorHasImages !== undefined ? { errorHasImages: m.errorHasImages } : {}))))
            : [];
        setMessages(_restoredMsgs);
        setPendingOps(_opsFromMessages(_restoredMsgs));
        _restoreThreadMode(lastThread);
        _restoreThreadReasoning(lastThread);
        // Restore agent panel if there was one pending when we left this file.
        if ((_d = cached.agentPanel) === null || _d === void 0 ? void 0 : _d.ready) {
            setAgentResultsReady(true);
            setAgentFileChanges(cached.agentPanel.fileChanges);
            setAgentFilesRead(cached.agentPanel.filesRead);
            setAgentOperationId(cached.agentPanel.operationId);
            setAgentResolved(cached.agentPanel.resolved);
            setAgentIncomplete(cached.agentPanel.incomplete);
            setAgentTimedOut(Boolean(cached.agentPanel.timedOut));
            setAgentBashCount(cached.agentPanel.bashCount);
        }
        return true;
    };
    // Debounced auto-save: 1.5 s after the last message change.
    // Capture path + threadId at schedule time so a notebook switch that
    // happens before the timer fires doesn't corrupt the wrong file.
    const saveTimerRef = useRef(null);
    useEffect(() => {
        var _a;
        const threadId = currentThreadIdRef.current;
        const nbPath = currentNotebookPathRef.current
            || currentFilePathRef.current
            || ((_a = notebookTracker.currentWidget) === null || _a === void 0 ? void 0 : _a.context.path)
            || '';
        if (!threadId || !nbPath)
            return;
        if (!messages.some(m => m.role === 'user' || m.role === 'assistant'))
            return;
        // Snapshot values NOW, before any possible notebook switch
        const snapshotPath = nbPath;
        const snapshotTid = threadId;
        const snapshotMsgs = messages;
        if (saveTimerRef.current)
            clearTimeout(saveTimerRef.current);
        saveTimerRef.current = setTimeout(() => {
            var _a, _b;
            const tName = (_b = (_a = threadsRef.current.find(t => t.id === snapshotTid)) === null || _a === void 0 ? void 0 : _a.name) !== null && _b !== void 0 ? _b : 'Thread';
            // Pass snapshotPath explicitly so even a notebook switch between
            // scheduling and firing doesn't corrupt the wrong file.
            void _saveThread(snapshotTid, tName, snapshotMsgs, snapshotPath);
        }, 1500);
        return () => {
            if (saveTimerRef.current)
                clearTimeout(saveTimerRef.current);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [messages]);
    // ── Auto-load chat history when the active notebook changes ───────────────
    useEffect(() => {
        const loadForNotebook = async (newPath) => {
            var _a, _b, _c;
            if (!newPath)
                return;
            // Skip if the same notebook is already active (e.g. a panel focus event
            // that doesn't actually change the notebook).
            if (newPath === currentNotebookPathRef.current)
                return;
            // ── 1. Flush any pending save for the OUTGOING notebook immediately ──
            //    The debounced timer may not have fired yet. Capture its path and
            //    messages before we switch.
            if (saveTimerRef.current) {
                clearTimeout(saveTimerRef.current);
                saveTimerRef.current = null;
            }
            const outgoingPath = currentNotebookPathRef.current;
            const outgoingTid = currentThreadIdRef.current;
            const outgoingMsgs = messagesRef.current;
            if (outgoingPath && outgoingTid && outgoingMsgs.length > 0) {
                const tName = (_b = (_a = threadsRef.current.find(t => t.id === outgoingTid)) === null || _a === void 0 ? void 0 : _a.name) !== null && _b !== void 0 ? _b : 'Thread';
                // Pass outgoingPath explicitly — currentNotebookPathRef is about to
                // be updated to newPath, so we must not rely on the ref here.
                void _saveThread(outgoingTid, tName, outgoingMsgs, outgoingPath);
            }
            // ── 2. Switch path refs immediately so any save that arrives later
            //       from a race condition writes to the correct file ──────────────
            setCurrentNotebookPath(newPath);
            currentNotebookPathRef.current = newPath;
            // Reset reproducibility badge for the new file and reload its persisted
            // issues.  Without this the old notebook's issue count bleeds through.
            reproStore.emit([]);
            if (newPath.endsWith('.ipynb')) {
                apiClient.getReproIssues(newPath).then(result => {
                    if (result.issues.length > 0)
                        reproStore.emit(result.issues);
                }).catch(() => { });
            }
            // Always reset agent panel when switching documents.  Without this the
            // panel from a previously-viewed py file bleeds onto notebook tabs.
            setAgentResultsReady(false);
            setAgentFileChanges([]);
            setAgentFilesRead([]);
            setAgentResolved({});
            setAgentOperationId('');
            setAgentIncomplete(false);
            setAgentTimedOut(false);
            setAgentBashCount(0);
            setAgentBashWarnings([]);
            setAgentBlockedCmds([]);
            setBashWarnDismissed({});
            setBlockedCmdDismissed({});
            // ── 3. Serve from in-memory cache if available (instant, no network) ─
            if (_restoreFromCache(newPath))
                return;
            // ── 4. Cache miss — clear UI, then load from disk ────────────────────
            setMessages([]);
            setThreads([]);
            setCurrentThreadId('');
            currentThreadIdRef.current = '';
            threadsRef.current = [];
            try {
                const chatFile = await apiClient.loadChatHistory(newPath);
                // Stale-guard: another focus event may have fired while we were
                // awaiting the network response.  Drop the result if we no longer
                // own this path so we don't clobber the freshly-loaded context.
                if (currentNotebookPathRef.current !== newPath)
                    return;
                if (chatFile.threads.length > 0) {
                    const lastId = (_c = chatFile.lastThreadId) !== null && _c !== void 0 ? _c : chatFile.threads[0].id;
                    const lastThread = chatFile.threads.find(t => t.id === lastId);
                    setThreads(chatFile.threads);
                    threadsRef.current = chatFile.threads;
                    setCurrentThreadId(lastId);
                    currentThreadIdRef.current = lastId;
                    // Seed the mode maps from disk so non-active threads have correct modes.
                    chatFile.threads.forEach(t => {
                        if (t.cellMode)
                            threadModeMapRef.current.set(t.id, t.cellMode);
                        if (t.reasoningMode)
                            threadReasoningMapRef.current.set(t.id, t.reasoningMode);
                    });
                    const _diskMsgs = lastThread && lastThread.messages.length > 0
                        ? lastThread.messages.map(m => (Object.assign(Object.assign(Object.assign(Object.assign(Object.assign(Object.assign(Object.assign({ id: m.id, role: m.role, content: m.content, timestamp: new Date(m.timestamp), fromHistory: true }, (m.thoughts ? { thoughts: m.thoughts } : {})), (m.operationId ? { operationId: m.operationId } : {})), (m.diffs && m.diffs.length > 0 ? { diffs: m.diffs } : {})), (m.diffResolved ? { diffResolved: m.diffResolved } : {})), (m.subtype ? { subtype: m.subtype } : {})), (m.errorProvider ? { errorProvider: m.errorProvider } : {})), (m.errorHasImages !== undefined ? { errorHasImages: m.errorHasImages } : {}))))
                        : [];
                    setMessages(_diskMsgs);
                    setPendingOps(_opsFromMessages(_diskMsgs));
                    _restoreThreadMode(lastThread);
                    _restoreThreadReasoning(lastThread);
                    _updateCache(newPath, chatFile.threads, lastId);
                }
                else {
                    const t = makeNewThread('Main');
                    setThreads([t]);
                    threadsRef.current = [t];
                    setCurrentThreadId(t.id);
                    currentThreadIdRef.current = t.id;
                    setMessages([]);
                    _updateCache(newPath, [t], t.id);
                }
            }
            catch (err) {
                if (currentNotebookPathRef.current !== newPath)
                    return;
                console.warn('[DSAssistant] Could not load chat history:', err);
                const t = makeNewThread('Main');
                setThreads([t]);
                threadsRef.current = [t];
                setCurrentThreadId(t.id);
                currentThreadIdRef.current = t.id;
                setMessages([]);
                _updateCache(newPath, [t], t.id);
            }
        };
        loadForNotebookRef.current = loadForNotebook;
        const current = notebookTracker.currentWidget;
        if (current === null || current === void 0 ? void 0 : current.context.path)
            void loadForNotebook(current.context.path);
        const handler = (_, widget) => {
            var _a, _b, _c;
            const nbWidget = widget;
            if ((_a = nbWidget === null || nbWidget === void 0 ? void 0 : nbWidget.context) === null || _a === void 0 ? void 0 : _a.path) {
                // Another notebook came into focus — load its chat history.
                void loadForNotebook(nbWidget.context.path);
            }
            else {
                // No notebook is in focus (last one was closed, or focus left notebooks).
                // Save any pending messages for the outgoing notebook then blank the UI.
                if (saveTimerRef.current) {
                    clearTimeout(saveTimerRef.current);
                    saveTimerRef.current = null;
                }
                const outgoingPath = currentNotebookPathRef.current;
                const outgoingTid = currentThreadIdRef.current;
                const outgoingMsgs = messagesRef.current;
                if (outgoingPath && outgoingTid && outgoingMsgs.length > 0) {
                    const tName = (_c = (_b = threadsRef.current.find(t => t.id === outgoingTid)) === null || _b === void 0 ? void 0 : _b.name) !== null && _c !== void 0 ? _c : 'Thread';
                    void _saveThread(outgoingTid, tName, outgoingMsgs, outgoingPath);
                }
                reproStore.emit([]);
                setCurrentNotebookPath('');
                currentNotebookPathRef.current = '';
                setCurrentFilePath('');
                currentFilePathRef.current = '';
                setMessages([]);
                setThreads([]);
                setCurrentThreadId('');
                currentThreadIdRef.current = '';
                threadsRef.current = [];
                setAgentResultsReady(false);
                setAgentToolError(null);
            }
        };
        notebookTracker.currentChanged.connect(handler);
        return () => { notebookTracker.currentChanged.disconnect(handler); };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    // ── Load / save chat when a non-notebook file becomes active ─────────────
    // index.ts calls dispatchNonNotebookFocus(filePath) whenever a non-notebook
    // document gains focus.  We:
    //   1. Flush any pending save for the outgoing notebook or file.
    //   2. Switch the active path to the new file.
    //   3. Load that file's chat history (or create a fresh "Main" thread).
    // When the user switches back to a notebook, dispatchNotebookActivated
    // will save this file's history and reload the notebook's.
    useEffect(() => {
        setNonNotebookFocusCallback(async (filePath) => {
            var _a, _b, _c, _d, _e;
            // Same file re-activated (e.g. reloadFile → docmanager:open triggers
            // activeChanged for the same document). Don't wipe state — the agent
            // panel and chat history are still valid.
            if (filePath && filePath === currentFilePathRef.current)
                return;
            // ── 1. Flush outgoing saves ────────────────────────────────────────
            if (saveTimerRef.current) {
                clearTimeout(saveTimerRef.current);
                saveTimerRef.current = null;
            }
            const outgoingNbPath = currentNotebookPathRef.current;
            const outgoingFilePath = currentFilePathRef.current;
            const outgoingTid = currentThreadIdRef.current;
            const outgoingMsgs = messagesRef.current;
            if (outgoingNbPath && outgoingTid && outgoingMsgs.length > 0) {
                const tName = (_b = (_a = threadsRef.current.find(t => t.id === outgoingTid)) === null || _a === void 0 ? void 0 : _a.name) !== null && _b !== void 0 ? _b : 'Thread';
                void _saveThread(outgoingTid, tName, outgoingMsgs, outgoingNbPath);
            }
            // Save the previous file's chat if switching between files.
            if (outgoingFilePath && outgoingFilePath !== filePath && outgoingTid && outgoingMsgs.length > 0) {
                const tName = (_d = (_c = threadsRef.current.find(t => t.id === outgoingTid)) === null || _c === void 0 ? void 0 : _c.name) !== null && _d !== void 0 ? _d : 'Thread';
                void _saveThread(outgoingTid, tName, outgoingMsgs, outgoingFilePath);
            }
            // Snapshot agent panel so it survives the focus switch.
            if (outgoingFilePath)
                _saveAgentStateToCache(outgoingFilePath);
            if (outgoingNbPath)
                _saveAgentStateToCache(outgoingNbPath);
            // ── 2. Update path refs and clear UI ─────────────────────────────
            reproStore.emit([]);
            setCurrentNotebookPath('');
            currentNotebookPathRef.current = '';
            setCurrentFilePath(filePath);
            currentFilePathRef.current = filePath;
            setMessages([]);
            setThreads([]);
            setCurrentThreadId('');
            currentThreadIdRef.current = '';
            threadsRef.current = [];
            setAgentResultsReady(false);
            setAgentToolError(null);
            if (!filePath)
                return;
            // ── 3. Serve from in-memory cache if available (instant) ─────────────
            if (_restoreFromCache(filePath))
                return;
            // ── 4. Cache miss — load from disk ───────────────────────────────────
            try {
                const chatFile = await apiClient.loadChatHistory(filePath);
                // Stale-guard: another focus event fired while we were awaiting.
                // Drop the result so we don't overwrite a more-recent context load.
                if (currentFilePathRef.current !== filePath)
                    return;
                if (chatFile.threads.length > 0) {
                    const lastId = (_e = chatFile.lastThreadId) !== null && _e !== void 0 ? _e : chatFile.threads[0].id;
                    const lastThread = chatFile.threads.find(t => t.id === lastId);
                    setThreads(chatFile.threads);
                    threadsRef.current = chatFile.threads;
                    setCurrentThreadId(lastId);
                    currentThreadIdRef.current = lastId;
                    // Seed the mode maps from disk so non-active threads have correct modes.
                    chatFile.threads.forEach(t => {
                        if (t.cellMode)
                            threadModeMapRef.current.set(t.id, t.cellMode);
                        if (t.reasoningMode)
                            threadReasoningMapRef.current.set(t.id, t.reasoningMode);
                    });
                    const _fileMsgs = lastThread && lastThread.messages.length > 0
                        ? lastThread.messages.map(m => (Object.assign(Object.assign(Object.assign(Object.assign(Object.assign(Object.assign(Object.assign({ id: m.id, role: m.role, content: m.content, timestamp: new Date(m.timestamp), fromHistory: true }, (m.thoughts ? { thoughts: m.thoughts } : {})), (m.operationId ? { operationId: m.operationId } : {})), (m.diffs && m.diffs.length > 0 ? { diffs: m.diffs } : {})), (m.diffResolved ? { diffResolved: m.diffResolved } : {})), (m.subtype ? { subtype: m.subtype } : {})), (m.errorProvider ? { errorProvider: m.errorProvider } : {})), (m.errorHasImages !== undefined ? { errorHasImages: m.errorHasImages } : {}))))
                        : [];
                    setMessages(_fileMsgs);
                    setPendingOps(_opsFromMessages(_fileMsgs));
                    _restoreThreadMode(lastThread);
                    _restoreThreadReasoning(lastThread);
                    _updateCache(filePath, chatFile.threads, lastId);
                }
                else {
                    const t = makeNewThread('Main');
                    setThreads([t]);
                    threadsRef.current = [t];
                    setCurrentThreadId(t.id);
                    currentThreadIdRef.current = t.id;
                    setMessages([]);
                    _updateCache(filePath, [t], t.id);
                }
            }
            catch (_f) {
                if (currentFilePathRef.current !== filePath)
                    return;
                const t = makeNewThread('Main');
                setThreads([t]);
                threadsRef.current = [t];
                setCurrentThreadId(t.id);
                currentThreadIdRef.current = t.id;
                setMessages([]);
                _updateCache(filePath, [t], t.id);
            }
        });
        return () => setNonNotebookFocusCallback(null);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    // ── Restore notebook context when user switches back to a notebook tab ─────
    // notebookTracker.currentChanged does NOT fire when the user returns to a
    // notebook that was already the "current" one (e.g., after visiting a .py
    // file).  dispatchNotebookActivated is called from app.shell.activeChanged
    // in index.ts whenever a notebook tab becomes the active main-area widget,
    // giving us a reliable trigger to reload context in that case.
    useEffect(() => {
        setNotebookActivatedCallback((path) => {
            var _a, _b, _c;
            if (!path)
                return;
            // Flush and save the outgoing file's chat history before switching.
            const outgoingFilePath = currentFilePathRef.current;
            if (outgoingFilePath) {
                if (saveTimerRef.current) {
                    clearTimeout(saveTimerRef.current);
                    saveTimerRef.current = null;
                }
                const outgoingTid = currentThreadIdRef.current;
                const outgoingMsgs = messagesRef.current;
                if (outgoingTid && outgoingMsgs.length > 0) {
                    const tName = (_b = (_a = threadsRef.current.find(t => t.id === outgoingTid)) === null || _a === void 0 ? void 0 : _a.name) !== null && _b !== void 0 ? _b : 'Thread';
                    void _saveThread(outgoingTid, tName, outgoingMsgs, outgoingFilePath);
                }
                // Snapshot agent panel so it survives switching back to this file.
                _saveAgentStateToCache(outgoingFilePath);
            }
            // Also snapshot the outgoing notebook's agent state.
            const outgoingNbPath = currentNotebookPathRef.current;
            if (outgoingNbPath)
                _saveAgentStateToCache(outgoingNbPath);
            // Clear any non-notebook file context now that a notebook is active.
            setCurrentFilePath('');
            currentFilePathRef.current = '';
            void ((_c = loadForNotebookRef.current) === null || _c === void 0 ? void 0 : _c.call(loadForNotebookRef, path));
        });
        return () => setNotebookActivatedCallback(null);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    // Model switcher state
    const [chatProvider, setChatProvider] = useState('');
    const [chatModel, setChatModel] = useState('');
    const [chatZoo, setChatZoo] = useState([]);
    const [modelSwitching, setModelSwitching] = useState(false);
    // ── Advisory phrases (loaded from .jupyter-assistant/rules/advisory-phrases.md) ──
    // Initialised with the hardcoded defaults; overwritten by server response.
    const [advisoryPhrases, setAdvisoryPhrases] = useState(_ADVISORY_STARTS);
    // ── Slash-command state ────────────────────────────────────────────────────
    const [commands, setCommands] = useState([]);
    const [showCmdPopup, setShowCmdPopup] = useState(false);
    const [activeCommand, setActiveCommand] = useState(null);
    // ── Version update check ──────────────────────────────────────────────────
    const [updateVersion, setUpdateVersion] = useState(null);
    const [updateUrl, setUpdateUrl] = useState('');
    const [currentVersion, setCurrentVersion] = useState('0.8.7');
    const [showChangelog, setShowChangelog] = useState(false);
    const [changelogBody, setChangelogBody] = useState('');
    const [changelogLoading, setChangelogLoading] = useState(false);
    useEffect(() => {
        void (async () => {
            try {
                const r = await fetch('/varys/version-check');
                if (!r.ok)
                    return;
                const d = await r.json();
                setCurrentVersion(d.current || '0.8.7');
                if (d.update_available) {
                    setUpdateVersion(d.latest);
                    setUpdateUrl(d.release_url || '');
                }
            }
            catch ( /* network error — silent */_a) { /* network error — silent */ }
        })();
    }, []);
    const openChangelog = () => {
        setChangelogLoading(true);
        setShowChangelog(true);
        void fetch('/varys/changelog')
            .then(r => r.json())
            .then((d) => { setChangelogBody(d.content || ''); setChangelogLoading(false); })
            .catch(() => { setChangelogBody('_Could not load changelog._'); setChangelogLoading(false); });
    };
    // Agent session state (for /file_agent)
    const [agentBadgeVisible, setAgentBadgeVisible] = useState(false);
    const [agentFileChanges, setAgentFileChanges] = useState([]);
    const [agentFilesRead, setAgentFilesRead] = useState([]);
    const [agentIncomplete, setAgentIncomplete] = useState(false);
    const [agentTimedOut, setAgentTimedOut] = useState(false);
    const [agentBashCount, setAgentBashCount] = useState(0);
    const [agentBashWarnings, setAgentBashWarnings] = useState([]);
    const [agentBlockedCmds, setAgentBlockedCmds] = useState([]);
    const [bashWarnDismissed, setBashWarnDismissed] = useState({});
    const [blockedCmdDismissed, setBlockedCmdDismissed] = useState({});
    const [agentOperationId, setAgentOperationId] = useState('');
    const [agentResolved, setAgentResolved] = useState({});
    const [agentResultsReady, setAgentResultsReady] = useState(false);
    /** ID of the assistant message that triggered the file agent run. */
    const [agentMsgId, setAgentMsgId] = useState('');
    // Ref that always holds the latest agent panel state.  Used by focus-switch
    // callbacks (which are captured in useEffect([], []) and would otherwise read
    // stale closure values from the initial render).
    const agentPanelRef = useRef(null);
    // Keep agentPanelRef in sync with state so the stale-closure callbacks
    // (nonNotebookFocusCallback, notebookActivatedCallback) can read live values.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    useEffect(() => {
        agentPanelRef.current = agentResultsReady
            ? { ready: agentResultsReady, fileChanges: agentFileChanges, filesRead: agentFilesRead,
                operationId: agentOperationId, resolved: agentResolved,
                incomplete: agentIncomplete, bashCount: agentBashCount }
            : null;
    }, [agentResultsReady, agentFileChanges, agentFilesRead,
        agentOperationId, agentResolved, agentIncomplete, agentBashCount]);
    // agentConfigOpen removed — config panel no longer shown in the UI
    const [agentToolError, setAgentToolError] = useState(null);
    const [settingsOpenToAgent, setSettingsOpenToAgent] = useState(false);
    const [sysWarnings, setSysWarnings] = useState([]);
    const [warningsDismissed, setWarningsDismissed] = useState(false);
    // Poll GET /varys/warnings on mount and every 60 s.
    useEffect(() => {
        const fetchWarnings = async () => {
            var _a;
            try {
                const resp = await fetch('/varys/warnings', {
                    headers: { 'X-XSRFToken': getXsrfToken() },
                    credentials: 'same-origin',
                });
                if (!resp.ok)
                    return;
                const data = await resp.json();
                if ((_a = data.warnings) === null || _a === void 0 ? void 0 : _a.length) {
                    setSysWarnings(prev => [...prev, ...data.warnings]);
                    setWarningsDismissed(false);
                }
            }
            catch ( /* silent — backend may not be ready yet */_b) { /* silent — backend may not be ready yet */ }
        };
        void fetchWarnings();
        const interval = setInterval(() => void fetchWarnings(), 60000);
        return () => clearInterval(interval);
    }, []);
    const messagesEndRef = useRef(null);
    const messagesContainerRef = useRef(null);
    // Tracks each rendered .ds-thinking-body element by message id so the scroll
    // effect can pin the active one to the bottom during thought streaming.
    const thinkingBodyRefs = useRef(new Map());
    // Load slash commands on mount (and re-load after skills refresh)
    useEffect(() => {
        apiClient.getCommands().then(cmds => {
            if (cmds.length)
                setCommands(cmds);
        }).catch(() => { });
    }, [apiClient]);
    // Re-fetch commands whenever the autocomplete popup opens so newly-added
    // skills appear immediately without a manual refresh.
    useEffect(() => {
        if (!showCmdPopup)
            return;
        apiClient.getCommands().then(cmds => {
            if (cmds.length)
                setCommands(cmds);
        }).catch(() => { });
    }, [showCmdPopup]);
    // Reusable settings loader — called on mount and after settings panel closes.
    const loadModelSettings = () => {
        apiClient
            .getSettings()
            .then((data) => {
            var _a, _b, _c, _d, _e;
            const vals = {};
            for (const [k, entry] of Object.entries(data)) {
                if (!k.startsWith('_')) {
                    vals[k] = (_a = entry.value) !== null && _a !== void 0 ? _a : '';
                }
            }
            // No fallback: if DS_CHAT_PROVIDER is empty the user must configure it in settings
            const provider = ((_b = vals['DS_CHAT_PROVIDER']) !== null && _b !== void 0 ? _b : '').toUpperCase();
            const zooRaw = provider ? ((_c = vals[`${provider}_MODELS`]) !== null && _c !== void 0 ? _c : '') : '';
            const zoo = zooRaw.trim() ? parseZoo(zooRaw) : (provider ? ((_d = DEFAULT_ZOO[`${provider}_MODELS`]) !== null && _d !== void 0 ? _d : []) : []);
            const model = provider ? ((_e = vals[`${provider}_CHAT_MODEL`]) !== null && _e !== void 0 ? _e : '') : '';
            setChatProvider(provider);
            setChatModel(model);
            setChatZoo(zoo);
            // Load user-configured advisory phrases from the rules file.
            const phrases = data['_advisoryPhrases'];
            if (Array.isArray(phrases) && phrases.length > 0) {
                setAdvisoryPhrases(phrases);
            }
        })
            .catch((err) => {
            console.warn('[Varys] settings load failed:', err);
            /* switcher shows — */
        });
    };
    // Load provider info + current chat model + zoo on mount
    useEffect(() => {
        apiClient
            .healthCheck()
            .catch(() => { });
        loadModelSettings();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [apiClient]);
    // Auto-scroll to bottom whenever messages update or streaming is active.
    // Uses instant scrollTop assignment so the view stays pinned during rapid
    // 30 ms token bursts without smooth-scroll lag.
    // Also pins the active thinking-body panel so reasoning text stays readable.
    useEffect(() => {
        const el = messagesContainerRef.current;
        if (el)
            el.scrollTop = el.scrollHeight;
        if (activeStreamId) {
            const thinkEl = thinkingBodyRefs.current.get(activeStreamId);
            if (thinkEl)
                thinkEl.scrollTop = thinkEl.scrollHeight;
        }
    }, [messages, isLoading, activeStreamId]);
    /**
     * Reconstruct pendingOps from a list of loaded messages.
     * Every message with diffs stored produces a PendingOp so the pinned section
     * shows the full diff history (resolved ones collapsed, pending ones active).
     */
    const _opsFromMessages = (msgs) => msgs
        .filter(m => m.diffs && m.diffs.length > 0 && m.operationId)
        .map(m => ({
        operationId: m.operationId,
        cellIndices: [],
        steps: [],
        description: m.diffResolved
            ? (m.diffResolved === 'accepted' ? '✓ Changes accepted' : '↩ Changes undone')
            : 'Restored from history',
        diffs: m.diffs,
        resolved: m.diffResolved,
    }));
    const addMessage = (role, content, extraProps) => {
        const id = generateId();
        const extra = typeof extraProps === 'string'
            ? { displayContent: extraProps }
            : (extraProps !== null && extraProps !== void 0 ? extraProps : {});
        setMessages(prev => [
            ...prev,
            Object.assign({ id, role, content, timestamp: new Date() }, extra)
        ]);
    };
    // ── One-time 0.8.7 upgrade toast: announce the disambiguation-card removal.
    // Fires once per browser; tracked via localStorage flag.  Won't appear on
    // fresh installs that have never seen the old card either — that's fine,
    // they just see "Auto" routing as the default.
    useEffect(() => {
        try {
            const seen = localStorage.getItem('varys-answer-default-notified-v1');
            if (seen === '1')
                return;
            // Defer one tick so the message lands after the welcome bubbles render.
            const t = setTimeout(() => {
                addMessage('system', "ℹ️  **What's new:** the *Where should the answer go?* card is gone. " +
                    "Varys now picks chat for questions and notebook for commands. " +
                    "Type `/chat <prompt>` to force a chat-only answer, or change the " +
                    "default in **Settings → Context → Where to send answers**.");
                try {
                    localStorage.setItem('varys-answer-default-notified-v1', '1');
                }
                catch ( /* ignore */_a) { /* ignore */ }
            }, 100);
            return () => clearTimeout(t);
        }
        catch ( /* localStorage may be disabled — silently skip */_a) { /* localStorage may be disabled — silently skip */ }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    const addMessageWithChip = (role, content, displayContent, contextChipData) => {
        const id = generateId();
        setMessages(prev => [
            ...prev,
            { id, role, content, displayContent, contextChip: contextChipData, timestamp: new Date() }
        ]);
    };
    // -------------------------------------------------------------------------
    // External message listener — invoked by context-menu AI Actions commands
    // -------------------------------------------------------------------------
    // Use a ref so the effect closure always captures the latest version of
    // handleSend without needing to re-register the listener on every render.
    const handleSendRef = useRef(null);
    /** Mirror of messages kept in a ref so the notebook-switch handler can read
     *  the current value synchronously (React state is async). */
    const messagesRef = useRef([]);
    useEffect(() => { messagesRef.current = messages; }, [messages]);
    // ── Persist token usage immediately when it changes for the active thread ──
    // The debounced message-save fires 1.5 s after any message change, so if the
    // user refreshes before that timer fires the last token count would be lost.
    // This effect listens to `threads` (which is updated every time tokenUsage
    // accumulates) and writes the thread to disk right away so the counter
    // survives hard reloads and notebook switches.
    //
    // It is placed AFTER the messagesRef sync above so messagesRef.current is
    // already up-to-date when the save reads it (React fires effects in hook-
    // definition order within the same render cycle).
    const _savedTokenRef = useRef(undefined);
    useEffect(() => {
        var _a, _b, _c;
        const tid = currentThreadIdRef.current;
        const nbPath = currentNotebookPathRef.current;
        if (!tid || !nbPath)
            return;
        const usage = (_a = threads.find(t => t.id === tid)) === null || _a === void 0 ? void 0 : _a.tokenUsage;
        if (!usage || (usage.input === 0 && usage.output === 0))
            return;
        const prev = _savedTokenRef.current;
        if (prev && prev.input === usage.input && prev.output === usage.output)
            return;
        _savedTokenRef.current = Object.assign({}, usage);
        const tName = (_c = (_b = threadsRef.current.find(t => t.id === tid)) === null || _b === void 0 ? void 0 : _b.name) !== null && _c !== void 0 ? _c : 'Thread';
        void _saveThread(tid, tName, messagesRef.current, nbPath);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [threads]);
    /** Holds the hidden LLM context that will be prepended on the next send. */
    const contextPrefixRef = useRef('');
    /** Visible chip above the textarea showing what code context is attached. */
    const [contextChip, setContextChip] = useState(null);
    /** Whether the chip preview is expanded in the input area. */
    const [chipExpanded, setChipExpanded] = useState(false);
    /** A specific output the user selected via the output overlay (right-click). */
    const selectedOutputRef = useRef(null);
    useEffect(() => {
        setExternalMessageListener(({ text, autoSend, openTags, displayText, contextPrefix, contextChip: chip, selectedOutput }) => {
            if (openTags) {
                setShowTags(true);
                return;
            }
            // Store the hidden LLM context prefix and its visible chip representation.
            contextPrefixRef.current = contextPrefix !== null && contextPrefix !== void 0 ? contextPrefix : '';
            setContextChip(chip !== null && chip !== void 0 ? chip : null);
            setChipExpanded(false);
            selectedOutputRef.current = selectedOutput !== null && selectedOutput !== void 0 ? selectedOutput : null;
            setInput(text);
            if (autoSend && handleSendRef.current) {
                setTimeout(() => { var _a; return (_a = handleSendRef.current) === null || _a === void 0 ? void 0 : _a.call(handleSendRef, text, displayText); }, 0);
            }
        });
        return () => setExternalMessageListener(null);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    // -------------------------------------------------------------------------
    // Send handler
    // -------------------------------------------------------------------------
    const handleSend = async (overrideText, displayText, skipAdvisory = false, 
    // When re-sending an edited message the caller passes the already-truncated
    // message list so chatHistory is built from the correct prior context rather
    // than the stale `messages` closure (React state updates are async).
    priorMessages) => {
        var _a, _b, _c, _d, _e, _f, _g, _h;
        const typedText = (overrideText !== null && overrideText !== void 0 ? overrideText : input).trim();
        if (!typedText || isLoading)
            return;
        // Auto-accept any unresolved ops that don't require explicit approval —
        // the user moving on is implicit acceptance (code is already running).
        pendingOps
            .filter(o => !o.requiresApproval && !o.resolved)
            .forEach(o => handleAccept(o.operationId));
        if (!chatProvider) {
            setMessages(prev => [...prev, {
                    id: Date.now().toString(),
                    role: 'assistant',
                    content: '⚠️ No provider configured. Please open **Settings** and select a provider and model for Chat.',
                    timestamp: new Date(),
                }]);
            return;
        }
        // Grab and clear the hidden LLM context prefix + visible chip.
        const prefix = contextPrefixRef.current;
        const chip = contextChip;
        contextPrefixRef.current = '';
        setContextChip(null);
        setChipExpanded(false);
        const rawInput = prefix ? `${prefix}${typedText}` : typedText;
        // The chat bubble shows either the caller-supplied short label, or just the
        // user's typed text (without the hidden prefix).
        const bubbleDisplay = displayText !== null && displayText !== void 0 ? displayText : (prefix ? typedText : undefined);
        // ── /resize(DIM) — special pre-check ─────────────────────────────────
        // parseSlashCommand() uses [\w-]+ which doesn't capture parentheses, so
        // /resize(7800) and /resize(7800) <message> must be detected here before
        // the regular slash-command parser runs.
        //
        // Two forms:
        //   /resize(7800)            → set mode, show confirmation, stop
        //   /resize(7800) <message>  → set mode, then treat <message> as the input
        const resizeCmdMatch = rawInput.trim().match(/^\/resize\((\d+)\)([\s\S]*)$/i);
        let slashCommand;
        let message = '';
        // _effectiveInput: what the slash-command parser and task flow use.
        // Normally equals rawInput; for /resize(DIM) <rest> it becomes just <rest>.
        let _effectiveInput = rawInput;
        if (resizeCmdMatch) {
            setInput('');
            const dim = parseInt(resizeCmdMatch[1], 10);
            const rest = resizeCmdMatch[2].trim();
            if (dim < 10) {
                addMessage('system', `❌ Invalid resize dimension: must be ≥ 10 (got **${dim}**). Nothing changed.`);
                return;
            }
            setImageMode({ mode: 'resize', dim });
            if (!rest) {
                addMessage('system', `🔬 Resize mode active — figures will be downscaled to **${dim}px** max before sending.\n\n` +
                    `Re-send your message to proceed.`);
                return;
            }
            // Has a trailing message — treat it as a plain message with mode already set
            message = rest;
            _effectiveInput = rest;
            // Fall through to disambiguation / task flow below (skip command parsing)
        }
        // ── Slash-command parsing ────────────────────────────────────────────
        // If the input starts with a /command, extract it and use the remainder
        // as the actual user message sent to the LLM.
        const parsed = resizeCmdMatch ? null : parseSlashCommand(_effectiveInput);
        if (parsed) {
            // Varys File Agent commands are always recognised, regardless of whether
            // the commands list has finished loading from the backend.
            const isAgentCommand = (parsed.command === '/file_agent' ||
                parsed.command === '/file_agent_find' ||
                parsed.command === '/file_agent_save');
            if (isAgentCommand) {
                setInput('');
                setActiveCommand(null);
                setShowCmdPopup(false);
                setAgentResultsReady(false);
                setAgentToolError(null);
                // agentConfigOpen removed
                slashCommand = parsed.command;
                message = (_b = (_a = parsed.rest) === null || _a === void 0 ? void 0 : _a.trim()) !== null && _b !== void 0 ? _b : '';
                // Fall through to the main task flow below.
            }
            else {
                // Check if it is a built-in command
                const knownBuiltin = commands.find(c => c.type === 'builtin' && c.command === parsed.command);
                if (knownBuiltin) {
                    setInput('');
                    setActiveCommand(null);
                    setShowCmdPopup(false);
                    if (parsed.command === '/chat' && parsed.rest) {
                        // /chat <message>: force advisory/chat mode for this single request.
                        // The backend skips tool-use and streams a plain markdown answer.
                        slashCommand = '/chat';
                        message = parsed.rest.trim();
                        // Don't return early — fall through to the main task flow below.
                    }
                    else if (parsed.command === '/file_agent' ||
                        parsed.command === '/file_agent_find' ||
                        parsed.command === '/file_agent_save') {
                        // Varys File Agent commands — pass through to the backend task flow.
                        // message may be empty (e.g. /file_agent with no args → help response).
                        slashCommand = parsed.command;
                        message = (_d = (_c = parsed.rest) === null || _c === void 0 ? void 0 : _c.trim()) !== null && _d !== void 0 ? _d : '';
                        // Don't return early — fall through to the main task flow below.
                    }
                    else if (parsed.command === '/no_figures' && parsed.rest) {
                        // /no_figures <message>: set strip mode and send the message.
                        // This form is produced by the recovery prompt pre-fill.
                        setImageMode({ mode: 'no_figures' });
                        message = parsed.rest.trim();
                        // Fall through to task flow (no slashCommand — plain message with mode set).
                    }
                    else {
                        // All other built-ins (including no-arg /ask, /index, /rag)
                        handleBuiltinCommand(parsed.command);
                        return;
                    }
                }
                else {
                    // Check if it's a known skill command
                    const knownSkill = commands.find(c => c.type === 'skill' && c.command === parsed.command);
                    if (!knownSkill) {
                        // Unknown command — reject immediately, do not send to LLM
                        addMessage('system', `Unknown command \`${parsed.command}\`. ` +
                            `Type \`/help\` to see all available commands, or check **Settings → Skills** to import skill commands.`);
                        setInput('');
                        return;
                    }
                    slashCommand = parsed.command;
                    message = parsed.rest || _effectiveInput;
                }
            } // end else (non-agent commands)
        }
        else if (!resizeCmdMatch) {
            // Plain message (no command, no /resize pre-match already set message)
            message = _effectiveInput;
        }
        // Clear command UI state
        setActiveCommand(null);
        setShowCmdPopup(false);
        // ── Answer-destination dispatch ──────────────────────────────────────
        // Routes plain (non-slash) prompts to chat or notebook based on the
        // user's setting (Settings → Context → "Where to send answers"):
        //   - "auto"             — questions → /chat, commands → notebook agent
        //   - "always_chat"      — always /chat unless a slash command says otherwise
        //   - "always_notebook"  — always run the notebook agent flow
        //   - "ask"              — show the legacy disambiguation card (pre-0.8.7)
        //
        // Skipped entirely when:
        //   - A slash command was explicitly typed (slashCommand !== null)
        //   - The user already routed via a disambiguation card (skipAdvisory=true)
        //   - The sidebar is in Chat mode or no notebook is loaded (intent clear)
        //   - A context chip is attached (specific targeted action)
        //   - A selected output is attached
        const effectiveCellMode = (notebookAware || !!currentFilePathRef.current) ? cellMode : 'chat';
        const dispatchEligible = !skipAdvisory && !slashCommand && effectiveCellMode === 'agent' && !chip && !selectedOutputRef.current;
        if (dispatchEligible) {
            const answerDefault = readAnswerDefault();
            const advisory = looksAdvisory(typedText, advisoryPhrases);
            // Decide where to route:
            let routeTo = null;
            if (answerDefault === 'always_chat') {
                routeTo = 'chat';
            }
            else if (answerDefault === 'always_notebook') {
                routeTo = 'notebook';
            }
            else if (answerDefault === 'ask') {
                // Legacy: show the card only when the prompt looks advisory; otherwise
                // proceed with the notebook flow (matching pre-0.8.7 behavior).
                routeTo = advisory ? 'ask' : 'notebook';
            }
            else {
                // "auto" (default): infer from prompt shape.
                routeTo = advisory ? 'chat' : 'notebook';
            }
            if (routeTo === 'chat') {
                // Re-enter handleSend with the /chat prefix; skipAdvisory=true so we
                // don't recurse through this block.
                void handleSend(`/chat ${typedText}`, typedText, true);
                return;
            }
            if (routeTo === 'ask') {
                setInput('');
                const disambigId = generateId();
                setMessages(prev => [...prev, {
                        id: disambigId,
                        role: 'disambiguation',
                        content: typedText,
                        timestamp: new Date(),
                    }]);
                return;
            }
            // routeTo === 'notebook' falls through to the existing task flow below.
        }
        // Capture conversation history BEFORE adding the new user message.
        // We only include user/assistant turns (not system/warning/report/code-review),
        // and cap at the last 6 turns (3 exchanges) to limit token usage.
        const MAX_HISTORY_TURNS = 6;
        // Build a cellId-prefix → current 1-based position map so we can rewrite
        // any stale "#N [id:X]" references that appear in older history turns.
        const idPrefixToCurrentNum = new Map();
        const freshCtx = notebookReader.getFullContext();
        if (freshCtx) {
            for (const c of freshCtx.cells) {
                if (c.cellId) {
                    const prefix = c.cellId.split('-')[0];
                    idPrefixToCurrentNum.set(prefix, c.index + 1); // 1-based
                }
            }
        }
        const chatHistory = (priorMessages !== null && priorMessages !== void 0 ? priorMessages : messages)
            .filter(m => m.role === 'user' || m.role === 'assistant')
            .slice(-MAX_HISTORY_TURNS)
            .map(m => ({
            role: m.role,
            content: translateCellRefs(m.content, idPrefixToCurrentNum),
        }));
        setInput('');
        // Show the raw input in the user bubble; if a short display label was
        // provided (e.g. from a context-menu action), show that instead so the
        // chat isn't cluttered with large code blocks.
        addMessageWithChip('user', rawInput, bubbleDisplay, chip !== null && chip !== void 0 ? chip : undefined);
        setIsLoading(true);
        setProgressText('Preparing…');
        let progressTimer;
        try {
            const nbContext = notebookReader.getFullContext();
            const fileCtxPath = currentFilePathRef.current;
            if (!nbContext && !fileCtxPath) {
                addMessage('system', 'No active notebook or file. Please open a notebook or file first.');
                return;
            }
            // When a non-notebook file is active, build a minimal context that
            // carries the file path. notebookPath mirrors fileContextPath so the
            // file agent (and other backend paths that read notebookPath) know
            // which file they are working on.
            const context = nbContext !== null && nbContext !== void 0 ? nbContext : {
                cells: [],
                notebookPath: fileCtxPath,
                fileContextPath: fileCtxPath,
            };
            // ── Attach selected output (from right-click output overlay) ─────
            if (selectedOutputRef.current) {
                context.selectedOutput = selectedOutputRef.current;
                selectedOutputRef.current = null; // consume once
            }
            // ── Inject active file path when a non-notebook file is focused ───
            if (fileCtxPath) {
                context.fileContextPath = fileCtxPath;
            }
            // ── Strip notebook cells when this thread is not notebook-aware ───
            // Keep notebookPath so skills still know which notebook is open,
            // but remove cell content and dataframes to save tokens.
            if (!notebookAware) {
                context.cells = [];
                context.dataframes = [];
            }
            // ── Resolve @variable_name references in the message ─────────────
            let resolvedVariables = [];
            const varRefs = parseVariableRefs(message);
            if (varRefs.length > 0) {
                setProgressText(`Resolving ${varRefs.map(r => '@' + r).join(', ')}…`);
                resolvedVariables = await variableResolver.resolve(message);
                if (resolvedVariables.length > 0) {
                    const badges = resolvedVariables.map(v => {
                        var _a, _b, _c;
                        const s = v.summary;
                        if (s.type === 'dataframe') {
                            return `📎 @${v.expr} (${(_b = (_a = s.shape) === null || _a === void 0 ? void 0 : _a[0]) === null || _b === void 0 ? void 0 : _b.toLocaleString()}×${(_c = s.shape) === null || _c === void 0 ? void 0 : _c[1]})`;
                        }
                        if (s.type === 'error') {
                            return `⚠️ @${v.expr}: ${s.error}`;
                        }
                        const val = s.value !== undefined ? ` = ${s.value}` : '';
                        return `📎 @${v.expr}${val}`;
                    }).join('  ');
                    addMessage('system', badges);
                }
            }
            // ── /learn command: save user preference to memory ───────────────
            // Route through the task endpoint with an explicit save-to-memory
            // instruction prepended so the LLM records it in preferences.md.
            if (slashCommand === '/learn' && message.trim()) {
                // Override the message to clearly instruct the backend to persist this.
                message = `Save this preference to memory and confirm it was recorded: ${message.trim()}`;
                // fall through to the normal task flow
            }
            // ── Report generation shortcut ──────────────────────────────────
            if (slashCommand === '/report') {
                const notebookPath = context.notebookPath;
                if (!notebookPath) {
                    addMessage('system', 'Cannot generate report: no notebook path found. Please open a notebook.');
                    return;
                }
                setProgressText('Analyzing notebook and generating report…');
                try {
                    const result = await apiClient.generateReport(notebookPath);
                    const id = generateId();
                    setMessages(prev => [...prev, {
                            id,
                            role: 'report',
                            content: `Report generated successfully.`,
                            timestamp: new Date(),
                            reportMeta: {
                                filename: result.filename,
                                relativePath: result.relativePath,
                                stats: result.stats,
                                imagesCount: result.imagesCount,
                                wordCount: result.wordCount,
                            },
                        }]);
                }
                catch (err) {
                    addMessage('system', `Report generation failed: ${(_e = err === null || err === void 0 ? void 0 : err.message) !== null && _e !== void 0 ? _e : err}`);
                }
                return;
            }
            // ────────────────────────────────────────────────────────────────
            setProgressText('Sending to AI…');
            // Fallback timer: if no SSE progress event arrives within 3s, cycle
            // through messages so the UI never looks completely frozen.
            const FALLBACK_MESSAGES = currentFilePathRef.current
                ? ['Sending to AI…', 'Reading file…', 'Generating…', 'Almost there…']
                : ['Sending to AI…', 'Reading notebook…', 'Generating…', 'Almost there…'];
            let progressIdx = 0;
            progressTimer = setInterval(() => {
                progressIdx = (progressIdx + 1) % FALLBACK_MESSAGES.length;
                setProgressText(FALLBACK_MESSAGES[progressIdx]);
            }, 3000);
            // Streaming strategy:
            //  - chat/advisory: LLM streams the full text response token by token
            //  - auto/preview:  LLM streams a 1-3 sentence explanation, then calls the
            //                   tool. We render that explanation live in the chat bubble,
            //                   then append the step summary once operations are applied.
            //  - manual:        no chunk streaming (JSON response), uses progress only.
            const streamMsgId = `stream-${Date.now()}`;
            let streamStarted = false;
            jsonExtractorRef.current.reset();
            // Ensure the streaming bubble exists and the queue is running.
            const ensureStreamStarted = () => {
                if (!streamStarted) {
                    clearInterval(progressTimer);
                    setProgressText('');
                    setMessages(prev => [...prev, {
                            id: streamMsgId,
                            role: 'assistant',
                            content: '',
                            timestamp: new Date(),
                        }]);
                    startStreamQueue(streamMsgId);
                    // Start silence detector so the "Writing code" indicator appears
                    // automatically once chunk tokens stop arriving (≥300 ms gap).
                    startSilenceDetector();
                    streamStarted = true;
                }
            };
            // Helper: append text to the streaming message (or add a new one if no stream)
            const appendToStream = (suffix) => {
                if (streamStarted) {
                    setMessages(prev => prev.map(m => m.id === streamMsgId ? Object.assign(Object.assign({}, m), { content: m.content + suffix }) : m));
                }
                else {
                    addMessage('assistant', suffix);
                }
            };
            // Helper: mark the streaming message as having produced cell operations.
            // Stores diffs in the dedicated diffStore (keyed by operationId) which
            // is completely decoupled from message state and never wiped by
            // message pipeline updates.
            const markHadCellOps = (opId, opDiffs) => {
                setMessages(prev => prev.map(m => m.id === streamMsgId
                    ? Object.assign(Object.assign(Object.assign({}, m), { hadCellOps: true, operationId: opId }), (opDiffs && opDiffs.length > 0 ? { diffs: opDiffs } : {})) : m));
            };
            // If a skill command is active, show a badge in the chat so the user knows
            // which skill was activated.
            if (slashCommand) {
                const skillCmd = commands.find(c => c.command === slashCommand && c.type === 'skill');
                if (skillCmd) {
                    addMessage('system', `🔧 Skill activated: **${skillCmd.command}** — ${skillCmd.description}`);
                }
            }
            // Create a fresh abort controller for this request so the stop button
            // can cancel the fetch mid-stream without affecting future requests.
            const abortCtrl = new AbortController();
            abortControllerRef.current = abortCtrl;
            // Accumulates sequential-thinking tokens as they stream in.
            let thoughtsAccum = '';
            const response = await apiClient.executeTaskStreaming(Object.assign(Object.assign(Object.assign(Object.assign(Object.assign({ message, notebookContext: context, chatHistory, variables: resolvedVariables }, (slashCommand ? { command: slashCommand } : {})), { cellMode: (notebookAware || !!currentFilePathRef.current) ? cellMode : 'chat' }), ((() => {
                try {
                    return localStorage.getItem('ds-assistant-limit-to-focal') === '1' ? { limitToFocal: true } : {};
                }
                catch (_a) {
                    return {};
                }
            })())), (reasoningModeRef.current !== 'off' ? { reasoningMode: reasoningModeRef.current } : {})), (imageModeRef.current ? { imageMode: imageModeRef.current } : {})), 
            // onChunk — explanation text Claude emits before the tool call
            (chunk) => {
                ensureStreamStarted();
                // Reset silence clock and accumulate chars so the silence detector
                // only fires after ≥100 chars + ≥1 500 ms of actual silence.
                lastChunkTimeRef.current = Date.now();
                chunkCharsRef.current += chunk.length;
                // Skip bare "null" tokens the LLM sometimes writes instead of JSON null
                if (chunk.trim() !== 'null') {
                    pushToStreamQueue(chunk);
                }
            }, 
            // onProgress — status label while the tool-call JSON is being generated
            (text) => {
                clearInterval(progressTimer);
                setProgressText(text);
                if (slashCommand === '/file_agent' || slashCommand === '/file_agent_find' || slashCommand === '/file_agent_save')
                    setAgentBadgeVisible(true);
            }, 
            // onJsonDelta — raw partial JSON from the tool call.
            // The LLM preamble text (streamed as 'chunk' events before the tool
            // call) already provides live feedback to the user.  Pushing extracted
            // json_delta content into the bubble causes artefacts ("null", garbled
            // partial JSON) when the LLM returns empty steps.  We keep the extractor
            // running so ensureStreamStarted fires (creating the bubble), and count
            // incoming bytes so we can show a live "Writing code · N chars" indicator
            // in the bubble — eliminating the silent freeze during long code generation.
            (partial) => {
                const extractor = jsonExtractorRef.current;
                if (!extractor.headerEmitted) {
                    ensureStreamStarted();
                    extractor.headerEmitted = true;
                    // json_delta events are arriving — switch from silence detection
                    // to the more precise char-counting path.
                    stopSilenceDetector();
                    startJsonCodeCounter();
                }
                jsonCodeCharsRef.current += partial.length;
                extractor.feed(partial); // keep accumulating but discard output
            }, abortCtrl.signal, 
            // onThought — reasoning token: stream thoughts live into the bubble
            // so the user sees the LLM reasoning as it happens, not just the answer.
            (thoughtText) => {
                ensureStreamStarted();
                thoughtsAccum += thoughtText;
                setMessages(prev => prev.map(m => m.id === streamMsgId ? Object.assign(Object.assign({}, m), { thoughts: thoughtsAccum }) : m));
            });
            clearInterval(progressTimer);
            stopStreamQueue();
            stopJsonCodeCounter();
            // Strip any stray bare-"null" tokens the LLM appended to its streaming
            // preamble (e.g. writing the JSON keyword literally instead of JSON null).
            // This must run after stopStreamQueue so all queued chunks have been
            // flushed into the message before we clean it.
            if (streamStarted) {
                setMessages(prev => prev.map(m => {
                    var _a;
                    if (m.id !== streamMsgId)
                        return m;
                    const cleaned = ((_a = m.content) !== null && _a !== void 0 ? _a : '').replace(/(\s*\bnull\b)+\s*$/g, '').replace(/\s+$/, '');
                    return cleaned !== m.content ? Object.assign(Object.assign({}, m), { content: cleaned }) : m;
                }));
            }
            // Attach the reasoning trace to the message when sequential thinking was used.
            if (response.thoughts && streamMsgId) {
                setMessages(prev => prev.map(m => m.id === streamMsgId ? Object.assign(Object.assign({}, m), { thoughts: response.thoughts }) : m));
            }
            // ── Agent session results (/file_agent*) ─────────────────────────
            // Also matches when the backend auto-routed (no explicit slash command
            // typed by the user) — detected via the is_file_agent sentinel.
            const isFileAgentResponse = slashCommand === '/file_agent'
                || slashCommand === '/file_agent_find'
                || slashCommand === '/file_agent_save'
                || Boolean(response.is_file_agent);
            if (isFileAgentResponse) {
                setAgentBadgeVisible(false);
                // Tool-use-not-supported error from the selected model
                if (response.errorType === 'tool_use_not_supported' && response.agentToolErrorDetails) {
                    setAgentToolError(response.agentToolErrorDetails);
                    setAgentResultsReady(true);
                    return;
                }
                const rawResponse = response;
                const rawChanges = rawResponse.file_changes;
                const changeArray = Array.isArray(rawChanges) ? rawChanges : [];
                const indexedChanges = changeArray.map((fc, i) => (Object.assign(Object.assign({}, fc), { index: i + 1 })));
                const rawFilesRead = rawResponse.files_read;
                const rawBashOutputs = rawResponse.bash_outputs;
                const rawBlockedCmds = rawResponse.blocked_commands;
                setAgentFileChanges(indexedChanges);
                setAgentFilesRead(Array.isArray(rawFilesRead) ? rawFilesRead : []);
                setAgentIncomplete(Boolean(rawResponse.incomplete));
                setAgentTimedOut(Boolean(rawResponse.timed_out));
                setAgentBashCount(Array.isArray(rawBashOutputs) ? rawBashOutputs.length : 0);
                // Collect warn_reason strings from bash outputs
                const warnReasons = Array.isArray(rawBashOutputs)
                    ? rawBashOutputs.filter(b => b.warn_reason).map(b => b.warn_reason)
                    : [];
                setAgentBashWarnings(warnReasons);
                setBashWarnDismissed({});
                // Collect blocked commands
                setAgentBlockedCmds(Array.isArray(rawBlockedCmds) ? rawBlockedCmds : []);
                setBlockedCmdDismissed({});
                setAgentOperationId(response.operationId);
                setAgentResolved({});
                setAgentMsgId(streamMsgId); // remember which bubble owns these file cards
                setAgentResultsReady(true);
                // Changes are already written to disk as a preview — open/reload
                // each file so the user sees the actual change in the editor.
                for (const fc of indexedChanges) {
                    if (fc.change_type === 'modified' && reloadFile) {
                        reloadFile(fc.file_path); // reload: file was overwritten
                    }
                    else if (fc.change_type === 'created' && openFile) {
                        openFile(fc.file_path); // open: new file now exists
                    }
                    // deleted: file still exists (deletion is deferred to Accept)
                }
            }
            // ── Accumulate token usage for the current thread ─────────────────
            console.debug('[Varys] accumulating tokenUsage:', response.tokenUsage, 'thread:', currentThreadIdRef.current);
            if (response.tokenUsage) {
                const tid = currentThreadIdRef.current;
                if (tid) {
                    setThreads(prev => prev.map(t => {
                        var _a;
                        if (t.id !== tid)
                            return t;
                        const existing = (_a = t.tokenUsage) !== null && _a !== void 0 ? _a : { input: 0, output: 0 };
                        return Object.assign(Object.assign({}, t), { tokenUsage: {
                                input: existing.input + (response.tokenUsage.input || 0),
                                output: existing.output + (response.tokenUsage.output || 0),
                            } });
                    }));
                }
            }
            // Surface backend warnings (e.g. vision not supported)
            if (response.warnings && response.warnings.length > 0) {
                for (const w of response.warnings) {
                    addMessage('warning', w);
                }
            }
            // ── Image dimension error — render recovery prompt ────────────────
            if (response.errorType === 'image_too_large') {
                // Remove the empty streaming bubble (if any) before adding the prompt
                if (streamMsgId) {
                    setMessages(prev => prev.filter(m => m.id !== streamMsgId));
                }
                setMessages(prev => {
                    var _a;
                    return [...prev, {
                            id: generateId(),
                            role: 'system',
                            subtype: 'error_recovery',
                            content: message,
                            errorProvider: (_a = response.errorProvider) !== null && _a !== void 0 ? _a : '',
                            timestamp: new Date(),
                        }];
                });
                return;
            }
            // ── Context too long — render advisory notice ─────────────────────
            if (response.errorType === 'context_too_long') {
                if (streamMsgId) {
                    setMessages(prev => prev.filter(m => m.id !== streamMsgId));
                }
                setMessages(prev => {
                    var _a;
                    return [...prev, {
                            id: generateId(),
                            role: 'system',
                            subtype: 'context_too_long',
                            content: message,
                            errorHasImages: (_a = response.errorHasImages) !== null && _a !== void 0 ? _a : false,
                            timestamp: new Date(),
                        }];
                });
                return;
            }
            // ── Post-action feedback after resize ─────────────────────────────
            if (response.imageResizeInfo && response.imageResizeInfo.count > 0) {
                const { count, warnings: imgWarnings } = response.imageResizeInfo;
                let feedback = `🔬 **${count} figure${count !== 1 ? 's' : ''} resized** before sending. Originals in the notebook are unchanged.`;
                if (imgWarnings && imgWarnings.length > 0) {
                    feedback += '\n\n⚠️ Skipped:\n' + imgWarnings.map(w => `- ${w}`).join('\n');
                }
                addMessage('system', feedback);
            }
            // ── Composite pipeline mode ──────────────────────────────────────
            if (response.cellInsertionMode === 'composite' && response.compositePlan) {
                // Defined here to close over appendToStream, setProgressText, etc.
                const runCompositePipeline = async (compositeName, pipelineSteps) => {
                    const masterOpId = `pipeline_${Date.now()}`;
                    const allDiffs = [];
                    const allOpIds = [];
                    const displayName = compositeName.replace(/-/g, ' ');
                    appendToStream(`\n\n⚙️ **Pipeline: ${displayName}** — ${pipelineSteps.length} steps\n`);
                    for (let si = 0; si < pipelineSteps.length; si++) {
                        const step = pipelineSteps[si];
                        const stepLabel = step.skill_name.replace(/-/g, ' ');
                        appendToStream(`\n**Step ${si + 1}/${pipelineSteps.length}:** ${stepLabel}…`);
                        setProgressText(`Step ${si + 1}/${pipelineSteps.length}: ${stepLabel}…`);
                        const freshContext = notebookReader.getFullContext();
                        if (!freshContext) {
                            appendToStream(` ✗ (no active notebook)`);
                            break;
                        }
                        try {
                            const stepOpId = `${masterOpId}_s${si}`;
                            const stepResponse = await apiClient.executeTaskStreaming({
                                message: step.prompt,
                                notebookContext: freshContext,
                                operationId: stepOpId,
                                forceAutoMode: true,
                                chatHistory: [],
                            }, () => { }, txt => setProgressText(txt));
                            if (stepResponse.steps && stepResponse.steps.length > 0) {
                                const { stepIndexMap: sMap, capturedOriginals: sOrig } = await cellEditor.applyOperations(stepResponse.operationId, stepResponse.steps);
                                const stepDiffs = stepResponse.steps
                                    .map((s, originalIdx) => ({ s, originalIdx }))
                                    .filter(({ s }) => s.type === 'insert' || s.type === 'modify' || s.type === 'delete')
                                    .map(({ s, originalIdx }) => {
                                    var _a, _b, _c, _d;
                                    return ({
                                        cellIndex: (_a = sMap.get(originalIdx)) !== null && _a !== void 0 ? _a : s.cellIndex,
                                        opType: s.type,
                                        cellType: ((_b = s.cellType) !== null && _b !== void 0 ? _b : 'code'),
                                        original: (_c = sOrig.get(originalIdx)) !== null && _c !== void 0 ? _c : '',
                                        modified: s.type === 'delete' ? '' : ((_d = s.content) !== null && _d !== void 0 ? _d : ''),
                                        description: s.description,
                                    });
                                });
                                allDiffs.push(...stepDiffs);
                                allOpIds.push(stepResponse.operationId);
                                appendToStream(` ✓ (${stepResponse.steps.length} cell(s))`);
                            }
                            else {
                                appendToStream(` ✓ (no cells)`);
                            }
                        }
                        catch (err) {
                            const errMsg = err instanceof Error ? err.message : String(err);
                            appendToStream(` ✗ (${errMsg})`);
                            console.warn(`[DSAssistant] Pipeline step ${si + 1} failed:`, err);
                        }
                    }
                    setProgressText('');
                    if (allDiffs.length > 0) {
                        const uniqueIndices = allDiffs
                            .map(d => d.cellIndex)
                            .filter((v, idx, arr) => arr.indexOf(v) === idx);
                        setPendingOps(prev => [
                            ...prev,
                            {
                                operationId: masterOpId,
                                cellIndices: uniqueIndices,
                                steps: [],
                                description: `Pipeline: ${displayName} — ${allDiffs.length} change(s)`,
                                diffs: allDiffs,
                                compositeOpIds: allOpIds,
                            }
                        ]);
                        markHadCellOps(masterOpId, allDiffs);
                        appendToStream(`\n\n✅ Pipeline complete — ${allDiffs.length} cell change(s) across ${pipelineSteps.length} steps.\nReview the diff below then Accept or Undo all.`);
                    }
                    else {
                        appendToStream(`\n\n✅ Pipeline complete — no cell changes.`);
                    }
                };
                await runCompositePipeline((_f = response.compositeName) !== null && _f !== void 0 ? _f : 'pipeline', response.compositePlan);
                return;
            }
            // ── Manual mode (code-review) ────────────────────────────────────
            if (response.cellInsertionMode === 'manual') {
                const id = generateId();
                setMessages(prev => {
                    var _a, _b, _c;
                    return [...prev, {
                            id,
                            role: 'code-review',
                            content: (_b = (_a = response.chatResponse) !== null && _a !== void 0 ? _a : response.summary) !== null && _b !== void 0 ? _b : 'Code review complete.',
                            timestamp: new Date(),
                            codeReviewSteps: (_c = response.steps) !== null && _c !== void 0 ? _c : [],
                        }];
                });
                return;
            }
            // ── Chat / advisory mode ─────────────────────────────────────────
            // Use chatResponse when available; fall back to summary so the message
            // is never blank. Always REPLACE (not append) so any ✍/null streaming
            // artefacts from json_delta are wiped out.
            if (response.cellInsertionMode === 'chat') {
                const chatText = (response.chatResponse
                    || response.summary
                    || 'Done.').replace(/(\s*\bnull\b)+\s*$/g, '').trim();
                // Treat any response that carries file_changes as an agent command so
                // the streamed LLM explanation is preserved (not overwritten by the
                // empty chatResponse that the file-agent done event normally sends).
                const isAgentCmd = isFileAgentResponse
                    || (Array.isArray(response.file_changes) && response.file_changes.length > 0);
                if (streamStarted) {
                    setMessages(prev => prev.map(m => {
                        var _a;
                        if (m.id !== streamMsgId)
                            return m;
                        if (isAgentCmd) {
                            // For agent commands the backend sends chatResponse:"" — preserve
                            // the LLM explanation text that was streamed live (already null-
                            // cleaned above). Fall back to chatText only when nothing streamed.
                            const existing = ((_a = m.content) !== null && _a !== void 0 ? _a : '').trim();
                            return Object.assign(Object.assign({}, m), { content: existing || chatText });
                        }
                        return Object.assign(Object.assign({}, m), { content: chatText });
                    }));
                }
                else {
                    addMessage('assistant', chatText);
                }
                // When the user's "Chat Only" toggle prevented a skill from writing cells,
                // show a gentle advisory note so they know they can switch mode.
                if (response.skillWantedCells) {
                    addMessage('system', '⚠️ **Chat Only mode is active** — this skill would normally create notebook cells. ' +
                        'Switch to **⚡ Auto** or **📝 Document** mode (button next to ✏️) to enable cell writing.');
                }
                return;
            }
            // ── Clarification needed (no tool call) ──────────────────────────
            // Guard against the LLM writing the string "null" instead of JSON null
            const realClarification = response.clarificationNeeded &&
                response.clarificationNeeded !== 'null'
                ? response.clarificationNeeded
                : null;
            if (realClarification) {
                appendToStream(streamStarted ? `\n\n${realClarification}` : realClarification);
                return;
            }
            if (!response.steps || response.steps.length === 0) {
                // Prefer chatResponse (full LLM answer) when available; otherwise fall
                // back to summary. For streamStarted messages, keep the existing
                // streamed preamble text rather than replacing it — the only thing we
                // need to strip is any stray json_delta artefacts (already prevented
                // above by not pushing ✍ and skipping null).
                const fallback = response.chatResponse
                    || response.summary
                    || 'Done — no cell changes were required.';
                if (streamStarted) {
                    // Do nothing — the streamed preamble is already the correct content.
                    // If for some reason the content is empty, fill in the fallback.
                    setMessages(prev => prev.map(m => {
                        var _a;
                        if (m.id !== streamMsgId)
                            return m;
                        return ((_a = m.content) === null || _a === void 0 ? void 0 : _a.trim()) ? m : Object.assign(Object.assign({}, m), { content: fallback });
                    }));
                }
                else {
                    addMessage('assistant', fallback);
                }
                return;
            }
            // Guarantee the stream-message bubble exists before we call markHadCellOps.
            // For providers that emit no chunk/thought events before the done event
            // (e.g. Bedrock plan_task), streamStarted is false and streamMsgId has no
            // corresponding message, so markHadCellOps would silently drop the diffs.
            ensureStreamStarted();
            setProgressText(`Applying ${response.steps.length} operation(s)…`);
            const { stepIndexMap, capturedOriginals } = await cellEditor.applyOperations(response.operationId, response.steps);
            const affectedIndices = Array.from(stepIndexMap.values());
            const stepSummary = response.steps
                .map(s => {
                var _a;
                if (s.description)
                    return `- ${s.description}`;
                if (s.type === 'reorder')
                    return `- Reorder ${((_a = s.newOrder) !== null && _a !== void 0 ? _a : []).length} cells`;
                return `- ${s.type} cell at index ${s.cellIndex}`;
            })
                .join('\n');
            // ── Auto mode ────────────────────────────────────────────────────
            const isAutoMode = response.cellInsertionMode === 'auto' && !response.requiresApproval;
            if (isAutoMode) {
                cellEditor.acceptOperation(response.operationId);
                markHadCellOps(response.operationId); // no diffs for auto mode — cells already applied
                appendToStream(`\n\n✓ Done\n\n${stepSummary}`);
                return;
            }
            // ── Build per-cell diff data for the visual diff panel ────────────
            const diffs = response.steps
                .map((s, originalIdx) => ({ s, originalIdx }))
                .filter(({ s }) => s.type === 'insert' || s.type === 'modify' || s.type === 'delete')
                .map(({ s, originalIdx }) => {
                var _a, _b, _c, _d;
                const notebookIdx = (_a = stepIndexMap.get(originalIdx)) !== null && _a !== void 0 ? _a : s.cellIndex;
                const original = (_b = capturedOriginals.get(originalIdx)) !== null && _b !== void 0 ? _b : '';
                const modified = s.type === 'delete' ? '' : ((_c = s.content) !== null && _c !== void 0 ? _c : '');
                return {
                    cellIndex: notebookIdx,
                    opType: s.type,
                    cellType: ((_d = s.cellType) !== null && _d !== void 0 ? _d : 'code'),
                    original,
                    modified,
                    description: s.description
                };
            });
            // ── Preview mode (default) — show diff block BEFORE executing cells ──
            // The diff panel must be visible to the user before any "Running cell…"
            // progress message appears, so they can see what changed regardless of
            // how long execution takes.
            const op = {
                operationId: response.operationId,
                cellIndices: affectedIndices,
                steps: response.steps,
                description: (_g = response.summary) !== null && _g !== void 0 ? _g : `Created/modified ${response.steps.length} cell(s)`,
                diffs,
                requiresApproval: response.requiresApproval,
            };
            setPendingOps(prev => [...prev, op]);
            // Mark the chat bubble and store the diffs directly on the message so
            // they survive re-renders, thread switches, and page refreshes.
            markHadCellOps(response.operationId, diffs);
            // Whether any step actually produces an undoable diff.  run_cell-only
            // operations have no content change, so claiming "Click ↺ to revert"
            // would reference a button that doesn't render.
            const hasUndoableChange = response.steps.some(s => s.type === 'insert' || s.type === 'modify' || s.type === 'delete' || s.type === 'reorder');
            // Append the step summary now; the "applied / review" message comes
            // later — after auto-execution finishes — so the bubble doesn't claim
            // "Changes applied" while cells are still running.
            appendToStream(`\n\n${stepSummary}`);
            // For staged-change flow (requiresApproval=true), the review prompt is
            // accurate immediately because the cells are populated but not yet run.
            if (response.requiresApproval && hasUndoableChange) {
                appendToStream('\n\nCell populated — review the changes and run manually when ready.');
            }
            // Execute cells flagged for auto-run — after the diff block is already visible.
            // executingOpIdRef lets handleUndo interrupt the kernel and break this loop
            // if the user clicks Undo while a cell is still running.
            let interruptedByUndo = false;
            if (!response.requiresApproval) {
                executingOpIdRef.current = response.operationId;
                try {
                    for (let i = 0; i < response.steps.length; i++) {
                        // If the user rejected the op mid-execution, stop running further cells.
                        if (executingOpIdRef.current !== response.operationId) {
                            interruptedByUndo = true;
                            break;
                        }
                        const step = response.steps[i];
                        const shouldRun = step.type === 'run_cell' ||
                            (step.autoExecute === true && step.type !== 'delete');
                        if (shouldRun) {
                            const notebookIndex = (_h = stepIndexMap.get(i)) !== null && _h !== void 0 ? _h : step.cellIndex;
                            setProgressText(`Running cell ${notebookIndex}…`);
                            try {
                                await cellEditor.executeCell(notebookIndex);
                            }
                            catch (err) {
                                console.warn(`[DSAssistant] auto-execution of cell ${notebookIndex} failed:`, err);
                            }
                        }
                    }
                }
                finally {
                    // Clear only if we're still the active op (don't stomp a newer one).
                    if (executingOpIdRef.current === response.operationId) {
                        executingOpIdRef.current = null;
                    }
                }
            }
            // Append the "applied" message ONLY when (a) the auto-execute loop
            // completed without being interrupted by Undo, and (b) at least one
            // step actually produced an undoable change.  This skips the
            // misleading line on run_cell-only operations and avoids stating
            // "applied" before the cells finished running.
            if (!response.requiresApproval &&
                !interruptedByUndo &&
                hasUndoableChange) {
                appendToStream('\n\nChanges applied. Click ↺ to revert.');
            }
        }
        catch (error) {
            clearInterval(progressTimer);
            stopJsonCodeCounter();
            // AbortError means the user clicked "Stop" — silently discard
            if (error instanceof Error && error.name === 'AbortError') {
                stopStreamQueue();
                // leave any already-streamed text visible
            }
            else {
                const msg = error instanceof Error ? error.message : 'Unknown error occurred';
                // If the message already starts with an error indicator (⛔ / ❌ / Error:)
                // don't prefix it again to avoid "Error: ⛔ ..."
                const display = /^(⛔|❌|Error:|error:)/i.test(msg) ? msg : `❌ Error: ${msg}`;
                addMessage('system', display);
            }
        }
        finally {
            abortControllerRef.current = null;
            // Unconditionally stop the stream queue.  ensureStreamStarted() may have
            // been called inside the try block (after the earlier stopStreamQueue call)
            // to guarantee a streamMsgId message exists for markHadCellOps.  Without
            // this second stop, activeStreamId stays set and the streaming animation
            // (blue bars / typing cursor) persists indefinitely.
            stopStreamQueue();
            setIsLoading(false);
            setProgressText('');
        }
    };
    // -------------------------------------------------------------------------
    // Accept / Undo handlers
    // -------------------------------------------------------------------------
    // ── Apply an individual code-review fix ────────────────────────────────────
    const handleApplyFix = async (msgId, stepIdx, step) => {
        const fixOpId = `fix_${msgId}_${stepIdx}`;
        try {
            await cellEditor.applyOperations(fixOpId, [step]);
            cellEditor.acceptOperation(fixOpId);
            setAppliedFixes(prev => {
                var _a;
                const next = new Map(prev);
                const set = new Set((_a = next.get(msgId)) !== null && _a !== void 0 ? _a : []);
                set.add(stepIdx);
                next.set(msgId, set);
                return next;
            });
        }
        catch (err) {
            addMessage('system', `Failed to apply fix: ${err instanceof Error ? err.message : err}`);
        }
    };
    const _acceptSingleOrComposite = (op) => {
        if (op.compositeOpIds) {
            op.compositeOpIds.forEach(id => cellEditor.acceptOperation(id));
        }
        else {
            cellEditor.acceptOperation(op.operationId);
        }
    };
    const handleAccept = (operationId) => {
        var _a, _b;
        const op = pendingOps.find(o => o.operationId === operationId);
        if (op) {
            _acceptSingleOrComposite(op);
            // requiresApproval ops: cell is already populated; user runs it manually.
        }
        setPendingOps(prev => prev.map(o => o.operationId === operationId ? Object.assign(Object.assign({}, o), { resolved: 'accepted' }) : o));
        // Stamp diffResolved on the message so it persists across re-renders and refreshes.
        setMessages(prev => prev.map(m => m.operationId === operationId ? Object.assign(Object.assign({}, m), { diffResolved: 'accepted' }) : m));
        // Immediate save — don't rely on the 1.5s debounce so a hard-refresh
        // right after Accept still shows the resolved diff.
        const tid = currentThreadIdRef.current;
        const nbPath = currentNotebookPathRef.current || currentFilePathRef.current || '';
        const tName = (_b = (_a = threadsRef.current.find(t => t.id === tid)) === null || _a === void 0 ? void 0 : _a.name) !== null && _b !== void 0 ? _b : 'Thread';
        if (tid && nbPath) {
            const updatedMsgs = messagesRef.current.map(m => m.operationId === operationId ? Object.assign(Object.assign({}, m), { diffResolved: 'accepted' }) : m);
            void _saveThread(tid, tName, updatedMsgs, nbPath);
        }
    };
    const handleUndo = (operationId) => {
        var _a, _b;
        // If this op's cells are currently auto-executing, interrupt the kernel first
        // so the running cell stops before we revert the code.
        if (executingOpIdRef.current === operationId) {
            executingOpIdRef.current = null; // signals the execution loop to bail out
            void cellEditor.interruptKernel();
        }
        const op = pendingOps.find(o => o.operationId === operationId);
        if (op === null || op === void 0 ? void 0 : op.compositeOpIds) {
            // Reverse order so later steps (which may have inserted cells) are undone first
            [...op.compositeOpIds].reverse().forEach(id => cellEditor.undoOperation(id));
        }
        else {
            cellEditor.undoOperation(operationId);
        }
        setPendingOps(prev => prev.map(o => o.operationId === operationId ? Object.assign(Object.assign({}, o), { resolved: 'undone' }) : o));
        // Stamp diffResolved on the message so it persists across re-renders and refreshes.
        setMessages(prev => prev.map(m => m.operationId === operationId ? Object.assign(Object.assign({}, m), { diffResolved: 'undone' }) : m));
        // Immediate save.
        const tid = currentThreadIdRef.current;
        const nbPath = currentNotebookPathRef.current || currentFilePathRef.current || '';
        const tName = (_b = (_a = threadsRef.current.find(t => t.id === tid)) === null || _a === void 0 ? void 0 : _a.name) !== null && _b !== void 0 ? _b : 'Thread';
        if (tid && nbPath) {
            const updatedMsgs = messagesRef.current.map(m => m.operationId === operationId ? Object.assign(Object.assign({}, m), { diffResolved: 'undone' }) : m);
            void _saveThread(tid, tName, updatedMsgs, nbPath);
        }
    };
    // -------------------------------------------------------------------------
    // Model switcher handler
    // -------------------------------------------------------------------------
    // -------------------------------------------------------------------------
    const handleModelSelect = async (newModel) => {
        const prev = chatModel;
        setChatModel(newModel);
        setModelSwitching(true);
        try {
            await apiClient.saveSettings({ [`${chatProvider}_CHAT_MODEL`]: newModel });
        }
        catch (_a) {
            setChatModel(prev);
        }
        finally {
            setModelSwitching(false);
        }
    };
    // Thread management
    // -------------------------------------------------------------------------
    const handleNewThread = () => {
        var _a, _b;
        const t = makeNewThread(`Thread ${threads.length + 1}`);
        // Persist the current thread before switching
        const curId = currentThreadIdRef.current;
        const curName = (_b = (_a = threadsRef.current.find(th => th.id === curId)) === null || _a === void 0 ? void 0 : _a.name) !== null && _b !== void 0 ? _b : 'Thread';
        void _saveThread(curId, curName, messagesRef.current);
        const updated = [...threadsRef.current, t];
        setThreads(updated);
        threadsRef.current = updated;
        setCurrentThreadId(t.id);
        currentThreadIdRef.current = t.id;
        stopStreamQueue();
        stopJsonCodeCounter();
        setMessages([{
                id: `welcome-${t.id}`,
                role: 'system',
                content: `✨ Thread "${t.name}" started.`,
                timestamp: new Date(),
            }]);
        setInput('');
        setProgressText('');
        setPendingOps([]);
        setAppliedFixes(new Map());
        setIsLoading(false);
        setActiveStreamId('');
    };
    const handleSwitchThread = (threadId) => {
        var _a, _b;
        if (threadId === currentThreadIdRef.current)
            return;
        // Save the current thread using the ref (always up-to-date, unlike the
        // messages state which may be one render behind in async flows).
        const curId = currentThreadIdRef.current;
        const curName = (_b = (_a = threadsRef.current.find(t => t.id === curId)) === null || _a === void 0 ? void 0 : _a.name) !== null && _b !== void 0 ? _b : 'Thread';
        void _saveThread(curId, curName, messagesRef.current);
        const thread = threadsRef.current.find(t => t.id === threadId);
        if (!thread)
            return;
        setCurrentThreadId(threadId);
        currentThreadIdRef.current = threadId;
        const restored = thread.messages.length > 0
            ? thread.messages.map(m => (Object.assign(Object.assign(Object.assign(Object.assign(Object.assign(Object.assign(Object.assign({ id: m.id, role: m.role, content: m.content, timestamp: new Date(m.timestamp), fromHistory: true }, (m.thoughts ? { thoughts: m.thoughts } : {})), (m.operationId ? { operationId: m.operationId } : {})), (m.diffs && m.diffs.length > 0 ? { diffs: m.diffs } : {})), (m.diffResolved ? { diffResolved: m.diffResolved } : {})), (m.subtype ? { subtype: m.subtype } : {})), (m.errorProvider ? { errorProvider: m.errorProvider } : {})), (m.errorHasImages !== undefined ? { errorHasImages: m.errorHasImages } : {}))))
            : [{
                    id: `welcome-${threadId}`,
                    role: 'system',
                    content: `Switched to "${thread.name}".`,
                    timestamp: new Date(),
                }];
        stopStreamQueue();
        stopJsonCodeCounter();
        setMessages(restored);
        setPendingOps(_opsFromMessages(restored));
        _restoreThreadMode(thread);
        _restoreThreadReasoning(thread);
        setAppliedFixes(new Map());
        setProgressText('');
        setActiveStreamId('');
    };
    const handleRenameThread = async (threadId, newName) => {
        var _a, _b;
        const updated = threadsRef.current.map(t => t.id === threadId ? Object.assign(Object.assign({}, t), { name: newName }) : t);
        setThreads(updated);
        threadsRef.current = updated;
        // Save with new name — use live messages for the current thread
        const msgs = threadId === currentThreadIdRef.current
            ? messages
            : ((_b = (_a = updated.find(t => t.id === threadId)) === null || _a === void 0 ? void 0 : _a.messages) !== null && _b !== void 0 ? _b : []).map(m => ({
                id: m.id,
                role: m.role,
                content: m.content,
                timestamp: new Date(m.timestamp),
            }));
        void _saveThread(threadId, newName, msgs);
    };
    const handleDuplicateThread = (threadId) => {
        var _a, _b;
        const src = threadsRef.current.find(t => t.id === threadId);
        if (!src)
            return;
        const copy = makeNewThread(`${src.name} (copy)`);
        copy.messages = src.messages.slice();
        copy.notebookAware = src.notebookAware;
        const updated = [...threadsRef.current, copy];
        setThreads(updated);
        threadsRef.current = updated;
        // Switch to the new duplicate
        const curId = currentThreadIdRef.current;
        const curName = (_b = (_a = threadsRef.current.find(t => t.id === curId)) === null || _a === void 0 ? void 0 : _a.name) !== null && _b !== void 0 ? _b : 'Thread';
        void _saveThread(curId, curName, messagesRef.current);
        setCurrentThreadId(copy.id);
        currentThreadIdRef.current = copy.id;
        stopStreamQueue();
        stopJsonCodeCounter();
        const restored = copy.messages.length > 0
            ? copy.messages.map(m => (Object.assign(Object.assign(Object.assign(Object.assign(Object.assign(Object.assign(Object.assign({ id: m.id, role: m.role, content: m.content, timestamp: new Date(m.timestamp), fromHistory: true }, (m.thoughts ? { thoughts: m.thoughts } : {})), (m.operationId ? { operationId: m.operationId } : {})), (m.diffs && m.diffs.length > 0 ? { diffs: m.diffs } : {})), (m.diffResolved ? { diffResolved: m.diffResolved } : {})), (m.subtype ? { subtype: m.subtype } : {})), (m.errorProvider ? { errorProvider: m.errorProvider } : {})), (m.errorHasImages !== undefined ? { errorHasImages: m.errorHasImages } : {}))))
            : [{
                    id: `welcome-${copy.id}`,
                    role: 'system',
                    content: `✨ Duplicated from "${src.name}".`,
                    timestamp: new Date(),
                }];
        setMessages(restored);
        setPendingOps(_opsFromMessages(restored));
        setAppliedFixes(new Map());
        setProgressText('');
        setActiveStreamId('');
    };
    const handleDeleteThread = async (threadId) => {
        var _a;
        if (threadsRef.current.length <= 1)
            return;
        const updated = threadsRef.current.filter(t => t.id !== threadId);
        setThreads(updated);
        threadsRef.current = updated;
        if (threadId === currentThreadIdRef.current) {
            handleSwitchThread(updated[0].id);
        }
        const nbPath = currentNotebookPathRef.current
            || ((_a = notebookTracker.currentWidget) === null || _a === void 0 ? void 0 : _a.context.path)
            || '';
        if (nbPath) {
            try {
                await apiClient.deleteChatThread(nbPath, threadId);
            }
            catch (err) {
                console.warn('[DSAssistant] Could not delete thread:', err);
            }
        }
    };
    // -------------------------------------------------------------------------
    // Built-in slash command handler
    // -------------------------------------------------------------------------
    const handleBuiltinCommand = (cmd) => {
        switch (cmd) {
            case '/clear':
                handleNewThread();
                break;
            case '/help': {
                const builtins = commands.filter(c => c.type === 'builtin');
                const skills = commands.filter(c => c.type === 'skill');
                const rows = (arr) => arr.map(c => `  **${c.command}** — ${c.description}`).join('\n');
                const helpText = '### Varys Commands\n\n' +
                    '**Built-in**\n' + rows(builtins) + '\n\n' +
                    (skills.length ? '**Skills**\n' + rows(skills) : '_(No skills installed)_');
                addMessage('assistant', helpText);
                break;
            }
            case '/skills': {
                const skill_cmds = commands.filter(c => c.type === 'skill');
                if (!skill_cmds.length) {
                    addMessage('system', 'No skill commands installed. Add skills in Settings → Skills.');
                }
                else {
                    const list = skill_cmds
                        .map(c => `  **${c.command}** — ${c.description}`)
                        .join('\n');
                    addMessage('assistant', '### Available skill commands\n\n' + list);
                }
                break;
            }
            case '/chat':
                // With no args: show usage. With args, handleSend routes to chat flow.
                addMessage('system', '### 💬 Chat-only mode\n\n' +
                    'Type `/chat <your request>` to get a response **in the chat window only** — no notebook cells will be created or modified, regardless of any skill defaults.\n\n' +
                    '**Example:** `/chat Compute the delta diff for this table: …`');
                break;
            case '/learn':
                // /learn is handled in handleSend when the full message is available
                addMessage('system', 'Type `/learn <your preference>` and press Enter to save it to memory.');
                break;
            case '/no_figures':
                setImageMode({ mode: 'no_figures' });
                addMessage('system', '🚫 **No-figures mode active** — all notebook plots will be excluded from messages sent to the LLM.\n\n' +
                    'Re-send your message to proceed. Type `/resize(DIM)` to switch to resize mode, or type `/no_figures` again to clear.');
                break;
            case '/resize':
                // /resize without parentheses — show usage hint
                addMessage('system', '### 🔬 Resize mode\n\n' +
                    'Use `/resize(DIM)` where DIM is the maximum pixel dimension (positive integer ≥ 10).\n\n' +
                    '**Examples:** `/resize(7800)` (Anthropic limit) · `/resize(6000)` (OpenAI limit)');
                break;
            case '/file_agent':
            case '/file_agent_find':
            case '/file_agent_save':
                // Agent commands need a task argument — show usage hint
                addMessage('system', `### Varys File Agent\n\n` +
                    `Type \`${cmd} <your task>\` to let the agent read and edit files in your project.\n\n` +
                    `**Examples:**\n` +
                    `- \`/file_agent refactor utils.py to use dataclasses\`\n` +
                    `- \`/file_agent_find where is the database connection configured?\`\n` +
                    `- \`/file_agent_save export the clean_data function to src/preprocessing.py\``);
                break;
            default:
                addMessage('system', `Unknown command: ${cmd}`);
        }
    };
    // -------------------------------------------------------------------------
    // RAG-specific handlers
    // -------------------------------------------------------------------------
    // Keep the ref pointing at the latest handleSend so the external-message
    // listener can invoke it without capturing a stale closure.
    useEffect(() => { handleSendRef.current = handleSend; });
    // Stop the current streaming request when the user clicks the stop button.
    const handleStop = () => {
        if (abortControllerRef.current) {
            abortControllerRef.current.abort();
        }
    };
    // -------------------------------------------------------------------------
    // Keyboard handler - Enter to send, Shift+Enter for newline
    // -------------------------------------------------------------------------
    // Insert the selected @-mention suggestion into the textarea.
    const insertAtSuggestion = (name) => {
        // Replace '@<partial>' at atAnchorPos with '@<full_name> '
        const before = input.slice(0, atAnchorPos);
        const after = input.slice(atAnchorPos + 1 + atQuery.length);
        const newVal = `${before}@${name} ${after}`;
        setInput(newVal);
        setAtAnchorPos(-1);
        // Move cursor to just after the inserted name
        setTimeout(() => {
            const el = textareaRef.current;
            if (!el)
                return;
            const pos = atAnchorPos + 1 + name.length + 1; // +1 for trailing space
            setCursorCharOffset(el, pos);
            el.focus();
        }, 0);
    };
    const atFiltered = atAnchorPos >= 0
        ? atSymbols.filter(s => s.name.toLowerCase().startsWith(atQuery.toLowerCase())).slice(0, 8)
        : [];
    const handleKeyDown = (e) => {
        var _a, _b;
        // When the @-mention dropdown is open, intercept navigation keys
        if (atAnchorPos >= 0 && atFiltered.length > 0) {
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                setAtFocusIdx(i => Math.min(i + 1, atFiltered.length - 1));
                return;
            }
            if (e.key === 'ArrowUp') {
                e.preventDefault();
                setAtFocusIdx(i => Math.max(i - 1, 0));
                return;
            }
            if (e.key === 'Enter' || e.key === 'Tab') {
                e.preventDefault();
                insertAtSuggestion((_b = (_a = atFiltered[atFocusIdx]) === null || _a === void 0 ? void 0 : _a.name) !== null && _b !== void 0 ? _b : atFiltered[0].name);
                return;
            }
            if (e.key === 'Escape') {
                setAtAnchorPos(-1);
                return;
            }
        }
        // Ctrl+Enter / Cmd+Enter → send immediately (explicit, before general check).
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            void handleSend();
            return;
        }
        if (e.key === 'Enter' && e.shiftKey) {
            // Insert a <br> directly at the cursor via the Selection API.
            // This avoids the "read offset → rebuild innerHTML → reposition" cycle
            // that was error-prone when existing <br>s caused off-by-N miscounts.
            e.preventDefault();
            const el = textareaRef.current;
            if (!el)
                return;
            const sel2 = window.getSelection();
            if (!sel2 || sel2.rangeCount === 0)
                return;
            const rng = sel2.getRangeAt(0);
            rng.deleteContents(); // collapse any selection first
            // Insert the <br> at the cursor — no innerHTML rebuild needed.
            const br = document.createElement('br');
            rng.insertNode(br);
            // DOM spec: insertNode calls splitText(offset) on text nodes, which
            // creates an empty Text("") sibling when the cursor is at the very end
            // of a text node.  Remove it so the spacer check below works correctly.
            const sib = br.nextSibling;
            if (sib && sib.nodeType === Node.TEXT_NODE && sib.textContent === '') {
                sib.parentNode.removeChild(sib);
            }
            // A lone trailing <br> is invisible: the cursor has no line to rest on.
            // Add a second one as a visual spacer when we're at the very end.
            if (!br.nextSibling) {
                const spacer = document.createElement('br');
                br.after(spacer);
            }
            // Move cursor to right after the newly inserted <br>.
            const after = document.createRange();
            after.setStartAfter(br);
            after.collapse(true);
            sel2.removeAllRanges();
            sel2.addRange(after);
            // Sync React state.  innerText gives \n per <br>; strip only the LAST
            // \n (the spacer) when we added one — the user's real newline is kept.
            const raw = el.innerText;
            const newInput = raw.endsWith('\n\n')
                ? raw.slice(0, -1) // strip spacer's \n, keep user's \n
                : raw.replace(/\n$/, ''); // strip single phantom trailing \n
            ceHtmlRef.current = el.innerHTML;
            lastCEText.current = newInput;
            setInput(newInput);
            return;
        }
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            void handleSend();
        }
    };
    // -------------------------------------------------------------------------
    // Render
    // -------------------------------------------------------------------------
    if (showSettings || settingsOpenToAgent) {
        return (React.createElement("div", { className: `ds-assistant-sidebar ds-chat-${chatTheme}` },
            React.createElement("div", { className: "ds-assistant-header" },
                React.createElement("span", { className: "ds-assistant-title" },
                    React.createElement("span", { className: "ds-varys-spider" }, "\uD83D\uDD77\uFE0F"),
                    " Varys \u2014 Settings"),
                React.createElement("button", { className: "ds-settings-close-btn", onClick: () => { setShowSettings(false); setSettingsOpenToAgent(false); }, title: "Back to chat" }, "\u2715")),
            React.createElement(SettingsPanel, { apiClient: apiClient, onClose: () => { setShowSettings(false); setSettingsOpenToAgent(false); loadModelSettings(); }, onSaved: loadModelSettings, notebookPath: currentNotebookPath, initialTab: settingsOpenToAgent ? 'agent' : undefined })));
    }
    if (showRepro) {
        return (React.createElement("div", { className: `ds-assistant-sidebar ds-chat-${chatTheme}` },
            React.createElement("div", { className: "ds-assistant-header" },
                React.createElement("span", { className: "ds-assistant-title" },
                    React.createElement("span", { className: "ds-varys-spider" }, "\uD83D\uDD77\uFE0F"),
                    " Varys \u2014 Reproducibility"),
                React.createElement("button", { className: "ds-settings-close-btn", onClick: () => setShowRepro(false), title: "Back to chat" }, "\u2715")),
            React.createElement(ReproPanel, { apiClient: apiClient, cellEditor: cellEditor, notebookReader: notebookReader })));
    }
    if (showTags) {
        return (React.createElement("div", { className: `ds-assistant-sidebar ds-chat-${chatTheme}` },
            React.createElement("div", { className: "ds-assistant-header" },
                React.createElement("span", { className: "ds-assistant-title" },
                    React.createElement("span", { className: "ds-varys-spider" }, "\uD83D\uDD77\uFE0F"),
                    " Varys \u2014 Tags"),
                React.createElement("button", { className: "ds-settings-close-btn", onClick: () => setShowTags(false), title: "Back to chat" }, "\u2715")),
            React.createElement(TagsPanel, { notebookTracker: notebookTracker })));
    }
    if (showChangelog) {
        return (React.createElement("div", { className: `ds-assistant-sidebar ds-chat-${chatTheme}` },
            React.createElement("div", { className: "ds-assistant-header" },
                React.createElement("span", { className: "ds-assistant-title" },
                    React.createElement("span", { className: "ds-varys-spider" }, "\uD83D\uDD77\uFE0F"),
                    ' ',
                    "Changelog"),
                React.createElement("button", { className: "ds-settings-close-btn", onClick: () => setShowChangelog(false), title: "Back to chat" }, "\u2715")),
            React.createElement("div", { className: "ds-changelog-panel" },
                React.createElement("div", { className: "ds-changelog-version-bar" },
                    React.createElement("span", { className: "ds-changelog-version-current" },
                        "Installed: v",
                        currentVersion),
                    updateVersion && (React.createElement("span", { className: "ds-changelog-version-latest" },
                        "Latest: v",
                        updateVersion))),
                updateVersion && (React.createElement("div", { className: "ds-changelog-footer" },
                    updateUrl && (React.createElement("a", { href: updateUrl, target: "_blank", rel: "noreferrer", className: "ds-changelog-github-link" }, "View release on GitHub \u2197")),
                    React.createElement("div", { className: "ds-changelog-update-cmd" },
                        React.createElement("code", null, "pip install --force-reinstall git+https://github.com/brightappsllc/varys-ai.git@main")))),
                React.createElement("div", { className: "ds-changelog-body" }, changelogLoading ? (React.createElement("div", { className: "ds-changelog-loading" }, "Loading\u2026")) : changelogBody ? (React.createElement("div", { className: "ds-changelog-content ds-message-content", dangerouslySetInnerHTML: { __html: renderMarkdown(changelogBody) } })) : (React.createElement("div", { className: "ds-changelog-empty" }, "Changelog not available."))))));
    }
    return (React.createElement("div", { className: `ds-assistant-sidebar ds-chat-${chatTheme}` },
        React.createElement("div", { className: "ds-assistant-header" },
            React.createElement("span", { className: "ds-assistant-title" },
                React.createElement("span", { className: "ds-varys-spider" }, "\uD83D\uDD77\uFE0F"),
                ' ',
                "Varys",
                ' ',
                React.createElement("span", { className: "ds-varys-version ds-varys-version--clickable", onClick: openChangelog, title: "View changelog" }, "v0.8.7"),
                updateVersion && (React.createElement("button", { className: "ds-varys-update-pill", onClick: openChangelog, title: `v${updateVersion} is available — click to see what's new` },
                    "\u2191 v",
                    updateVersion))),
            React.createElement("button", { className: "ds-tags-panel-btn", onClick: () => setShowTags(true), "data-tip": "Cell Tags & Metadata", "data-tip-below": true }, "\uD83C\uDFF7\uFE0F"),
            React.createElement("button", { className: "ds-theme-toggle-btn", onClick: toggleChatTheme, "data-tip": chatTheme === 'day' ? 'Switch to night mode' : 'Switch to day mode', "data-tip-below": true, "aria-label": chatTheme === 'day' ? 'Switch to night mode' : 'Switch to day mode' }, chatTheme === 'day' ? '🌙' : '☀️'),
            sysWarnings.length > 0 && !warningsDismissed && (React.createElement("button", { className: "ds-warning-icon-btn", onClick: () => setWarningsDismissed(true), "data-tip": sysWarnings[sysWarnings.length - 1].message, "data-tip-below": true, "aria-label": "Dismiss warning" },
                React.createElement("span", { className: "ds-warning-icon" }, "\u26A0"),
                sysWarnings.length > 1 && (React.createElement("span", { className: "ds-warning-badge" }, sysWarnings.length)))),
            React.createElement("button", { className: "ds-wiki-help-btn", onClick: () => window.open('https://github.com/brightappsllc/varys-ai', '_blank'), "data-tip": "Open documentation", "data-tip-below": true }, "?"),
            React.createElement("button", { className: "ds-settings-gear-btn", onClick: () => setShowSettings(true), "data-tip": "Settings", "data-tip-below": true }, "\u2699\uFE0F")),
        React.createElement(ThreadBar, { threads: threads, currentId: currentThreadId, notebookName: currentNotebookPath
                ? (_d = (_c = currentNotebookPath.split('/').pop()) === null || _c === void 0 ? void 0 : _c.replace(/\.ipynb$/, '')) !== null && _d !== void 0 ? _d : ''
                : '', onSwitch: handleSwitchThread, onNew: handleNewThread, onRename: (id, name) => void handleRenameThread(id, name), onDuplicate: handleDuplicateThread, onDelete: (id) => void handleDeleteThread(id), rightSlot: currentNotebookPath.endsWith('.ipynb') ? (React.createElement("span", { className: "ds-thread-bar-icons" },
                React.createElement("span", { className: "ds-repro-shield-wrap" },
                    React.createElement("button", { className: "ds-repro-shield-btn", onClick: () => setShowRepro(true), "data-tip": "Reproducibility Guardian", "data-tip-below": true }, "\uD83D\uDEE1\uFE0F"),
                    (() => {
                        const hasCritical = reproIssues.some(i => i.severity === 'critical');
                        const hasWarning = reproIssues.some(i => i.severity === 'warning');
                        const hasInfo = reproIssues.some(i => i.severity === 'info');
                        const color = hasCritical ? '#e53935'
                            : hasWarning ? '#F97316'
                                : hasInfo ? '#3B82F6'
                                    : null;
                        if (!color)
                            return null;
                        return (React.createElement("span", { className: "ds-repro-dot", style: { background: color }, "aria-label": `${reproIssues.length} reproducibility issue${reproIssues.length === 1 ? '' : 's'}` }));
                    })()),
                React.createElement("button", { className: "ds-graph-open-btn", onClick: () => { var _a; return (_a = props.onOpenGraph) === null || _a === void 0 ? void 0 : _a.call(props); }, title: "Notebook dependency graph", "data-tip": "Dependency Graph", "data-tip-below": true },
                    React.createElement("svg", { width: "13", height: "13", viewBox: "0 0 13 13", fill: "none", "aria-hidden": "true" },
                        React.createElement("circle", { cx: "6.5", cy: "2", r: "1.7", fill: "currentColor" }),
                        React.createElement("circle", { cx: "2.2", cy: "10.5", r: "1.7", fill: "currentColor" }),
                        React.createElement("circle", { cx: "10.8", cy: "10.5", r: "1.7", fill: "currentColor" }),
                        React.createElement("line", { x1: "5.7", y1: "3.6", x2: "3.0", y2: "8.8", stroke: "currentColor", strokeWidth: "1.3", strokeLinecap: "round" }),
                        React.createElement("line", { x1: "7.3", y1: "3.6", x2: "10.0", y2: "8.8", stroke: "currentColor", strokeWidth: "1.3", strokeLinecap: "round" }))))) : undefined }),
        React.createElement("div", { ref: messagesContainerRef, className: "ds-assistant-messages", onClick: (e) => {
                var _a, _b, _c;
                const btn = e.target.closest('.ds-copy-code-btn');
                if (!btn)
                    return;
                const code = (_c = (_b = (_a = btn.closest('.ds-code-block-wrapper')) === null || _a === void 0 ? void 0 : _a.querySelector('code')) === null || _b === void 0 ? void 0 : _b.textContent) !== null && _c !== void 0 ? _c : '';
                void navigator.clipboard.writeText(code).then(() => {
                    btn.textContent = '✓ Copied';
                    setTimeout(() => { btn.textContent = 'Copy'; }, 2000);
                });
            } },
            messages.map(msg => {
                var _a, _b, _c;
                return (React.createElement(React.Fragment, { key: msg.id },
                    React.createElement("div", { className: [
                            'ds-assistant-message',
                            `ds-assistant-message-${msg.role}`,
                            msg.role === 'user' && msg.id === editingMsgId ? 'ds-assistant-message-user--editing' : '',
                        ].filter(Boolean).join(' ') },
                        msg.subtype === 'error_recovery' ? (
                        /* ── Image dimension error — recovery prompt ─────── */
                        React.createElement(ImageRecoveryPrompt, { originalMessage: msg.content, provider: (_a = msg.errorProvider) !== null && _a !== void 0 ? _a : '', onFill: (cmd, originalMsg) => {
                                // Apply image mode immediately (reliable — does not depend on
                                // the user pressing Enter on a pre-filled textarea).
                                const resizeMatch = cmd.match(/^\/resize\((\d+)\)$/);
                                if (resizeMatch) {
                                    setImageMode({ mode: 'resize', dim: parseInt(resizeMatch[1], 10) });
                                }
                                else if (cmd === '/no_figures') {
                                    setImageMode({ mode: 'no_figures' });
                                }
                                // Pre-fill textarea with just the original message so the
                                // user only has to press Enter to re-send with the new mode.
                                setInput(originalMsg);
                                requestAnimationFrame(() => {
                                    if (textareaRef.current) {
                                        textareaRef.current.focus();
                                    }
                                });
                            } })) : msg.subtype === 'context_too_long' ? (
                        /* ── Context too long — advisory notice ─────────── */
                        React.createElement("div", { className: "ds-ctx-too-long" },
                            React.createElement("span", { className: "ds-ctx-too-long-icon" }, "\u26A0\uFE0F"),
                            React.createElement("div", { className: "ds-ctx-too-long-body" },
                                React.createElement("p", { className: "ds-ctx-too-long-title" }, "Context too large"),
                                React.createElement("p", { className: "ds-ctx-too-long-desc" },
                                    "Your prompt exceeded the model's token limit.",
                                    msg.errorHasImages
                                        ? ' The context includes figures — try '
                                        : ' This is caused by text (chat history, code, outputs), not by images. Try '),
                                msg.errorHasImages && (React.createElement("div", { className: "ds-ctx-too-long-actions" },
                                    React.createElement("button", { className: "ds-ctx-too-long-btn", onClick: () => {
                                            setImageMode({ mode: 'no_figures' });
                                            setInput(msg.content);
                                            requestAnimationFrame(() => { var _a; return (_a = textareaRef.current) === null || _a === void 0 ? void 0 : _a.focus(); });
                                        } }, "/no_figures"),
                                    React.createElement("span", { className: "ds-ctx-too-long-or" }, "or clear the chat history below."))),
                                !msg.errorHasImages && (React.createElement("span", { className: "ds-ctx-too-long-hint" }, "clearing the chat history (trash icon) or asking about fewer cells."))))) : msg.role === 'disambiguation' ? (
                        /* ── Disambiguation card ───────────────────────────── */
                        React.createElement(DisambiguationCard, { originalMessage: msg.content, msgId: msg.id, onChoice: (mode, id) => {
                                // Remove the disambiguation message
                                setMessages(prev => prev.filter(m => m.id !== id));
                                if (mode === 'chat') {
                                    // Re-send with /chat prefix so the backend uses advisory mode
                                    void handleSend(`/chat ${msg.content}`, msg.content, true);
                                }
                                else {
                                    // Re-send plain — skip the advisory check this time
                                    void handleSend(msg.content, undefined, true);
                                }
                            } })) : msg.role === 'report' && msg.reportMeta ? (React.createElement("div", { className: "ds-report-card" },
                            React.createElement("div", { className: "ds-report-card-header" },
                                React.createElement("span", { className: "ds-report-card-icon" }, "\uD83D\uDCC4"),
                                React.createElement("span", { className: "ds-report-card-title" }, "Report ready")),
                            React.createElement("div", { className: "ds-report-card-filename" }, msg.reportMeta.filename),
                            React.createElement("div", { className: "ds-report-card-stats" },
                                React.createElement("span", null,
                                    msg.reportMeta.wordCount.toLocaleString(),
                                    " words"),
                                React.createElement("span", null, "\u00B7"),
                                React.createElement("span", null,
                                    msg.reportMeta.imagesCount,
                                    " image",
                                    msg.reportMeta.imagesCount !== 1 ? 's' : ''),
                                React.createElement("span", null, "\u00B7"),
                                React.createElement("span", null,
                                    msg.reportMeta.stats.total,
                                    " cells")),
                            React.createElement("a", { className: "ds-report-card-download", href: `${window.location.origin}/files/${msg.reportMeta.relativePath}`, target: "_blank", rel: "noreferrer", download: msg.reportMeta.filename }, "\uD83D\uDCE5 Download report"))) : msg.role === 'code-review' ? (
                        /* ── Code-review message ──────────────────────────────────── */
                        React.createElement("div", { className: `ds-code-review-message ds-msg-collapsible-wrap${collapsedMsgs.has(msg.id) ? ' ds-msg-collapsed' : ''}` },
                            collapsedMsgs.has(msg.id) && React.createElement("div", { className: "ds-msg-fade", "aria-hidden": "true" }),
                            React.createElement("div", { className: "ds-assistant-message-content ds-markdown", dangerouslySetInnerHTML: { __html: renderMarkdown(msg.content) } }),
                            msg.codeReviewSteps && msg.codeReviewSteps.length > 0 && (React.createElement("div", { className: "ds-fix-panel" },
                                React.createElement("div", { className: "ds-fix-panel-header" },
                                    "\uD83D\uDD27 Available Fixes (",
                                    msg.codeReviewSteps.length,
                                    ")"),
                                msg.codeReviewSteps.map((step, i) => {
                                    var _a, _b, _c;
                                    const applied = (_b = (_a = appliedFixes.get(msg.id)) === null || _a === void 0 ? void 0 : _a.has(i)) !== null && _b !== void 0 ? _b : false;
                                    return (React.createElement("div", { key: i, className: `ds-fix-card${applied ? ' ds-fix-card--applied' : ''}` },
                                        React.createElement("div", { className: "ds-fix-card-desc" }, (_c = step.description) !== null && _c !== void 0 ? _c : `Fix for cell ${step.cellIndex}`),
                                        React.createElement("details", { className: "ds-fix-card-toggle" },
                                            React.createElement("summary", null, "View code"),
                                            React.createElement("pre", { className: "ds-fix-card-code" }, step.content)),
                                        React.createElement("button", { className: "ds-fix-card-btn", disabled: applied, onClick: () => handleApplyFix(msg.id, i, step) }, applied ? '✓ Applied' : 'Apply Fix')));
                                }))),
                            ((_c = (_b = msg.content) === null || _b === void 0 ? void 0 : _b.length) !== null && _c !== void 0 ? _c : 0) >= COLLAPSE_THRESHOLD && (React.createElement("button", { className: "ds-msg-toggle-btn", title: collapsedMsgs.has(msg.id) ? 'Expand' : 'Collapse', onClick: () => toggleCollapse(msg.id) }, collapsedMsgs.has(msg.id) ? '⌄' : '⌃')))) : (React.createElement(React.Fragment, null,
                            (() => {
                                var _a, _b;
                                if (msg.role !== 'assistant' || msg.id === activeStreamId)
                                    return null;
                                const isLong = ((_b = (_a = msg.content) === null || _a === void 0 ? void 0 : _a.length) !== null && _b !== void 0 ? _b : 0) >= COLLAPSE_THRESHOLD;
                                return (React.createElement("div", { className: "ds-bubble-toolbar" },
                                    React.createElement("div", { className: "ds-bubble-toolbar-right ds-bubble-toolbar-actions" },
                                        React.createElement("button", { className: "ds-bubble-tool-btn ds-bubble-copy-btn", "data-tip": "Copy response", onClick: () => {
                                                var _a, _b;
                                                const text = ((_b = (_a = msg.displayContent) !== null && _a !== void 0 ? _a : msg.content) !== null && _b !== void 0 ? _b : '').trim();
                                                void navigator.clipboard.writeText(text);
                                            } },
                                            React.createElement("svg", { viewBox: "0 0 16 16", width: "13", height: "13", fill: "none", xmlns: "http://www.w3.org/2000/svg" },
                                                React.createElement("rect", { x: "5", y: "5", width: "8", height: "9", rx: "1.2", stroke: "currentColor", strokeWidth: "1.5" }),
                                                React.createElement("path", { d: "M3 11V3a1 1 0 0 1 1-1h7", stroke: "currentColor", strokeWidth: "1.5", strokeLinecap: "round" }))),
                                        isLong && (React.createElement("button", { className: "ds-bubble-tool-btn", "data-tip": collapsedMsgs.has(msg.id) ? 'Expand' : 'Collapse', onClick: () => toggleCollapse(msg.id) },
                                            React.createElement("svg", { viewBox: "0 0 16 16", width: "13", height: "13", fill: "none", xmlns: "http://www.w3.org/2000/svg" }, collapsedMsgs.has(msg.id)
                                                ? React.createElement("path", { d: "M4 6l4 4 4-4", stroke: "currentColor", strokeWidth: "1.6", strokeLinecap: "round", strokeLinejoin: "round" })
                                                : React.createElement("path", { d: "M4 10l4-4 4 4", stroke: "currentColor", strokeWidth: "1.6", strokeLinecap: "round", strokeLinejoin: "round" })))))));
                            })(),
                            (() => {
                                var _a, _b, _c, _d, _e;
                                const isStreaming = msg.id === activeStreamId;
                                const isLong = ((_b = (_a = msg.content) === null || _a === void 0 ? void 0 : _a.length) !== null && _b !== void 0 ? _b : 0) >= COLLAPSE_THRESHOLD;
                                const collapsed = !isStreaming && isLong && collapsedMsgs.has(msg.id);
                                // Inline editor for user messages — click bubble to edit,
                                // Enter to resend, Escape or click-outside to cancel
                                if (msg.role === 'user' && msg.id === editingMsgId) {
                                    const doSend = () => {
                                        const text = editingText.trim();
                                        if (!text)
                                            return;
                                        setEditingMsgId(null);
                                        // Compute the truncated list NOW (synchronously) so we can
                                        // pass it as priorMessages to handleSend.  React state updates
                                        // are async, so reading `messages` inside handleSend after
                                        // setMessages() would still see the stale (untruncated) array,
                                        // causing all post-edit messages to leak into chatHistory.
                                        const idx = messages.findIndex(m => m.id === msg.id);
                                        const truncated = idx >= 0 ? messages.slice(0, idx) : messages;
                                        setMessages(truncated);
                                        void handleSend(text, undefined, false, truncated);
                                    };
                                    return (React.createElement("div", { className: "ds-msg-edit-wrap" },
                                        React.createElement("div", { role: "textbox", "aria-multiline": "true", contentEditable: true, suppressContentEditableWarning: true, className: "ds-msg-edit-textarea ds-msg-edit-ce", ref: editCeRef, onInput: () => {
                                                const el = editCeRef.current;
                                                if (!el)
                                                    return;
                                                const val = el.innerText.replace(/\n$/, '');
                                                setEditingText(val);
                                                const newHtml = buildHighlightHtml(val);
                                                if (newHtml !== editCeHtmlRef.current) {
                                                    const pos = getCursorCharOffset(el);
                                                    el.innerHTML = newHtml;
                                                    editCeHtmlRef.current = newHtml;
                                                    setCursorCharOffset(el, pos);
                                                }
                                            }, onKeyDown: e => {
                                                if (e.key === 'Enter' && !e.shiftKey) {
                                                    e.preventDefault();
                                                    doSend();
                                                }
                                                else if (e.key === 'Escape') {
                                                    setEditingMsgId(null);
                                                }
                                            } }),
                                        React.createElement("div", { className: "ds-msg-edit-hint" }, "\u21B5 send \u00B7 Shift+\u21B5 newline \u00B7 Esc cancel")));
                                }
                                return (React.createElement("div", { className: `ds-msg-collapsible-wrap${collapsed ? ' ds-msg-collapsed' : ''}` },
                                    msg.role === 'assistant' && msg.thoughts && (() => {
                                        var _a;
                                        // While streaming: locked open (full height).
                                        // When done: collapsed by default; user can click to expand.
                                        const thinkIsCollapsed = isStreaming
                                            ? false
                                            : ((_a = thinkCollapsed.get(msg.id)) !== null && _a !== void 0 ? _a : true);
                                        return (React.createElement("div", { className: `ds-thinking-section${isStreaming ? ' ds-thinking-section--active' : ''}` },
                                            React.createElement("button", { className: "ds-thinking-header", onClick: () => { if (!isStreaming)
                                                    toggleThinkCollapsed(msg.id); }, title: isStreaming ? 'Thinking…' : (thinkIsCollapsed ? 'Show thought' : 'Hide thought'), style: isStreaming ? { cursor: 'default' } : undefined },
                                                React.createElement("span", { className: "ds-thinking-label" }, isStreaming ? 'Thinking…' : 'Thought'),
                                                React.createElement("span", { className: "ds-thinking-chevron" }, thinkIsCollapsed ? '▸' : '▾')),
                                            !thinkIsCollapsed && (React.createElement("div", { className: "ds-thinking-body", ref: el => {
                                                    if (el)
                                                        thinkingBodyRefs.current.set(msg.id, el);
                                                    else
                                                        thinkingBodyRefs.current.delete(msg.id);
                                                } }, msg.thoughts))));
                                    })(),
                                    msg.role === 'user' ? (React.createElement("div", { className: `ds-assistant-message-content ds-markdown${!isLoading ? ' ds-user-editable' : ''}`, onClick: !isLoading ? () => {
                                            var _a;
                                            setEditingMsgId(msg.id);
                                            setEditingText(((_a = msg.content) !== null && _a !== void 0 ? _a : '').trim());
                                        } : undefined, dangerouslySetInnerHTML: {
                                            __html: renderUserContent(((_d = (_c = msg.displayContent) !== null && _c !== void 0 ? _c : msg.content) !== null && _d !== void 0 ? _d : '').trim()),
                                        } })) : (React.createElement("div", { className: "ds-assistant-message-content ds-markdown", "data-testid": "varys-assistant-message", dangerouslySetInnerHTML: { __html: renderMarkdown(((_e = msg.displayContent) !== null && _e !== void 0 ? _e : msg.content).replace(/[\r\n\s]+$/, '')) } })),
                                    msg.role === 'user' && msg.contextChip && (React.createElement(ContextChipBubble, { chip: msg.contextChip })),
                                    msg.role === 'user' && !isLoading && msg.id !== editingMsgId && (React.createElement("button", { className: "ds-user-copy-btn", "aria-label": "Copy message", onClick: e => {
                                            var _a;
                                            e.stopPropagation();
                                            void navigator.clipboard.writeText(((_a = msg.content) !== null && _a !== void 0 ? _a : '').trim());
                                        } },
                                        React.createElement("svg", { viewBox: "0 0 16 16", width: "12", height: "12", fill: "none", xmlns: "http://www.w3.org/2000/svg" },
                                            React.createElement("rect", { x: "5", y: "5", width: "8", height: "9", rx: "1.2", stroke: "currentColor", strokeWidth: "1.5" }),
                                            React.createElement("path", { d: "M3 11V3a1 1 0 0 1 1-1h7", stroke: "currentColor", strokeWidth: "1.5", strokeLinecap: "round" })))),
                                    isStreaming && isWritingCode && (React.createElement("div", { className: "ds-generating-hint" },
                                        React.createElement("span", { className: "ds-generating-icon" }, "\u270D"),
                                        ' Writing code',
                                        elapsedSecs > 0 && (React.createElement("span", { className: "ds-generating-count" },
                                            " \u00B7 ",
                                            elapsedSecs,
                                            "s")),
                                        React.createElement("span", { className: "ds-thinking-dots", "aria-hidden": "true" },
                                            React.createElement("span", null),
                                            React.createElement("span", null),
                                            React.createElement("span", null)))),
                                    isStreaming && (React.createElement("span", { className: "ds-typing-cursor", "aria-hidden": "true" },
                                        React.createElement("span", null))),
                                    collapsed && React.createElement("div", { className: "ds-msg-fade", "aria-hidden": "true" })));
                            })())),
                        msg.id === agentMsgId && agentResultsReady && agentFileChanges.length > 0 && (React.createElement("div", { className: "ds-agent-file-cards" },
                            agentFileChanges.map(fc => (React.createElement(FileChangeCard, { key: fc.change_id, event: fc, operationId: agentOperationId, apiBaseUrl: "", xsrfToken: getXsrfToken(), onResolved: (changeId, accepted) => {
                                    const newResolved = Object.assign(Object.assign({}, agentResolved), { [changeId]: accepted });
                                    setAgentResolved(newResolved);
                                    const changed = agentFileChanges.find(f => f.change_id === changeId);
                                    if (!changed)
                                        return;
                                    if (!accepted && changed.change_type === 'modified' && reloadFile) {
                                        reloadFile(changed.file_path);
                                    }
                                } }))),
                            agentFileChanges.length > 1 && (React.createElement("div", { className: "ds-agent-bulk-actions" },
                                React.createElement("button", { className: "ds-assistant-btn ds-assistant-btn-accept", onClick: async () => {
                                        const token = getXsrfToken();
                                        for (const fc of agentFileChanges) {
                                            if (agentResolved[fc.change_id] === undefined) {
                                                try {
                                                    const r = await fetch('/varys/agent/accept', {
                                                        method: 'POST', credentials: 'same-origin',
                                                        headers: { 'Content-Type': 'application/json', 'X-XSRFToken': token },
                                                        body: JSON.stringify({ operation_id: agentOperationId, change_id: fc.change_id, confirmed_content: null, confirmed_path: fc.file_path }),
                                                    });
                                                    const data = await r.json();
                                                    if (data.success)
                                                        setAgentResolved(prev => (Object.assign(Object.assign({}, prev), { [fc.change_id]: true })));
                                                }
                                                catch ( /* ignore per-item errors */_a) { /* ignore per-item errors */ }
                                            }
                                        }
                                    } }, "\u2713 Apply All"),
                                React.createElement("button", { className: "ds-assistant-btn ds-assistant-btn-undo", onClick: async () => {
                                        const token = getXsrfToken();
                                        for (const fc of agentFileChanges) {
                                            if (agentResolved[fc.change_id] === undefined) {
                                                try {
                                                    const r = await fetch('/varys/agent/reject', {
                                                        method: 'POST', credentials: 'same-origin',
                                                        headers: { 'Content-Type': 'application/json', 'X-XSRFToken': token },
                                                        body: JSON.stringify({ operation_id: agentOperationId, change_id: fc.change_id }),
                                                    });
                                                    const data = await r.json();
                                                    if (data.success) {
                                                        setAgentResolved(prev => (Object.assign(Object.assign({}, prev), { [fc.change_id]: false })));
                                                        if (fc.change_type === 'modified' && reloadFile)
                                                            reloadFile(fc.file_path);
                                                    }
                                                }
                                                catch ( /* ignore per-item errors */_a) { /* ignore per-item errors */ }
                                            }
                                        }
                                    } }, "\u21BA Undo All"))))),
                        msg.role === 'assistant' && msg.operationId && (() => {
                            var _a, _b, _c, _d, _e, _f;
                            // Primary: diffs stored directly on the message (survive refreshes).
                            // Fallback: live pendingOps entry covers the window before the next save.
                            const op = pendingOps.find(o => o.operationId === msg.operationId);
                            const diffsToShow = (msg.diffs && msg.diffs.length > 0)
                                ? msg.diffs
                                : ((_a = op === null || op === void 0 ? void 0 : op.diffs) !== null && _a !== void 0 ? _a : []);
                            // Reorder ops have no cell diffs but still need Accept/Undo buttons.
                            const isReorderOp = (_b = op === null || op === void 0 ? void 0 : op.steps.some(s => s.type === 'reorder')) !== null && _b !== void 0 ? _b : false;
                            if (!diffsToShow.length && !isReorderOp && !msg.diffResolved)
                                return null;
                            const resolvedStatus = (_c = msg.diffResolved) !== null && _c !== void 0 ? _c : op === null || op === void 0 ? void 0 : op.resolved;
                            return (React.createElement(DiffView, { key: msg.operationId, operationId: msg.operationId, description: (_d = op === null || op === void 0 ? void 0 : op.description) !== null && _d !== void 0 ? _d : (_e = msg.content) === null || _e === void 0 ? void 0 : _e.split('\n')[0], diffs: diffsToShow, onAccept: handleAccept, onUndo: handleUndo, resolved: resolvedStatus, requiresApproval: (_f = op === null || op === void 0 ? void 0 : op.requiresApproval) !== null && _f !== void 0 ? _f : false }));
                        })())));
            }),
            isLoading && progressText && !activeStreamId && (React.createElement("div", { className: "ds-assistant-message ds-assistant-message-system" },
                React.createElement("span", { className: "ds-assistant-loading" },
                    progressText,
                    React.createElement("span", { className: "ds-thinking-dots", "aria-hidden": "true" },
                        React.createElement("span", null),
                        React.createElement("span", null),
                        React.createElement("span", null))))),
            agentBadgeVisible && (React.createElement("div", { className: "ds-agent-badge ds-agent-badge--active" },
                React.createElement("span", { className: "ds-agent-badge__label" }, "Varys File Agent"))),
            sysWarnings.length > 0 && !warningsDismissed && (React.createElement("div", { className: "ds-sys-warnings" }, sysWarnings.map((w, i) => (React.createElement("div", { key: i, className: `ds-sys-warning ds-sys-warning--${w.level}` },
                React.createElement("span", { className: "ds-sys-warning__icon" }, w.level === 'error' ? '⚠️' : 'ℹ️'),
                React.createElement("span", { className: "ds-sys-warning__msg" }, w.message),
                React.createElement("button", { className: "ds-sys-warning__dismiss", onClick: () => {
                        const remaining = sysWarnings.filter((_, j) => j !== i);
                        setSysWarnings(remaining);
                        if (remaining.length === 0)
                            setWarningsDismissed(true);
                    }, "aria-label": "Dismiss" }, "\u2715")))))),
            React.createElement("div", { ref: messagesEndRef })),
        agentResultsReady && (agentToolError || agentIncomplete || agentBashCount > 0 ||
            agentBashWarnings.length > 0 || agentBlockedCmds.length > 0) && (React.createElement("div", { className: "ds-agent-results" },
            agentToolError && (React.createElement(AgentToolErrorBanner, { error: agentToolError, onOpenAgentSettings: () => setSettingsOpenToAgent(true) })),
            agentIncomplete && (React.createElement("div", { className: "ds-agent-incomplete-banner" }, agentTimedOut
                ? '⚠ Task reached the time limit — results may be incomplete.'
                : '⚠ Task reached the turn limit — results may be incomplete.')),
            agentBashCount > 0 && (React.createElement("div", { className: "ds-agent-bash-banner" }, "\uD83D\uDD27 Shell commands were run during this task.")),
            agentBashWarnings.map((reason, i) => !bashWarnDismissed[i] && (React.createElement("div", { key: `bwarn-${i}`, className: "ds-agent-bash-warn-chip" },
                React.createElement("span", { className: "ds-agent-bash-warn-icon" }, "\u26A0"),
                React.createElement("span", { className: "ds-agent-bash-warn-text" },
                    "Potentially destructive command: ",
                    reason),
                React.createElement("button", { className: "ds-agent-bash-warn-dismiss", onClick: () => setBashWarnDismissed(prev => (Object.assign(Object.assign({}, prev), { [i]: true }))), title: "Dismiss" }, "\u2715")))),
            agentBlockedCmds.map((bc, i) => !blockedCmdDismissed[i] && (React.createElement("div", { key: `bblock-${i}`, className: "ds-agent-blocked-chip" },
                React.createElement("span", { className: "ds-agent-blocked-icon" }, "\uD83D\uDEAB"),
                React.createElement("span", { className: "ds-agent-blocked-text" },
                    "Command blocked: ",
                    bc.reason),
                React.createElement("button", { className: "ds-agent-blocked-dismiss", onClick: () => setBlockedCmdDismissed(prev => (Object.assign(Object.assign({}, prev), { [i]: true }))), title: "Dismiss" }, "\u2715")))))),
        React.createElement("div", { className: "ds-assistant-input-area" },
            React.createElement("div", { className: "ds-input-resize-handle", onMouseDown: handleResizeMouseDown, title: "Drag to resize input", "aria-label": "Resize input area" },
                React.createElement("span", { className: "ds-input-resize-grip" })),
            showCmdPopup && (React.createElement(CommandAutocomplete, { commands: commands, query: input, onSelect: cmd => {
                    if (cmd.command === '/resize') {
                        // Place cursor inside the parentheses so the user types the number directly
                        setInput('/resize(');
                        setShowCmdPopup(false);
                        requestAnimationFrame(() => {
                            const el = textareaRef.current;
                            if (el) {
                                el.focus();
                                moveCECursorToEnd(el);
                            }
                        });
                    }
                    else if (cmd.command === '/file_agent' ||
                        cmd.command === '/file_agent_find' ||
                        cmd.command === '/file_agent_save') {
                        // Agent commands require a task argument — fill input so user can type it
                        setInput(cmd.command + ' ');
                        setActiveCommand(cmd);
                        setShowCmdPopup(false);
                        requestAnimationFrame(() => {
                            const el = textareaRef.current;
                            if (el) {
                                el.focus();
                                moveCECursorToEnd(el);
                            }
                        });
                    }
                    else if (cmd.type === 'builtin') {
                        // Handle built-ins immediately without going to the backend
                        handleBuiltinCommand(cmd.command);
                        setInput('');
                        setShowCmdPopup(false);
                    }
                    else {
                        // Fill the input with the command prefix so the user can add args
                        setInput(cmd.command + ' ');
                        setActiveCommand(cmd);
                        setShowCmdPopup(false);
                    }
                }, onClose: () => setShowCmdPopup(false) })),
            activeCommand && (React.createElement("div", { className: "ds-cmd-active-badge" },
                React.createElement("span", { className: "ds-cmd-active-name" }, activeCommand.command),
                React.createElement("span", { className: "ds-cmd-active-desc" }, activeCommand.description),
                React.createElement("span", { className: "ds-cmd-active-clear", onClick: () => {
                        setActiveCommand(null);
                        setInput('');
                    }, "data-tip": "Clear command" }, "\u2715"))),
            contextChip && (React.createElement("div", { className: "ds-ctx-chip" },
                React.createElement("span", { className: "ds-ctx-chip-icon" }, "\uD83D\uDCCE"),
                React.createElement("span", { className: "ds-ctx-chip-label" }, contextChip.label),
                React.createElement("button", { className: "ds-ctx-chip-toggle", onClick: () => setChipExpanded(x => !x), "data-tip": chipExpanded ? 'Collapse' : 'Expand context', "aria-label": chipExpanded ? 'Collapse context' : 'Expand context' }, chipExpanded ? '▲' : '▼'),
                React.createElement("button", { className: "ds-ctx-chip-remove", onClick: () => { setContextChip(null); contextPrefixRef.current = ''; }, "data-tip": "Remove context", "aria-label": "Remove context" }, "\u2715"),
                chipExpanded && (React.createElement("pre", { className: "ds-ctx-chip-preview" }, contextChip.preview)))),
            imageMode && (React.createElement("div", { className: "ds-image-mode-badge" },
                React.createElement("span", { className: "ds-image-mode-icon" }, imageMode.mode === 'no_figures' ? '🚫' : '🔬'),
                React.createElement("span", { className: "ds-image-mode-label" }, imageMode.mode === 'no_figures'
                    ? 'no figures'
                    : `resize(${imageMode.dim}px)`),
                React.createElement("button", { className: "ds-image-mode-clear", onClick: () => {
                        setImageMode(null);
                        addMessage('system', '✓ Image mode cleared — figures will be sent as normal.');
                    }, title: "Clear image mode", "aria-label": "Clear image mode" }, "\u2715"))),
            React.createElement("div", { className: "ds-input-frame" },
                React.createElement("div", { className: "ds-input-body" },
                    React.createElement("div", { className: "ds-nb-ctx-row" },
                        currentFilePath ? (React.createElement("span", { className: "ds-nb-ctx-chip ds-nb-ctx-chip--on ds-nb-ctx-chip--file", "data-tip": `File included as context: ${currentFilePath}`, "aria-label": `File context: ${currentFilePath}`, title: currentFilePath },
                            React.createElement("span", { className: "ds-nb-ctx-sign" }, "\uD83D\uDCCE"),
                            currentFilePath.split('/').pop())) : (React.createElement("button", { className: `ds-nb-ctx-chip${notebookAware ? ' ds-nb-ctx-chip--on' : ' ds-nb-ctx-chip--off'}`, onClick: handleToggleNotebookAware, "data-tip": notebookAware
                                ? `${currentNotebookPath || 'Notebook'} included as context — click to exclude`
                                : `${currentNotebookPath || 'Notebook'} excluded from context — click to include`, "aria-label": notebookAware ? 'Notebook included' : 'Notebook excluded', title: currentNotebookPath },
                            React.createElement("span", { className: "ds-nb-ctx-sign" }, "\uD83D\uDCCE"),
                            currentNotebookPath ? currentNotebookPath.split('/').pop() : 'notebook')),
                        extractCellRefs(input).map(ref => (React.createElement("span", { key: ref, className: "ds-nb-ctx-chip ds-nb-ctx-chip--on ds-cell-ref-ctx-chip", title: `"${ref}" referenced in your query`, "aria-label": ref },
                            React.createElement("span", { className: "ds-nb-ctx-sign" }, "\uD83D\uDCCE"),
                            ref))),
                        extractAtMentions(input, atSymbols).map(sym => (React.createElement("span", { key: sym.name, className: "ds-nb-ctx-chip ds-nb-ctx-chip--on ds-at-ref-ctx-chip", title: `@${sym.name}${sym.vtype ? ` (${sym.vtype})` : ''} — kernel variable in context`, "aria-label": `@${sym.name}` },
                            "@",
                            sym.name))),
                        React.createElement("div", { className: "ds-reasoning-dropdown", ref: reasoningDropdownRef },
                            React.createElement("button", { className: `ds-thinking-chip${reasoningMode === 'sequential' ? ' ds-thinking-chip--on'
                                    : reasoningMode === 'cot' ? ' ds-thinking-chip--cot'
                                        : ' ds-thinking-chip--off'}`, onClick: () => setReasoningDropdownOpen(v => !v), "aria-label": `Chain-of-Thought mode: ${reasoningMode}`, "aria-haspopup": "listbox", "aria-expanded": reasoningDropdownOpen },
                                "\uD83E\uDDE0",
                                ' ',
                                reasoningMode === 'sequential' ? 'Sequential'
                                    : reasoningMode === 'cot' ? 'CoT'
                                        : 'CoT: off',
                                React.createElement("span", { className: "ds-reasoning-chevron" }, reasoningDropdownOpen ? '▴' : '▾')),
                            reasoningDropdownOpen && (React.createElement("div", { className: "ds-reasoning-menu", role: "listbox" }, [
                                { value: 'off', label: 'Off', sub: 'No extra reasoning calls', mod: '' },
                                { value: 'cot', label: 'CoT', sub: '1 call · steps inline', mod: 'cot' },
                                { value: 'sequential', label: 'Sequential', sub: 'Multi-step · 🧠 panel', mod: 'seq' },
                            ].map(opt => (React.createElement("button", { key: opt.value, role: "option", "aria-selected": reasoningMode === opt.value, className: `ds-reasoning-item ds-reasoning-item--${opt.mod || 'off'}${reasoningMode === opt.value ? ' ds-reasoning-item--active' : ''}`, onClick: () => {
                                    var _a, _b;
                                    setReasoningMode(opt.value);
                                    reasoningModeRef.current = opt.value;
                                    threadReasoningMapRef.current.set(currentThreadIdRef.current, opt.value);
                                    try {
                                        localStorage.setItem('ds-varys-reasoning-mode', opt.value);
                                    }
                                    catch ( /* ignore */_c) { /* ignore */ }
                                    setReasoningDropdownOpen(false);
                                    // Persist immediately so a refresh before the next message
                                    // does not lose the selection.
                                    const tid = currentThreadIdRef.current;
                                    const tName = (_b = (_a = threadsRef.current.find(t => t.id === tid)) === null || _a === void 0 ? void 0 : _a.name) !== null && _b !== void 0 ? _b : 'Thread';
                                    void _saveThread(tid, tName, messagesRef.current);
                                } },
                                React.createElement("span", { className: "ds-reasoning-item-label" }, opt.label),
                                React.createElement("span", { className: "ds-reasoning-item-sub" }, opt.sub)))))))),
                    React.createElement("div", { ref: textareaRef, role: "textbox", "aria-multiline": "true", "data-testid": "varys-chat-input", contentEditable: isLoading ? 'false' : 'true', className: "ds-assistant-input ds-assistant-ce", style: { minHeight: MIN_INPUT_HEIGHT, maxHeight: inputHeight }, "data-placeholder": contextChip ? `Describe your edit for ${contextChip.label}…` : "Ask Varys… (use @varName · /command · Enter to send)", suppressContentEditableWarning: true, onInput: () => {
                            var _a, _b, _c, _d, _e, _f;
                            const el = textareaRef.current;
                            if (!el)
                                return;
                            // innerText normalises <br> to \n; strip one trailing \n browsers add.
                            const val = el.innerText.replace(/\n$/, '');
                            lastCEText.current = val;
                            setInput(val);
                            // Auto-resize
                            el.style.height = 'auto';
                            el.style.height = `${Math.min(el.scrollHeight, inputHeight)}px`;
                            // Slash-command autocomplete
                            if (val.match(/^\/[\w-]*/)) {
                                setShowCmdPopup(true);
                            }
                            else {
                                setShowCmdPopup(false);
                                setActiveCommand(null);
                            }
                            // @-mention detection — cursor offset via Selection API
                            const cursor = getCursorCharOffset(el);
                            const before = val.slice(0, cursor);
                            const atMatch = before.match(/@([A-Za-z_]\w*)$/);
                            if (atMatch) {
                                const anchor = before.length - atMatch[0].length;
                                setAtAnchorPos(anchor);
                                setAtQuery(atMatch[1]);
                                setAtFocusIdx(0);
                                const ctx = notebookReader.getFullContext();
                                const nbPath = (_a = ctx === null || ctx === void 0 ? void 0 : ctx.notebookPath) !== null && _a !== void 0 ? _a : '';
                                if (nbPath) {
                                    const activeIdx = (_b = ctx === null || ctx === void 0 ? void 0 : ctx.activeCellIndex) !== null && _b !== void 0 ? _b : -1;
                                    const cellIds = ((_c = ctx === null || ctx === void 0 ? void 0 : ctx.cells) !== null && _c !== void 0 ? _c : [])
                                        .filter((_, i) => activeIdx < 0 || i <= activeIdx)
                                        .map(c => { var _a; return (_a = c.cellId) !== null && _a !== void 0 ? _a : ''; })
                                        .filter(Boolean);
                                    apiClient.fetchSymbols(nbPath, cellIds).then(syms => setAtSymbols(syms)).catch(() => { });
                                }
                            }
                            else if (before.endsWith('@')) {
                                const anchor = before.length - 1;
                                setAtAnchorPos(anchor);
                                setAtQuery('');
                                setAtFocusIdx(0);
                                const ctx = notebookReader.getFullContext();
                                const nbPath = (_d = ctx === null || ctx === void 0 ? void 0 : ctx.notebookPath) !== null && _d !== void 0 ? _d : '';
                                if (nbPath) {
                                    const activeIdx = (_e = ctx === null || ctx === void 0 ? void 0 : ctx.activeCellIndex) !== null && _e !== void 0 ? _e : -1;
                                    const cellIds = ((_f = ctx === null || ctx === void 0 ? void 0 : ctx.cells) !== null && _f !== void 0 ? _f : [])
                                        .filter((_, i) => activeIdx < 0 || i <= activeIdx)
                                        .map(c => { var _a; return (_a = c.cellId) !== null && _a !== void 0 ? _a : ''; })
                                        .filter(Boolean);
                                    apiClient.fetchSymbols(nbPath, cellIds).then(syms => setAtSymbols(syms)).catch(() => { });
                                }
                            }
                            else {
                                setAtAnchorPos(-1);
                            }
                            // Update inline cell-ref / @-mention highlighting
                            const newHtml = buildHighlightHtml(val, new Set(atSymbols.map(s => s.name)));
                            if (newHtml !== ceHtmlRef.current) {
                                const pos = getCursorCharOffset(el);
                                el.innerHTML = newHtml;
                                ceHtmlRef.current = newHtml;
                                setCursorCharOffset(el, pos);
                            }
                        }, onKeyDown: handleKeyDown, onBeforeInput: (e) => {
                            // Chrome fires beforeinput(insertParagraph/insertLineBreak) for
                            // Enter keys even when keydown called e.preventDefault() — this
                            // causes spurious DOM mutations (e.g. Ctrl+Enter splits backtick
                            // blocks instead of sending).  Block all browser-level newline
                            // injection; our keydown handler is the sole gate.
                            const ie = e.nativeEvent;
                            if (ie.inputType === 'insertParagraph' || ie.inputType === 'insertLineBreak') {
                                e.preventDefault();
                            }
                        }, onPaste: (e) => {
                            e.preventDefault();
                            // Block any paste that contains image data — only plain text is allowed.
                            const items = Array.from(e.clipboardData.items);
                            if (items.some(item => item.type.startsWith('image/')))
                                return;
                            const text = e.clipboardData.getData('text/plain');
                            if (!text)
                                return;
                            document.execCommand('insertText', false, text);
                        } }),
                    atAnchorPos >= 0 && atFiltered.length > 0 && (React.createElement("div", { className: "ds-at-menu", ref: atDropdownRef, role: "listbox" }, atFiltered.map((sym, i) => (React.createElement("button", { key: sym.name, role: "option", "aria-selected": i === atFocusIdx, className: `ds-at-item${i === atFocusIdx ? ' ds-at-item--focused' : ''}`, onMouseDown: e => { e.preventDefault(); insertAtSuggestion(sym.name); }, onMouseEnter: () => setAtFocusIdx(i) },
                        React.createElement("span", { className: "ds-at-item-name" },
                            "@",
                            sym.name),
                        sym.vtype && React.createElement("span", { className: "ds-at-item-type" }, sym.vtype))))))),
                React.createElement("div", { className: "ds-assistant-input-bottom" },
                    (notebookAware || !!currentFilePath) && (React.createElement("select", { className: "ds-cell-mode-select", value: cellMode, title: CELL_MODE_TITLE[cellMode], onChange: e => {
                            var _a, _b;
                            const next = e.target.value;
                            setCellMode(next);
                            cellModeRef.current = next;
                            threadModeMapRef.current.set(currentThreadIdRef.current, next);
                            try {
                                localStorage.setItem('ds-assistant-cell-mode', next);
                            }
                            catch ( /* ignore */_c) { /* ignore */ }
                            const tid = currentThreadIdRef.current;
                            const tName = (_b = (_a = threadsRef.current.find(t => t.id === tid)) === null || _a === void 0 ? void 0 : _a.name) !== null && _b !== void 0 ? _b : 'Thread';
                            void _saveThread(tid, tName, messagesRef.current);
                        } },
                        React.createElement("option", { value: "chat" }, "\uD83D\uDCAC Chat"),
                        React.createElement("option", { value: "agent" }, "\u2728 Agent"))),
                    React.createElement("span", { className: "ds-input-bottom-spacer" }),
                    (() => {
                        var _a;
                        const usage = (_a = threads.find(t => t.id === currentThreadId)) === null || _a === void 0 ? void 0 : _a.tokenUsage;
                        const hasUsage = usage && (usage.input > 0 || usage.output > 0);
                        const fmt = (n) => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
                        const tip = hasUsage
                            ? `In: ${usage.input.toLocaleString()} · Out: ${usage.output.toLocaleString()} tokens (this thread)`
                            : 'Token usage — accumulates across all turns in this thread';
                        return (React.createElement("span", { className: `ds-token-counter${hasUsage ? '' : ' ds-token-counter--empty'}`, "data-tip": tip },
                            React.createElement("span", { className: "ds-token-in" },
                                "\u2191",
                                hasUsage ? fmt(usage.input) : '0'),
                            React.createElement("span", { className: "ds-token-out" },
                                "\u2193",
                                hasUsage ? fmt(usage.output) : '0')));
                    })(),
                    isLoading ? (React.createElement("button", { className: "ds-assistant-send-btn ds-send-stop", "data-testid": "varys-stop-button", onClick: handleStop, title: "Stop generation", "aria-label": "Stop generation" },
                        React.createElement("svg", { viewBox: "0 0 24 24", width: "10", height: "10", fill: "none", xmlns: "http://www.w3.org/2000/svg" },
                            React.createElement("circle", { cx: "12", cy: "12", r: "10", stroke: "currentColor", strokeWidth: "2" }),
                            React.createElement("rect", { x: "8", y: "8", width: "8", height: "8", rx: "1", fill: "currentColor" })))) : input.trim() ? (React.createElement("button", { className: "ds-assistant-send-btn ds-send-arrow", "data-testid": "varys-send-button", onClick: () => void handleSend(), title: "Send message (Enter)", "aria-label": "Send message" },
                        React.createElement("svg", { viewBox: "0 0 24 24", width: "10", height: "10", fill: "none", xmlns: "http://www.w3.org/2000/svg" },
                            React.createElement("path", { d: "M12 19V5M5 12l7-7 7 7", stroke: "currentColor", strokeWidth: "2.5", strokeLinecap: "round", strokeLinejoin: "round" })))) : null)),
            React.createElement("div", { className: "ds-assistant-input-model-row" },
                React.createElement(ModelSwitcher, { provider: chatProvider, model: chatModel, zoo: chatZoo, saving: modelSwitching, onSelect: m => void handleModelSelect(m) })))));
};
// ---------------------------------------------------------------------------
// Lumino widget wrapper
// ---------------------------------------------------------------------------
export class DSAssistantSidebar extends ReactWidget {
    constructor(props) {
        super();
        this._props = props;
        this.addClass('jp-ReactWidget');
    }
    /**
     * Send a message into the chat panel.
     * If autoSend is true the message is submitted immediately (e.g. context-menu
     * actions); if false the text is pre-filled so the user can review/edit it.
     */
    sendMessage(text, autoSend = true, displayText, contextPrefix, contextChip, selectedOutput) {
        _dispatchExternalMessage({ text, autoSend, displayText, contextPrefix, contextChip, selectedOutput });
    }
    /** Convenience: send a specific notebook output to the chat input. */
    sendOutputToChat(output) {
        const chip = { label: output.label, preview: output.preview };
        _dispatchExternalMessage({
            text: '',
            autoSend: false,
            contextChip: chip,
            selectedOutput: output,
        });
    }
    /** Open the Tags & Metadata panel inside the sidebar. */
    openTagsPanel() {
        _dispatchExternalMessage({ text: '', autoSend: false, openTags: true });
    }
    render() {
        return React.createElement(DSAssistantChat, Object.assign({}, this._props));
    }
}

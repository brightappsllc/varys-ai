/**
 * SidebarWidget - Main chat interface for Varys.
 * Renders as a ReactWidget in the JupyterLab right sidebar.
 */

import React, { useState, useRef, useEffect } from 'react';
import { ReactWidget } from '@jupyterlab/apputils';
import { INotebookTracker } from '@jupyterlab/notebook';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { APIClient, TaskResponse, OperationStep, ChatTurn, CompositeStep, ResolvedVariable, ChatThread, SlashCommand, ImageMode } from '../api/client';
import { NotebookReader } from '../context/NotebookReader';
import { VariableResolver, parseVariableRefs } from '../context/VariableResolver';
import { CellEditor } from '../editor/CellEditor';
import { DiffView, DiffInfo } from '../ui/DiffView';
import { FileChangeCard, FileChangeEvent } from '../ui/FileChangeCard';
import { ReproPanel } from '../reproducibility/ReproPanel';
import { reproStore } from '../reproducibility/store';
import { TagsPanel } from '../tags/TagsPanel';

// ---------------------------------------------------------------------------
// XSRF token helper (mirrors APIClient.getXSRFToken for direct fetch calls)
// ---------------------------------------------------------------------------

function getXsrfToken(): string {
  const cookies = document.cookie.split(';');
  for (const cookie of cookies) {
    const trimmed = cookie.trim();
    const sep = trimmed.indexOf('=');
    if (sep === -1) continue;
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
_markedRenderer.code = function (
  { text, lang }: { text: string; lang?: string }
): string {
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  const langAttr = lang ? ` class="language-${lang}"` : '';
  return (
    `<div class="ds-code-block-wrapper">` +
    `<button class="ds-copy-code-btn" aria-label="Copy code">Copy</button>` +
    `<pre><code${langAttr}>${escaped}</code></pre>` +
    `</div>`
  );
};

function renderMarkdown(text: string): string {
  // Guard against null/undefined during streaming
  if (!text) return '';
  try {
    const raw = marked.parse(text, { renderer: _markedRenderer }) as string;
    // Sanitize to prevent XSS while keeping all formatting elements.
    // 'button' is added so copy buttons survive the sanitizer.
    return DOMPurify.sanitize(raw, {
      ALLOWED_TAGS: [
        'p','br','b','i','strong','em','s','code','pre','blockquote',
        'ul','ol','li','h1','h2','h3','h4','h5','h6',
        'table','thead','tbody','tr','th','td',
        'a','hr','span','div','button',
      ],
      ALLOWED_ATTR: ['href', 'target', 'rel', 'class', 'aria-label'],
    });
  } catch {
    return text;
  }
}

// ---------------------------------------------------------------------------
// User-bubble content renderer
// ---------------------------------------------------------------------------

/** Escape HTML special characters in a plain-text segment. */
function _escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Extracts unique "cell #N" tokens from the user's input for display as
 * context-row chips.  A token is only collected once a non-digit character
 * follows the number (i.e. the user has "closed off" the number by typing a
 * separator).  Returns tokens in order of first appearance, de-duplicated by
 * their normalised form ("Cell  # 3" and "cell #3" both yield "cell #3").
 */
function extractCellRefs(text: string): string[] {
  const re = /\b(cell\s*#\s*\d+)(?=\D)/gi;
  const seen = new Set<string>();
  const result: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const normalised = m[1].replace(/\s+/g, ' ').toLowerCase().trim();
    if (!seen.has(normalised)) {
      seen.add(normalised);
      result.push(normalised);
    }
    if (m[0].length === 0) re.lastIndex++;
  }
  return result;
}

// ── Contenteditable rich-text input helpers ───────────────────────────────

/**
 * Builds the innerHTML to set on the contenteditable input div.
 * "cell #N" tokens followed by a non-digit are wrapped in a styled span;
 * all other text is HTML-escaped.  Newlines become <br> so they render
 * correctly inside a div (unlike a textarea where they are native).
 */
function buildHighlightHtml(text: string): string {
  const re = /\b(cell\s*#\s*\d+)(?=\D)/gi;
  const parts: string[] = [];
  let lastIdx = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    parts.push(_escHtml(text.slice(lastIdx, m.index)).replace(/\n/g, '<br>'));
    parts.push(`<span class="ds-cell-ref-inline">${_escHtml(m[0])}</span>`);
    lastIdx = m.index + m[0].length;
    if (m[0].length === 0) re.lastIndex++;
  }
  parts.push(_escHtml(text.slice(lastIdx)).replace(/\n/g, '<br>'));
  return parts.join('');
}

/** Returns the cursor's character offset within the element's plain text. */
function getCursorCharOffset(el: HTMLElement): number {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return 0;
  const pre = sel.getRangeAt(0).cloneRange();
  pre.selectNodeContents(el);
  pre.setEnd(sel.getRangeAt(0).endContainer, sel.getRangeAt(0).endOffset);
  return pre.toString().length;
}

/** Moves the cursor to `offset` characters into the element's plain text. */
function setCursorCharOffset(el: HTMLElement, offset: number): void {
  const sel = window.getSelection();
  if (!sel) return;
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let charCount = 0;
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const len = (node.textContent ?? '').length;
    if (charCount + len >= offset) {
      const range = document.createRange();
      range.setStart(node, offset - charCount);
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);
      return;
    }
    charCount += len;
  }
  // Fallback: cursor to end
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(false);
  sel.removeAllRanges();
  sel.addRange(range);
}

/** Moves the cursor to the very end of the element's content. */
function moveCECursorToEnd(el: HTMLElement): void {
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(false);
  const sel = window.getSelection();
  if (sel) { sel.removeAllRanges(); sel.addRange(range); }
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
function renderUserContent(text: string): string {
  if (!text) return '';
  // Split on fenced code blocks; capture the fence so we can inspect it
  const segments = text.split(/(```[\w.-]*\r?\n[\s\S]*?```)/g);
  let html = '';
  for (const seg of segments) {
    const fenceMatch = seg.match(/^```([\w.-]*)\r?\n([\s\S]*?)```$/);
    if (fenceMatch) {
      const lang    = fenceMatch[1] ? ` class="language-${_escHtml(fenceMatch[1])}"` : '';
      const code    = _escHtml(fenceMatch[2]);
      html +=
        `<div class="ds-code-block-wrapper">` +
        `<button class="ds-copy-code-btn" aria-label="Copy code">Copy</button>` +
        `<pre><code${lang}>${code}</code></pre>` +
        `</div>`;
    } else if (seg) {
      // Handle inline backticks, then wrap in a pre-wrap span
      const withInline = _escHtml(seg).replace(/`([^`\r\n]+)`/g, '<code>$1</code>');
      html += `<span class="ds-user-text">${withInline}</span>`;
    }
  }
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: ['span', 'div', 'pre', 'code', 'button'],
    ALLOWED_ATTR: ['class', 'aria-label'],
  });
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'warning' | 'report' | 'code-review' | 'disambiguation';
  content: string;
  /**
   * Optional short label shown in the chat bubble instead of the full content.
   * The full content is still used for LLM context and history.
   * Used by context-menu actions that pre-fill the prompt with large code blocks.
   */
  displayContent?: string;
  /**
   * True when this assistant turn produced ≥1 cell operations (insert/modify/delete).
   * Suppresses the "Push code to cell" fallback button so it only appears when
   * the LLM genuinely returned code in chat with no corresponding cell plan.
   */
  hadCellOps?: boolean;
  /**
   * Code context chip attached by "Edit with AI" (or similar actions).
   * Shown as a collapsible snippet card below the user's instruction in the
   * chat bubble, and as a chip in the input area before sending.
   */
  contextChip?: { label: string; preview: string };
  /**
   * The operationId returned by the backend for this turn, if any.
   * Used to correlate the chat bubble with its pending DiffView.
   */
  operationId?: string;
  /**
   * Diff data for the cell-edit operation this turn produced.
   * Stored directly on the message so it survives React re-renders,
   * thread switches, and page refreshes (serialised into the chat file).
   */
  diffs?: DiffInfo[];
  /**
   * Set after the user resolves the diff — drives the collapsed inline DiffView.
   * Persisted to disk so the collapsed view survives page refresh.
   */
  diffResolved?: 'accepted' | 'undone';
  timestamp: Date;
  /** For report messages: metadata returned by the backend */
  reportMeta?: {
    filename: string;
    relativePath: string;
    stats: { total: number; code: number; markdown: number; with_outputs: number; errors: number };
    imagesCount: number;
    wordCount: number;
  };
  /** For code-review messages: individually applicable fix steps */
  codeReviewSteps?: OperationStep[];
  /**
   * True when this message was loaded from persisted chat history (disk) rather
   * than produced in the current session.
   */
  fromHistory?: boolean;
  /**
   * Step-by-step reasoning trace produced when sequential thinking is enabled.
   * Rendered as a collapsible section above the main answer in the bubble.
   */
  thoughts?: string;
  /**
   * Optional subtype for system messages that require specialised rendering.
   * 'error_recovery' — renders an image-error recovery prompt with command chips.
   * 'context_too_long' — renders a context-size advisory notice.
   */
  subtype?: 'error_recovery' | 'context_too_long';
  /**
   * LLM provider at the time of an image_too_large error (e.g. "anthropic", "openai").
   * Used by the recovery prompt to show only the relevant resize option.
   */
  errorProvider?: string;
  /** True when a context_too_long error occurred and the context had at least one image. */
  errorHasImages?: boolean;
}

// Report generation is triggered only by the explicit /report command.
// Keyword-based detection was removed: it was fragile (e.g. "write a report
// on cell 5" or "don't generate a report" both matched incorrectly).

// ---------------------------------------------------------------------------
// Advisory disambiguation — phrases that suggest a discussion/question intent
// When detected on a plain (non-command) message, we surface two options to
// the user instead of silently guessing.
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

function looksAdvisory(message: string, phrases: string[] = _ADVISORY_STARTS): boolean {
  const low = message.toLowerCase().trim();
  if (low.endsWith('?')) return true;
  return phrases.some(p => low.startsWith(p.toLowerCase()));
}

// ---------------------------------------------------------------------------
// ImageRecoveryPrompt — compact inline message + dropdown for image errors
// ---------------------------------------------------------------------------
interface ImageRecoveryPromptProps {
  /** The original user message that triggered the error. */
  originalMessage: string;
  /** Lowercase provider name ("anthropic", "openai", …). */
  provider: string;
  /**
   * Called with (cmd, originalMessage) when the user picks an option.
   * cmd  — the command string, e.g. "/no_figures" or "/resize(7800)"
   * originalMessage — the user's original message text
   */
  onFill: (cmd: string, originalMessage: string) => void;
}

const ImageRecoveryPrompt: React.FC<ImageRecoveryPromptProps> = ({
  originalMessage, provider, onFill,
}) => {
  const [open, setOpen]             = useState(false);
  const [showCustom, setShowCustom] = useState(false);
  const [customDim, setCustomDim]   = useState('');
  const [flipUp, setFlipUp]         = useState(false);
  const dropRef    = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  // Build provider-aware resize options
  const resizeOptions: [string, string][] = provider.includes('anthropic')
    ? [['/resize(7800)', 'Resize to 7800 px']]
    : provider.includes('openai')
    ? [['/resize(6000)', 'Resize to 6000 px']]
    : [['/resize(7800)', 'Resize to 7800 px (Anthropic)'], ['/resize(6000)', 'Resize to 6000 px (OpenAI)']];

  const staticOptions: [string, string][] = [
    ['/no_figures', 'Exclude all figures'],
    ...resizeOptions,
  ];

  // Decide whether to open the menu upward based on available space below
  useEffect(() => {
    if (!open || !triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    setFlipUp(rect.bottom > window.innerHeight * 0.55);
  }, [open]);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (dropRef.current && !dropRef.current.contains(e.target as Node)) {
        setOpen(false);
        setShowCustom(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const pick = (cmd: string) => {
    setOpen(false);
    setShowCustom(false);
    setCustomDim('');
    onFill(cmd, originalMessage);
  };

  const submitCustom = () => {
    const d = parseInt(customDim, 10);
    if (isNaN(d) || d < 10) return;
    pick(`/resize(${d})`);
  };

  return (
    <div className="ds-img-rec">
      <span className="ds-img-rec-msg">
        ⚠️ One or more figures exceed the provider's image size limit.
      </span>
      <div className="ds-img-rec-wrap" ref={dropRef}>
        <button
          ref={triggerRef}
          className={`ds-img-rec-trigger${open ? ' ds-img-rec-trigger--open' : ''}`}
          onClick={() => { setOpen(o => !o); setShowCustom(false); }}
        >
          Choose action <span className="ds-img-rec-caret">{open ? '▲' : '▼'}</span>
        </button>
        {open && (
          <div className={`ds-img-rec-menu${flipUp ? ' ds-img-rec-menu--up' : ''}`}>
            {staticOptions.map(([cmd, desc]) => (
              <button key={cmd} className="ds-img-rec-item" onClick={() => pick(cmd)}>
                <code className="ds-img-rec-cmd">{cmd}</code>
                <span className="ds-img-rec-desc">{desc}</span>
              </button>
            ))}
            {/* Custom dimension row */}
            {!showCustom ? (
              <button className="ds-img-rec-item" onClick={() => setShowCustom(true)}>
                <code className="ds-img-rec-cmd">/resize(…)</code>
                <span className="ds-img-rec-desc">Custom dimension</span>
              </button>
            ) : (
              <div className="ds-img-rec-custom">
                <code className="ds-img-rec-cmd">/resize(</code>
                <input
                  className="ds-img-rec-dim-input"
                  type="number"
                  min={10}
                  placeholder="e.g. 4000"
                  value={customDim}
                  autoFocus
                  onChange={e => setCustomDim(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') submitCustom();
                    if (e.key === 'Escape') { setShowCustom(false); setCustomDim(''); }
                  }}
                />
                <code className="ds-img-rec-cmd">)</code>
                <button
                  className="ds-img-rec-ok"
                  onClick={submitCustom}
                  disabled={!customDim || parseInt(customDim, 10) < 10}
                >
                  OK
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// DisambiguationCard — shown when a plain message looks like a question/
// discussion but the user hasn't specified whether they want a chat answer
// or a notebook cell.
// ---------------------------------------------------------------------------
interface DisambiguationCardProps {
  originalMessage: string;
  msgId: string;
  onChoice: (mode: 'chat' | 'cell', msgId: string) => void;
}

const DisambiguationCard: React.FC<DisambiguationCardProps> = ({
  originalMessage, msgId, onChoice,
}) => {
  const preview = originalMessage.length > 55
    ? originalMessage.slice(0, 55) + '…'
    : originalMessage;
  const cmdPreview = originalMessage.length > 40
    ? originalMessage.slice(0, 40) + '…'
    : originalMessage;
  return (
    <div className="ds-disambig-card">
      <div className="ds-disambig-header">
        <span className="ds-disambig-icon">❓</span>
        <span className="ds-disambig-title">Where should the answer go?</span>
      </div>
      <div className="ds-disambig-hint">
        <em>"{preview}"</em>
      </div>
      <div className="ds-disambig-options">
        <button
          className="ds-disambig-btn ds-disambig-btn--chat"
          onClick={() => onChoice('chat', msgId)}
          title={`/chat ${originalMessage}`}
        >
          <span className="ds-disambig-btn-icon">💬</span>
          <span className="ds-disambig-btn-body">
            <strong>Answer in chat</strong>
            <code>/chat {cmdPreview}</code>
          </span>
        </button>
        <button
          className="ds-disambig-btn ds-disambig-btn--cell"
          onClick={() => onChoice('cell', msgId)}
          title={originalMessage}
        >
          <span className="ds-disambig-btn-icon">📝</span>
          <span className="ds-disambig-btn-body">
            <strong>Write to notebook</strong>
            <code>{cmdPreview}</code>
          </span>
        </button>
      </div>
    </div>
  );
};

interface PendingOp {
  operationId: string;
  cellIndices: number[];
  steps: OperationStep[];
  description: string;
  diffs: DiffInfo[];
  /**
   * For composite pipeline operations: the individual step operationIds
   * registered in CellEditor, in execution order.  Accept/Undo iterates these.
   */
  compositeOpIds?: string[];
  /** Set after the user resolves the op — keeps the diff visible but collapsed. */
  resolved?: 'accepted' | 'undone';
  /**
   * Whether the plan required approval (auto-execute was held back).
   * When true, handleAccept will run autoExecute:true cells after accepting.
   */
  requiresApproval?: boolean;
}

export interface SidebarProps {
  apiClient: APIClient;
  notebookReader: NotebookReader;
  cellEditor: CellEditor;
  notebookTracker: INotebookTracker;
  /** Open (or focus) a file in the JupyterLab main area by its path. */
  openFile?: (path: string) => void;
  /**
   * Open a file AND reload it from disk — used after an accepted change so the
   * editor reflects the newly-written content rather than the cached version.
   */
  reloadFile?: (path: string) => void;
}

// ---------------------------------------------------------------------------
// External message dispatch
// Allows commands registered in index.ts to send messages into the chat
// without any tight coupling between the widget class and the React tree.
// ---------------------------------------------------------------------------

export interface ExternalMessage {
  /** Text to inject into the chat input (or auto-send). */
  text: string;
  /** When true the message is sent immediately; when false it pre-fills the input. */
  autoSend: boolean;
  /** When true the Tags panel is opened instead of sending a message. */
  openTags?: boolean;
  /**
   * Short human-readable label to show in the chat bubble in place of the full
   * prompt text (which may contain large code blocks). The full text is still
   * sent to the LLM.
   */
  displayText?: string;
  /**
   * Hidden context that is prepended to the user's typed input just before
   * sending to the backend. It is NEVER shown in the textarea or chat bubble.
   * Used by "Edit with AI" to pass the selected snippet + full cell context
   * without cluttering the input box.
   */
  contextPrefix?: string;
  /**
   * Visible chip shown in the input area (and in the sent bubble) so the user
   * knows what code context is attached without seeing the full text.
   */
  contextChip?: { label: string; preview: string };
  /**
   * A specific notebook output selected by the user (right-click → Ask DS
   * Assistant). When present the task request includes this output so the LLM
   * can focus its answer on it.
   */
  selectedOutput?: {
    label:      string;
    mimeType:   string;
    imageData?: string;
    textData?:  string;
    cellIndex:  number;
    outputIndex: number;
  };
}

type ExternalMsgListener = (msg: ExternalMessage) => void;
let _extMsgListener: ExternalMsgListener | null = null;

/** Called by the React component on mount to subscribe. */
export function setExternalMessageListener(fn: ExternalMsgListener | null): void {
  _extMsgListener = fn;
}

/** Called by the widget's sendMessage() method. */
function _dispatchExternalMessage(msg: ExternalMessage): void {
  _extMsgListener?.(msg);
}

// ---------------------------------------------------------------------------
// Non-notebook focus notification
// When the user focuses a non-notebook document (Python file, Markdown, etc.)
// app.shell.currentChanged fires in index.ts and calls dispatchNonNotebookFocus.
// The React component clears the notebook context path (so cells are not sent
// as LLM context) while keeping the chat history visible.
// ---------------------------------------------------------------------------

// filePath is the path of the newly-active non-notebook file (empty string if
// it's not a file-editor widget — e.g. the Settings or Extension Manager panel).
type NonNotebookFocusCb = (filePath: string) => void | Promise<void>;
let _nonNbFocusCb: NonNotebookFocusCb | null = null;

export function setNonNotebookFocusCallback(fn: NonNotebookFocusCb | null): void {
  _nonNbFocusCb = fn;
}

export function dispatchNonNotebookFocus(filePath = ''): void {
  void _nonNbFocusCb?.(filePath);
}

// Called when a notebook tab becomes active in the shell (via activeChanged).
// Needed because notebookTracker.currentChanged does NOT fire when the user
// returns to the SAME notebook they had open before (its currentWidget never
// changed), so we need an independent signal to restore the context path.
type NotebookActivatedCb = (path: string) => void;
let _notebookActivatedCb: NotebookActivatedCb | null = null;

export function setNotebookActivatedCallback(fn: NotebookActivatedCb | null): void {
  _notebookActivatedCb = fn;
}

export function dispatchNotebookActivated(path: string): void {
  _notebookActivatedCb?.(path);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function generateId(): string {
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
const DEFAULT_ZOO: Record<string, string[]> = {
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

const parseZoo = (raw: string): string[] =>
  raw.split(',').map(s => s.trim()).filter(Boolean);

const serializeZoo = (models: string[]): string => models.join(',');

/** Return models from the zoo value, falling back to built-in defaults. */
const getZooModels = (zooKey: string, values: Record<string, string>): string[] => {
  const raw = values[zooKey] ?? '';
  return raw.trim() ? parseZoo(raw) : DEFAULT_ZOO[zooKey] ?? [];
};

interface TabGroup {
  id: string;
  label: string;
  providerKey: string | null;
  zooKey: string | null;
  fields: { key: string; label: string; type: string; placeholder?: string; description?: string }[];
}

const TAB_GROUPS: TabGroup[] = [
  {
    id: 'routing',
    label: 'Routing',
    providerKey: null,
    zooKey: null,
    fields: [
      { key: 'DS_CHAT_PROVIDER',           label: 'Chat',         type: 'select' },
      { key: 'DS_COMPLETION_PROVIDER',     label: 'Completion',   type: 'select' },
      { key: 'DS_EMBED_PROVIDER',          label: 'Embedding',    type: 'select' },
      { key: 'DS_SIMPLE_TASKS_PROVIDER',   label: 'Simple tasks', type: 'select' },
    ]
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    providerKey: 'ANTHROPIC',
    zooKey: 'ANTHROPIC_MODELS',
    fields: [
      { key: 'ANTHROPIC_API_KEY',              label: 'API key',                type: 'password' },
      { key: 'ANTHROPIC_CHAT_MODEL',           label: 'Chat & Agent model',     type: 'model-select' },
      { key: 'VARYS_AGENT_PROMPT_CACHING',     label: 'Prompt caching',         type: 'toggle',
        description: 'Cache prompt context between turns — cuts cost ~70% on long sessions. Supported on claude-3+ models.' },
      { key: 'ANTHROPIC_COMPLETION_MODEL',     label: 'Completion model',       type: 'model-select' },
      { key: 'ANTHROPIC_SIMPLE_TASKS_MODEL',   label: 'Simple tasks model',     type: 'model-select' },
      { key: 'ANTHROPIC_EMBED_MODEL',          label: 'Embedding model',        type: 'model-select' },
      { key: 'ANTHROPIC_EXTENDED_THINKING',    label: 'Extended thinking',      type: 'toggle',
        description: 'Enable Anthropic native extended thinking (claude-3-7+ / claude-4+). The LLM reasons internally before answering — visible in the 🧠 panel. Higher token cost.' },
    ]
  },
  {
    id: 'openai',
    label: 'OpenAI',
    providerKey: 'OPENAI',
    zooKey: 'OPENAI_MODELS',
    fields: [
      { key: 'OPENAI_API_KEY',               label: 'API key',            type: 'password' },
      { key: 'OPENAI_CHAT_MODEL',            label: 'Chat & Agent model', type: 'model-select' },
      { key: 'OPENAI_PROMPT_CACHING',        label: 'Prompt caching',     type: 'toggle',
        description: 'OpenAI automatically caches repeated input prefixes for gpt-4o and newer. Enable to structure prompts for maximum cache reuse.' },
      { key: 'OPENAI_COMPLETION_MODEL',      label: 'Completion model',   type: 'model-select' },
      { key: 'OPENAI_SIMPLE_TASKS_MODEL',    label: 'Simple tasks model', type: 'model-select' },
      { key: 'OPENAI_EMBED_MODEL',           label: 'Embedding model',    type: 'model-select' },
    ]
  },
  {
    id: 'google',
    label: 'Google',
    providerKey: 'GOOGLE',
    zooKey: 'GOOGLE_MODELS',
    fields: [
      { key: 'GOOGLE_API_KEY',               label: 'API key',            type: 'password',
        description: 'For individual developers using the Gemini API directly.' },
      { key: 'GOOGLE_SERVICE_ACCOUNT_JSON',  label: 'Service account JSON', type: 'text',
        placeholder: '/path/to/service_account.json',
        description: 'Path to a GCP service-account JSON file (project_id, private_key, client_email…). When set, takes precedence over the API key.' },
      { key: 'GOOGLE_CHAT_MODEL',            label: 'Chat & Agent model', type: 'model-select' },
      { key: 'GOOGLE_ENABLE_THINKING',       label: 'Enable thinking',    type: 'toggle',
        description: 'Allow Gemini 2.5+ models to use extended reasoning (thinkingBudget). The reasoning trace appears as a collapsible thinking bubble in chat.' },
      { key: 'GOOGLE_THINKING_BUDGET',       label: 'Thinking token budget', type: 'text',
        placeholder: '8192  (use -1 for dynamic)',
        description: 'Max tokens the model may use for internal reasoning. Set to -1 to let the model decide. Only effective when Enable thinking is on and a Gemini 2.5+ model is selected.' },
      { key: 'GOOGLE_PROMPT_CACHING',        label: 'Prompt caching',     type: 'toggle',
        description: 'Context caching for Gemini 1.5+ models. Reduces cost when the same large context is reused across turns.' },
      { key: 'GOOGLE_COMPLETION_MODEL',      label: 'Completion model',   type: 'model-select' },
      { key: 'GOOGLE_SIMPLE_TASKS_MODEL',    label: 'Simple tasks model', type: 'model-select' },
      { key: 'GOOGLE_EMBED_MODEL',           label: 'Embedding model',    type: 'model-select' },
    ]
  },
  {
    id: 'bedrock',
    label: 'Bedrock',
    providerKey: 'BEDROCK',
    zooKey: 'BEDROCK_MODELS',
    fields: [
      { key: 'AWS_PROFILE',                   label: 'AWS profile',           type: 'text', placeholder: 'e.g. default, np  (leave blank for explicit keys)' },
      { key: 'AWS_AUTH_REFRESH',              label: 'Auth refresh command',  type: 'text', placeholder: 'e.g. aws-azure-login --profile ITOSS --no-prompt  (runs only when token is expired)' },
      { key: 'AWS_ACCESS_KEY_ID',             label: 'Access key ID',         type: 'password', placeholder: '(leave blank when using AWS_PROFILE)' },
      { key: 'AWS_SECRET_ACCESS_KEY',         label: 'Secret access key',     type: 'password', placeholder: '(leave blank when using AWS_PROFILE)' },
      { key: 'AWS_SESSION_TOKEN',             label: 'Session token',         type: 'password', placeholder: '(optional)' },
      { key: 'AWS_REGION',                    label: 'Region',                type: 'text', placeholder: 'us-east-1' },
      { key: 'BEDROCK_CHAT_MODEL',            label: 'Chat & Agent model',    type: 'model-select' },
      { key: 'BEDROCK_PROMPT_CACHING',        label: 'Prompt caching',        type: 'toggle',
        description: 'Prompt caching for Anthropic Claude models on Bedrock. Reduces cost on long multi-turn sessions.' },
      { key: 'BEDROCK_COMPLETION_MODEL',      label: 'Completion model',      type: 'model-select' },
      { key: 'BEDROCK_SIMPLE_TASKS_MODEL',    label: 'Simple tasks model',    type: 'model-select' },
      { key: 'BEDROCK_EMBED_MODEL',           label: 'Embedding model',       type: 'model-select' },
      { key: 'BEDROCK_ENABLE_THINKING',       label: 'Extended thinking',     type: 'toggle',
        description: 'Enable extended thinking for Anthropic Claude Sonnet and Opus models. Improves reasoning on complex tasks at the cost of higher latency and token usage.' },
      { key: 'BEDROCK_THINKING_BUDGET',       label: 'Thinking token budget', type: 'text',
        placeholder: '8000  (min 1024, used only when extended thinking is on)' },
      { key: 'BEDROCK_MAX_TOKENS',            label: 'Max output tokens',     type: 'text',
        placeholder: 'leave blank for auto (4096 Haiku 4.5 · 8192 others)' },
    ]
  },
  {
    id: 'azure',
    label: 'Azure',
    providerKey: 'AZURE',
    zooKey: 'AZURE_MODELS',
    fields: [
      { key: 'AZURE_OPENAI_API_KEY',          label: 'API key',                    type: 'password' },
      { key: 'AZURE_OPENAI_ENDPOINT',         label: 'Endpoint URL',               type: 'text', placeholder: 'https://YOUR-RESOURCE.openai.azure.com/' },
      { key: 'AZURE_OPENAI_API_VERSION',      label: 'API version',                type: 'text', placeholder: '2024-02-01' },
      { key: 'AZURE_CHAT_MODEL',              label: 'Chat & Agent deployment',    type: 'model-select' },
      { key: 'AZURE_PROMPT_CACHING',          label: 'Prompt caching',             type: 'toggle',
        description: 'Enable prompt prefix caching for deployments that support it.' },
      { key: 'AZURE_COMPLETION_MODEL',        label: 'Completion deployment',      type: 'model-select' },
      { key: 'AZURE_SIMPLE_TASKS_MODEL',      label: 'Simple tasks deployment',    type: 'model-select' },
      { key: 'AZURE_EMBED_MODEL',             label: 'Embedding deployment',       type: 'model-select' },
    ]
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    providerKey: 'OPENROUTER',
    zooKey: 'OPENROUTER_MODELS',
    fields: [
      { key: 'OPENROUTER_API_KEY',             label: 'API key',              type: 'password' },
      { key: 'OPENROUTER_SITE_URL',            label: 'Site URL (optional)',  type: 'text', placeholder: 'https://your-app.com' },
      { key: 'OPENROUTER_SITE_NAME',           label: 'Site name (optional)', type: 'text', placeholder: 'Varys' },
      { key: 'OPENROUTER_CHAT_MODEL',          label: 'Chat & Agent model',   type: 'model-select' },
      { key: 'OPENROUTER_PROMPT_CACHING',      label: 'Prompt caching',       type: 'toggle',
        description: 'Pass caching hints to providers that support it (e.g., Anthropic models via OpenRouter).' },
      { key: 'OPENROUTER_COMPLETION_MODEL',    label: 'Completion model',     type: 'model-select' },
      { key: 'OPENROUTER_SIMPLE_TASKS_MODEL',  label: 'Simple tasks model',   type: 'model-select' },
      { key: 'OPENROUTER_EMBED_MODEL',         label: 'Embedding model',      type: 'model-select' },
    ]
  },
  {
    id: 'ollama',
    label: 'Ollama',
    providerKey: 'OLLAMA',
    zooKey: 'OLLAMA_MODELS',
    fields: [
      { key: 'OLLAMA_URL',                     label: 'Server URL',         type: 'text', placeholder: 'http://localhost:11434' },
      { key: 'OLLAMA_CHAT_MODEL',              label: 'Chat & Agent model', type: 'model-select' },
      { key: 'OLLAMA_PROMPT_CACHING',          label: 'Prompt caching',     type: 'toggle',
        description: 'Ollama caches KV context natively. Enable to keep the system prompt resident between requests.' },
      { key: 'OLLAMA_COMPLETION_MODEL',        label: 'Completion model',   type: 'model-select' },
      { key: 'OLLAMA_SIMPLE_TASKS_MODEL',      label: 'Simple tasks model', type: 'model-select' },
      { key: 'OLLAMA_EMBED_MODEL',             label: 'Embedding model',    type: 'model-select' },
    ]
  },
];

// ---------------------------------------------------------------------------
// RAGStatusSection — live knowledge-base stats shown on the Knowledge tab
// ---------------------------------------------------------------------------

interface RAGStatusSectionProps {
  apiClient: APIClient;
  notebookPath?: string;
}

const RAGStatusSection: React.FC<RAGStatusSectionProps> = ({ apiClient, notebookPath = '' }) => {
  const [status, setStatus] = useState<{
    available: boolean;
    total_chunks: number;
    indexed_files: number;
    files: string[];
    hint?: string;
  } | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = async () => {
    setLoading(true);
    try {
      const s = await apiClient.ragStatus(notebookPath);
      setStatus(s);
    } catch {
      setStatus(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void refresh(); }, []);

  if (loading) {
    return (
      <div className="ds-rag-status">
        <span className="ds-rag-status-loading">Checking index…</span>
      </div>
    );
  }

  if (!status) return null;

  if (!status.available) {
    return (
      <div className="ds-rag-status ds-rag-status--unavailable">
        <p>⚠️ RAG dependencies not installed.</p>
        <code>{status.hint ?? 'pip install chromadb sentence-transformers'}</code>
      </div>
    );
  }

  return (
    <div className="ds-rag-status">
      <div className="ds-rag-status-header">
        <span className="ds-rag-status-title">📚 Knowledge base</span>
        <button className="ds-rag-status-refresh" onClick={() => void refresh()} title="Refresh">↻</button>
      </div>
      <div className="ds-rag-status-stats">
        <span><strong>{status.total_chunks}</strong> chunks</span>
        <span><strong>{status.indexed_files}</strong> files indexed</span>
      </div>
      {status.indexed_files > 0 && (
        <div className="ds-rag-status-files">
          {status.files.slice(0, 8).map((f: string) => (
            <div key={f} className="ds-rag-status-file" title={f}>
              {f.split('/').pop()}
            </div>
          ))}
          {status.files.length > 8 && (
            <div className="ds-rag-status-file ds-rag-status-file--more">
              +{status.files.length - 8} more…
            </div>
          )}
        </div>
      )}
      {status.indexed_files === 0 && status.available && (
        <div className="ds-rag-status-empty">
          No files indexed yet. Drop files in <code>.jupyter-assistant/knowledge/</code> then run <code>/index</code> in chat.
        </div>
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
// MCPPanel — MCP server management shown on the MCP settings tab
// ---------------------------------------------------------------------------

interface MCPServerInfo {
  status: 'connected' | 'connecting' | 'disconnected' | 'error' | 'disabled';
  error: string;
  tools: string[];
  config: { command: string; args: string[]; env: Record<string, string>; disabled: boolean };
}

const MCPPanel: React.FC<{ apiClient: APIClient }> = ({ apiClient }) => {
  const [servers, setServers] = useState<Record<string, MCPServerInfo>>({});
  const [totalTools, setTotalTools] = useState(0);
  const [configRaw, setConfigRaw] = useState('');
  const [loading, setLoading] = useState(false);
  const [toggling, setToggling] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [pasteJson, setPasteJson] = useState('');
  const [pasteError, setPasteError] = useState('');
  const [expandedTools, setExpandedTools] = useState<Record<string, boolean>>({});
  const [statusMsg, setStatusMsg] = useState<{type: 'ok'|'err'; text: string} | null>(null);

  const refresh = async () => {
    setLoading(true);
    try {
      const s = await apiClient.getMCPStatus();
      setServers(s.servers);
      setTotalTools(s.totalTools);
      setConfigRaw(s.configRaw ?? '');
    } catch (e: unknown) {
      setStatusMsg({ type: 'err', text: `Load failed: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
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
    } catch (e: unknown) {
      setStatusMsg({ type: 'err', text: `Reload failed: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setLoading(false);
    }
  };

  const handleToggle = async (name: string, currentlyDisabled: boolean) => {
    setToggling(name);
    setStatusMsg(null);
    try {
      await apiClient.toggleMCPServer(name, !currentlyDisabled);
      await refresh();
      setStatusMsg({
        type: 'ok',
        text: `Server "${name}" ${currentlyDisabled ? 'enabled' : 'disabled'}.`,
      });
    } catch (e: unknown) {
      setStatusMsg({ type: 'err', text: `Toggle failed: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setToggling(null);
    }
  };

  const handleRetry = async (name: string) => {
    setToggling(name);
    setStatusMsg(null);
    try {
      // Re-run connect() by going disabled→enabled
      await apiClient.toggleMCPServer(name, false);
      await refresh();
      const updated = await apiClient.getMCPStatus();
      const srv = updated.servers[name];
      if (srv?.status === 'connected') {
        setStatusMsg({ type: 'ok', text: `"${name}" connected.` });
      } else {
        setStatusMsg({ type: 'err', text: `"${name}" retry failed: ${srv?.error ?? 'unknown error'}` });
      }
    } catch (e: unknown) {
      setStatusMsg({ type: 'err', text: `Retry failed: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
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
    setPasteError('');
    setStatusMsg(null);
    const raw = pasteJson.trim();
    if (!raw) return;

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>;
    } catch (e: unknown) {
      setPasteError(`Invalid JSON: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }

    // Normalise to { name -> config } regardless of wrapper key
    const entries: Record<string, Record<string, unknown>> =
      ('mcpServers' in parsed && typeof parsed['mcpServers'] === 'object' && parsed['mcpServers'] !== null)
        ? (parsed['mcpServers'] as Record<string, Record<string, unknown>>)
        : (parsed as Record<string, Record<string, unknown>>);

    const names = Object.keys(entries);
    if (names.length === 0) {
      setPasteError('No servers found. Expected at least one entry under "mcpServers".');
      return;
    }

    setAdding(true);
    const added: string[] = [];
    const errors: string[] = [];

    for (const name of names) {
      const cfg = entries[name];
      if (!cfg || typeof cfg !== 'object') { errors.push(`${name}: not an object`); continue; }
      const command  = (cfg['command'] as string ?? '').trim();
      const args     = Array.isArray(cfg['args']) ? (cfg['args'] as string[]) : [];
      const env      = (typeof cfg['env'] === 'object' && cfg['env'] !== null)
                         ? (cfg['env'] as Record<string, string>) : {};
      const disabled = Boolean(cfg['disabled']);

      if (!command) { errors.push(`${name}: missing "command"`); continue; }

      try {
        await apiClient.addMCPServer(name, command, args, env);
        if (disabled) {
          // Newly-added servers default to enabled; disable if the config says so
          await apiClient.toggleMCPServer(name, true);
        }
        added.push(name);
      } catch (e: unknown) {
        errors.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    await refresh();
    setAdding(false);

    if (errors.length === 0) {
      setPasteJson('');
      setStatusMsg({ type: 'ok', text: `Added: ${added.join(', ')}` });
    } else {
      const okPart  = added.length ? `Added: ${added.join(', ')}. ` : '';
      const errPart = `Errors: ${errors.join('; ')}`;
      setStatusMsg({ type: 'err', text: okPart + errPart });
    }
  };

  const handleRemove = async (name: string) => {
    try {
      await apiClient.removeMCPServer(name);
      await refresh();
      setStatusMsg({ type: 'ok', text: `Server "${name}" removed.` });
    } catch (e: unknown) {
      setStatusMsg({ type: 'err', text: `Remove failed: ${e instanceof Error ? e.message : String(e)}` });
    }
  };

  const STATUS_DOT: Record<string, string> = {
    connected: '🟢', connecting: '🟡', disconnected: '⚫', error: '🔴', disabled: '⬜',
  };

  return (
    <div className="ds-mcp-panel">
      <div className="ds-mcp-header">
        <span className="ds-mcp-summary">
          {Object.keys(servers).length} server(s) · {totalTools} tool(s)
        </span>
        <button className="ds-mcp-reload-btn" onClick={() => void handleReload()} disabled={loading}>
          {loading ? '…' : '↺ Reload'}
        </button>
      </div>

      {statusMsg && (
        <div className={`ds-mcp-status ds-mcp-status--${statusMsg.type}`}>{statusMsg.text}</div>
      )}

      {/* Server list */}
      {Object.keys(servers).length === 0 && !loading && (
        <p className="ds-mcp-empty">
          No servers configured. Add one below or edit{' '}
          <code>~/.jupyter/varys-mcp.json</code> directly.
        </p>
      )}

      {Object.entries(servers).map(([name, info]) => {
        const isDisabled = info.config.disabled;
        const isToggling = toggling === name;
        return (
          <div key={name} className={`ds-mcp-server ds-mcp-server--${info.status}${isDisabled ? ' ds-mcp-server--dim' : ''}`}>
            <div className="ds-mcp-server-header">
              <span className="ds-mcp-server-dot" title={info.status}>
                {STATUS_DOT[info.status] ?? '⚫'}
              </span>
              <span className={`ds-mcp-server-name${isDisabled ? ' ds-mcp-server-name--disabled' : ''}`}>{name}</span>
              <span className="ds-mcp-server-cmd" title={`${info.config.command} ${info.config.args.join(' ')}`}>
                {info.config.command} {info.config.args.join(' ')}
              </span>
              {/* Enable / disable toggle */}
              <label
                className="ds-mcp-server-toggle"
                title={isDisabled ? 'Enable server' : 'Disable server (keeps config)'}
              >
                <input
                  type="checkbox"
                  checked={!isDisabled}
                  disabled={isToggling}
                  onChange={() => void handleToggle(name, isDisabled)}
                />
                <span className="ds-mcp-server-toggle-slider" />
              </label>
              <button
                className="ds-mcp-server-remove"
                onClick={() => void handleRemove(name)}
                title="Remove server"
              >✕</button>
            </div>
            {info.error && (
              <div className="ds-mcp-server-error">
                <pre className="ds-mcp-server-error-pre">{info.error}</pre>
                <button
                  className="ds-mcp-retry-btn"
                  disabled={isToggling}
                  onClick={() => void handleRetry(name)}
                  title="Retry connection"
                >
                  {isToggling ? '…' : '↺ Retry'}
                </button>
              </div>
            )}
            {info.tools.length > 0 && (
              <div className="ds-mcp-tools">
                <button
                  className="ds-mcp-tools-toggle"
                  onClick={() => setExpandedTools(p => ({ ...p, [name]: !p[name] }))}
                >
                  {expandedTools[name] ? '▾' : '▸'} {info.tools.length} tool(s)
                </button>
                {expandedTools[name] && (
                  <ul className="ds-mcp-tools-list">
                    {info.tools.map(t => (
                      <li key={t} className="ds-mcp-tool-name">
                        {t.replace(`${name}__`, '')}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
        );
      })}

      {/* Add server — paste JSON */}
      <div className="ds-mcp-add">
        <div className="ds-mcp-add-title">Add server</div>
        <p className="ds-mcp-hint ds-mcp-hint--top">
          Paste the JSON block exactly as provided by Cursor, Claude Desktop, or any MCP
          resource. Both the <code>{"{"}"mcpServers":{"{"}…{"}"}{"}"}</code> wrapper and bare
          {' '}<code>{"{"}"Name":{"{"}…{"}"}{"}"}</code> formats are accepted.
          Multiple servers in one paste are all added at once.
        </p>
        <textarea
          className="ds-mcp-input ds-mcp-paste-textarea"
          placeholder={`{\n  "mcpServers": {\n    "Filesystem": {\n      "command": "npx",\n      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],\n      "env": {},\n      "disabled": false\n    }\n  }\n}`}
          value={pasteJson}
          rows={10}
          spellCheck={false}
          onChange={e => { setPasteJson(e.target.value); setPasteError(''); }}
        />
        {pasteError && (
          <div className="ds-mcp-paste-error">{pasteError}</div>
        )}
        <button
          className="ds-mcp-add-btn"
          onClick={() => void handleAddFromJson()}
          disabled={adding || !pasteJson.trim()}
        >
          {adding ? 'Connecting…' : '+ Add server(s)'}
        </button>
        <p className="ds-mcp-hint">
          Config persisted to <code>~/.jupyter/varys-mcp.json</code>. Disable servers to
          keep their config without running the subprocess.
        </p>
      </div>

      {/* Read-only config viewer */}
      {configRaw && (
        <div className="ds-mcp-config-viewer">
          <div className="ds-mcp-config-viewer-label">~/.jupyter/varys-mcp.json</div>
          <textarea
            className="ds-mcp-config-textarea"
            value={configRaw}
            readOnly
            rows={Math.min(configRaw.split('\n').length + 1, 20)}
            spellCheck={false}
          />
        </div>
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
// ModelZooSection — add/remove model names for a provider
// ---------------------------------------------------------------------------

interface ModelZooProps {
  zooKey: string;
  values: Record<string, string>;
  onChange: (key: string, value: string) => void;
}

const ModelZooSection: React.FC<ModelZooProps> = ({ zooKey, values, onChange }) => {
  const [newModel, setNewModel] = useState('');
  const models = getZooModels(zooKey, values);

  const commit = (updated: string[]) => onChange(zooKey, serializeZoo(updated));

  const handleAdd = () => {
    const name = newModel.trim();
    if (!name || models.includes(name)) return;
    commit([...models, name]);
    setNewModel('');
  };

  const handleRemove = (name: string) => commit(models.filter(m => m !== name));

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') { e.preventDefault(); handleAdd(); }
  };

  return (
    <div className="ds-settings-zoo">
      <div className="ds-settings-zoo-header">
        <span className="ds-settings-zoo-title">Model Zoo</span>
        <span className="ds-settings-zoo-count">{models.length}</span>
      </div>
      <div className="ds-settings-zoo-chips">
        {models.map(m => (
          <span key={m} className="ds-settings-zoo-chip" title={m}>
            <span className="ds-settings-zoo-chip-name">{m}</span>
            <button
              className="ds-settings-zoo-chip-remove"
              onClick={() => handleRemove(m)}
              title={`Remove ${m}`}
            >×</button>
          </span>
        ))}
        {models.length === 0 && (
          <span className="ds-settings-zoo-empty">No models yet — add one below.</span>
        )}
      </div>
      <div className="ds-settings-zoo-add">
        <input
          className="ds-settings-zoo-add-input"
          value={newModel}
          onChange={e => setNewModel(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Type model name and press Enter…"
          autoComplete="off"
          spellCheck={false}
        />
        <button
          className="ds-settings-zoo-add-btn"
          onClick={handleAdd}
          disabled={!newModel.trim() || models.includes(newModel.trim())}
          title="Add to zoo"
        >+ Add</button>
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Nav types, data, and sidebar for vertical settings navigation
// ---------------------------------------------------------------------------

type NavSubItem = { id: string; label: string };
type NavItem    = { id: string; label: string; icon: React.ReactNode; subItems?: NavSubItem[] };
type NavGroup   = { label: string; items: NavItem[] };

const SETTINGS_NAV_GROUPS: NavGroup[] = [
  {
    label: 'LLM',
    items: [
      {
        id: 'model-providers',
        label: 'Model Providers',
        icon: (
          <svg width="15" height="15" viewBox="0 0 15 15" fill="none" stroke="currentColor" strokeWidth="1.3">
            <rect x="1.5" y="1.5" width="5" height="5" rx="1"/>
            <rect x="8.5" y="1.5" width="5" height="5" rx="1"/>
            <rect x="1.5" y="8.5" width="5" height="5" rx="1"/>
            <rect x="8.5" y="8.5" width="5" height="5" rx="1"/>
          </svg>
        ),
        subItems: [
          { id: 'anthropic',  label: 'Anthropic' },
          { id: 'openai',     label: 'OpenAI' },
          { id: 'google',     label: 'Google' },
          { id: 'bedrock',    label: 'Bedrock' },
          { id: 'azure',      label: 'Azure' },
          { id: 'ollama',     label: 'Ollama' },
          { id: 'openrouter', label: 'OpenRouter' },
        ],
      },
      {
        id: 'model-routing',
        label: 'Model Routing',
        icon: (
          <svg width="15" height="15" viewBox="0 0 15 15" fill="none" stroke="currentColor" strokeWidth="1.3">
            <path d="M1 7.5h4M13 4l-4 3.5L13 11M9 4h2a2 2 0 012 2v0M9 11h2a2 2 0 002-2v0"/>
          </svg>
        ),
      },
      {
        id: 'mcp',
        label: 'MCP',
        icon: (
          <svg width="15" height="15" viewBox="0 0 15 15" fill="none" stroke="currentColor" strokeWidth="1.3">
            <circle cx="7.5" cy="7.5" r="2"/>
            <path d="M7.5 1v2M7.5 12v2M1 7.5h2M12 7.5h2M2.9 2.9l1.4 1.4M10.7 10.7l1.4 1.4M2.9 12.1l1.4-1.4M10.7 4.3l1.4-1.4"/>
          </svg>
        ),
      },
    ],
  },
  {
    label: 'Workspace',
    items: [
      {
        id: 'skills',
        label: 'Skills',
        icon: (
          <svg width="15" height="15" viewBox="0 0 15 15" fill="none" stroke="currentColor" strokeWidth="1.3">
            <path d="M7.5 1L9.5 5.5H14L10.5 8.5L11.5 13L7.5 10.5L3.5 13L4.5 8.5L1 5.5H5.5L7.5 1Z"/>
          </svg>
        ),
      },
      {
        id: 'commands',
        label: 'Commands',
        icon: (
          <svg width="15" height="15" viewBox="0 0 15 15" fill="none" stroke="currentColor" strokeWidth="1.3">
            <path d="M3 5l2 2-2 2M7 9h4"/>
          </svg>
        ),
      },
      {
        id: 'indexing',
        label: 'Indexing & Docs',
        icon: (
          <svg width="15" height="15" viewBox="0 0 15 15" fill="none" stroke="currentColor" strokeWidth="1.3">
            <path d="M3 3h9M3 7h9M3 11h5"/>
          </svg>
        ),
      },
      {
        id: 'tags',
        label: 'Tags',
        icon: (
          <svg width="15" height="15" viewBox="0 0 15 15" fill="none" stroke="currentColor" strokeWidth="1.3">
            <path d="M1.5 1.5h5.5l6 6a1 1 0 010 1.4l-4 4a1 1 0 01-1.4 0l-6-6V1.5z"/>
            <circle cx="5" cy="5" r="1" fill="currentColor" stroke="none"/>
          </svg>
        ),
      },
    ],
  },
  {
    label: 'Memory',
    items: [
      {
        id: 'memory',
        label: 'Long-term memory',
        icon: (
          <svg width="15" height="15" viewBox="0 0 15 15" fill="none" stroke="currentColor" strokeWidth="1.3">
            <rect x="1.5" y="4" width="12" height="7" rx="1.5"/>
            <path d="M5 4V2.5M10 4V2.5M5 11v1.5M10 11v1.5"/>
          </svg>
        ),
      },
    ],
  },
  {
    label: 'Analytics',
    items: [
      {
        id: 'usage',
        label: 'Usage',
        icon: (
          <svg width="15" height="15" viewBox="0 0 15 15" fill="none" stroke="currentColor" strokeWidth="1.3">
            <rect x="1" y="9" width="3" height="5" rx="0.5"/>
            <rect x="6" y="5" width="3" height="9" rx="0.5"/>
            <rect x="11" y="1" width="3" height="13" rx="0.5"/>
          </svg>
        ),
      },
    ],
  },
];

const SECTION_HEADING_MAP: Record<string, string> = {
  'model-routing':   'Model Routing',
  'model-providers': 'Model Providers',
  'mcp':             'MCP',
  'skills':          'Skills',
  'commands':        'Commands',
  'indexing':        'Indexing & Docs',
  'tags':            'Tags',
  'memory':          'Long-term memory',
  'usage':           'Usage',
};

const SUB_SECTION_LABEL_MAP: Record<string, string> = {
  anthropic:  'Anthropic',
  openai:     'OpenAI',
  google:     'Google',
  bedrock:    'Bedrock',
  azure:      'Azure',
  ollama:     'Ollama',
  openrouter: 'OpenRouter',
};

const SettingsSidebar: React.FC<{
  activeSection: string;
  activeSubSection: string | null;
  providerStatuses: Record<string, boolean>;
  onNavigate: (section: string, subSection: string | null) => void;
}> = ({ activeSection, activeSubSection, providerStatuses, onNavigate }) => (
  <div className="ds-settings-nav-sidebar">
    <div className="ds-settings-nav-title">Settings</div>
    {SETTINGS_NAV_GROUPS.map((group, gi) => (
      <React.Fragment key={group.label}>
        {gi > 0 && <div className="ds-settings-nav-divider" />}
        <div className={`ds-settings-nav-group-label${gi === 0 ? ' ds-settings-nav-group-label--first' : ''}`}>
          {group.label}
        </div>
        {group.items.map(item => {
          const isActive = activeSection === item.id;
          const handleClick = () => {
            const defaultSub = item.subItems?.[0]?.id ?? null;
            const sub = isActive && activeSubSection ? activeSubSection : defaultSub;
            onNavigate(item.id, sub);
          };
          return (
            <React.Fragment key={item.id}>
              <button
                className={`ds-settings-nav-item${isActive ? ' ds-settings-nav-item--active' : ''}`}
                onClick={handleClick}
                tabIndex={0}
                onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleClick(); } }}
              >
                <span className="ds-settings-nav-item-icon">{item.icon}</span>
                <span className="ds-settings-nav-item-label">{item.label}</span>
              </button>
              {isActive && item.subItems?.map(sub => {
                const isSubActive = activeSubSection === sub.id;
                const connected = providerStatuses[sub.id] === true;
                return (
                  <button
                    key={sub.id}
                    className={`ds-settings-nav-sub-item${isSubActive ? ' ds-settings-nav-sub-item--active' : ''}`}
                    onClick={() => onNavigate(item.id, sub.id)}
                    tabIndex={0}
                    onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onNavigate(item.id, sub.id); } }}
                  >
                    <span
                      className="ds-settings-nav-dot"
                      style={{ background: connected ? '#1D9E75' : 'var(--ds-border)' }}
                    />
                    {sub.label}
                  </button>
                );
              })}
            </React.Fragment>
          );
        })}
      </React.Fragment>
    ))}
  </div>
);

const SectionHeading: React.FC<{ section: string; subSection: string | null }> = ({ section, subSection }) => {
  const heading = SECTION_HEADING_MAP[section] ?? section;
  const sub = subSection ? (SUB_SECTION_LABEL_MAP[subSection] ?? subSection) : null;
  return (
    <div className="ds-settings-section-heading">
      <span className="ds-settings-section-heading-main">{heading}</span>
      {sub && (
        <>
          <span className="ds-settings-section-heading-sep"> · </span>
          <span className="ds-settings-section-heading-sub">{sub}</span>
        </>
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
// SettingsPanel
// ---------------------------------------------------------------------------

const ROUTING_KEYS = [
  'DS_CHAT_PROVIDER',
  'DS_COMPLETION_PROVIDER',
  'DS_EMBED_PROVIDER',
  'DS_SIMPLE_TASKS_PROVIDER',
] as const;

const ModelsPanel: React.FC<{
  apiClient: APIClient;
  onClose: () => void;
  onSaved?: () => void;
  notebookPath?: string;
  section?: string;
  subSection?: string | null;
  onProviderStatusChange?: (statuses: Record<string, boolean>) => void;
}> = ({
  apiClient,
  onClose,
  onSaved,
  notebookPath = '',
  section = 'model-routing',
  subSection = null,
  onProviderStatusChange,
}) => {
  const [values, setValues] = useState<Record<string, string>>({});
  const [masked, setMasked] = useState<Record<string, boolean>>({});
  const [envPath, setEnvPath] = useState('');
  const [envExists, setEnvExists] = useState(false);
  const [envPathIsCustom, setEnvPathIsCustom] = useState(false);
  const [newEnvPath, setNewEnvPath] = useState('');
  const [editingEnvPath, setEditingEnvPath] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [toolSupport, setToolSupport]               = useState<{ supported: boolean; reason: string | null } | null>(null);
  const [checkingToolSupport, setCheckingToolSupport] = useState(false);

  useEffect(() => {
    apiClient
      .getSettings()
      .then(data => {
        const v: Record<string, string> = {};
        const m: Record<string, boolean> = {};
        for (const [k, entry] of Object.entries(data)) {
          if (k.startsWith('_')) continue;
          const e = entry as { value: string; masked: boolean };
          v[k] = e.value ?? '';
          m[k] = e.masked ?? false;
        }
        // Pre-seed zoo defaults so dropdowns always have options
        for (const zooKey of Object.keys(DEFAULT_ZOO)) {
          if (!v[zooKey]) v[zooKey] = DEFAULT_ZOO[zooKey].join(',');
        }
        setValues(v);
        setMasked(m);
        setEnvPath(String((data as any)._env_path ?? ''));
        setEnvExists(Boolean((data as any)._env_exists));
        setEnvPathIsCustom(Boolean((data as any)._env_path_is_custom));
        setLoading(false);
      })
      .catch(err => {
        setStatus({ type: 'error', text: `Failed to load: ${err}` });
        setLoading(false);
      });
  }, [apiClient]);

  // Report active routing providers to the sidebar so status dots stay current
  useEffect(() => {
    if (!onProviderStatusChange) return;
    const statuses: Record<string, boolean> = {};
    for (const key of ROUTING_KEYS) {
      const val = (values[key] ?? '').trim().toLowerCase();
      if (val) statuses[val] = true;
    }
    onProviderStatusChange(statuses);
  }, [values, onProviderStatusChange]);

  // Derive the chat model key for the currently-displayed provider tab
  const CHAT_MODEL_KEYS: Record<string, string> = {
    anthropic:  'ANTHROPIC_CHAT_MODEL',
    openai:     'OPENAI_CHAT_MODEL',
    google:     'GOOGLE_CHAT_MODEL',
    bedrock:    'BEDROCK_CHAT_MODEL',
    azure:      'AZURE_CHAT_MODEL',
    ollama:     'OLLAMA_CHAT_MODEL',
    openrouter: 'OPENROUTER_CHAT_MODEL',
  };
  const chatModelKey   = section !== 'model-routing' ? (CHAT_MODEL_KEYS[subSection ?? 'anthropic'] ?? null) : null;
  const chatModelValue = chatModelKey ? (values[chatModelKey] ?? '').trim() : '';

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
    apiClient.checkToolSupport(subSection ?? 'anthropic', chatModelValue)
      .then(r => { if (!cancelled) { setToolSupport(r); setCheckingToolSupport(false); } })
      .catch(() => { if (!cancelled) { setToolSupport(null); setCheckingToolSupport(false); } });
    return () => { cancelled = true; };
  }, [chatModelKey, chatModelValue, subSection, apiClient]);

  const handleChange = (key: string, value: string) => {
    setValues(v => ({ ...v, [key]: value }));
    if (masked[key]) setMasked(m => ({ ...m, [key]: false }));
  };

  const _validateBeforeSave = (): string | null => {
    const PROVIDER_API_KEYS: Record<string, string> = {
      ANTHROPIC:   'ANTHROPIC_API_KEY',
      OPENAI:      'OPENAI_API_KEY',
      GOOGLE:      'GOOGLE_API_KEY',
      AZURE:       'AZURE_OPENAI_API_KEY',
      OPENROUTER:  'OPENROUTER_API_KEY',
      // BEDROCK is intentionally absent: it supports profile-based auth via
      // AWS_PROFILE / ~/.aws/credentials with no explicit key required.
    };
    const PROVIDER_MODEL_KEYS: Record<string, Record<string, string>> = {
      ANTHROPIC:   { chat: 'ANTHROPIC_CHAT_MODEL',    completion: 'ANTHROPIC_COMPLETION_MODEL' },
      OPENAI:      { chat: 'OPENAI_CHAT_MODEL',        completion: 'OPENAI_COMPLETION_MODEL' },
      GOOGLE:      { chat: 'GOOGLE_CHAT_MODEL',        completion: 'GOOGLE_COMPLETION_MODEL' },
      AZURE:       { chat: 'AZURE_CHAT_MODEL',         completion: 'AZURE_COMPLETION_MODEL' },
      OPENROUTER:  { chat: 'OPENROUTER_CHAT_MODEL',   completion: 'OPENROUTER_COMPLETION_MODEL' },
      BEDROCK:     { chat: 'BEDROCK_CHAT_MODEL',       completion: 'BEDROCK_COMPLETION_MODEL' },
      OLLAMA:      { chat: 'OLLAMA_CHAT_MODEL',        completion: 'OLLAMA_COMPLETION_MODEL' },
    };

    const chatProvider = (values['DS_CHAT_PROVIDER'] ?? '').toUpperCase();
    const completionProvider = (values['DS_COMPLETION_PROVIDER'] ?? '').toUpperCase();

    // Check that chat provider is set
    if (!chatProvider) {
      return 'DS_CHAT_PROVIDER is empty. Select a provider for Chat in the Routing tab.';
    }

    // Check API key for chat provider (skip Ollama — no key needed)
    if (chatProvider in PROVIDER_API_KEYS) {
      const keyField = PROVIDER_API_KEYS[chatProvider];
      const keyVal = (values[keyField] ?? '').trim();
      if (!keyVal || keyVal === '••••••••') {
        return `${keyField} is empty. Set the API key for ${chatProvider} in its tab.`;
      }
    }

    // Check chat model
    const chatModelKey = PROVIDER_MODEL_KEYS[chatProvider]?.['chat'];
    if (chatModelKey && !(values[chatModelKey] ?? '').trim()) {
      return `${chatModelKey} is empty. Select a chat model for ${chatProvider}.`;
    }

    // If a completion provider is set, validate it too
    if (completionProvider) {
      if (completionProvider in PROVIDER_API_KEYS) {
        const keyField = PROVIDER_API_KEYS[completionProvider];
        const keyVal = (values[keyField] ?? '').trim();
        if (!keyVal || keyVal === '••••••••') {
          return `${keyField} is empty. Set the API key for ${completionProvider} in its tab.`;
        }
      }
      const completionModelKey = PROVIDER_MODEL_KEYS[completionProvider]?.['completion'];
      if (completionModelKey && !(values[completionModelKey] ?? '').trim()) {
        return `${completionModelKey} is empty. Select a completion model for ${completionProvider}.`;
      }
    }

    return null;
  };

  const handleSave = async () => {
    setStatus(null);
    const validationError = _validateBeforeSave();
    if (validationError) {
      setStatus({ type: 'error', text: validationError });
      return;
    }
    setSaving(true);
    try {
      const payload: Record<string, string> = { ...values };
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
      } else {
        if (editingEnvPath && newEnvPath.trim()) {
          setEnvPath(newEnvPath.trim());
          setEnvPathIsCustom(true);
          setEnvExists(true);
          setEditingEnvPath(false);
          setNewEnvPath('');
        }
        setStatus({
          type: 'success',
          text: `Saved ${(result.updated ?? []).length} setting(s). Active immediately.`
        });
        onSaved?.();
      }
    } catch (err) {
      setStatus({ type: 'error', text: `Save failed: ${err}` });
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <div className="ds-settings-loading">Loading settings…</div>;
  }

  const currentGroup = section === 'model-routing'
    ? (TAB_GROUPS.find(g => g.id === 'routing') ?? TAB_GROUPS[0])
    : (TAB_GROUPS.find(g => g.id === (subSection ?? 'anthropic')) ?? TAB_GROUPS[1]);

  const TASK_LABELS: Record<string, string> = {
    DS_CHAT_PROVIDER:           'Chat',
    DS_COMPLETION_PROVIDER:     'Completion',
    DS_EMBED_PROVIDER:          'Embedding',
    DS_SIMPLE_TASKS_PROVIDER:   'Simple tasks',
  };

  return (
    <div className="ds-settings-panel">
      {/* Content */}
      <div className="ds-settings-tab-content">
        {section === 'model-routing' ? (
          <>
            <div className="ds-settings-routing-grid">
              {currentGroup.fields.map(field => (
                <React.Fragment key={field.key}>
                  <label className="ds-settings-label">{TASK_LABELS[field.key] ?? field.label}</label>
                  {field.key === 'DS_COMPLETION_PROVIDER' ? (
                    <div className="ds-settings-routing-controls">
                      <select
                        className="ds-settings-select"
                        value={values[field.key] ?? ''}
                        onChange={e => handleChange(field.key, e.target.value)}
                      >
                        <option value="">— select provider —</option>
                        {PROVIDER_LIST.map(p => (
                          <option key={p} value={p}>{p}</option>
                        ))}
                      </select>
                      <label className="ds-settings-token-label" title="Max tokens returned per completion">
                        Tokens
                        <input
                          className="ds-settings-token-input"
                          type="number"
                          min={16}
                          max={2048}
                          step={16}
                          value={values['COMPLETION_MAX_TOKENS'] ?? '128'}
                          onChange={e => handleChange('COMPLETION_MAX_TOKENS', e.target.value)}
                          title="Max tokens returned per completion (default: 128)"
                        />
                      </label>
                    </div>
                  ) : (
                    <select
                      className="ds-settings-select"
                      value={values[field.key] ?? ''}
                      onChange={e => handleChange(field.key, e.target.value)}
                    >
                      <option value="">— select provider —</option>
                      {PROVIDER_LIST.map(p => (
                        <option key={p} value={p}>{p}</option>
                      ))}
                    </select>
                  )}
                </React.Fragment>
              ))}
            </div>
            <p className="ds-settings-simple-tasks-note">
              <strong>Simple tasks</strong> powers background work: long-term memory
              inference, preference extraction, and LLM prose summarization of large
              markdown cells (&gt;2 000 chars). Without a configured Simple Tasks model,
              large markdown cells are <em>truncated at a sentence boundary</em> rather
              than summarized.
            </p>
          </>
        ) : (
          <>
            {currentGroup.fields.map(field => {
              if (field.type === 'model-select') {
                const zoo = currentGroup.zooKey ? getZooModels(currentGroup.zooKey, values) : [];
                const cur = values[field.key] ?? '';
                const options = cur && !zoo.includes(cur) ? [cur, ...zoo] : zoo;
                const isEmpty = !cur;
                const isChatModel = field.key === chatModelKey;
                return (
                  <React.Fragment key={field.key}>
                    <div className="ds-settings-row">
                      <label className="ds-settings-label">
                        {field.label}
                        {isEmpty && <span className="ds-settings-required" title="Required"> *</span>}
                      </label>
                      <select
                        className={`ds-settings-select${isEmpty ? ' ds-settings-select--empty' : ''}`}
                        value={cur}
                        onChange={e => handleChange(field.key, e.target.value)}
                      >
                        <option value="">
                          {options.length === 0 ? '— add models to zoo below —' : '— select model —'}
                        </option>
                        {options.map(m => (
                          <option key={m} value={m}>{m}</option>
                        ))}
                      </select>
                    </div>
                    {isChatModel && cur && (
                      <div className="ds-settings-tool-indicator">
                        {checkingToolSupport ? (
                          <span className="ds-agent-prov-tool-checking">Checking tool support…</span>
                        ) : toolSupport === null ? null : toolSupport.supported ? (
                          <span className="ds-agent-prov-tool-ok">✓ Tool calling supported</span>
                        ) : (
                          <span className="ds-agent-prov-tool-warn">
                            ⚠ Tool calling not supported{toolSupport.reason ? ` — ${toolSupport.reason}` : ''}
                          </span>
                        )}
                      </div>
                    )}
                  </React.Fragment>
                );
              }
              if (field.type === 'toggle') {
                const isOn = (values[field.key] ?? 'true') !== 'false';
                return (
                  <div key={field.key} className="ds-settings-row ds-settings-row--toggle">
                    <div className="ds-settings-toggle-label-group">
                      <span className="ds-settings-label">{field.label}</span>
                      {field.description && (
                        <span className="ds-settings-toggle-desc">{field.description}</span>
                      )}
                    </div>
                    <label className="ds-settings-toggle-switch" title={isOn ? 'Click to disable' : 'Click to enable'}>
                      <input
                        type="checkbox"
                        checked={isOn}
                        onChange={e => handleChange(field.key, e.target.checked ? 'true' : 'false')}
                      />
                      <span className="ds-settings-toggle-slider" />
                    </label>
                  </div>
                );
              }
              return (
                <div key={field.key} className="ds-settings-row">
                  <label className="ds-settings-label">{field.label}</label>
                  <input
                    className="ds-settings-input"
                    type={field.type === 'password' && masked[field.key] ? 'password' : 'text'}
                    value={values[field.key] ?? ''}
                    onChange={e => handleChange(field.key, e.target.value)}
                    placeholder={field.type === 'password' ? '(unchanged)' : (field.placeholder ?? '')}
                    autoComplete="off"
                  />
                </div>
              );
            })}

            {/* Model zoo — shown on provider tabs that have a zoo */}
            {currentGroup.zooKey && (
              <ModelZooSection
                zooKey={currentGroup.zooKey}
                values={values}
                onChange={handleChange}
              />
            )}
          </>
        )}
      </div>

      {/* Sticky footer */}
      <div className="ds-settings-footer">
        {status && (
          <div className={`ds-settings-status ds-settings-status-${status.type}`}>
            {status.text}
          </div>
        )}
        <div className="ds-settings-path">
          {editingEnvPath ? (
            <div className="ds-settings-path-edit">
              <input
                className="ds-settings-path-input"
                type="text"
                value={newEnvPath}
                placeholder={envPath}
                onChange={e => setNewEnvPath(e.target.value)}
                autoFocus
              />
              <button
                className="ds-settings-path-cancel-btn"
                onClick={() => { setEditingEnvPath(false); setNewEnvPath(''); }}
                title="Cancel"
              >✕</button>
            </div>
          ) : (
            <span
              className={`ds-settings-path-text${envPathIsCustom ? ' ds-settings-path-custom' : ''}`}
              title={envExists ? envPath : `Will be created: ${envPath}`}
            >
              {envExists ? envPath : `Will create: ${envPath}`}
              <button
                className="ds-settings-path-edit-btn"
                onClick={() => { setEditingEnvPath(true); setNewEnvPath(envPath); }}
                title="Change .env file location"
              >✎</button>
            </span>
          )}
        </div>
        <div className="ds-settings-actions">
          <button
            className="ds-settings-save-btn"
            onClick={() => void handleSave()}
            disabled={saving}
          >
            {saving ? 'Saving…' : 'Save & Apply'}
          </button>
          <button className="ds-settings-cancel-btn" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// SkillsPanel
// ---------------------------------------------------------------------------

interface SkillEntry { name: string; enabled: boolean; }
interface BundledSkillEntry { name: string; command: string | null; description: string | null; imported: boolean; }

const SkillsPanel: React.FC<{ apiClient: APIClient; notebookPath?: string }> = ({ apiClient, notebookPath = '' }) => {
  const [skills, setSkills]             = useState<SkillEntry[]>([]);
  const [skillsDir, setSkillsDir]       = useState('');
  const [loading, setLoading]           = useState(true);
  const [refreshing, setRefreshing]     = useState(false);
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [editorTab, setEditorTab]       = useState<'skill' | 'readme'>('skill');
  const [editContent, setEditContent]   = useState('');
  const [editReadme, setEditReadme]     = useState('');
  const [dirty, setDirty]               = useState(false);
  const [saving, setSaving]             = useState(false);
  const [saveStatus, setSaveStatus]     = useState<'ok' | 'err' | null>(null);
  const [saveError, setSaveError]       = useState<string>('');
  const [newName, setNewName]           = useState('');
  const [creatingNew, setCreatingNew]   = useState(false);

  // Bundled skill library
  const [libraryOpen, setLibraryOpen]       = useState(false);
  const [library, setLibrary]               = useState<BundledSkillEntry[]>([]);
  const [libraryLoading, setLibraryLoading] = useState(false);
  const [importing, setImporting]           = useState<string | null>(null);
  const [skillError, setSkillError]         = useState<string | null>(null);

  // Resizable splitter
  const [listWidth, setListWidth] = useState(160);
  const panelRef   = useRef<HTMLDivElement>(null);
  const dragging   = useRef(false);

  const onSplitterMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    dragging.current = true;
    const onMove = (ev: MouseEvent) => {
      if (!dragging.current || !panelRef.current) return;
      const rect = panelRef.current.getBoundingClientRect();
      const newW = Math.min(Math.max(ev.clientX - rect.left, 80), rect.width - 80);
      setListWidth(newW);
    };
    const onUp = () => {
      dragging.current = false;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
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
    } catch { /* ignore */ }
    finally { setRefreshing(false); }
  };

  const handleEdit = async (name: string) => {
    try {
      const d = await apiClient.getSkillContent(name, notebookPath);
      setSelectedName(name);
      setEditContent(d.content);
      setEditReadme(d.readme ?? '');
      setEditorTab('skill');
      setDirty(false);
      setSaveStatus(null);
    } catch { /* ignore */ }
  };

  const handleToggle = async (name: string, enabled: boolean) => {
    setSkills(prev => prev.map(s => s.name === name ? { ...s, enabled } : s));
    try {
      await apiClient.saveSkill(name, { enabled }, notebookPath);
    } catch {
      setSkills(prev => prev.map(s => s.name === name ? { ...s, enabled: !enabled } : s));
    }
  };

  const handleSaveContent = async () => {
    if (!selectedName) return;
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
    } catch (e: any) {
      setSaveStatus('err');
      setSaveError(e?.message || 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const handleCreateNew = async () => {
    const name = newName.trim().replace(/\s+/g, '_').replace(/[^\w\-]/g, '');
    if (!name) return;
    const starter = `# ${name.replace(/_/g, ' ')}\n\nDescribe this skill here.\n`;
    const readme  = `# ${name.replace(/_/g, ' ')}\n\nDocumentation for the **${name}** skill.\n\n## Purpose\n\n...\n`;
    try {
      await apiClient.saveSkill(name, { content: starter, readme, enabled: true }, notebookPath);
      setSkills(prev => [...prev, { name, enabled: true }]);
      setNewName('');
      setCreatingNew(false);
      await handleEdit(name);
    } catch { /* ignore */ }
  };

  const handleToggleLibrary = async () => {
    const willOpen = !libraryOpen;
    setLibraryOpen(willOpen);
    if (willOpen && library.length === 0) {
      setLibraryLoading(true);
      try {
        const d = await apiClient.getBundledSkills(notebookPath);
        setLibrary(d.bundled);
      } catch { /* ignore */ } finally { setLibraryLoading(false); }
    }
  };

  const handleImport = async (name: string) => {
    setImporting(name);
    try {
      const result = await apiClient.importBundledSkill(name, notebookPath);
      if (result.status === 'ok' || result.status === 'already_exists') {
        // Re-fetch the authoritative list from the backend so the checkmark
        // reflects the actual on-disk state rather than optimistic local state.
        try {
          const fresh = await apiClient.getBundledSkills(notebookPath);
          setLibrary(fresh.bundled);
        } catch {
          // Fallback: update locally if the re-fetch fails.
          setLibrary(prev => prev.map(b => b.name === name ? { ...b, imported: true } : b));
        }
        setSkills(prev => prev.some(s => s.name === name) ? prev : [...prev, { name, enabled: true }]);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setSkillError(`Import of "${name}" failed: ${msg}`);
    } finally {
      setImporting(null);
    }
  };

  return (
    <div className="ds-skills-panel" ref={panelRef}>
      {/* ── Left: skill list ── */}
      <div className="ds-skills-list" style={{ width: listWidth, minWidth: 80, maxWidth: undefined, flexShrink: 0 }}>
        <div className="ds-skills-list-header">
          <span className="ds-skills-list-title">Skills</span>
          <button
            className={`ds-skills-refresh-btn${refreshing ? ' ds-skills-refresh-btn--spinning' : ''}`}
            onClick={() => void handleRefresh()}
            disabled={refreshing}
            title="Reload all skill files from disk"
          >↺</button>
        </div>
        {loading ? (
          <div className="ds-skills-empty">Loading…</div>
        ) : skills.length === 0 ? (
          <div className="ds-skills-empty">
            No skills yet.{'\n'}{skillsDir}
          </div>
        ) : (
          skills.map(skill => (
            <div
              key={skill.name}
              className={`ds-skill-row${selectedName === skill.name ? ' ds-skill-row--active' : ''}`}
              onClick={() => void handleEdit(skill.name)}
              title="Click to edit"
            >
              <span className="ds-skill-name" title={skill.name}>{skill.name}</span>
              {/* iOS-style toggle — stop propagation so clicking toggle doesn't open editor */}
              <button
                role="switch"
                aria-checked={skill.enabled}
                className={`ds-skill-toggle${skill.enabled ? ' ds-skill-toggle--on' : ''}`}
                onClick={e => { e.stopPropagation(); void handleToggle(skill.name, !skill.enabled); }}
                title={skill.enabled ? 'Enabled — click to disable' : 'Disabled — click to enable'}
              />
            </div>
          ))
        )}

        {/* Add new skill row */}
        {creatingNew ? (
          <div className="ds-skill-new-row">
            <input
              className="ds-skill-new-input"
              value={newName}
              onChange={e => setNewName(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') void handleCreateNew(); if (e.key === 'Escape') setCreatingNew(false); }}
              placeholder="skill_name"
              autoFocus
              spellCheck={false}
            />
            <button className="ds-skill-new-ok" onClick={() => void handleCreateNew()} title="Create">✓</button>
            <button className="ds-skill-new-cancel" onClick={() => setCreatingNew(false)} title="Cancel">✕</button>
          </div>
        ) : (
          <button className="ds-skill-add-btn" onClick={() => setCreatingNew(true)}>+ New skill</button>
        )}

        {/* ── Bundled skill library ── */}
        <div className="ds-skill-library">
          <button
            className="ds-skill-library-header"
            onClick={() => void handleToggleLibrary()}
            title="Browse factory-default skills bundled with the extension"
          >
            <span className="ds-skill-library-chevron">{libraryOpen ? '▾' : '▸'}</span>
            <span>📦 Skill Library</span>
          </button>

          {libraryOpen && (
            <div className="ds-skill-library-body">
              {skillError && (
                <div className="ds-skill-library-error" role="alert">
                  <span>⚠ {skillError}</span>
                  <button className="ds-skill-library-error-close" onClick={() => setSkillError(null)} title="Dismiss">✕</button>
                </div>
              )}
              {libraryLoading ? (
                <div className="ds-skill-library-msg">Loading…</div>
              ) : library.length === 0 ? (
                <div className="ds-skill-library-msg">No bundled skills found.</div>
              ) : (
                library.map(b => (
                  <div
                    key={b.name}
                    className={`ds-skill-library-row${b.imported ? ' ds-skill-library-row--imported' : ''}`}
                  >
                    <div className="ds-skill-library-info">
                      <span className="ds-skill-library-name">{b.name}</span>
                      {b.command && <span className="ds-skill-library-cmd">{b.command}</span>}
                      {b.description && <span className="ds-skill-library-desc">{b.description}</span>}
                    </div>
                    {b.imported ? (
                      <span className="ds-skill-library-check" title="Already in your project">✓</span>
                    ) : (
                      <button
                        className="ds-skill-library-import-btn"
                        onClick={() => void handleImport(b.name)}
                        disabled={importing === b.name}
                        title={`Import ${b.name} into this project`}
                      >{importing === b.name ? '…' : '↓ Import'}</button>
                    )}
                  </div>
                ))
              )}
            </div>
          )}
        </div>
      </div>

      {/* ── Drag splitter ── */}
      <div className="ds-skills-splitter" onMouseDown={onSplitterMouseDown} title="Drag to resize" />

      {/* ── Right: editor ── */}
      <div className="ds-skill-editor">
        {!selectedName ? (
          <div className="ds-skill-editor-placeholder">
            <span>Click a skill to edit it</span>
          </div>
        ) : (
          <>
            {/* Tab bar */}
            <div className="ds-skill-editor-tabs">
              <button
                className={`ds-skill-editor-tab${editorTab === 'skill' ? ' ds-skill-editor-tab--active' : ''}`}
                onClick={() => {
                  if (dirty && !window.confirm('Discard unsaved changes?')) return;
                  setEditorTab('skill'); setDirty(false); setSaveStatus(null); setSaveError('');
                }}
              >SKILL.md</button>
              <button
                className={`ds-skill-editor-tab${editorTab === 'readme' ? ' ds-skill-editor-tab--active' : ''}`}
                onClick={() => {
                  if (dirty && !window.confirm('Discard unsaved changes?')) return;
                  setEditorTab('readme'); setDirty(false); setSaveStatus(null); setSaveError('');
                }}
              >README.md</button>
              <div className="ds-skill-editor-tabs-spacer" />
              {dirty && <span className="ds-skill-editor-dirty" title="Unsaved changes">●</span>}
              {saveStatus === 'ok'  && <span className="ds-skill-editor-saved">✓ Saved</span>}
              {saveStatus === 'err' && <span className="ds-skill-editor-error" title={saveError}>✗ {saveError || 'Error'}</span>}
              <button
                className="ds-skill-editor-save-btn"
                onClick={() => void handleSaveContent()}
                disabled={saving || !dirty}
                title="Save (Ctrl+S)"
              >{saving ? '…' : 'Save'}</button>
            </div>
            {/* Filename hint */}
            <div className="ds-skill-editor-filepath">
              {selectedName}/{editorTab === 'skill' ? 'SKILL.md' : 'README.md'}
            </div>
            <textarea
              key={`${selectedName}-${editorTab}`}
              className="ds-skill-editor-textarea"
              value={editorTab === 'skill' ? editContent : editReadme}
              onChange={e => {
                if (editorTab === 'skill') setEditContent(e.target.value);
                else setEditReadme(e.target.value);
                setDirty(true);
                setSaveStatus(null);
              }}
              spellCheck={false}
              placeholder={editorTab === 'readme' ? 'No README.md yet — start writing user documentation here…' : ''}
              onKeyDown={e => {
                if (e.key === 's' && (e.ctrlKey || e.metaKey)) {
                  e.preventDefault();
                  void handleSaveContent();
                }
              }}
            />
          </>
        )}
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// CommandsPanel — live list of all slash commands (builtins + skills)
// ---------------------------------------------------------------------------

const CommandsPanel: React.FC<{ apiClient: APIClient }> = ({ apiClient }) => {
  const [cmds, setCmds] = useState<SlashCommand[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = () => {
    setLoading(true);
    apiClient.getCommands()
      .then(list => { setCmds(list); setLoading(false); })
      .catch(() => { setLoading(false); });
  };

  useEffect(() => { refresh(); }, [apiClient]);

  const byCmd = (a: SlashCommand, b: SlashCommand) => a.command.localeCompare(b.command);
  const builtins = cmds.filter(c => c.type === 'builtin').sort(byCmd);
  const skills   = cmds.filter(c => c.type === 'skill').sort(byCmd);

  return (
    <div className="ds-commands-panel">
      <div className="ds-commands-toolbar">
        <span className="ds-commands-count">{cmds.length} commands</span>
        <button className="ds-commands-refresh-btn" onClick={refresh} title="Reload commands">
          {loading ? '…' : '↻'}
        </button>
      </div>

      <div className="ds-commands-section">
        <div className="ds-commands-section-title">Built-in</div>
        {builtins.map(c => (
          <div key={c.command} className="ds-commands-row">
            <code className="ds-commands-name">{c.command}</code>
            <span className="ds-commands-desc">{c.description}</span>
          </div>
        ))}
      </div>

      {skills.length > 0 && (
        <div className="ds-commands-section">
          <div className="ds-commands-section-title">Skills</div>
          {skills.map(c => (
            <div key={c.command} className="ds-commands-row">
              <code className="ds-commands-name">{c.command}</code>
              <span className="ds-commands-desc">{c.description}</span>
              {c.skill_name && (
                <span className="ds-commands-skill-badge" title={`From skill: ${c.skill_name}`}>
                  {c.skill_name}
                </span>
              )}
            </div>
          ))}
        </div>
      )}

      {!loading && skills.length === 0 && (
        <p className="ds-commands-empty">
          No skill commands loaded yet. Import or create a skill with a <code>/command</code> in its front matter.
        </p>
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
// IndexingPanel — Indexing & Docs top-level tab
// ---------------------------------------------------------------------------

const IndexingPanel: React.FC<{ apiClient: APIClient; notebookPath: string }> = ({
  apiClient, notebookPath,
}) => {
  const [embedProvider, setEmbedProvider] = useState('');
  const [embedModel, setEmbedModel]       = useState('');

  useEffect(() => {
    apiClient.getSettings().then(raw => {
      // Normalize: entries are {value, masked} objects
      const s: Record<string, string> = {};
      for (const [k, entry] of Object.entries(raw)) {
        if (!k.startsWith('_')) s[k] = (entry as { value: string }).value ?? String(entry);
      }
      const p = (s['DS_EMBED_PROVIDER'] ?? '').toUpperCase();
      setEmbedProvider(p);
      setEmbedModel(p ? (s[`${p}_EMBED_MODEL`] ?? '') : '');
    }).catch(() => { /* ignore */ });
  }, []);

  return (
    <div className="ds-settings-tab-content ds-indexing-panel">
      {/* Embed routing summary */}
      <div className="ds-rag-routing-summary">
        <div className="ds-rag-routing-row">
          <span className="ds-rag-routing-label">Embedding provider</span>
          <span className="ds-rag-routing-value">{embedProvider || '—'}</span>
        </div>
        <div className="ds-rag-routing-row">
          <span className="ds-rag-routing-label">Embedding model</span>
          <span className="ds-rag-routing-value">{embedModel || '— (use model zoo)'}</span>
        </div>
        <p className="ds-rag-routing-hint">
          Configure the provider in <strong>Models → Routing → Embedding</strong> and
          the model in the provider tab's <em>Embedding model</em> field.
        </p>
      </div>

      {/* How-to */}
      <div className="ds-rag-storage-hint">
        <strong>How to add knowledge</strong>
        <p>
          Drop PDFs, notebooks, or markdown files into{' '}
          <code>.jupyter-assistant/knowledge/</code>, then run{' '}
          <code>/index</code> in the chat to index them.
        </p>
        <p>
          Indexed content is stored as vectors in{' '}
          <code>.jupyter-assistant/rag/chroma/</code> — original files are never
          moved or copied. Only files inside the <code>knowledge/</code> folder
          can be indexed.
        </p>
      </div>

      {/* Live index status */}
      <RAGStatusSection apiClient={apiClient} notebookPath={notebookPath} />
    </div>
  );
};

// ---------------------------------------------------------------------------
// TagsSettingsPanel — tag library: definitions + create/delete custom tags
// ---------------------------------------------------------------------------

const BUILT_IN_TAG_DEFS: { category: string; tags: { value: string; topic: string; description: string }[] }[] = [
  { category: 'ML Pipeline', tags: [
    { value: 'data-loading',        topic: 'ML Pipeline', description: 'Cells that load data from files, databases, or APIs' },
    { value: 'preprocessing',       topic: 'ML Pipeline', description: 'Data cleaning, normalization, and transformation steps' },
    { value: 'feature-engineering', topic: 'ML Pipeline', description: 'Feature creation, selection, and encoding' },
    { value: 'training',            topic: 'ML Pipeline', description: 'Model training and fitting' },
    { value: 'evaluation',          topic: 'ML Pipeline', description: 'Metrics, validation, and model assessment' },
    { value: 'inference',           topic: 'ML Pipeline', description: 'Prediction or scoring on new data' },
  ]},
  { category: 'Quality', tags: [
    { value: 'todo',            topic: 'Quality', description: 'Cell needs attention or further work' },
    { value: 'reviewed',        topic: 'Quality', description: 'Cell has been reviewed and approved' },
    { value: 'needs-refactor',  topic: 'Quality', description: 'Works but the implementation should be improved' },
    { value: 'slow',            topic: 'Quality', description: 'Computationally slow — candidate for optimization' },
    { value: 'broken',          topic: 'Quality', description: 'Cell is broken or produces errors' },
    { value: 'tested',          topic: 'Quality', description: 'Cell has been verified to produce correct output' },
  ]},
  { category: 'Report', tags: [
    { value: 'report',          topic: 'Report', description: 'Output to include in an exported report' },
    { value: 'figure',          topic: 'Report', description: 'Cell that generates a figure or chart' },
    { value: 'table',           topic: 'Report', description: 'Cell that generates a table' },
    { value: 'key-finding',     topic: 'Report', description: 'Contains an important result or insight' },
    { value: 'report-exclude',  topic: 'Report', description: 'Explicitly exclude from report output' },
  ]},
  { category: 'Status', tags: [
    { value: 'draft',       topic: 'Status', description: 'Work in progress — not finalized' },
    { value: 'stable',      topic: 'Status', description: 'Unlikely to change; safe dependency for other cells' },
    { value: 'deprecated',  topic: 'Status', description: 'No longer needed; kept for reference' },
    { value: 'sensitive',   topic: 'Status', description: 'Contains sensitive data, credentials, or PII' },
  ]},
];

const CUSTOM_TAGS_KEY = 'varys_custom_tag_definitions';

/** Tag JSON shape: { "value": string, "topic": string, "description": string } */
interface CustomTagDef { value: string; topic: string; description: string }

function loadCustomTags(): CustomTagDef[] {
  try {
    const raw = localStorage.getItem(CUSTOM_TAGS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Array<Record<string, string>>;
    return parsed.map(r => ({
      value:       r['value'] ?? r['name'] ?? '',
      topic:       r['topic'] ?? 'Custom',
      description: r['description'] ?? '',
    })).filter(t => t.value);
  } catch { return []; }
}

function saveCustomTags(tags: CustomTagDef[]): void {
  localStorage.setItem(CUSTOM_TAGS_KEY, JSON.stringify(tags));
}

const TAG_PALETTE_TS = [
  '#3b82f6','#10b981','#f59e0b','#ef4444','#8b5cf6',
  '#06b6d4','#f97316','#ec4899','#14b8a6','#6366f1',
];
function tagColorTs(tag: string): string {
  let h = 0;
  for (let i = 0; i < tag.length; i++) h = (h * 31 + tag.charCodeAt(i)) >>> 0;
  return TAG_PALETTE_TS[h % TAG_PALETTE_TS.length];
}

const TagsSettingsPanel: React.FC = () => {
  const [customTags, setCustomTags] = useState<CustomTagDef[]>(loadCustomTags);
  const [newValue, setNewValue]     = useState('');
  const [newDesc, setNewDesc]       = useState('');
  const [nameErr, setNameErr]       = useState('');
  const [editIdx, setEditIdx]       = useState<number | null>(null);

  const allBuiltInValues: string[] = ([] as string[]).concat(
    ...BUILT_IN_TAG_DEFS.map((g: { category: string; tags: { value: string; topic: string; description: string }[] }) =>
      g.tags.map((t: { value: string; topic: string; description: string }) => t.value)
    )
  );

  const addCustomTag = () => {
    const raw = newValue.trim().toLowerCase().replace(/\s+/g, '-');
    if (!raw) { setNameErr('Value is required.'); return; }
    if (!/^[a-z0-9][\w\-.]*$/.test(raw)) { setNameErr('Only a-z, 0-9, - or _ allowed.'); return; }
    if (allBuiltInValues.includes(raw)) { setNameErr('This value is already a built-in tag.'); return; }
    if (customTags.some(t => t.value === raw)) { setNameErr('Tag already exists.'); return; }
    const updated = [...customTags, { value: raw, topic: 'Custom', description: newDesc.trim() }];
    setCustomTags(updated);
    saveCustomTags(updated);
    setNewValue(''); setNewDesc(''); setNameErr('');
  };

  const deleteCustomTag = (idx: number) => {
    const updated = customTags.filter((_, i) => i !== idx);
    setCustomTags(updated);
    saveCustomTags(updated);
    if (editIdx === idx) setEditIdx(null);
  };

  const saveEdit = (idx: number, desc: string) => {
    const updated = customTags.map((t, i) => i === idx ? { ...t, description: desc } : t);
    setCustomTags(updated);
    saveCustomTags(updated);
    setEditIdx(null);
  };

  return (
    <div className="ds-tags-settings-panel">

      {/* ── About ──────────────────────────────────────────────────────────── */}
      <div className="ds-tags-settings-about">
        <div className="ds-tags-settings-about-title">🏷️ What are tags?</div>
        <p>Tags let you label notebook cells with their role or status. They appear as coloured pills in the thin bar above each cell and can be added, removed, and browsed without leaving the notebook.</p>
        <div className="ds-tags-settings-usecases">
          <div className="ds-tags-settings-usecase">
            <span className="ds-tags-settings-usecase-icon">🔬</span>
            <span><strong>Pipeline stages</strong> — mark cells as <em>data-loading</em>, <em>training</em>, or <em>evaluation</em> to navigate large notebooks at a glance.</span>
          </div>
          <div className="ds-tags-settings-usecase">
            <span className="ds-tags-settings-usecase-icon">✅</span>
            <span><strong>Quality tracking</strong> — use <em>reviewed</em>, <em>todo</em>, or <em>needs-refactor</em> in code reviews or collaborative work.</span>
          </div>
          <div className="ds-tags-settings-usecase">
            <span className="ds-tags-settings-usecase-icon">📄</span>
            <span><strong>Report control</strong> — tag cells as <em>report</em> or <em>report-exclude</em> to control what gets exported.</span>
          </div>
          <div className="ds-tags-settings-usecase">
            <span className="ds-tags-settings-usecase-icon">🏗️</span>
            <span><strong>Custom workflows</strong> — create your own tags below to match your team's conventions.</span>
          </div>
        </div>
        <p className="ds-tags-settings-how">
          Add tags from the <strong>[+] button</strong> above any cell, or use the <strong>🏷️ panel</strong> in the sidebar to browse all tagged cells and jump between them.
        </p>
      </div>

      {/* ── Custom tags ────────────────────────────────────────────────────── */}
      <div className="ds-tags-settings-section">
        <div className="ds-tags-settings-section-header">
          <span className="ds-tags-settings-section-title">Custom Tags</span>
          <span className="ds-tags-settings-section-count">{customTags.length}</span>
        </div>

        {customTags.length === 0 && (
          <p className="ds-tags-settings-empty">No custom tags yet. Create one below.</p>
        )}

        {customTags.map((tag, idx) => (
          <div key={tag.value} className="ds-tags-settings-row">
            <span
              className="ds-tags-settings-pill"
              style={{ '--pill-color': tagColorTs(tag.value) } as React.CSSProperties}
            >{tag.value}</span>
            {editIdx === idx ? (
              <EditDescRow
                initial={tag.description}
                onSave={desc => saveEdit(idx, desc)}
                onCancel={() => setEditIdx(null)}
              />
            ) : (
              <>
                <span className="ds-tags-settings-desc" onClick={() => setEditIdx(idx)}>
                  {tag.description || <em className="ds-tags-settings-desc-empty">no description — click to add</em>}
                </span>
                <button className="ds-tags-settings-edit-btn" onClick={() => setEditIdx(idx)} title="Edit description">✎</button>
                <button className="ds-tags-settings-del-btn" onClick={() => deleteCustomTag(idx)} title="Delete tag">🗑</button>
              </>
            )}
          </div>
        ))}

        {/* New tag form */}
        <div className="ds-tags-settings-new-form">
          <div className="ds-tags-settings-new-row">
            <input
              className="ds-tags-settings-name-input"
              placeholder="tag-value"
              value={newValue}
              onChange={e => { setNewValue(e.target.value); setNameErr(''); }}
              onKeyDown={e => { if (e.key === 'Enter') addCustomTag(); }}
            />
            <input
              className="ds-tags-settings-desc-input"
              placeholder="Description (optional)"
              value={newDesc}
              onChange={e => setNewDesc(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') addCustomTag(); }}
            />
            <button
              className="ds-tags-settings-add-btn"
              onClick={addCustomTag}
              disabled={!newValue.trim()}
            >+ Add</button>
          </div>
          {nameErr && <p className="ds-tags-settings-error">{nameErr}</p>}
        </div>
      </div>

      {/* ── Built-in tags ──────────────────────────────────────────────────── */}
      <div className="ds-tags-settings-section">
        <div className="ds-tags-settings-section-header">
          <span className="ds-tags-settings-section-title">Built-in Tags</span>
          <span className="ds-tags-settings-section-count">{allBuiltInValues.length}</span>
        </div>
        {BUILT_IN_TAG_DEFS.map(group => (
          <div key={group.category} className="ds-tags-settings-group">
            <div className="ds-tags-settings-group-label">{group.category}</div>
            {group.tags.map(tag => (
              <div key={tag.value} className="ds-tags-settings-row ds-tags-settings-row--builtin">
                <span
                  className="ds-tags-settings-pill"
                  style={{ '--pill-color': tagColorTs(tag.value) } as React.CSSProperties}
                >{tag.value}</span>
                <span className="ds-tags-settings-desc">{tag.description}</span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
};

const EditDescRow: React.FC<{ initial: string; onSave: (d: string) => void; onCancel: () => void }> = ({ initial, onSave, onCancel }) => {
  const [val, setVal] = useState(initial);
  return (
    <div className="ds-tags-settings-edit-row">
      <input
        className="ds-tags-settings-desc-input"
        autoFocus
        value={val}
        onChange={e => setVal(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter')  { onSave(val); }
          if (e.key === 'Escape') { onCancel(); }
        }}
      />
      <button className="ds-tags-settings-save-btn" onClick={() => onSave(val)}>Save</button>
      <button className="ds-tags-settings-cancel-btn-sm" onClick={onCancel}>✕</button>
    </div>
  );
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
] as const;

export const FileAgentConfigPanel: React.FC<{
  notebookPath: string;
  apiClient: APIClient;
  onClose: () => void;
}> = ({ notebookPath, apiClient, onClose }) => {
  const [values, setValues]     = useState<Record<string, string>>({});
  const [configPath, setConfigPath] = useState('');
  const [loading, setLoading]   = useState(true);
  const [saving, setSaving]     = useState(false);
  const [status, setStatus]     = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  useEffect(() => {
    if (!notebookPath) {
      setLoading(false);
      return;
    }
    apiClient
      .getAgentSettings(notebookPath)
      .then(data => {
        const v: Record<string, string> = {};
        for (const k of FILE_AGENT_CONFIG_KEYS) v[k] = data[k] ?? '';
        setValues(v);
        setConfigPath(data._config_path ?? '');
        setLoading(false);
      })
      .catch(err => {
        setStatus({ type: 'error', text: `Failed to load: ${err}` });
        setLoading(false);
      });
  }, [notebookPath, apiClient]);

  const handleChange = (key: string, value: string) =>
    setValues(v => ({ ...v, [key]: value }));

  const boolVal = (key: string, defaultOn: boolean): boolean => {
    const v = values[key];
    if (!v) return defaultOn;
    return v.toLowerCase() !== 'false';
  };

  const handleSave = async () => {
    setSaving(true);
    setStatus(null);
    try {
      const payload: Record<string, string> = {};
      for (const k of FILE_AGENT_CONFIG_KEYS) payload[k] = values[k] ?? '';
      await apiClient.saveAgentSettings(notebookPath, payload);
      setStatus({ type: 'success', text: '✓ Saved to project' });
      setTimeout(() => setStatus(null), 2500);
    } catch (err) {
      setStatus({ type: 'error', text: `Save failed: ${err}` });
    } finally {
      setSaving(false);
    }
  };

  if (!notebookPath) {
    return (
      <div className="ds-agent-config-panel">
        <p className="ds-agent-config-no-nb">No active notebook — open a notebook to configure project settings.</p>
      </div>
    );
  }

  return (
    <div className="ds-agent-config-panel">
      {configPath && (
        <div className="ds-agent-config-path" title={configPath}>
          📁 {configPath}
        </div>
      )}

      {loading ? (
        <div className="ds-agent-config-loading">Loading…</div>
      ) : (
        <>
          {/* Enable / disable */}
          <div className="ds-settings-row ds-settings-row--toggle">
            <div className="ds-settings-toggle-label-group">
              <span className="ds-settings-label">Enable for this project</span>
            </div>
            <label className="ds-settings-toggle-switch" title={boolVal('VARYS_AGENT_ENABLED', false) ? 'Click to disable' : 'Click to enable'}>
              <input
                type="checkbox"
                checked={boolVal('VARYS_AGENT_ENABLED', false)}
                onChange={e => handleChange('VARYS_AGENT_ENABLED', e.target.checked ? 'true' : 'false')}
              />
              <span className="ds-settings-toggle-slider" />
            </label>
          </div>

          {/* Working directory */}
          <div className="ds-settings-row">
            <label className="ds-settings-label">Working directory</label>
            <input
              className="ds-settings-input"
              type="text"
              value={values['VARYS_AGENT_WORKING_DIR'] ?? ''}
              onChange={e => handleChange('VARYS_AGENT_WORKING_DIR', e.target.value)}
              placeholder="Leave empty — uses notebook's parent directory"
              autoComplete="off"
            />
          </div>

          {/* Max turns */}
          <div className="ds-settings-row">
            <label className="ds-settings-label">Max agent turns</label>
            <input
              className="ds-settings-input ds-agent-input--narrow"
              type="text"
              inputMode="numeric"
              value={values['VARYS_AGENT_MAX_TURNS'] ?? ''}
              onChange={e => handleChange('VARYS_AGENT_MAX_TURNS', e.target.value)}
              placeholder="10"
              autoComplete="off"
            />
          </div>

          {/* Allowed tools */}
          <div className="ds-settings-row">
            <label className="ds-settings-label">Allowed tools</label>
            <input
              className="ds-settings-input"
              type="text"
              value={values['VARYS_AGENT_ALLOWED_TOOLS'] ?? ''}
              onChange={e => handleChange('VARYS_AGENT_ALLOWED_TOOLS', e.target.value)}
              placeholder="Read,Write,Edit"
              autoComplete="off"
            />
          </div>

          {/* Background scan */}
          <div className="ds-settings-row ds-settings-row--toggle">
            <div className="ds-settings-toggle-label-group">
              <span className="ds-settings-label">Background project scan</span>
            </div>
            <label className="ds-settings-toggle-switch" title={boolVal('VARYS_AGENT_BACKGROUND_SCAN', true) ? 'Click to disable' : 'Click to enable'}>
              <input
                type="checkbox"
                checked={boolVal('VARYS_AGENT_BACKGROUND_SCAN', true)}
                onChange={e => handleChange('VARYS_AGENT_BACKGROUND_SCAN', e.target.checked ? 'true' : 'false')}
              />
              <span className="ds-settings-toggle-slider" />
            </label>
          </div>

          {/* Project-local provider override */}
          <div className="ds-settings-row">
            <label className="ds-settings-label">Provider override</label>
            <select
              className="ds-settings-select"
              value={values['VARYS_AGENT_PROVIDER'] || ''}
              onChange={e => handleChange('VARYS_AGENT_PROVIDER', e.target.value)}
            >
              <option value="">— use global default —</option>
              <option value="anthropic">Anthropic</option>
              <option value="openai">OpenAI</option>
              <option value="azure">Azure OpenAI</option>
              <option value="bedrock">AWS Bedrock</option>
              <option value="ollama">Ollama</option>
            </select>
          </div>

          {status && (
            <div className={`ds-agent-config-status ds-agent-config-status--${status.type}`}>
              {status.text}
            </div>
          )}

          <div className="ds-agent-config-actions">
            <button className="ds-settings-cancel-btn" onClick={onClose}>Close</button>
            <button
              className="ds-settings-save-btn"
              onClick={handleSave}
              disabled={saving}
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </>
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
// AgentToolErrorBanner — shown when a /file_agent command fails because the
// selected model does not support tool calling.
// ---------------------------------------------------------------------------

interface AgentToolErrorInfo {
  provider: string;
  model: string;
  message: string;
  suggestion: string;
}

const AgentToolErrorBanner: React.FC<{
  error: AgentToolErrorInfo;
  onOpenAgentSettings?: () => void;
}> = ({ error, onOpenAgentSettings }) => (
  <div className="ds-agent-tool-error-banner">
    <div className="ds-agent-tool-error-heading">This model does not support tool calling</div>
    <div className="ds-agent-tool-error-meta">
      Provider: <strong>{error.provider}</strong> · Model: <strong>{error.model}</strong>
    </div>
    <div className="ds-agent-tool-error-suggestion">{error.suggestion}</div>
    {onOpenAgentSettings && (
      <button className="ds-agent-tool-error-link" onClick={onOpenAgentSettings}>
        Change the agent provider →
      </button>
    )}
  </div>
);


// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// UsageTab — LLM token usage heatmap + summary
// ---------------------------------------------------------------------------

const USAGE_BASE = '/varys/usage';
const PERIODS = ['Day', 'Week', 'Month', 'Year', 'All'] as const;
type UsagePeriod = typeof PERIODS[number];

interface UsageTotals { in: number; out: number; total: number; }
interface HeatmapData  { [date: string]: number; }

function _usageFetch(action: string, params: Record<string, string> = {}): Promise<Response> {
  const qs = new URLSearchParams({ action, ...params }).toString();
  return fetch(`${USAGE_BASE}?${qs}`);
}

function _buildHeatmapGrid(data: HeatmapData): Array<Array<{ date: string | null; value: number }>> {
  const today   = new Date();
  today.setHours(0, 0, 0, 0);
  const start   = new Date(today);
  start.setDate(today.getDate() - 364);

  // Build week columns. Each column = 7 slots (Sun–Sat), null = padding.
  const startDow = start.getDay(); // 0=Sun
  const columns: Array<Array<{ date: string | null; value: number }>> = [];
  let col: Array<{ date: string | null; value: number }> = Array.from({ length: startDow }, () => ({ date: null, value: 0 }));

  const cur = new Date(start);
  while (cur <= today) {
    const iso   = cur.toISOString().slice(0, 10);
    const value = data[iso] ?? 0;
    col.push({ date: iso, value });
    if (col.length === 7) { columns.push(col); col = []; }
    cur.setDate(cur.getDate() + 1);
  }
  if (col.length > 0) {
    while (col.length < 7) col.push({ date: null, value: 0 });
    columns.push(col);
  }
  return columns;
}

function _heatmapColor(value: number, max: number): string {
  if (value === 0 || max === 0) return 'var(--ds-heatmap-0)';
  const ratio = value / max;
  if (ratio <= 0.20) return 'var(--ds-heatmap-1)';
  if (ratio <= 0.40) return 'var(--ds-heatmap-2)';
  if (ratio <= 0.65) return 'var(--ds-heatmap-3)';
  if (ratio <= 0.85) return 'var(--ds-heatmap-4)';
  return 'var(--ds-heatmap-5)';
}

function _monthLabel(columns: Array<Array<{ date: string | null; value: number }>>, colIdx: number): string | null {
  const firstCell = columns[colIdx].find(c => c.date !== null);
  if (!firstCell || !firstCell.date) return null;
  const d = new Date(firstCell.date + 'T00:00:00');
  if (colIdx === 0) return d.toLocaleString('default', { month: 'short' });
  const prevCell = columns[colIdx - 1].find(c => c.date !== null);
  if (!prevCell || !prevCell.date) return null;
  const prev = new Date(prevCell.date + 'T00:00:00');
  return d.getMonth() !== prev.getMonth() ? d.toLocaleString('default', { month: 'short' }) : null;
}

const DOW_LABELS: Record<number, string> = { 1: 'M', 3: 'W', 5: 'F' };

const UsageTab: React.FC<{ apiClient: APIClient }> = ({ apiClient }) => {
  const [models,        setModels]        = React.useState<string[]>([]);
  const [selectedModel, setSelectedModel] = React.useState<string>('');
  const [period,        setPeriod]        = React.useState<UsagePeriod>('Month');
  const [totals,        setTotals]        = React.useState<UsageTotals>({ in: 0, out: 0, total: 0 });
  const [heatmap,       setHeatmap]       = React.useState<HeatmapData>({});
  const [loading,       setLoading]       = React.useState(true);

  const fetchHeatmap = React.useCallback(async (model: string) => {
    const params: Record<string, string> = {};
    if (model) params.model = model;
    try {
      const r = await _usageFetch('heatmap', params);
      const j = await r.json();
      setHeatmap(j.data ?? {});
    } catch { /* swallowed */ }
  }, []);

  const fetchTotals = React.useCallback(async (model: string, p: UsagePeriod) => {
    const params: Record<string, string> = { period: p.toLowerCase() };
    if (model) params.model = model;
    try {
      const r = await _usageFetch('totals', params);
      const j = await r.json();
      setTotals(j.data ?? { in: 0, out: 0, total: 0 });
    } catch { /* swallowed */ }
  }, []);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const [rModels, rHeatmap, rTotals] = await Promise.all([
          _usageFetch('models'),
          _usageFetch('heatmap'),
          _usageFetch('totals', { period: 'month' }),
        ]);
        if (cancelled) return;
        const [jM, jH, jT] = await Promise.all([rModels.json(), rHeatmap.json(), rTotals.json()]);
        if (cancelled) return;
        setModels(jM.data ?? []);
        setHeatmap(jH.data ?? {});
        setTotals(jT.data ?? { in: 0, out: 0, total: 0 });
      } catch { /* swallowed */ } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const handleModelChange = async (model: string) => {
    setSelectedModel(model);
    await Promise.all([fetchHeatmap(model), fetchTotals(model, period)]);
  };

  const handlePeriodChange = async (p: UsagePeriod) => {
    setPeriod(p);
    await fetchTotals(selectedModel, p);
  };

  const handleExport = async () => {
    try {
      const r = await _usageFetch('export');
      const blob = await r.blob();
      const cd   = r.headers.get('Content-Disposition') ?? '';
      const match = /filename="([^"]+)"/.exec(cd);
      const fname = match ? match[1] : `varys_usage_export_${new Date().toISOString().slice(0, 10)}.jsonl`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = fname; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch { /* swallowed */ }
  };

  const columns  = _buildHeatmapGrid(heatmap);
  const maxValue = Math.max(...Object.values(heatmap), 0);

  if (loading) {
    return <div className="ds-usage-loading">Loading usage data…</div>;
  }

  return (
    <div className="ds-usage-tab">
      {/* Filter bar */}
      <div className="ds-usage-filter-bar">
        <div className="ds-usage-filter-left">
          <label className="ds-usage-filter-label">Model</label>
          <select
            className="ds-settings-select ds-usage-model-select"
            value={selectedModel}
            onChange={e => handleModelChange(e.target.value)}
          >
            <option value="">All</option>
            {models.map(m => <option key={m} value={m}>{m}</option>)}
          </select>
        </div>
        <button className="ds-usage-export-btn" onClick={handleExport}>Export</button>
      </div>

      {/* Summary cards */}
      <div className="ds-usage-cards">
        <div className="ds-usage-card">
          <span className="ds-usage-card-label">Tokens in</span>
          <span className="ds-usage-card-value">{totals.in.toLocaleString()}</span>
        </div>
        <div className="ds-usage-card">
          <span className="ds-usage-card-label">Tokens out</span>
          <span className="ds-usage-card-value">{totals.out.toLocaleString()}</span>
        </div>
        <div className="ds-usage-card">
          <span className="ds-usage-card-label">Total</span>
          <span className="ds-usage-card-value">{totals.total.toLocaleString()}</span>
        </div>
      </div>

      {/* Period pills */}
      <div className="ds-usage-period-pills">
        {PERIODS.map(p => (
          <button
            key={p}
            className={`ds-usage-pill${period === p ? ' ds-usage-pill--active' : ''}`}
            onClick={() => handlePeriodChange(p)}
          >{p}</button>
        ))}
      </div>

      {/* Heatmap */}
      <div className="ds-usage-heatmap-wrap">
        <div className="ds-usage-heatmap">
          {/* Month labels row */}
          <div className="ds-usage-heatmap-months">
            <div className="ds-usage-heatmap-dow-spacer" />
            {columns.map((_, ci) => (
              <div key={ci} className="ds-usage-heatmap-month-cell">
                {_monthLabel(columns, ci) && (
                  <span className="ds-usage-heatmap-month-label">{_monthLabel(columns, ci)}</span>
                )}
              </div>
            ))}
          </div>
          {/* Grid rows */}
          <div className="ds-usage-heatmap-grid">
            {/* Day-of-week labels */}
            <div className="ds-usage-heatmap-dow-col">
              {[0,1,2,3,4,5,6].map(row => (
                <div key={row} className="ds-usage-heatmap-dow-label">
                  {DOW_LABELS[row] ?? ''}
                </div>
              ))}
            </div>
            {/* Week columns */}
            {columns.map((week, ci) => (
              <div key={ci} className="ds-usage-heatmap-week">
                {week.map((cell, row) => (
                  <div
                    key={row}
                    className="ds-usage-heatmap-cell"
                    style={{ background: cell.date ? _heatmapColor(cell.value, maxValue) : 'transparent' }}
                    title={cell.date
                      ? `${cell.date} — ${cell.value.toLocaleString()} tokens`
                      : undefined
                    }
                  />
                ))}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};

// MemoryTab — placeholder for long-term memory configuration
// ---------------------------------------------------------------------------

const MemoryTab: React.FC = () => (
  <div className="ds-settings-section-body">
    <p className="ds-settings-section-placeholder">Long-term memory configuration coming soon.</p>
  </div>
);

// ---------------------------------------------------------------------------
// SettingsPanel — vertical sidebar nav + content pane
// ---------------------------------------------------------------------------

const SettingsPanel: React.FC<{
  apiClient: APIClient;
  onClose: () => void;
  onSaved?: () => void;
  notebookPath?: string;
  initialTab?: string;
}> = ({ apiClient, onClose, onSaved, notebookPath = '', initialTab }) => {
  const initSection = (() => {
    switch (initialTab) {
      case 'mcp':      return 'mcp';
      case 'skills':   return 'skills';
      case 'commands': return 'commands';
      case 'indexing': return 'indexing';
      case 'tags':     return 'tags';
      default:         return 'model-routing';
    }
  })();

  const [activeSection, setActiveSection]         = useState<string>(initSection);
  const [activeSubSection, setActiveSubSection]   = useState<string | null>(null);
  const [providerStatuses, setProviderStatuses]   = useState<Record<string, boolean>>({});

  const handleNavigate = (section: string, subSection: string | null) => {
    setActiveSection(section);
    setActiveSubSection(subSection);
  };

  const renderContent = (section: string, subSection: string | null): React.ReactNode => {
    switch (section) {
      case 'model-routing':
      case 'model-providers':
        return (
          <ModelsPanel
            apiClient={apiClient}
            onClose={onClose}
            onSaved={onSaved}
            notebookPath={notebookPath}
            section={section}
            subSection={subSection}
            onProviderStatusChange={setProviderStatuses}
          />
        );
      case 'mcp':
        return (
          <div className="ds-settings-section-body">
            <MCPPanel apiClient={apiClient} />
          </div>
        );
      case 'skills':
        return <SkillsPanel apiClient={apiClient} notebookPath={notebookPath} />;
      case 'commands':
        return (
          <div className="ds-settings-section-body">
            <CommandsPanel apiClient={apiClient} />
          </div>
        );
      case 'indexing':
        return (
          <div className="ds-settings-section-body">
            <IndexingPanel apiClient={apiClient} notebookPath={notebookPath} />
          </div>
        );
      case 'tags':
        return (
          <div className="ds-settings-section-body">
            <TagsSettingsPanel />
          </div>
        );
      case 'memory':
        return <MemoryTab />;
      case 'usage':
        return (
          <div className="ds-settings-section-body">
            <UsageTab apiClient={apiClient} />
          </div>
        );
      default:
        return null;
    }
  };

  return (
    <div className="ds-settings-outer">
      <SettingsSidebar
        activeSection={activeSection}
        activeSubSection={activeSubSection}
        providerStatuses={providerStatuses}
        onNavigate={handleNavigate}
      />
      <div className="ds-settings-content">
        <SectionHeading section={activeSection} subSection={activeSubSection} />
        {renderContent(activeSection, activeSubSection)}
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// ModelSwitcher — inline model picker at the bottom of the chat textarea
// ---------------------------------------------------------------------------

const shortModelName = (model: string): string =>
  model.includes('/') ? model.split('/').slice(1).join('/') : model;

const PROVIDER_COLORS: Record<string, string> = {
  ANTHROPIC:   '#d97757',
  OPENAI:      '#10a37f',
  GOOGLE:      '#4285f4',
  BEDROCK:     '#ff9900',
  AZURE:       '#0078d4',
  OPENROUTER:  '#7c3aed',
  OLLAMA:      '#0ea5e9',
};
const providerColor = (p: string): string =>
  PROVIDER_COLORS[p.toUpperCase()] ?? '#1976d2';

interface ModelSwitcherProps {
  provider: string;
  model: string;
  zoo: string[];
  saving: boolean;
  onSelect: (model: string) => void;
}

const ModelSwitcher: React.FC<ModelSwitcherProps> = ({
  provider, model, zoo, saving, onSelect
}) => {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const color = providerColor(provider);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node))
        setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const noProvider    = !provider;
  const displayName   = noProvider ? 'No provider set — open Settings' : (shortModelName(model) || '—');
  const displayProvider = (!provider || provider === 'unknown') ? '?' : provider.toUpperCase();

  return (
    <div className="ds-model-switcher" ref={wrapperRef}>
      {open && (
        <div className="ds-model-switcher-popup">
          <div className="ds-model-switcher-popup-header" style={{ borderLeftColor: color, color }}>
            <span className="ds-model-switcher-popup-provider">{displayProvider}</span>
            <span className="ds-model-switcher-popup-label">Chat model</span>
          </div>
          {zoo.length === 0 ? (
            <div className="ds-model-switcher-empty">
              No models in zoo.{'\n'}Go to ⚙ Settings → {displayProvider} tab.
            </div>
          ) : (
            <div className="ds-model-switcher-list">
              {zoo.map(m => {
                const isActive = m === model;
                return (
                  <button
                    key={m}
                    className={`ds-model-switcher-option${isActive ? ' ds-model-switcher-option--active' : ''}`}
                    style={isActive ? { borderLeftColor: color } : undefined}
                    onClick={() => { onSelect(m); setOpen(false); }}
                    title={m}
                  >
                    <span className="ds-model-switcher-option-name">{m}</span>
                    {isActive && <span className="ds-model-switcher-check" style={{ color }}>✓</span>}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}
      <button
        className={`ds-model-switcher-btn${open ? ' ds-model-switcher-btn--open' : ''}${saving ? ' ds-model-switcher-btn--saving' : ''}${noProvider ? ' ds-model-switcher-btn--unconfigured' : ''}`}
        onClick={() => !saving && setOpen(o => !o)}
        data-tip={noProvider ? 'No provider configured — open Settings' : `${displayProvider} · ${model}`}
        disabled={saving}
      >
        <span className="ds-model-switcher-model-name">{saving ? 'Switching…' : displayName}</span>
        <span className="ds-model-switcher-chevron" />
      </button>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Slash-command helpers
// ---------------------------------------------------------------------------

/** Parse a /command prefix from the start of a message.
 *  Returns { command: "/eda", rest: "rest of message" } or null if no command. */
function parseSlashCommand(input: string): { command: string; rest: string } | null {
  const m = input.match(/^(\/[\w-]+)(?:\s+(.*))?$/s);
  if (!m) return null;
  return { command: m[1].toLowerCase(), rest: (m[2] ?? '').trim() };
}

// ---------------------------------------------------------------------------
// CommandAutocomplete component
// ---------------------------------------------------------------------------

interface CommandAutocompleteProps {
  commands: SlashCommand[];
  query: string;           // current partial input starting with "/"
  onSelect: (cmd: SlashCommand) => void;
  onClose: () => void;
}

const CommandAutocomplete: React.FC<CommandAutocompleteProps> = ({
  commands, query, onSelect, onClose,
}) => {
  const filtered = React.useMemo(() => {
    const q = query.toLowerCase();
    return commands.filter(c => c.command.startsWith(q) || c.description.toLowerCase().includes(q));
  }, [commands, query]);

  const popupRef = useRef<HTMLDivElement>(null);
  const [activeIdx, setActiveIdx] = useState(0);

  // Reset active index when filter changes
  useEffect(() => { setActiveIdx(0); }, [filtered.length]);

  // Close on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (popupRef.current && !popupRef.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose]);

  // Keyboard navigation — exposed via a global keydown handler attached to
  // the textarea when this component is visible.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!filtered.length) return;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActiveIdx(i => Math.min(i + 1, filtered.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActiveIdx(i => Math.max(i - 1, 0));
      } else if (e.key === 'Tab' || e.key === 'Enter') {
        e.preventDefault();
        if (filtered[activeIdx]) onSelect(filtered[activeIdx]);
      } else if (e.key === 'Escape') {
        onClose();
      }
    };
    document.addEventListener('keydown', handler, true);
    return () => document.removeEventListener('keydown', handler, true);
  }, [filtered, activeIdx, onSelect, onClose]);

  if (!filtered.length) return null;

  return (
    <div className="ds-cmd-popup" ref={popupRef}>
      {filtered.map((cmd, i) => (
        <div
          key={cmd.command}
          className={`ds-cmd-item${i === activeIdx ? ' ds-cmd-item-active' : ''}`}
          onMouseEnter={() => setActiveIdx(i)}
          onClick={() => onSelect(cmd)}
        >
          <span className="ds-cmd-name">{cmd.command}</span>
          <span className={`ds-cmd-badge ds-cmd-badge-${cmd.type}`}>{cmd.type}</span>
          <span className="ds-cmd-desc">{cmd.description}</span>
        </div>
      ))}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Thread helpers
// ---------------------------------------------------------------------------

function makeNewThread(name: string): ChatThread {
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
function translateCellRefs(
  text: string,
  idMap: Map<string, number>
): string {
  // Matches "#7 [id:a3f7b2c1]" or "#7  [id:a3f7b2c1]" (one or two spaces)
  return text.replace(/#(\d+)\s{1,2}\[id:([0-9a-f]{8})\]/g, (_m, numStr, prefix) => {
    const oldNum = parseInt(numStr, 10);
    if (!idMap.has(prefix)) {
      // Cell was deleted from the notebook entirely
      return `#${oldNum} [id:${prefix}] [cell no longer exists]`;
    }
    const currentNum = idMap.get(prefix)!;
    if (currentNum !== oldNum) {
      return `#${currentNum} [id:${prefix}] (was #${oldNum})`;
    }
    return `#${oldNum} [id:${prefix}]`;
  });
}

// ---------------------------------------------------------------------------
// ThreadBar component
// ---------------------------------------------------------------------------

/** Max thread pills shown directly in the bar before overflow into ··· menu */
const MAX_VISIBLE_THREADS = 4;

interface ThreadBarProps {
  threads: ChatThread[];
  currentId: string;
  notebookName: string;
  onSwitch: (id: string) => void;
  onNew: () => void;
  onRename: (id: string, name: string) => void;
  onDuplicate: (id: string) => void;
  onDelete: (id: string) => void;
}

const ThreadBar: React.FC<ThreadBarProps> = ({
  threads, currentId, notebookName, onSwitch, onNew, onRename, onDuplicate, onDelete,
}) => {
  const [open, setOpen]           = useState(false);
  const [editingId, setEditingId] = useState('');
  const [editValue, setEditValue] = useState('');
  const [renameError, setRenameError] = useState('');
  const popupRef = useRef<HTMLDivElement>(null);

  const tryRename = (id: string, name: string): boolean => {
    const trimmed = name.trim();
    if (!trimmed) return false;
    const collision = threads.some(t => t.id !== id && t.name === trimmed);
    if (collision) {
      setRenameError(`"${trimmed}" already exists`);
      return false;
    }
    onRename(id, trimmed);
    setRenameError('');
    return true;
  };

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (popupRef.current && !popupRef.current.contains(e.target as Node)) {
        setOpen(false);
        setEditingId('');
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const visibleThreads = threads.slice(0, MAX_VISIBLE_THREADS);
  const hiddenCount    = Math.max(0, threads.length - MAX_VISIBLE_THREADS);

  return (
    <div className="ds-thread-bar" ref={popupRef}>
      {/* Named thread pills — one-click switching, up to MAX_VISIBLE_THREADS */}
      <div className="ds-thread-pills">
        {visibleThreads.map(t => (
          <button
            key={t.id}
            className={`ds-thread-pill${t.id === currentId ? ' ds-thread-pill--active' : ''}`}
            onClick={() => onSwitch(t.id)}
            title={t.name}
          >
            {t.name}
          </button>
        ))}
      </div>

      {/* ··· / +N  — manage all threads, access hidden ones, create new */}
      <div className="ds-thread-overflow-wrap">
        <button
          className={`ds-thread-overflow-btn${open ? ' ds-thread-overflow-btn--open' : ''}`}
          onClick={() => setOpen(o => !o)}
          title={open ? 'Close thread menu' : 'Manage threads'}
          aria-label="Thread menu"
        >
          {hiddenCount > 0 ? `+${hiddenCount}` : '···'}
        </button>

      {/* Management popup — anchored to the ··· button, not the full bar */}
      {open && (
        <div className="ds-thread-popup">
          {/* Notebook context header */}
          {notebookName && (
            <div className="ds-thread-popup-notebook">
              <span className="ds-thread-popup-nb-icon">📓</span>
              <span className="ds-thread-popup-nb-name" title={notebookName}>{notebookName}</span>
            </div>
          )}
          {threads.map(t => (
            <div
              key={t.id}
              className={`ds-thread-item${t.id === currentId ? ' ds-thread-item-active' : ''}`}
            >
              {editingId === t.id ? (
                <div className="ds-thread-rename-wrap">
                  <input
                    className={`ds-thread-rename-input${renameError ? ' ds-thread-rename-error' : ''}`}
                    value={editValue}
                    autoFocus
                    onChange={e => { setEditValue(e.target.value); setRenameError(''); }}
                    onBlur={() => {
                      if (!tryRename(t.id, editValue)) {
                        if (!renameError) setEditingId('');
                      } else {
                        setEditingId('');
                      }
                    }}
                    onKeyDown={e => {
                      if (e.key === 'Enter') {
                        if (tryRename(t.id, editValue)) setEditingId('');
                      }
                      if (e.key === 'Escape') { setEditingId(''); setRenameError(''); }
                    }}
                  />
                  {renameError && (
                    <span className="ds-thread-rename-msg">{renameError}</span>
                  )}
                </div>
              ) : (
                <span
                  className="ds-thread-item-name"
                  onClick={() => { onSwitch(t.id); setOpen(false); }}
                >
                  {t.id === currentId && <span className="ds-thread-check">✓</span>}
                  {t.name}
                </span>
              )}
              <div className="ds-thread-actions">
                {/* Rename */}
                <span
                  className="ds-thread-action-btn"
                  onClick={e => { e.stopPropagation(); setEditingId(t.id); setEditValue(t.name); }}
                  data-tip="Rename"
                >
                  <svg viewBox="0 0 14 14" width="11" height="11" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <path d="M9.5 1.5l3 3L4 13H1v-3L9.5 1.5z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round"/>
                  </svg>
                </span>
                {/* Duplicate */}
                <span
                  className="ds-thread-action-btn"
                  onClick={e => { e.stopPropagation(); onDuplicate(t.id); }}
                  data-tip="Duplicate thread"
                >
                  <svg viewBox="0 0 14 14" width="11" height="11" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <rect x="4" y="4" width="8" height="9" rx="1.2" stroke="currentColor" strokeWidth="1.4"/>
                    <path d="M2 10V2a1 1 0 011-1h7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
                  </svg>
                </span>
                {/* Delete — only when more than one thread exists */}
                {threads.length > 1 && (
                  <span
                    className="ds-thread-action-btn ds-thread-action-delete"
                    onClick={e => { e.stopPropagation(); onDelete(t.id); }}
                    data-tip="Delete thread"
                  >
                    <svg viewBox="0 0 14 14" width="11" height="11" fill="none" xmlns="http://www.w3.org/2000/svg">
                      <path d="M2 4h10M5 4V2.5a.5.5 0 01.5-.5h3a.5.5 0 01.5.5V4M6 7v3.5M8 7v3.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
                      <path d="M3 4l.8 7.2a1 1 0 001 .8h4.4a1 1 0 001-.8L11 4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
                    </svg>
                  </span>
                )}
              </div>
            </div>
          ))}
          <div className="ds-thread-new-item" onClick={() => { onNew(); setOpen(false); }}>
            + New thread
          </div>
        </div>
      )}
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// ContextChipBubble — collapsible code-context chip shown in sent user bubbles
// ---------------------------------------------------------------------------

const ContextChipBubble: React.FC<{ chip: { label: string; preview: string } }> = ({ chip }) => {
  const [expanded, setExpanded] = React.useState(false);
  return (
    <div className="ds-ctx-chip ds-ctx-chip--bubble">
      <div className="ds-ctx-chip-header">
        <span className="ds-ctx-chip-icon">📎</span>
        <span className="ds-ctx-chip-label">{chip.label}</span>
        <button
          className="ds-ctx-chip-toggle"
          onClick={() => setExpanded(x => !x)}
          title={expanded ? 'Collapse' : 'Expand context'}
          aria-label={expanded ? 'Collapse context' : 'Expand context'}
        >{expanded ? '▲' : '▼'}</button>
      </div>
      {expanded && (
        <pre className="ds-ctx-chip-preview">{chip.preview}</pre>
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Chat component
// ---------------------------------------------------------------------------

const DSAssistantChat: React.FC<SidebarProps> = ({
  apiClient,
  notebookReader,
  cellEditor,
  notebookTracker,
  openFile,
  reloadFile,
}) => {
  // Resolves @variable_name references typed in the chat input
  const variableResolver = React.useMemo(
    () => new VariableResolver(notebookTracker),
    [notebookTracker]
  );
  const [messages, setMessages] = useState<Message[]>([
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
  const [collapsedMsgs, setCollapsedMsgs] = useState<Set<string>>(new Set());
  const toggleCollapse = (id: string) =>
    setCollapsedMsgs(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  // ── Streaming animation queue ──────────────────────────────────────────
  // Chunks from the SSE stream are pushed here and drained by a setInterval
  // at 30 ms, decoupling rendering from React 18 automatic batching and from
  // Tornado's TCP flush timing. This guarantees visible token-by-token
  // streaming regardless of how the backend sends the events.
  const streamQueueRef  = useRef<string[]>([]);
  const streamMsgIdRef  = useRef<string>('');
  const streamTimerRef  = useRef<ReturnType<typeof setInterval> | null>(null);

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
    feed(partial: string): string {
      this.accumulated += partial;
      // Match from the last "content": " to the current end of string.
      // The regex intentionally anchors to $ so it tracks the LATEST field.
      const match = this.accumulated.match(/"content"\s*:\s*"((?:[^"\\]|\\[\s\S])*)$/);
      if (!match) return '';
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

  const startStreamQueue = (msgId: string) => {
    streamMsgIdRef.current = msgId;
    streamQueueRef.current = [];
    setActiveStreamId(msgId);
    if (streamTimerRef.current) clearInterval(streamTimerRef.current);
    streamTimerRef.current = setInterval(() => {
      if (streamQueueRef.current.length === 0) return;

      // Collapse all buffered tokens into one character string so we can
      // drip by character count rather than token count.  LLM tokens range
      // from 1 to 20+ chars; token-based draining produces irregular jumps.
      const pending = streamQueueRef.current.splice(0).join('');

      // Adaptive character drip:
      //   ≤ 50 chars backlog  → 8  chars/tick  (~267 chars/s) — smooth typewriter
      //   ≤ 200 chars backlog → 16 chars/tick  (~533 chars/s) — normal pace
      //   > 200 chars backlog → 32 chars/tick  (~1066 chars/s) — catch-up mode
      const charsPerTick = pending.length > 200 ? 32 : pending.length > 50 ? 16 : 8;
      const toReveal     = pending.slice(0, charsPerTick);
      const leftover     = pending.slice(charsPerTick);

      // Put the unshown remainder back so the next tick continues from here.
      if (leftover) streamQueueRef.current.unshift(leftover);

      setMessages(prev => prev.map(m =>
        m.id === streamMsgIdRef.current
          ? { ...m, content: m.content + toReveal }
          : m
      ));
    }, 30);
  };

  const pushToStreamQueue = (text: string | null | undefined) => {
    if (text) streamQueueRef.current.push(text);
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

  const jsonCodeCharsRef    = useRef(0);
  const chunkCharsRef       = useRef(0);   // total chars received via onChunk
  const isWritingCodeRef    = useRef(false); // sync mirror of isWritingCode state

  const [isWritingCode,  setIsWritingCode]  = useState(false);
  const [elapsedSecs,    setElapsedSecs]    = useState(0);

  const elapsedTimerRef   = useRef<ReturnType<typeof setInterval> | null>(null);
  const writeStartRef     = useRef<number>(0);

  // Silence detector state
  const lastChunkTimeRef  = useRef<number>(0);
  const silenceTimerRef   = useRef<ReturnType<typeof setInterval> | null>(null);

  // Mark the writing phase as active (idempotent).  Always call through here
  // so the ref and state stay in sync.
  const beginWritingPhase = () => {
    if (isWritingCodeRef.current) return;
    isWritingCodeRef.current = true;
    setIsWritingCode(true);
    writeStartRef.current = Date.now();
    setElapsedSecs(0);
    if (elapsedTimerRef.current) clearInterval(elapsedTimerRef.current);
    elapsedTimerRef.current = setInterval(() => {
      setElapsedSecs(Math.floor((Date.now() - writeStartRef.current) / 1000));
    }, 1000);
  };

  // Start polling for chunk silence.  Called once streaming begins.
  const startSilenceDetector = () => {
    lastChunkTimeRef.current = Date.now();
    chunkCharsRef.current    = 0;
    if (silenceTimerRef.current) clearInterval(silenceTimerRef.current);
    silenceTimerRef.current = setInterval(() => {
      const silentMs = Date.now() - lastChunkTimeRef.current;
      if (!isWritingCodeRef.current &&
          lastChunkTimeRef.current > 0 &&
          silentMs > 1500 &&                   // long enough to skip CoT step gaps
          chunkCharsRef.current >= 100) {       // at least ~20 words already shown
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
    stopSilenceDetector();   // hand off from silence path to elapsed-time path
    beginWritingPhase();
    jsonCodeCharsRef.current = 0;
  };

  const stopJsonCodeCounter = () => {
    stopSilenceDetector();
    if (elapsedTimerRef.current)   { clearInterval(elapsedTimerRef.current);   elapsedTimerRef.current   = null; }
    isWritingCodeRef.current = false;
    setIsWritingCode(false);
    setElapsedSecs(0);
    jsonCodeCharsRef.current  = 0;
    chunkCharsRef.current     = 0;
    writeStartRef.current     = 0;
  };

  const stopStreamQueue = () => {
    if (streamTimerRef.current) {
      clearInterval(streamTimerRef.current);
      streamTimerRef.current = null;
    }
    // Flush any remaining items immediately
    if (streamQueueRef.current.length > 0) {
      const remaining = streamQueueRef.current.splice(0).join('');
      setMessages(prev => prev.map(m =>
        m.id === streamMsgIdRef.current
          ? { ...m, content: m.content + remaining }
          : m
      ));
    }
    setActiveStreamId('');
  };

  // Clean up the animation timer when the component unmounts
  useEffect(() => () => {
    if (streamTimerRef.current) clearInterval(streamTimerRef.current);
  }, []);
  const [showSettings, setShowSettings]     = useState(false);
  const [showRepro,    setShowRepro]         = useState(false);
  const [showTags,     setShowTags]          = useState(false);
  const [reproIssueCount, setReproIssueCount] = useState(reproStore.current.length);

  // Keep the red-dot badge in sync with reproStore updates.
  // Also seed the store from the backend on mount so the badge shows
  // even before the user ever opens the Reproducibility panel.
  useEffect(() => {
    const handler = (issues: any[]) => setReproIssueCount(issues.length);
    reproStore.subscribe(handler);

    const ctx = notebookReader.getFullContext();
    if (ctx?.notebookPath) {
      apiClient.getReproIssues(ctx.notebookPath).then(result => {
        if (result.issues.length > 0) {
          reproStore.emit(result.issues);
        }
      }).catch(() => { /* backend may not have data yet — ignore */ });
    }

    return () => reproStore.unsubscribe(handler);
  }, []);

  // Reasoning mode chip: 'off' | 'cot' | 'sequential'
  // 'cot'       = Chain-of-Thought system prompt injection, 1 API call, steps inline
  // 'sequential' = MCP sequential thinking loop, N API calls, 🧠 panel
  type ReasoningMode = 'off' | 'cot' | 'sequential';
  const REASONING_CYCLE: ReasoningMode[] = ['off', 'cot', 'sequential'];
  const [reasoningMode, setReasoningMode] = useState<ReasoningMode>(() => {
    try {
      const stored = localStorage.getItem('ds-varys-reasoning-mode') as ReasoningMode | null;
      // Migrate legacy boolean flag
      if (!stored && localStorage.getItem('ds-varys-thinking') === 'true') return 'sequential';
      return REASONING_CYCLE.includes(stored as ReasoningMode) ? (stored as ReasoningMode) : 'off';
    } catch {
      return 'off';
    }
  });
  // Tracks which message IDs have their thinking section collapsed (true = collapsed)
  const [thinkCollapsed, setThinkCollapsed] = useState<Map<string, boolean>>(new Map());
  const toggleThinkCollapsed = (id: string) =>
    setThinkCollapsed(prev => new Map(prev).set(id, !prev.get(id)));
  // Ref mirrors state so async callbacks (handleSend) always read the live value
  // even if captured in a stale closure.
  const reasoningModeRef = useRef(reasoningMode);
  useEffect(() => { reasoningModeRef.current = reasoningMode; }, [reasoningMode]);

  const [reasoningDropdownOpen, setReasoningDropdownOpen] = useState(false);
  const reasoningDropdownRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!reasoningDropdownOpen) return;
    const close = (e: MouseEvent) => {
      if (reasoningDropdownRef.current && !reasoningDropdownRef.current.contains(e.target as Node)) {
        setReasoningDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [reasoningDropdownOpen]);

  // ── Image mode — per-notebook, persisted in localStorage ──────────────────
  // Set by /no_figures (strip all figures) or /resize(DIM) (downscale figures).
  // Sent with every task request until changed.
  const _imageModeKey = (path: string) => `ds-varys-image-mode:${path || '_default'}`;
  const [imageMode, setImageModeState] = useState<ImageMode | null>(null);
  const imageModeRef = useRef<ImageMode | null>(null);

  const setImageMode = (mode: ImageMode | null) => {
    imageModeRef.current = mode;
    setImageModeState(mode);
    try {
      const k = _imageModeKey(currentNotebookPathRef.current);
      if (mode) localStorage.setItem(k, JSON.stringify(mode));
      else localStorage.removeItem(k);
    } catch { /* ignore */ }
  };

  // Chat window theme toggle: 'day' (light) or 'night' (dark), persisted in
  // localStorage so it survives JupyterLab restarts independently of the
  // global IDE theme.
  const [chatTheme, setChatTheme] = useState<'day' | 'night'>(() => {
    try {
      return (localStorage.getItem('ds-assistant-chat-theme') as 'day' | 'night') || 'day';
    } catch {
      return 'day';
    }
  });

  const toggleChatTheme = () => {
    setChatTheme(prev => {
      const next = prev === 'day' ? 'night' : 'day';
      try { localStorage.setItem('ds-assistant-chat-theme', next); } catch { /* ignore */ }
      return next;
    });
  };

  // Cell-writing mode toggle — persisted per thread and across sessions.
  // 'chat'  = never write cells (discussion only)
  // 'agent' = skill/heuristic decides (default)
  type CellMode = 'chat' | 'agent';
  const [cellMode, setCellMode] = useState<CellMode>(() => {
    try {
      const stored = localStorage.getItem('ds-assistant-cell-mode');
      // Migrate legacy values: never→chat, auto/always/doc→agent
      if (stored === 'never') return 'chat';
      if (stored === 'auto' || stored === 'always' || stored === 'doc') return 'agent';
      if (stored === 'chat' || stored === 'agent') return stored;
      return 'agent';
    } catch {
      return 'agent';
    }
  });
  // Ref so closures (e.g. _saveThread) always read the latest mode.
  const cellModeRef = useRef<CellMode>(cellMode);
  useEffect(() => { cellModeRef.current = cellMode; }, [cellMode]);
  // Per-thread mode map — the authoritative in-session source.
  // Updated synchronously on every explicit mode change and on thread load,
  // so handleSwitchThread always sees the correct mode regardless of render timing
  // or async _saveThread lag.
  const threadModeMapRef = useRef<Map<string, CellMode>>(new Map());

  // Per-thread reasoning map — same pattern as threadModeMapRef.
  const threadReasoningMapRef = useRef<Map<string, ReasoningMode>>(new Map());

  // ── Input area resize (drag from top) ─────────────────────────────────────
  const MIN_INPUT_HEIGHT = 56;
  const MAX_INPUT_HEIGHT = 400;
  const [inputHeight, setInputHeight] = useState<number>(() => {
    try {
      const saved = localStorage.getItem('ds-assistant-input-height');
      return saved ? Math.max(MIN_INPUT_HEIGHT, parseInt(saved, 10)) : 80;
    } catch { return 80; }
  });
  const dragStateRef  = useRef<{ startY: number; startH: number } | null>(null);
  const textareaRef   = useRef<HTMLDivElement>(null);
  // Tracks the last innerHTML we explicitly set so we can skip redundant updates.
  const ceHtmlRef     = useRef<string>('');
  // Tracks the plain text last read from the CE div in handleCEInput, so the
  // external-input sync useEffect can distinguish user typing from code-driven
  // setInput() calls (e.g. after send, command autocomplete, etc.).
  const lastCEText    = useRef<string>('');

  // ── @-mention autocomplete ─────────────────────────────────────────────────
  // atAnchorPos: index of the triggering '@' in `input` (-1 = closed)
  // atQuery:     partial text the user typed after '@' (used to filter)
  // atSymbols:   full list fetched from /varys/symbols (cached until notebook changes)
  // atFocusIdx:  keyboard-selected row index in the dropdown
  const [atAnchorPos,  setAtAnchorPos]  = useState(-1);
  const [atQuery,      setAtQuery]      = useState('');
  const [atSymbols,    setAtSymbols]    = useState<{ name: string; vtype: string }[]>([]);
  const [atFocusIdx,   setAtFocusIdx]   = useState(0);
  const atDropdownRef = useRef<HTMLDivElement>(null);

  // Auto-resize contenteditable div to fit content, capped at the user-configured
  // max height.  Runs whenever `input` changes and when `inputHeight` changes.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    if (!input) {
      el.style.height = '';   // let min-height CSS take over
    } else {
      el.style.height = 'auto';
      el.style.height = `${Math.min(el.scrollHeight, inputHeight)}px`;
    }
  }, [input, inputHeight]);

  // Sync the CE div's innerHTML when `input` is changed by code (not by the
  // user typing).  When the user types, lastCEText.current === input so we
  // skip the update and avoid disrupting the cursor.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    if (input === lastCEText.current) return; // user's own typing, already handled
    const newHtml = buildHighlightHtml(input);
    el.innerHTML = newHtml;
    ceHtmlRef.current = newHtml;
    if (input) moveCECursorToEnd(el);
  }, [input]);

  const handleResizeMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    dragStateRef.current = { startY: e.clientY, startH: inputHeight };

    const onMove = (mv: MouseEvent) => {
      if (!dragStateRef.current) return;
      // Dragging UP (negative delta) → increase height
      const delta = dragStateRef.current.startY - mv.clientY;
      const next = Math.min(MAX_INPUT_HEIGHT,
        Math.max(MIN_INPUT_HEIGHT, dragStateRef.current.startH + delta));
      setInputHeight(next);
    };
    const onUp = () => {
      dragStateRef.current = null;
      setInputHeight(h => {
        try { localStorage.setItem('ds-assistant-input-height', String(h)); } catch { /* */ }
        return h;
      });
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const CELL_MODE_TITLE: Record<CellMode, string> = {
    chat:  'Chat — assistant responds in the chat panel only',
    agent: 'Agent — assistant decides when to write code or content directly into cells',
  };
  const [pendingOps, setPendingOps] = useState<PendingOp[]>([]);
  // diffStoreRef removed — inline DiffViews now read directly from pendingOps
  // Tracks which fix indices have been applied per code-review message id
  const [appliedFixes, setAppliedFixes] = useState<Map<string, Set<number>>>(new Map());
  const [progressText, setProgressText] = useState<string>('');
  // ID of the assistant message currently being streamed — used to render a
  // typing cursor and to append step results without creating a new bubble.
  const [activeStreamId, setActiveStreamId] = useState<string>('');
  const [editingMsgId,   setEditingMsgId]   = useState<string | null>(null);
  const [editingText,    setEditingText]     = useState<string>('');

  // Cancel edit when the user clicks outside the editing bubble
  useEffect(() => {
    if (!editingMsgId) return;
    const handler = (e: MouseEvent) => {
      const el = document.querySelector('.ds-assistant-message-user--editing');
      if (el && !el.contains(e.target as Node)) setEditingMsgId(null);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [editingMsgId]);

  // ── Chat thread state ──────────────────────────────────────────────────────
  const [threads, setThreads]                   = useState<ChatThread[]>([]);
  const [currentThreadId, setCurrentThreadId]   = useState('');
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
    ? (threads.find(t => t.id === currentThreadId)?.notebookAware ?? true)
    : false;

  const handleToggleNotebookAware = () => {
    setThreads(prev => prev.map(t =>
      t.id === currentThreadId
        ? { ...t, notebookAware: !(t.notebookAware ?? true) }
        : t
    ));
  };
  // AbortController for the current streaming request — allows the user to
  // cancel mid-stream by clicking the stop button.
  const abortControllerRef = useRef<AbortController | null>(null);

  // Refs mirror the state above so that async callbacks (handleSend, auto-save)
  // always see the latest values without stale closures.
  const threadsRef             = useRef<ChatThread[]>([]);
  const currentThreadIdRef     = useRef('');
  const currentNotebookPathRef = useRef('');
  // Holds a stable reference to loadForNotebook so the shell-focus callbacks
  // (registered once at mount) can invoke it without stale closures.
  const loadForNotebookRef = useRef<((path: string) => Promise<void>) | null>(null);
  useEffect(() => { threadsRef.current = threads; },               [threads]);
  useEffect(() => { currentThreadIdRef.current = currentThreadId; }, [currentThreadId]);
  useEffect(() => { currentNotebookPathRef.current = currentNotebookPath; }, [currentNotebookPath]);

  // Restore image mode when the active notebook changes.
  useEffect(() => {
    try {
      const stored = localStorage.getItem(_imageModeKey(currentNotebookPath));
      const m: ImageMode | null = stored ? JSON.parse(stored) : null;
      imageModeRef.current = m;
      setImageModeState(m);
    } catch {
      imageModeRef.current = null;
      setImageModeState(null);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentNotebookPath]);

  // ── Thread persistence helpers ─────────────────────────────────────────────

  const _saveThread = async (
    threadId: string,
    threadName: string,
    msgs: Message[],
    /** Explicit notebook path — pass this to avoid reading a stale ref when
     *  the save fires after a notebook switch. */
    explicitPath?: string,
  ): Promise<void> => {
    const nbPath = explicitPath
      || currentNotebookPathRef.current
      || currentFilePathRef.current
      || notebookTracker.currentWidget?.context.path
      || '';
    if (!nbPath || !threadId) return;
    // Guard against the delete-race: if this thread was already removed from
    // threadsRef (e.g. handleDeleteThread ran concurrently), do not re-save it.
    // Without this check, void _saveThread() calls fired from handleSwitchThread
    // can complete AFTER the DELETE API call, silently re-creating the thread.
    if (!threadsRef.current.some(t => t.id === threadId)) return;
    const saved = msgs
      .filter(m => m.role === 'user' || m.role === 'assistant')
      .map(m => ({
        id: m.id,
        role: m.role as 'user' | 'assistant',
        content: m.content,
        timestamp: m.timestamp.toISOString(),
        ...(m.thoughts        ? { thoughts: m.thoughts }               : {}),
        ...(m.operationId     ? { operationId: m.operationId }         : {}),
        ...(m.diffs && m.diffs.length > 0 ? { diffs: m.diffs }        : {}),
        ...(m.diffResolved    ? { diffResolved: m.diffResolved }       : {}),
      }));
    const now = new Date().toISOString();
    const existing = threadsRef.current.find(t => t.id === threadId);
    const savedThread: ChatThread = {
      id: threadId,
      name: threadName || existing?.name || 'Thread',
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      messages: saved,
      tokenUsage:    existing?.tokenUsage,
      notebookAware: existing?.notebookAware,
      cellMode:      cellModeRef.current,
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
        return;  // success
      } catch (err) {
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

  // In-memory cache: path → {threads, lastThreadId}.
  // Populated when history loads from disk; kept fresh via _saveThread.
  // Checked before disk reads so switching back to a visited doc is instant.
  type AgentPanelSnapshot = {
    ready: boolean;
    fileChanges: FileChangeEvent[];
    filesRead: string[];
    operationId: string;
    resolved: Record<string, boolean>;
    incomplete: boolean;
    bashCount: number;
  };

  const historyCacheRef = useRef<Map<string, {
    threads: ChatThread[];
    lastThreadId: string | null;
    agentPanel?: AgentPanelSnapshot;
  }>>(new Map());

  const _updateCache = (path: string, threads: ChatThread[], lastThreadId: string | null) => {
    if (!path) return;
    const existing = historyCacheRef.current.get(path);
    historyCacheRef.current.set(path, { threads, lastThreadId, agentPanel: existing?.agentPanel });
    // Keep the cache bounded — evict the oldest entry when it grows past 10.
    if (historyCacheRef.current.size > 10) {
      const oldest = historyCacheRef.current.keys().next().value as string;
      historyCacheRef.current.delete(oldest);
    }
  };

  /** Snapshot the current agent panel state into the cache for the given path.
   *  Reads from agentPanelRef (always current) rather than React state
   *  (which would be stale inside useEffect([], []) callbacks). */
  const _saveAgentStateToCache = (path: string) => {
    if (!path) return;
    const snapshot = agentPanelRef.current; // null when panel is closed
    const entry = historyCacheRef.current.get(path);
    if (entry) {
      historyCacheRef.current.set(path, { ...entry, agentPanel: snapshot ?? undefined });
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
  const _restoreThreadMode = (thread: ChatThread | undefined): void => {
    if (!thread) return;
    const mapped = threadModeMapRef.current.get(thread.id);
    const mode: CellMode =
      mapped !== undefined ? mapped :
      (thread.cellMode === 'chat' ? 'chat' : 'agent');
    setCellMode(mode);
    cellModeRef.current = mode;
    // Record so subsequent reads from the map are correct even if the user
    // never explicitly toggles this thread in the current session.
    threadModeMapRef.current.set(thread.id, mode);
    try { localStorage.setItem('ds-assistant-cell-mode', mode); } catch { /* ignore */ }
  };

  const _restoreThreadReasoning = (thread: ChatThread | undefined): void => {
    if (!thread) return;
    const mapped = threadReasoningMapRef.current.get(thread.id);
    const mode: ReasoningMode =
      mapped !== undefined ? mapped :
      (REASONING_CYCLE.includes(thread.reasoningMode as ReasoningMode)
        ? (thread.reasoningMode as ReasoningMode)
        : 'off');
    setReasoningMode(mode);
    reasoningModeRef.current = mode;
    threadReasoningMapRef.current.set(thread.id, mode);
    try { localStorage.setItem('ds-varys-reasoning-mode', mode); } catch { /* ignore */ }
  };

  const _restoreFromCache = (path: string): boolean => {
    const cached = historyCacheRef.current.get(path);
    if (!cached || cached.threads.length === 0) return false;
    const lastId = cached.lastThreadId ?? cached.threads[0]?.id ?? '';
    const lastThread = cached.threads.find(t => t.id === lastId);
    setThreads(cached.threads);
    threadsRef.current = cached.threads;
    setCurrentThreadId(lastId);
    currentThreadIdRef.current = lastId;
    const _restoredMsgs: Message[] =
      lastThread && lastThread.messages.length > 0
        ? lastThread.messages.map(m => ({
            id: m.id,
            role: m.role as Message['role'],
            content: m.content,
            timestamp: new Date(m.timestamp),
            fromHistory: true,
            ...(m.thoughts      ? { thoughts: m.thoughts }           : {}),
            ...(m.operationId   ? { operationId: m.operationId }     : {}),
            ...(m.diffs && m.diffs.length > 0 ? { diffs: m.diffs as DiffInfo[] } : {}),
            ...(m.diffResolved  ? { diffResolved: m.diffResolved }   : {}),
          }))
        : [];
    setMessages(_restoredMsgs);
    setPendingOps(_opsFromMessages(_restoredMsgs));
    _restoreThreadMode(lastThread);
    _restoreThreadReasoning(lastThread);
    // Restore agent panel if there was one pending when we left this file.
    if (cached.agentPanel?.ready) {
      setAgentResultsReady(true);
      setAgentFileChanges(cached.agentPanel.fileChanges);
      setAgentFilesRead(cached.agentPanel.filesRead);
      setAgentOperationId(cached.agentPanel.operationId);
      setAgentResolved(cached.agentPanel.resolved);
      setAgentIncomplete(cached.agentPanel.incomplete);
      setAgentBashCount(cached.agentPanel.bashCount);
    }
    return true;
  };

  // Debounced auto-save: 1.5 s after the last message change.
  // Capture path + threadId at schedule time so a notebook switch that
  // happens before the timer fires doesn't corrupt the wrong file.
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const threadId = currentThreadIdRef.current;
    const nbPath   = currentNotebookPathRef.current
      || currentFilePathRef.current
      || notebookTracker.currentWidget?.context.path
      || '';
    if (!threadId || !nbPath) return;
    if (!messages.some(m => m.role === 'user' || m.role === 'assistant')) return;
    // Snapshot values NOW, before any possible notebook switch
    const snapshotPath = nbPath;
    const snapshotTid  = threadId;
    const snapshotMsgs = messages;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      const tName = threadsRef.current.find(t => t.id === snapshotTid)?.name ?? 'Thread';
      // Pass snapshotPath explicitly so even a notebook switch between
      // scheduling and firing doesn't corrupt the wrong file.
      void _saveThread(snapshotTid, tName, snapshotMsgs, snapshotPath);
    }, 1500);
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages]);

  // ── Auto-load chat history when the active notebook changes ───────────────
  useEffect(() => {
    const loadForNotebook = async (newPath: string): Promise<void> => {
      if (!newPath) return;
      // Skip if the same notebook is already active (e.g. a panel focus event
      // that doesn't actually change the notebook).
      if (newPath === currentNotebookPathRef.current) return;

      // ── 1. Flush any pending save for the OUTGOING notebook immediately ──
      //    The debounced timer may not have fired yet. Capture its path and
      //    messages before we switch.
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      const outgoingPath   = currentNotebookPathRef.current;
      const outgoingTid    = currentThreadIdRef.current;
      const outgoingMsgs   = messagesRef.current;
      if (outgoingPath && outgoingTid && outgoingMsgs.length > 0) {
        const tName = threadsRef.current.find(t => t.id === outgoingTid)?.name ?? 'Thread';
        // Pass outgoingPath explicitly — currentNotebookPathRef is about to
        // be updated to newPath, so we must not rely on the ref here.
        void _saveThread(outgoingTid, tName, outgoingMsgs, outgoingPath);
      }

      // ── 2. Switch path refs immediately so any save that arrives later
      //       from a race condition writes to the correct file ──────────────
      setCurrentNotebookPath(newPath);
      currentNotebookPathRef.current = newPath;

      // Always reset agent panel when switching documents.  Without this the
      // panel from a previously-viewed py file bleeds onto notebook tabs.
      setAgentResultsReady(false);
      setAgentFileChanges([]);
      setAgentFilesRead([]);
      setAgentResolved({});
      setAgentOperationId('');
      setAgentIncomplete(false);
      setAgentBashCount(0);
      setAgentBashWarnings([]);
      setAgentBlockedCmds([]);
      setBashWarnDismissed({});
      setBlockedCmdDismissed({});

      // ── 3. Serve from in-memory cache if available (instant, no network) ─
      if (_restoreFromCache(newPath)) return;

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
        if (currentNotebookPathRef.current !== newPath) return;
        if (chatFile.threads.length > 0) {
          const lastId     = chatFile.lastThreadId ?? chatFile.threads[0].id;
          const lastThread = chatFile.threads.find(t => t.id === lastId);
          setThreads(chatFile.threads);
          threadsRef.current = chatFile.threads;
          setCurrentThreadId(lastId);
          currentThreadIdRef.current = lastId;
          // Seed the mode maps from disk so non-active threads have correct modes.
          chatFile.threads.forEach(t => {
            if (t.cellMode) threadModeMapRef.current.set(t.id, t.cellMode as CellMode);
            if (t.reasoningMode) threadReasoningMapRef.current.set(t.id, t.reasoningMode as ReasoningMode);
          });
          const _diskMsgs: Message[] =
            lastThread && lastThread.messages.length > 0
              ? lastThread.messages.map(m => ({
                  id: m.id,
                  role: m.role as Message['role'],
                  content: m.content,
                  timestamp: new Date(m.timestamp),
                  fromHistory: true,
                  ...(m.thoughts      ? { thoughts: m.thoughts }         : {}),
                  ...(m.operationId   ? { operationId: m.operationId }   : {}),
                  ...(m.diffs && m.diffs.length > 0 ? { diffs: m.diffs as DiffInfo[] } : {}),
                  ...(m.diffResolved  ? { diffResolved: m.diffResolved } : {}),
                }))
              : [];
          setMessages(_diskMsgs);
          setPendingOps(_opsFromMessages(_diskMsgs));
          _restoreThreadMode(lastThread);
          _restoreThreadReasoning(lastThread);
          _updateCache(newPath, chatFile.threads, lastId);
        } else {
          const t = makeNewThread('Main');
          setThreads([t]);
          threadsRef.current = [t];
          setCurrentThreadId(t.id);
          currentThreadIdRef.current = t.id;
          setMessages([]);
          _updateCache(newPath, [t], t.id);
        }
      } catch (err) {
        if (currentNotebookPathRef.current !== newPath) return;
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
    if (current?.context.path) void loadForNotebook(current.context.path);

    const handler = (_: INotebookTracker, widget: unknown) => {
      const nbWidget = widget as { context?: { path?: string } } | null;
      if (nbWidget?.context?.path) {
        // Another notebook came into focus — load its chat history.
        void loadForNotebook(nbWidget.context.path);
      } else {
        // No notebook is in focus (last one was closed, or focus left notebooks).
        // Save any pending messages for the outgoing notebook then blank the UI.
        if (saveTimerRef.current) {
          clearTimeout(saveTimerRef.current);
          saveTimerRef.current = null;
        }
        const outgoingPath = currentNotebookPathRef.current;
        const outgoingTid  = currentThreadIdRef.current;
        const outgoingMsgs = messagesRef.current;
        if (outgoingPath && outgoingTid && outgoingMsgs.length > 0) {
          const tName = threadsRef.current.find(t => t.id === outgoingTid)?.name ?? 'Thread';
          void _saveThread(outgoingTid, tName, outgoingMsgs, outgoingPath);
        }
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
    setNonNotebookFocusCallback(async (filePath: string) => {
      // Same file re-activated (e.g. reloadFile → docmanager:open triggers
      // activeChanged for the same document). Don't wipe state — the agent
      // panel and chat history are still valid.
      if (filePath && filePath === currentFilePathRef.current) return;

      // ── 1. Flush outgoing saves ────────────────────────────────────────
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      const outgoingNbPath   = currentNotebookPathRef.current;
      const outgoingFilePath = currentFilePathRef.current;
      const outgoingTid      = currentThreadIdRef.current;
      const outgoingMsgs     = messagesRef.current;
      if (outgoingNbPath && outgoingTid && outgoingMsgs.length > 0) {
        const tName = threadsRef.current.find(t => t.id === outgoingTid)?.name ?? 'Thread';
        void _saveThread(outgoingTid, tName, outgoingMsgs, outgoingNbPath);
      }
      // Save the previous file's chat if switching between files.
      if (outgoingFilePath && outgoingFilePath !== filePath && outgoingTid && outgoingMsgs.length > 0) {
        const tName = threadsRef.current.find(t => t.id === outgoingTid)?.name ?? 'Thread';
        void _saveThread(outgoingTid, tName, outgoingMsgs, outgoingFilePath);
      }
      // Snapshot agent panel so it survives the focus switch.
      if (outgoingFilePath) _saveAgentStateToCache(outgoingFilePath);
      if (outgoingNbPath)   _saveAgentStateToCache(outgoingNbPath);

      // ── 2. Update path refs and clear UI ─────────────────────────────
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

      if (!filePath) return;

      // ── 3. Serve from in-memory cache if available (instant) ─────────────
      if (_restoreFromCache(filePath)) return;

      // ── 4. Cache miss — load from disk ───────────────────────────────────
      try {
        const chatFile = await apiClient.loadChatHistory(filePath);
        // Stale-guard: another focus event fired while we were awaiting.
        // Drop the result so we don't overwrite a more-recent context load.
        if (currentFilePathRef.current !== filePath) return;
        if (chatFile.threads.length > 0) {
          const lastId     = chatFile.lastThreadId ?? chatFile.threads[0].id;
          const lastThread = chatFile.threads.find(t => t.id === lastId);
          setThreads(chatFile.threads);
          threadsRef.current = chatFile.threads;
          setCurrentThreadId(lastId);
          currentThreadIdRef.current = lastId;
          // Seed the mode maps from disk so non-active threads have correct modes.
          chatFile.threads.forEach(t => {
            if (t.cellMode) threadModeMapRef.current.set(t.id, t.cellMode as CellMode);
            if (t.reasoningMode) threadReasoningMapRef.current.set(t.id, t.reasoningMode as ReasoningMode);
          });
          const _fileMsgs: Message[] =
            lastThread && lastThread.messages.length > 0
              ? lastThread.messages.map(m => ({
                  id: m.id,
                  role: m.role as Message['role'],
                  content: m.content,
                  timestamp: new Date(m.timestamp),
                  fromHistory: true,
                  ...(m.thoughts      ? { thoughts: m.thoughts }         : {}),
                  ...(m.operationId   ? { operationId: m.operationId }   : {}),
                  ...(m.diffs && m.diffs.length > 0 ? { diffs: m.diffs as DiffInfo[] } : {}),
                  ...(m.diffResolved  ? { diffResolved: m.diffResolved } : {}),
                }))
              : [];
          setMessages(_fileMsgs);
          setPendingOps(_opsFromMessages(_fileMsgs));
          _restoreThreadMode(lastThread);
          _restoreThreadReasoning(lastThread);
          _updateCache(filePath, chatFile.threads, lastId);
        } else {
          const t = makeNewThread('Main');
          setThreads([t]);
          threadsRef.current = [t];
          setCurrentThreadId(t.id);
          currentThreadIdRef.current = t.id;
          setMessages([]);
          _updateCache(filePath, [t], t.id);
        }
      } catch {
        if (currentFilePathRef.current !== filePath) return;
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
    setNotebookActivatedCallback((path: string) => {
      if (!path) return;
      // Flush and save the outgoing file's chat history before switching.
      const outgoingFilePath = currentFilePathRef.current;
      if (outgoingFilePath) {
        if (saveTimerRef.current) {
          clearTimeout(saveTimerRef.current);
          saveTimerRef.current = null;
        }
        const outgoingTid  = currentThreadIdRef.current;
        const outgoingMsgs = messagesRef.current;
        if (outgoingTid && outgoingMsgs.length > 0) {
          const tName = threadsRef.current.find(t => t.id === outgoingTid)?.name ?? 'Thread';
          void _saveThread(outgoingTid, tName, outgoingMsgs, outgoingFilePath);
        }
        // Snapshot agent panel so it survives switching back to this file.
        _saveAgentStateToCache(outgoingFilePath);
      }
      // Also snapshot the outgoing notebook's agent state.
      const outgoingNbPath = currentNotebookPathRef.current;
      if (outgoingNbPath) _saveAgentStateToCache(outgoingNbPath);
      // Clear any non-notebook file context now that a notebook is active.
      setCurrentFilePath('');
      currentFilePathRef.current = '';
      void loadForNotebookRef.current?.(path);
    });
    return () => setNotebookActivatedCallback(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);


  // Model switcher state
  const [chatProvider, setChatProvider] = useState('');
  const [chatModel,    setChatModel]    = useState('');
  const [chatZoo,      setChatZoo]      = useState<string[]>([]);
  const [modelSwitching, setModelSwitching] = useState(false);

  // ── Advisory phrases (loaded from .jupyter-assistant/rules/advisory-phrases.md) ──
  // Initialised with the hardcoded defaults; overwritten by server response.
  const [advisoryPhrases, setAdvisoryPhrases] = useState<string[]>(_ADVISORY_STARTS);

  // ── Slash-command state ────────────────────────────────────────────────────
  const [commands, setCommands]       = useState<SlashCommand[]>([]);
  const [showCmdPopup, setShowCmdPopup] = useState(false);
  const [activeCommand, setActiveCommand] = useState<SlashCommand | null>(null);

  // Agent session state (for /file_agent)
  const [agentBadgeVisible, setAgentBadgeVisible] = useState(false);
  const [agentFileChanges, setAgentFileChanges] = useState<FileChangeEvent[]>([]);
  const [agentFilesRead, setAgentFilesRead] = useState<string[]>([]);
  const [agentIncomplete, setAgentIncomplete] = useState(false);
  const [agentBashCount, setAgentBashCount] = useState(0);
  const [agentBashWarnings, setAgentBashWarnings]     = useState<string[]>([]);
  const [agentBlockedCmds, setAgentBlockedCmds]       = useState<{command: string; reason: string}[]>([]);
  const [bashWarnDismissed, setBashWarnDismissed]     = useState<Record<number, boolean>>({});
  const [blockedCmdDismissed, setBlockedCmdDismissed] = useState<Record<number, boolean>>({});
  const [agentOperationId, setAgentOperationId] = useState('');
  const [agentResolved, setAgentResolved] = useState<Record<string, boolean>>({});
  const [agentResultsReady, setAgentResultsReady] = useState(false);
  /** ID of the assistant message that triggered the file agent run. */
  const [agentMsgId, setAgentMsgId] = useState('');

  // Ref that always holds the latest agent panel state.  Used by focus-switch
  // callbacks (which are captured in useEffect([], []) and would otherwise read
  // stale closure values from the initial render).
  const agentPanelRef = useRef<AgentPanelSnapshot | null>(null);

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
  const [agentToolError, setAgentToolError] = useState<AgentToolErrorInfo | null>(null);
  const [settingsOpenToAgent, setSettingsOpenToAgent] = useState(false);

  // ── Background warnings (billing errors, scan failures, etc.) ────────────
  interface BackendWarning { level: string; code: string; message: string; timestamp: string; }
  const [sysWarnings, setSysWarnings] = useState<BackendWarning[]>([]);
  const [warningsDismissed, setWarningsDismissed] = useState(false);

  // Poll GET /varys/warnings on mount and every 60 s.
  useEffect(() => {
    const fetchWarnings = async () => {
      try {
        const resp = await fetch('/varys/warnings', {
          headers: { 'X-XSRFToken': getXsrfToken() },
          credentials: 'same-origin',
        });
        if (!resp.ok) return;
        const data = await resp.json() as { warnings: BackendWarning[] };
        if (data.warnings?.length) {
          setSysWarnings(prev => [...prev, ...data.warnings]);
          setWarningsDismissed(false);
        }
      } catch { /* silent — backend may not be ready yet */ }
    };
    void fetchWarnings();
    const interval = setInterval(() => void fetchWarnings(), 60_000);
    return () => clearInterval(interval);
  }, []);

  const messagesEndRef       = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  // Tracks each rendered .ds-thinking-body element by message id so the scroll
  // effect can pin the active one to the bottom during thought streaming.
  const thinkingBodyRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  // Load slash commands on mount (and re-load after skills refresh)
  useEffect(() => {
    apiClient.getCommands().then(cmds => {
      if (cmds.length) setCommands(cmds);
    }).catch(() => { /* silently ignore */ });
  }, [apiClient]);

  // Re-fetch commands whenever the autocomplete popup opens so newly-added
  // skills appear immediately without a manual refresh.
  useEffect(() => {
    if (!showCmdPopup) return;
    apiClient.getCommands().then(cmds => {
      if (cmds.length) setCommands(cmds);
    }).catch(() => { /* silently ignore */ });
  }, [showCmdPopup]);

  // Reusable settings loader — called on mount and after settings panel closes.
  const loadModelSettings = () => {
    apiClient
      .getSettings()
      .then((data: Record<string, any>) => {
        const vals: Record<string, string> = {};
        for (const [k, entry] of Object.entries(data)) {
          if (!k.startsWith('_')) {
            vals[k] = (entry as { value: string }).value ?? '';
          }
        }
        // No fallback: if DS_CHAT_PROVIDER is empty the user must configure it in settings
        const provider     = (vals['DS_CHAT_PROVIDER'] ?? '').toUpperCase();
        const zooRaw       = provider ? (vals[`${provider}_MODELS`] ?? '') : '';
        const zoo          = zooRaw.trim() ? parseZoo(zooRaw) : (provider ? (DEFAULT_ZOO[`${provider}_MODELS`] ?? []) : []);
        const model        = provider ? (vals[`${provider}_CHAT_MODEL`] ?? '') : '';
        setChatProvider(provider);
        setChatModel(model);
        setChatZoo(zoo);
        // Load user-configured advisory phrases from the rules file.
        const phrases = data['_advisoryPhrases'];
        if (Array.isArray(phrases) && phrases.length > 0) {
          setAdvisoryPhrases(phrases as string[]);
        }
      })
      .catch((err: unknown) => {
        console.warn('[Varys] settings load failed:', err);
        /* switcher shows — */
      });
  };

  // Load provider info + current chat model + zoo on mount
  useEffect(() => {
    apiClient
      .healthCheck()
      .catch(() => { /* server not ready yet */ });

    loadModelSettings();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiClient]);

  // Auto-scroll to bottom whenever messages update or streaming is active.
  // Uses instant scrollTop assignment so the view stays pinned during rapid
  // 30 ms token bursts without smooth-scroll lag.
  // Also pins the active thinking-body panel so reasoning text stays readable.
  useEffect(() => {
    const el = messagesContainerRef.current;
    if (el) el.scrollTop = el.scrollHeight;

    if (activeStreamId) {
      const thinkEl = thinkingBodyRefs.current.get(activeStreamId);
      if (thinkEl) thinkEl.scrollTop = thinkEl.scrollHeight;
    }
  }, [messages, isLoading, activeStreamId]);

  /**
   * Reconstruct pendingOps from a list of loaded messages.
   * Every message with diffs stored produces a PendingOp so the pinned section
   * shows the full diff history (resolved ones collapsed, pending ones active).
   */
  const _opsFromMessages = (msgs: Message[]): PendingOp[] =>
    msgs
      .filter(m => m.diffs && m.diffs.length > 0 && m.operationId)
      .map(m => ({
        operationId: m.operationId!,
        cellIndices: [],
        steps: [],
        description: m.diffResolved
          ? (m.diffResolved === 'accepted' ? '✓ Changes accepted' : '↩ Changes undone')
          : 'Restored from history',
        diffs: m.diffs!,
        resolved: m.diffResolved,
      }));

  const addMessage = (
    role: Message['role'],
    content: string,
    extraProps?: string | Partial<Omit<Message, 'id' | 'role' | 'content' | 'timestamp'>>
  ): void => {
    const id = generateId();
    const extra: Partial<Message> = typeof extraProps === 'string'
      ? { displayContent: extraProps }
      : (extraProps ?? {});
    setMessages(prev => [
      ...prev,
      { id, role, content, timestamp: new Date(), ...extra }
    ]);
  };

  const addMessageWithChip = (
    role: Message['role'],
    content: string,
    displayContent?: string,
    contextChipData?: { label: string; preview: string },
  ): void => {
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
  const handleSendRef = useRef<((text: string, displayText?: string, skipAdvisory?: boolean) => Promise<void>) | null>(null);
  /** Mirror of messages kept in a ref so the notebook-switch handler can read
   *  the current value synchronously (React state is async). */
  const messagesRef = useRef<Message[]>([]);
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
  const _savedTokenRef = useRef<{ input: number; output: number } | undefined>(undefined);
  useEffect(() => {
    const tid    = currentThreadIdRef.current;
    const nbPath = currentNotebookPathRef.current;
    if (!tid || !nbPath) return;
    const usage = threads.find(t => t.id === tid)?.tokenUsage;
    if (!usage || (usage.input === 0 && usage.output === 0)) return;
    const prev = _savedTokenRef.current;
    if (prev && prev.input === usage.input && prev.output === usage.output) return;
    _savedTokenRef.current = { ...usage };
    const tName = threadsRef.current.find(t => t.id === tid)?.name ?? 'Thread';
    void _saveThread(tid, tName, messagesRef.current, nbPath);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threads]);

  /** Holds the hidden LLM context that will be prepended on the next send. */
  const contextPrefixRef = useRef<string>('');
  /** Visible chip above the textarea showing what code context is attached. */
  const [contextChip, setContextChip] = useState<{ label: string; preview: string } | null>(null);
  /** Whether the chip preview is expanded in the input area. */
  const [chipExpanded, setChipExpanded] = useState(false);
  /** A specific output the user selected via the output overlay (right-click). */
  const selectedOutputRef = useRef<ExternalMessage['selectedOutput'] | null>(null);

  useEffect(() => {
    setExternalMessageListener(({ text, autoSend, openTags, displayText, contextPrefix, contextChip: chip, selectedOutput }) => {
      if (openTags) {
        setShowTags(true);
        return;
      }
      // Store the hidden LLM context prefix and its visible chip representation.
      contextPrefixRef.current = contextPrefix ?? '';
      setContextChip(chip ?? null);
      setChipExpanded(false);
      selectedOutputRef.current = selectedOutput ?? null;
      setInput(text);
      if (autoSend && handleSendRef.current) {
        setTimeout(() => handleSendRef.current?.(text, displayText), 0);
      }
    });
    return () => setExternalMessageListener(null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // -------------------------------------------------------------------------
  // Send handler
  // -------------------------------------------------------------------------

  const handleSend = async (
    overrideText?: string,
    displayText?: string,
    skipAdvisory = false,
    // When re-sending an edited message the caller passes the already-truncated
    // message list so chatHistory is built from the correct prior context rather
    // than the stale `messages` closure (React state updates are async).
    priorMessages?: Message[],
  ): Promise<void> => {
    const typedText = (overrideText ?? input).trim();
    if (!typedText || isLoading) return;
    if (!chatProvider) {
      setMessages(prev => [...prev, {
        id: Date.now().toString(),
        role: 'assistant' as const,
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
    const bubbleDisplay = displayText ?? (prefix ? typedText : undefined);

    // ── /resize(DIM) — special pre-check ─────────────────────────────────
    // parseSlashCommand() uses [\w-]+ which doesn't capture parentheses, so
    // /resize(7800) and /resize(7800) <message> must be detected here before
    // the regular slash-command parser runs.
    //
    // Two forms:
    //   /resize(7800)            → set mode, show confirmation, stop
    //   /resize(7800) <message>  → set mode, then treat <message> as the input
    const resizeCmdMatch = rawInput.trim().match(/^\/resize\((\d+)\)([\s\S]*)$/i);
    let slashCommand: string | undefined;
    let message = '';
    // _effectiveInput: what the slash-command parser and task flow use.
    // Normally equals rawInput; for /resize(DIM) <rest> it becomes just <rest>.
    let _effectiveInput = rawInput;

    if (resizeCmdMatch) {
      setInput('');
      const dim  = parseInt(resizeCmdMatch[1], 10);
      const rest = resizeCmdMatch[2].trim();
      if (dim < 10) {
        addMessage('system', `❌ Invalid resize dimension: must be ≥ 10 (got **${dim}**). Nothing changed.`);
        return;
      }
      setImageMode({ mode: 'resize', dim });
      if (!rest) {
        addMessage('system',
          `🔬 Resize mode active — figures will be downscaled to **${dim}px** max before sending.\n\n` +
          `Re-send your message to proceed.`
        );
        return;
      }
      // Has a trailing message — treat it as a plain message with mode already set
      message          = rest;
      _effectiveInput  = rest;
      // Fall through to disambiguation / task flow below (skip command parsing)
    }

    // ── Slash-command parsing ────────────────────────────────────────────
    // If the input starts with a /command, extract it and use the remainder
    // as the actual user message sent to the LLM.
    const parsed = resizeCmdMatch ? null : parseSlashCommand(_effectiveInput);

    if (parsed) {
      // Varys File Agent commands are always recognised, regardless of whether
      // the commands list has finished loading from the backend.
      const isAgentCommand = (
        parsed.command === '/file_agent' ||
        parsed.command === '/file_agent_find' ||
        parsed.command === '/file_agent_save'
      );
      if (isAgentCommand) {
        setInput('');
        setActiveCommand(null);
        setShowCmdPopup(false);
        setAgentResultsReady(false);
        setAgentToolError(null);
        // agentConfigOpen removed
        slashCommand = parsed.command;
        message      = parsed.rest?.trim() ?? '';
        // Fall through to the main task flow below.
      } else {

      // Check if it is a built-in command
      const knownBuiltin = commands.find(
        c => c.type === 'builtin' && c.command === parsed.command
      );
      if (knownBuiltin) {
        setInput('');
        setActiveCommand(null);
        setShowCmdPopup(false);

        // /index [path]: route to the RAG index flow (async).
        // No path → index the whole knowledge folder (backend defaults to it).
        if (parsed.command === '/index') {
          await handleIndexCommand(parsed.rest?.trim() ?? '');
          return;
        }

        // /rag: show knowledge-base status
        if (parsed.command === '/rag') {
          await handleRagStatus();
          return;
        }

        // /ask <query>: fall through to the task flow with command='/ask'
        // so the backend can do RAG retrieval.  /ask with NO args shows help.
        if (parsed.command === '/ask' && parsed.rest) {
          slashCommand = '/ask';
          message      = parsed.rest.trim();
          // Don't return early — fall through to the main task flow below.
        } else if (parsed.command === '/chat' && parsed.rest) {
          // /chat <message>: force advisory/chat mode for this single request.
          // The backend skips tool-use and streams a plain markdown answer.
          slashCommand = '/chat';
          message      = parsed.rest.trim();
          // Don't return early — fall through to the main task flow below.
        } else if (
          parsed.command === '/file_agent' ||
          parsed.command === '/file_agent_find' ||
          parsed.command === '/file_agent_save'
        ) {
          // Varys File Agent commands — pass through to the backend task flow.
          // message may be empty (e.g. /file_agent with no args → help response).
          slashCommand = parsed.command;
          message      = parsed.rest?.trim() ?? '';
          // Don't return early — fall through to the main task flow below.
        } else if (parsed.command === '/no_figures' && parsed.rest) {
          // /no_figures <message>: set strip mode and send the message.
          // This form is produced by the recovery prompt pre-fill.
          setImageMode({ mode: 'no_figures' });
          message = parsed.rest.trim();
          // Fall through to task flow (no slashCommand — plain message with mode set).
        } else {
          // All other built-ins (including no-arg /ask, /index, /rag)
          handleBuiltinCommand(parsed.command);
          return;
        }
      } else {
        // Check if it's a known skill command
        const knownSkill = commands.find(
          c => c.type === 'skill' && c.command === parsed.command
        );
        if (!knownSkill) {
          // Unknown command — reject immediately, do not send to LLM
          addMessage('system',
            `Unknown command \`${parsed.command}\`. ` +
            `Type \`/help\` to see all available commands, or check **Settings → Skills** to import skill commands.`
          );
          setInput('');
          return;
        }
        slashCommand = parsed.command;
        message      = parsed.rest || _effectiveInput;
      }
      } // end else (non-agent commands)
    } else if (!resizeCmdMatch) {
      // Plain message (no command, no /resize pre-match already set message)
      message = _effectiveInput;
    }

    // Clear command UI state
    setActiveCommand(null);
    setShowCmdPopup(false);

    // ── Disambiguation check ─────────────────────────────────────────────
    // When the user types a plain message (no /command) that looks like a
    // discussion/question, and the sidebar is in Auto mode (intent unknown),
    // surface two options instead of guessing silently:
    //   💬 /chat <message>  — answer in chat only
    //   📝 <message>        — write result to notebook cells
    //
    // This is skipped when:
    //   - A slash command was explicitly typed
    //   - The user already chose via a disambiguation card (skipAdvisory=true)
    //   - The sidebar is locked to Chat or Document mode (intent is clear)
    //   - A context chip is attached (specific targeted action)
    const effectiveCellMode = (notebookAware || !!currentFilePathRef.current) ? cellMode : 'chat';
    if (
      !skipAdvisory &&
      !slashCommand &&
      effectiveCellMode === 'agent' &&
      !chip &&
      !selectedOutputRef.current &&
      looksAdvisory(typedText, advisoryPhrases)
    ) {
      setInput('');
      const disambigId = generateId();
      setMessages(prev => [...prev, {
        id: disambigId,
        role: 'disambiguation',
        content: typedText,   // store original typed text for re-send
        timestamp: new Date(),
      }]);
      return;
    }

    // Capture conversation history BEFORE adding the new user message.
    // We only include user/assistant turns (not system/warning/report/code-review),
    // and cap at the last 6 turns (3 exchanges) to limit token usage.
    const MAX_HISTORY_TURNS = 6;

    // Build a cellId-prefix → current 1-based position map so we can rewrite
    // any stale "#N [id:X]" references that appear in older history turns.
    const idPrefixToCurrentNum = new Map<string, number>();
    const freshCtx = notebookReader.getFullContext();
    if (freshCtx) {
      for (const c of freshCtx.cells) {
        if (c.cellId) {
          const prefix = c.cellId.split('-')[0];
          idPrefixToCurrentNum.set(prefix, c.index + 1);  // 1-based
        }
      }
    }

    const chatHistory: ChatTurn[] = (priorMessages ?? messages)
      .filter(m => m.role === 'user' || m.role === 'assistant')
      .slice(-MAX_HISTORY_TURNS)
      .map(m => ({
        role: m.role as 'user' | 'assistant',
        content: translateCellRefs(m.content, idPrefixToCurrentNum),
      }));

    setInput('');
    // Show the raw input in the user bubble; if a short display label was
    // provided (e.g. from a context-menu action), show that instead so the
    // chat isn't cluttered with large code blocks.
    addMessageWithChip('user', rawInput, bubbleDisplay, chip ?? undefined);
    setIsLoading(true);
    setProgressText('Preparing…');

    let progressTimer: ReturnType<typeof setInterval> | undefined;

    try {
      const nbContext = notebookReader.getFullContext();
      const fileCtxPath = currentFilePathRef.current;
      if (!nbContext && !fileCtxPath) {
        addMessage(
          'system',
          'No active notebook or file. Please open a notebook or file first.'
        );
        return;
      }

      // When a non-notebook file is active, build a minimal context that
      // carries the file path. notebookPath mirrors fileContextPath so the
      // file agent (and other backend paths that read notebookPath) know
      // which file they are working on.
      const context = nbContext ?? {
        cells: [],
        notebookPath: fileCtxPath,
        fileContextPath: fileCtxPath,
      };

      // ── Attach selected output (from right-click output overlay) ─────
      if (selectedOutputRef.current) {
        context.selectedOutput = selectedOutputRef.current;
        selectedOutputRef.current = null;  // consume once
      }

      // ── Inject active file path when a non-notebook file is focused ───
      if (fileCtxPath) {
        context.fileContextPath = fileCtxPath;
      }

      // ── Strip notebook cells when this thread is not notebook-aware ───
      // Keep notebookPath so skills still know which notebook is open,
      // but remove cell content and dataframes to save tokens.
      if (!notebookAware) {
        context.cells      = [];
        context.dataframes = [];
      }

      // ── Resolve @variable_name references in the message ─────────────
      let resolvedVariables: ResolvedVariable[] = [];
      const varRefs = parseVariableRefs(message);
      if (varRefs.length > 0) {
        setProgressText(`Resolving ${varRefs.map(r => '@' + r).join(', ')}…`);
        resolvedVariables = await variableResolver.resolve(message);
        if (resolvedVariables.length > 0) {
          const badges = resolvedVariables.map(v => {
            const s = v.summary;
            if (s.type === 'dataframe') {
              return `📎 @${v.expr} (${s.shape?.[0]?.toLocaleString()}×${s.shape?.[1]})`;
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
        } catch (err: any) {
          addMessage('system', `Report generation failed: ${err?.message ?? err}`);
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
            role: 'assistant' as const,
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
      const appendToStream = (suffix: string) => {
        if (streamStarted) {
          setMessages(prev => prev.map(m =>
            m.id === streamMsgId ? { ...m, content: m.content + suffix } : m
          ));
        } else {
          addMessage('assistant', suffix);
        }
      };

      // Helper: mark the streaming message as having produced cell operations.
      // Stores diffs in the dedicated diffStore (keyed by operationId) which
      // is completely decoupled from message state and never wiped by
      // message pipeline updates.
      const markHadCellOps = (opId: string, opDiffs?: DiffInfo[]) => {
        setMessages(prev => prev.map(m =>
          m.id === streamMsgId
            ? { ...m, hadCellOps: true, operationId: opId, ...(opDiffs && opDiffs.length > 0 ? { diffs: opDiffs } : {}) }
            : m
        ));
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

      const response: TaskResponse = await apiClient.executeTaskStreaming(
        {
          message,
          notebookContext: context,
          chatHistory,
          variables: resolvedVariables,
          ...(slashCommand ? { command: slashCommand } : {}),
          cellMode: (notebookAware || !!currentFilePathRef.current) ? cellMode : 'chat',
          ...(reasoningModeRef.current !== 'off' ? { reasoningMode: reasoningModeRef.current } : {}),
          ...(imageModeRef.current ? { imageMode: imageModeRef.current } : {}),
        },
        // onChunk — explanation text Claude emits before the tool call
        (chunk: string) => {
          ensureStreamStarted();
          // Reset silence clock and accumulate chars so the silence detector
          // only fires after ≥100 chars + ≥1 500 ms of actual silence.
          lastChunkTimeRef.current = Date.now();
          chunkCharsRef.current   += chunk.length;
          // Skip bare "null" tokens the LLM sometimes writes instead of JSON null
          if (chunk.trim() !== 'null') {
            pushToStreamQueue(chunk);
          }
        },
        // onProgress — status label while the tool-call JSON is being generated
        (text: string) => {
          clearInterval(progressTimer);
          setProgressText(text);
          if (slashCommand === '/file_agent' || slashCommand === '/file_agent_find' || slashCommand === '/file_agent_save') setAgentBadgeVisible(true);
        },
        // onJsonDelta — raw partial JSON from the tool call.
        // The LLM preamble text (streamed as 'chunk' events before the tool
        // call) already provides live feedback to the user.  Pushing extracted
        // json_delta content into the bubble causes artefacts ("null", garbled
        // partial JSON) when the LLM returns empty steps.  We keep the extractor
        // running so ensureStreamStarted fires (creating the bubble), and count
        // incoming bytes so we can show a live "Writing code · N chars" indicator
        // in the bubble — eliminating the silent freeze during long code generation.
        (partial: string) => {
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
        },
        abortCtrl.signal,
        // onThought — reasoning token: stream thoughts live into the bubble
        // so the user sees the LLM reasoning as it happens, not just the answer.
        (thoughtText: string) => {
          ensureStreamStarted();
          thoughtsAccum += thoughtText;
          setMessages(prev => prev.map(m =>
            m.id === streamMsgId ? { ...m, thoughts: thoughtsAccum } : m
          ));
        },
      );
      clearInterval(progressTimer);
      stopStreamQueue();
      stopJsonCodeCounter();

      // Strip any stray bare-"null" tokens the LLM appended to its streaming
      // preamble (e.g. writing the JSON keyword literally instead of JSON null).
      // This must run after stopStreamQueue so all queued chunks have been
      // flushed into the message before we clean it.
      if (streamStarted) {
        setMessages(prev => prev.map(m => {
          if (m.id !== streamMsgId) return m;
          const cleaned = (m.content ?? '').replace(/(\s*\bnull\b)+\s*$/g, '').replace(/\s+$/, '');
          return cleaned !== m.content ? { ...m, content: cleaned } : m;
        }));
      }

      // Attach the reasoning trace to the message when sequential thinking was used.
      if (response.thoughts && streamMsgId) {
        setMessages(prev => prev.map(m =>
          m.id === streamMsgId ? { ...m, thoughts: response.thoughts } : m
        ));
      }

      // ── Agent session results (/file_agent*) ─────────────────────────
      // Also matches when the backend auto-routed (no explicit slash command
      // typed by the user) — detected via the is_file_agent sentinel.
      const isFileAgentResponse = slashCommand === '/file_agent'
        || slashCommand === '/file_agent_find'
        || slashCommand === '/file_agent_save'
        || Boolean((response as any).is_file_agent);
      if (isFileAgentResponse) {
        setAgentBadgeVisible(false);

        // Tool-use-not-supported error from the selected model
        if (response.errorType === 'tool_use_not_supported' && response.agentToolErrorDetails) {
          setAgentToolError(response.agentToolErrorDetails);
          setAgentResultsReady(true);
          return;
        }

        const rawResponse = response as unknown as Record<string, unknown>;
        const rawChanges = rawResponse.file_changes;
        const changeArray = Array.isArray(rawChanges) ? rawChanges : [];
        const indexedChanges: FileChangeEvent[] = changeArray.map(
          (fc: Omit<FileChangeEvent, 'index'>, i: number) => ({ ...fc, index: i + 1 })
        );
        const rawFilesRead = rawResponse.files_read;
        const rawBashOutputs = rawResponse.bash_outputs;
        const rawBlockedCmds = rawResponse.blocked_commands;
        setAgentFileChanges(indexedChanges);
        setAgentFilesRead(Array.isArray(rawFilesRead) ? (rawFilesRead as string[]) : []);
        setAgentIncomplete(Boolean(rawResponse.incomplete));
        setAgentBashCount(Array.isArray(rawBashOutputs) ? rawBashOutputs.length : 0);
        // Collect warn_reason strings from bash outputs
        const warnReasons: string[] = Array.isArray(rawBashOutputs)
          ? (rawBashOutputs as any[]).filter(b => b.warn_reason).map(b => b.warn_reason as string)
          : [];
        setAgentBashWarnings(warnReasons);
        setBashWarnDismissed({});
        // Collect blocked commands
        setAgentBlockedCmds(Array.isArray(rawBlockedCmds) ? (rawBlockedCmds as any[]) : []);
        setBlockedCmdDismissed({});
        setAgentOperationId(response.operationId);
        setAgentResolved({});
        setAgentMsgId(streamMsgId);   // remember which bubble owns these file cards
        setAgentResultsReady(true);
        // Changes are already written to disk as a preview — open/reload
        // each file so the user sees the actual change in the editor.
        for (const fc of indexedChanges) {
          if (fc.change_type === 'modified' && reloadFile) {
            reloadFile(fc.file_path);          // reload: file was overwritten
          } else if (fc.change_type === 'created' && openFile) {
            openFile(fc.file_path);            // open: new file now exists
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
            if (t.id !== tid) return t;
            const existing = t.tokenUsage ?? { input: 0, output: 0 };
            return {
              ...t,
              tokenUsage: {
                input:  existing.input  + (response.tokenUsage!.input  || 0),
                output: existing.output + (response.tokenUsage!.output || 0),
              },
            };
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
        setMessages(prev => [...prev, {
          id: generateId(),
          role: 'system' as const,
          subtype: 'error_recovery' as const,
          content: message,               // original user message — used by recovery prompt to pre-fill
          errorProvider: response.errorProvider ?? '',
          timestamp: new Date(),
        }]);
        return;
      }

      // ── Context too long — render advisory notice ─────────────────────
      if (response.errorType === 'context_too_long') {
        if (streamMsgId) {
          setMessages(prev => prev.filter(m => m.id !== streamMsgId));
        }
        setMessages(prev => [...prev, {
          id: generateId(),
          role: 'system' as const,
          subtype: 'context_too_long' as const,
          content: message,
          errorHasImages: response.errorHasImages ?? false,
          timestamp: new Date(),
        }]);
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
        const runCompositePipeline = async (
          compositeName: string,
          pipelineSteps: CompositeStep[]
        ): Promise<void> => {
          const masterOpId = `pipeline_${Date.now()}`;
          const allDiffs: DiffInfo[] = [];
          const allOpIds: string[] = [];
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
              const stepResponse = await apiClient.executeTaskStreaming(
                {
                  message: step.prompt,
                  notebookContext: freshContext,
                  operationId: stepOpId,
                  forceAutoMode: true,
                  chatHistory: [],
                },
                () => { /* suppress inline streaming for pipeline steps */ },
                txt => setProgressText(txt),
              );

              if (stepResponse.steps && stepResponse.steps.length > 0) {
                const { stepIndexMap: sMap, capturedOriginals: sOrig } =
                  await cellEditor.applyOperations(stepResponse.operationId, stepResponse.steps);

                const stepDiffs: DiffInfo[] = stepResponse.steps
                  .map((s, originalIdx) => ({ s, originalIdx }))
                  .filter(({ s }) => s.type === 'insert' || s.type === 'modify' || s.type === 'delete')
                  .map(({ s, originalIdx }) => ({
                    cellIndex: sMap.get(originalIdx) ?? s.cellIndex,
                    opType: s.type as DiffInfo['opType'],
                    cellType: (s.cellType ?? 'code') as DiffInfo['cellType'],
                    original: sOrig.get(originalIdx) ?? '',
                    modified: s.type === 'delete' ? '' : (s.content ?? ''),
                    description: s.description,
                  }));

                allDiffs.push(...stepDiffs);
                allOpIds.push(stepResponse.operationId);
                appendToStream(` ✓ (${stepResponse.steps.length} cell(s))`);
              } else {
                appendToStream(` ✓ (no cells)`);
              }
            } catch (err) {
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
            appendToStream(
              `\n\n✅ Pipeline complete — ${allDiffs.length} cell change(s) across ${pipelineSteps.length} steps.\nReview the diff below then Accept or Undo all.`
            );
          } else {
            appendToStream(`\n\n✅ Pipeline complete — no cell changes.`);
          }
        };

        await runCompositePipeline(
          response.compositeName ?? 'pipeline',
          response.compositePlan
        );
        return;
      }

      // ── Manual mode (code-review) ────────────────────────────────────
      if (response.cellInsertionMode === 'manual') {
        const id = generateId();
        setMessages(prev => [...prev, {
          id,
          role: 'code-review',
          content: response.chatResponse ?? response.summary ?? 'Code review complete.',
          timestamp: new Date(),
          codeReviewSteps: response.steps ?? [],
        }]);
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
          || (Array.isArray((response as any).file_changes) && (response as any).file_changes.length > 0);
        if (streamStarted) {
          setMessages(prev => prev.map(m => {
            if (m.id !== streamMsgId) return m;
            if (isAgentCmd) {
              // For agent commands the backend sends chatResponse:"" — preserve
              // the LLM explanation text that was streamed live (already null-
              // cleaned above). Fall back to chatText only when nothing streamed.
              const existing = (m.content ?? '').trim();
              return { ...m, content: existing || chatText };
            }
            return { ...m, content: chatText };
          }));
        } else {
          addMessage('assistant', chatText);
        }
        // Show RAG source citations if the response was augmented
        if (response.ragSources && Array.isArray(response.ragSources) && response.ragSources.length > 0) {
          const sources = (response.ragSources as any[])
            .map((s: any, i: number) => {
              const file  = s.source ? s.source.split('/').pop() : 'unknown';
              const loc   = s.cell_idx != null ? `, cell ${s.cell_idx}` : s.page != null ? `, page ${s.page}` : '';
              const score = typeof s.score === 'number' ? ` (score: ${s.score.toFixed(2)})` : '';
              return `${i + 1}. **${file}**${loc}${score}`;
            })
            .join('\n');
          addMessage('system', `📎 **Sources from knowledge base:**\n${sources}`);
        }
        // When the user's "Chat Only" toggle prevented a skill from writing cells,
        // show a gentle advisory note so they know they can switch mode.
        if (response.skillWantedCells) {
          addMessage('system',
            '⚠️ **Chat Only mode is active** — this skill would normally create notebook cells. ' +
            'Switch to **⚡ Auto** or **📝 Document** mode (button next to ✏️) to enable cell writing.'
          );
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
        appendToStream(
          streamStarted ? `\n\n${realClarification}` : realClarification
        );
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
            if (m.id !== streamMsgId) return m;
            return m.content?.trim() ? m : { ...m, content: fallback };
          }));
        } else {
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

      const { stepIndexMap, capturedOriginals } = await cellEditor.applyOperations(
        response.operationId,
        response.steps
      );

      // Execute cells flagged for auto-run
      if (!response.requiresApproval) {
        for (let i = 0; i < response.steps.length; i++) {
          const step = response.steps[i];
          const shouldRun =
            step.type === 'run_cell' ||
            (step.autoExecute === true && step.type !== 'delete');
          if (shouldRun) {
            const notebookIndex = stepIndexMap.get(i) ?? step.cellIndex;
            setProgressText(`Running cell ${notebookIndex}…`);
            try {
              await cellEditor.executeCell(notebookIndex);
            } catch (err) {
              console.warn(`[DSAssistant] auto-execution of cell ${notebookIndex} failed:`, err);
            }
          }
        }
      }

      const affectedIndices = Array.from(stepIndexMap.values());
      const stepSummary = response.steps
        .map(s => {
          if (s.description) return `- ${s.description}`;
          if (s.type === 'reorder') return `- Reorder ${(s.newOrder ?? []).length} cells`;
          return `- ${s.type} cell at index ${s.cellIndex}`;
        })
        .join('\n');

      // ── Auto mode ────────────────────────────────────────────────────
      const isAutoMode =
        response.cellInsertionMode === 'auto' && !response.requiresApproval;

      if (isAutoMode) {
        cellEditor.acceptOperation(response.operationId);
        markHadCellOps(response.operationId); // no diffs for auto mode — cells already applied
        appendToStream(`\n\n✓ Done\n\n${stepSummary}`);
        return;
      }

      // ── Build per-cell diff data for the visual diff panel ────────────
      const diffs: DiffInfo[] = response.steps
        .map((s, originalIdx) => ({ s, originalIdx }))
        .filter(({ s }) => s.type === 'insert' || s.type === 'modify' || s.type === 'delete')
        .map(({ s, originalIdx }) => {
          const notebookIdx = stepIndexMap.get(originalIdx) ?? s.cellIndex;
          const original = capturedOriginals.get(originalIdx) ?? '';
          const modified = s.type === 'delete' ? '' : (s.content ?? '');
          return {
            cellIndex: notebookIdx,
            opType: s.type as DiffInfo['opType'],
            cellType: (s.cellType ?? 'code') as DiffInfo['cellType'],
            original,
            modified,
            description: s.description
          };
        });

      // ── Preview mode (default) ────────────────────────────────────────
      const op: PendingOp = {
        operationId: response.operationId,
        cellIndices: affectedIndices,
        steps: response.steps,
        description: response.summary ?? `Created/modified ${response.steps.length} cell(s)`,
        diffs,
        requiresApproval: response.requiresApproval,
      };
      setPendingOps(prev => [...prev, op]);
      // Mark the chat bubble and store the diffs directly on the message so
      // they survive re-renders, thread switches, and page refreshes.
      markHadCellOps(response.operationId, diffs);

      // Append step summary + review prompt to the streamed explanation bubble
      const reviewPrompt = response.requiresApproval
        ? '\n\n⚠️ This operation requires approval before execution.'
        : '\n\nReview the highlighted cell(s) then Accept or Undo.';
      appendToStream(`\n\n${stepSummary}${reviewPrompt}`);

    } catch (error: unknown) {
      clearInterval(progressTimer);
      stopJsonCodeCounter();
      // AbortError means the user clicked "Stop" — silently discard
      if (error instanceof Error && error.name === 'AbortError') {
        stopStreamQueue();
        // leave any already-streamed text visible
      } else {
        const msg = error instanceof Error ? error.message : 'Unknown error occurred';
        // If the message already starts with an error indicator (⛔ / ❌ / Error:)
        // don't prefix it again to avoid "Error: ⛔ ..."
        const display = /^(⛔|❌|Error:|error:)/i.test(msg) ? msg : `❌ Error: ${msg}`;
        addMessage('system', display);
      }
    } finally {
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
  const handleApplyFix = async (
    msgId: string,
    stepIdx: number,
    step: OperationStep
  ): Promise<void> => {
    const fixOpId = `fix_${msgId}_${stepIdx}`;
    try {
      await cellEditor.applyOperations(fixOpId, [step]);
      cellEditor.acceptOperation(fixOpId);
      setAppliedFixes(prev => {
        const next = new Map(prev);
        const set  = new Set(next.get(msgId) ?? []);
        set.add(stepIdx);
        next.set(msgId, set);
        return next;
      });
    } catch (err) {
      addMessage('system', `Failed to apply fix: ${err instanceof Error ? err.message : err}`);
    }
  };

  const _acceptSingleOrComposite = (op: PendingOp): void => {
    if (op.compositeOpIds) {
      op.compositeOpIds.forEach(id => cellEditor.acceptOperation(id));
    } else {
      cellEditor.acceptOperation(op.operationId);
    }
  };

  const handleAccept = (operationId: string): void => {
    const op = pendingOps.find(o => o.operationId === operationId);
    if (op) {
      _acceptSingleOrComposite(op);
      // When the plan required approval, auto-execute was held back.
      // Run cells now so the user doesn't have to manually execute each one.
      if (op.requiresApproval) {
        void (async () => {
          for (const step of op.steps) {
            if (
              step.autoExecute === true &&
              (step.type === 'insert' || step.type === 'modify' || step.type === 'run_cell')
            ) {
              try { await cellEditor.executeCell(step.cellIndex); } catch { /* ignore */ }
            }
          }
        })();
      }
    }
    setPendingOps(prev =>
      prev.map(o => o.operationId === operationId ? { ...o, resolved: 'accepted' as const } : o)
    );
    // Stamp diffResolved on the message so it persists across re-renders and refreshes.
    setMessages(prev =>
      prev.map(m => m.operationId === operationId ? { ...m, diffResolved: 'accepted' as const } : m)
    );
    // Immediate save — don't rely on the 1.5s debounce so a hard-refresh
    // right after Accept still shows the resolved diff.
    const tid    = currentThreadIdRef.current;
    const nbPath = currentNotebookPathRef.current || currentFilePathRef.current || '';
    const tName  = threadsRef.current.find(t => t.id === tid)?.name ?? 'Thread';
    if (tid && nbPath) {
      const updatedMsgs = messagesRef.current.map(
        m => m.operationId === operationId ? { ...m, diffResolved: 'accepted' as const } : m
      );
      void _saveThread(tid, tName, updatedMsgs, nbPath);
    }
  };

  const handleUndo = (operationId: string): void => {
    const op = pendingOps.find(o => o.operationId === operationId);
    if (op?.compositeOpIds) {
      // Reverse order so later steps (which may have inserted cells) are undone first
      [...op.compositeOpIds].reverse().forEach(id => cellEditor.undoOperation(id));
    } else {
      cellEditor.undoOperation(operationId);
    }
    setPendingOps(prev =>
      prev.map(o => o.operationId === operationId ? { ...o, resolved: 'undone' as const } : o)
    );
    // Stamp diffResolved on the message so it persists across re-renders and refreshes.
    setMessages(prev =>
      prev.map(m => m.operationId === operationId ? { ...m, diffResolved: 'undone' as const } : m)
    );
    // Immediate save.
    const tid    = currentThreadIdRef.current;
    const nbPath = currentNotebookPathRef.current || currentFilePathRef.current || '';
    const tName  = threadsRef.current.find(t => t.id === tid)?.name ?? 'Thread';
    if (tid && nbPath) {
      const updatedMsgs = messagesRef.current.map(
        m => m.operationId === operationId ? { ...m, diffResolved: 'undone' as const } : m
      );
      void _saveThread(tid, tName, updatedMsgs, nbPath);
    }
  };

  // -------------------------------------------------------------------------
  // Model switcher handler
  // -------------------------------------------------------------------------


  // -------------------------------------------------------------------------
  const handleModelSelect = async (newModel: string): Promise<void> => {
    const prev = chatModel;
    setChatModel(newModel);
    setModelSwitching(true);
    try {
      await apiClient.saveSettings({ [`${chatProvider}_CHAT_MODEL`]: newModel });
    } catch {
      setChatModel(prev);
    } finally {
      setModelSwitching(false);
    }
  };

  // Thread management
  // -------------------------------------------------------------------------

  const handleNewThread = (): void => {
    const t = makeNewThread(`Thread ${threads.length + 1}`);
    // Persist the current thread before switching
    const curId   = currentThreadIdRef.current;
    const curName = threadsRef.current.find(th => th.id === curId)?.name ?? 'Thread';
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

  const handleSwitchThread = (threadId: string): void => {
    if (threadId === currentThreadIdRef.current) return;
    // Save the current thread using the ref (always up-to-date, unlike the
    // messages state which may be one render behind in async flows).
    const curId   = currentThreadIdRef.current;
    const curName = threadsRef.current.find(t => t.id === curId)?.name ?? 'Thread';
    void _saveThread(curId, curName, messagesRef.current);

    const thread = threadsRef.current.find(t => t.id === threadId);
    if (!thread) return;
    setCurrentThreadId(threadId);
    currentThreadIdRef.current = threadId;
    const restored: Message[] = thread.messages.length > 0
      ? thread.messages.map(m => ({
          id: m.id,
          role: m.role as Message['role'],
          content: m.content,
          timestamp: new Date(m.timestamp),
          fromHistory: true,
          ...(m.thoughts      ? { thoughts: m.thoughts }         : {}),
          ...(m.operationId   ? { operationId: m.operationId }   : {}),
          ...(m.diffs && m.diffs.length > 0 ? { diffs: m.diffs as DiffInfo[] } : {}),
          ...(m.diffResolved  ? { diffResolved: m.diffResolved } : {}),
        }))
      : [{
          id: `welcome-${threadId}`,
          role: 'system' as const,
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

  const handleRenameThread = async (threadId: string, newName: string): Promise<void> => {
    const updated = threadsRef.current.map(t =>
      t.id === threadId ? { ...t, name: newName } : t
    );
    setThreads(updated);
    threadsRef.current = updated;
    // Save with new name — use live messages for the current thread
    const msgs: Message[] = threadId === currentThreadIdRef.current
      ? messages
      : (updated.find(t => t.id === threadId)?.messages ?? []).map(m => ({
          id: m.id,
          role: m.role as Message['role'],
          content: m.content,
          timestamp: new Date(m.timestamp),
        }));
    void _saveThread(threadId, newName, msgs);
  };

  const handleDuplicateThread = (threadId: string): void => {
    const src = threadsRef.current.find(t => t.id === threadId);
    if (!src) return;
    const copy = makeNewThread(`${src.name} (copy)`);
    copy.messages = src.messages.slice();
    copy.notebookAware = src.notebookAware;
    const updated = [...threadsRef.current, copy];
    setThreads(updated);
    threadsRef.current = updated;
    // Switch to the new duplicate
    const curId   = currentThreadIdRef.current;
    const curName = threadsRef.current.find(t => t.id === curId)?.name ?? 'Thread';
    void _saveThread(curId, curName, messagesRef.current);
    setCurrentThreadId(copy.id);
    currentThreadIdRef.current = copy.id;
    stopStreamQueue();
    stopJsonCodeCounter();
    const restored: Message[] = copy.messages.length > 0
      ? copy.messages.map(m => ({
          id: m.id,
          role: m.role as Message['role'],
          content: m.content,
          timestamp: new Date(m.timestamp),
          fromHistory: true,
          ...(m.thoughts      ? { thoughts: m.thoughts }         : {}),
          ...(m.operationId   ? { operationId: m.operationId }   : {}),
          ...(m.diffs && m.diffs.length > 0 ? { diffs: m.diffs as DiffInfo[] } : {}),
          ...(m.diffResolved  ? { diffResolved: m.diffResolved } : {}),
        }))
      : [{
          id: `welcome-${copy.id}`,
          role: 'system' as const,
          content: `✨ Duplicated from "${src.name}".`,
          timestamp: new Date(),
        }];
    setMessages(restored);
    setPendingOps(_opsFromMessages(restored));
    setAppliedFixes(new Map());
    setProgressText('');
    setActiveStreamId('');
  };

  const handleDeleteThread = async (threadId: string): Promise<void> => {
    if (threadsRef.current.length <= 1) return;
    const updated = threadsRef.current.filter(t => t.id !== threadId);
    setThreads(updated);
    threadsRef.current = updated;
    if (threadId === currentThreadIdRef.current) {
      handleSwitchThread(updated[0].id);
    }
    const nbPath = currentNotebookPathRef.current
      || notebookTracker.currentWidget?.context.path
      || '';
    if (nbPath) {
      try { await apiClient.deleteChatThread(nbPath, threadId); }
      catch (err) { console.warn('[DSAssistant] Could not delete thread:', err); }
    }
  };

  // -------------------------------------------------------------------------
  // Built-in slash command handler
  // -------------------------------------------------------------------------

  const handleBuiltinCommand = (cmd: string): void => {
    switch (cmd) {
      case '/clear':
        handleNewThread();
        break;

      case '/help': {
        const builtins = commands.filter(c => c.type === 'builtin');
        const skills   = commands.filter(c => c.type === 'skill');
        const rows = (arr: SlashCommand[]) =>
          arr.map(c => `  **${c.command}** — ${c.description}`).join('\n');
        const helpText =
          '### Varys Commands\n\n' +
          '**Built-in**\n' + rows(builtins) + '\n\n' +
          (skills.length ? '**Skills**\n' + rows(skills) : '_(No skills installed)_');
        addMessage('assistant', helpText);
        break;
      }

      case '/skills': {
        const skill_cmds = commands.filter(c => c.type === 'skill');
        if (!skill_cmds.length) {
          addMessage('system', 'No skill commands installed. Add skills in Settings → Skills.');
        } else {
          const list = skill_cmds
            .map(c => `  **${c.command}** — ${c.description}`)
            .join('\n');
          addMessage('assistant', '### Available skill commands\n\n' + list);
        }
        break;
      }

      case '/chat':
        // With no args: show usage. With args, handleSend routes to chat flow.
        addMessage('system',
          '### 💬 Chat-only mode\n\n' +
          'Type `/chat <your request>` to get a response **in the chat window only** — no notebook cells will be created or modified, regardless of any skill defaults.\n\n' +
          '**Example:** `/chat Compute the delta diff for this table: …`'
        );
        break;

      case '/ask':
        // With no args: show usage. With args, handleSend routes to RAG flow.
        addMessage('system',
          '### 📚 Knowledge Base Query\n\n' +
          'Type `/ask <your question>` to search indexed documents and get an answer with citations.\n\n' +
          'Run `/index <path>` first to index files into the knowledge base.'
        );
        break;

      case '/learn':
        // /learn is handled in handleSend when the full message is available
        addMessage('system', 'Type `/learn <your preference>` and press Enter to save it to memory.');
        break;

      case '/index':
        // No args → index the whole knowledge folder immediately.
        void handleIndexCommand('');
        break;

      case '/rag':
        // Show RAG status — handled async in handleSend-style flow
        void handleRagStatus();
        break;

      case '/no_figures':
        setImageMode({ mode: 'no_figures' });
        addMessage('system',
          '🚫 **No-figures mode active** — all notebook plots will be excluded from messages sent to the LLM.\n\n' +
          'Re-send your message to proceed. Type `/resize(DIM)` to switch to resize mode, or type `/no_figures` again to clear.'
        );
        break;

      case '/resize':
        // /resize without parentheses — show usage hint
        addMessage('system',
          '### 🔬 Resize mode\n\n' +
          'Use `/resize(DIM)` where DIM is the maximum pixel dimension (positive integer ≥ 10).\n\n' +
          '**Examples:** `/resize(7800)` (Anthropic limit) · `/resize(6000)` (OpenAI limit)'
        );
        break;

      case '/file_agent':
      case '/file_agent_find':
      case '/file_agent_save':
        // Agent commands need a task argument — show usage hint
        addMessage('system',
          `### Varys File Agent\n\n` +
          `Type \`${cmd} <your task>\` to let the agent read and edit files in your project.\n\n` +
          `**Examples:**\n` +
          `- \`/file_agent refactor utils.py to use dataclasses\`\n` +
          `- \`/file_agent_find where is the database connection configured?\`\n` +
          `- \`/file_agent_save export the clean_data function to src/preprocessing.py\``
        );
        break;

      default:
        addMessage('system', `Unknown command: ${cmd}`);
    }
  };

  // -------------------------------------------------------------------------
  // RAG-specific handlers
  // -------------------------------------------------------------------------

  const handleIndexCommand = async (path: string): Promise<void> => {
    const displayPath = path || '.jupyter-assistant/knowledge';
    setIsLoading(true);
    const progressId = generateId();
    setMessages(prev => [...prev, {
      id: progressId,
      role: 'system' as const,
      content: `📂 Indexing **${displayPath}**…`,
      timestamp: new Date()
    }]);
    try {
      const result = await apiClient.ragLearn(path, (msg: string) => {
        setMessages(prev => prev.map(m =>
          m.id === progressId ? { ...m, content: msg } : m
        ));
      }, false, currentNotebookPathRef.current);
      const summary =
        `✅ **Indexing complete** — \`${displayPath}\`\n\n` +
        `- Files found: **${result.total}**\n` +
        `- Indexed: **${result.processed}**\n` +
        `- Skipped (unchanged): **${result.skipped}**\n` +
        (result.errors.length
          ? `- Errors: ${result.errors.map((e: string) => `\n  - ${e}`).join('')}`
          : '');
      setMessages(prev => prev.map(m =>
        m.id === progressId ? { ...m, content: summary } : m
      ));
    } catch (err: any) {
      setMessages(prev => prev.map(m =>
        m.id === progressId
          ? { ...m, content: `❌ Indexing failed: ${err.message}` }
          : m
      ));
    } finally {
      setIsLoading(false);
    }
  };

  const handleRagStatus = async (): Promise<void> => {
    setIsLoading(true);
    try {
      const status = await apiClient.ragStatus(currentNotebookPathRef.current);
      if (!status.available) {
        addMessage('system',
          '⚠️ **RAG not available**\n\n' +
          (status.hint || 'Install with: `pip install chromadb sentence-transformers`')
        );
        return;
      }
      const fileList = status.files.length
        ? status.files.slice(0, 20).map((f: string) => `- \`${f.split('/').pop()}\``).join('\n') +
          (status.files.length > 20 ? `\n- _...and ${status.files.length - 20} more_` : '')
        : '_No files indexed yet_';
      addMessage('assistant',
        `### 📚 Knowledge Base Status\n\n` +
        `- **Total chunks**: ${status.total_chunks}\n` +
        `- **Indexed files**: ${status.indexed_files}\n\n` +
        `**Files:**\n${fileList}\n\n` +
        `Drop documents in \`.jupyter-assistant/knowledge/\` and run \`/index\` to index them.`
      );
    } catch (err: any) {
      addMessage('system', `❌ Could not get RAG status: ${err.message}`);
    } finally {
      setIsLoading(false);
    }
  };

  // Keep the ref pointing at the latest handleSend so the external-message
  // listener can invoke it without capturing a stale closure.
  useEffect(() => { handleSendRef.current = handleSend; });

  // Stop the current streaming request when the user clicks the stop button.
  const handleStop = (): void => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
  };

  // -------------------------------------------------------------------------
  // Keyboard handler - Enter to send, Shift+Enter for newline
  // -------------------------------------------------------------------------

  // Insert the selected @-mention suggestion into the textarea.
  const insertAtSuggestion = (name: string) => {
    // Replace '@<partial>' at atAnchorPos with '@<full_name> '
    const before = input.slice(0, atAnchorPos);
    const after  = input.slice(atAnchorPos + 1 + atQuery.length);
    const newVal = `${before}@${name} ${after}`;
    setInput(newVal);
    setAtAnchorPos(-1);
    // Move cursor to just after the inserted name
    setTimeout(() => {
      const el = textareaRef.current;
      if (!el) return;
      const pos = atAnchorPos + 1 + name.length + 1; // +1 for trailing space
      setCursorCharOffset(el, pos);
      el.focus();
    }, 0);
  };

  const atFiltered = atAnchorPos >= 0
    ? atSymbols.filter(s => s.name.toLowerCase().startsWith(atQuery.toLowerCase())).slice(0, 8)
    : [];

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
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
        insertAtSuggestion(atFiltered[atFocusIdx]?.name ?? atFiltered[0].name);
        return;
      }
      if (e.key === 'Escape') {
        setAtAnchorPos(-1);
        return;
      }
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
    return (
      <div className={`ds-assistant-sidebar ds-chat-${chatTheme}`}>
        <div className="ds-assistant-header">
          <span className="ds-assistant-title"><span className="ds-varys-spider">🕷️</span> Varys — Settings</span>
          <button
            className="ds-settings-close-btn"
            onClick={() => { setShowSettings(false); setSettingsOpenToAgent(false); }}
            title="Back to chat"
          >✕</button>
        </div>
        <SettingsPanel
          apiClient={apiClient}
          onClose={() => { setShowSettings(false); setSettingsOpenToAgent(false); loadModelSettings(); }}
          onSaved={loadModelSettings}
          notebookPath={currentNotebookPath}
          initialTab={settingsOpenToAgent ? 'agent' : undefined}
        />
      </div>
    );
  }

  if (showRepro) {
    return (
      <div className={`ds-assistant-sidebar ds-chat-${chatTheme}`}>
        <div className="ds-assistant-header">
          <span className="ds-assistant-title"><span className="ds-varys-spider">🕷️</span> Varys — Reproducibility</span>
          <button
            className="ds-settings-close-btn"
            onClick={() => setShowRepro(false)}
            title="Back to chat"
          >✕</button>
        </div>
        <ReproPanel
          apiClient={apiClient}
          cellEditor={cellEditor}
          notebookReader={notebookReader}
        />
      </div>
    );
  }

  if (showTags) {
    return (
      <div className={`ds-assistant-sidebar ds-chat-${chatTheme}`}>
        <div className="ds-assistant-header">
          <span className="ds-assistant-title"><span className="ds-varys-spider">🕷️</span> Varys — Tags</span>
          <button
            className="ds-settings-close-btn"
            onClick={() => setShowTags(false)}
            title="Back to chat"
          >✕</button>
        </div>
        <TagsPanel notebookTracker={notebookTracker} />
      </div>
    );
  }

  return (
    <div className={`ds-assistant-sidebar ds-chat-${chatTheme}`}>
      {/* Header */}
      <div className="ds-assistant-header">
        <span className="ds-assistant-title"><span className="ds-varys-spider">🕷️</span> Varys <span className="ds-varys-version">v0.6.0</span></span>
        <button
          className="ds-tags-panel-btn"
          onClick={() => setShowTags(true)}
          data-tip="Cell Tags & Metadata"
          data-tip-below
        >🏷️</button>
        <span className="ds-repro-shield-wrap">
          <button
            className="ds-repro-shield-btn"
            onClick={() => setShowRepro(true)}
            data-tip="Reproducibility Guardian"
            data-tip-below
          >🛡️</button>
          {reproIssueCount > 0 && (
            <span className="ds-repro-dot" aria-label={`${reproIssueCount} reproducibility issue${reproIssueCount === 1 ? '' : 's'}`}>
              {reproIssueCount < 10 ? reproIssueCount : '9+'}
            </span>
          )}
        </span>
        <button
          className="ds-theme-toggle-btn"
          onClick={toggleChatTheme}
          data-tip={chatTheme === 'day' ? 'Switch to night mode' : 'Switch to day mode'}
          data-tip-below
          aria-label={chatTheme === 'day' ? 'Switch to night mode' : 'Switch to day mode'}
        >{chatTheme === 'day' ? '🌙' : '☀️'}</button>
        {sysWarnings.length > 0 && !warningsDismissed && (
          <button
            className="ds-warning-icon-btn"
            onClick={() => setWarningsDismissed(true)}
            data-tip={sysWarnings[sysWarnings.length - 1].message}
            data-tip-below
            aria-label="Dismiss warning"
          >
            <span className="ds-warning-icon">⚠</span>
            {sysWarnings.length > 1 && (
              <span className="ds-warning-badge">{sysWarnings.length}</span>
            )}
          </button>
        )}
        <button
          className="ds-wiki-help-btn"
          onClick={() => window.open('https://github.com/brightappsllc/varys-ai', '_blank')}
          data-tip="Open documentation"
          data-tip-below
        >?</button>
        <button
          className="ds-settings-gear-btn"
          onClick={() => setShowSettings(true)}
          data-tip="Settings"
          data-tip-below
        >⚙️</button>
      </div>

      {/* Thread bar */}
      <ThreadBar
        threads={threads}
        currentId={currentThreadId}
        notebookName={currentNotebookPath
          ? currentNotebookPath.split('/').pop()?.replace(/\.ipynb$/, '') ?? ''
          : ''}
        onSwitch={handleSwitchThread}
        onNew={handleNewThread}
        onRename={(id, name) => void handleRenameThread(id, name)}
        onDuplicate={handleDuplicateThread}
        onDelete={(id) => void handleDeleteThread(id)}
      />

      {/* Message list */}
      <div
        ref={messagesContainerRef}
        className="ds-assistant-messages"
        onClick={(e: React.MouseEvent<HTMLDivElement>) => {
          const btn = (e.target as Element).closest('.ds-copy-code-btn');
          if (!btn) return;
          const code = btn.closest('.ds-code-block-wrapper')
            ?.querySelector('code')?.textContent ?? '';
          void navigator.clipboard.writeText(code).then(() => {
            btn.textContent = '✓ Copied';
            setTimeout(() => { btn.textContent = 'Copy'; }, 2000);
          });
        }}
      >
        {messages.map(msg => (
          <React.Fragment key={msg.id}>
          <div
            className={[
              'ds-assistant-message',
              `ds-assistant-message-${msg.role}`,
              msg.role === 'user' && msg.id === editingMsgId ? 'ds-assistant-message-user--editing' : '',
            ].filter(Boolean).join(' ')}
          >
            {msg.subtype === 'error_recovery' ? (
              /* ── Image dimension error — recovery prompt ─────── */
              <ImageRecoveryPrompt
                originalMessage={msg.content}
                provider={msg.errorProvider ?? ''}
                onFill={(cmd, originalMsg) => {
                  // Apply image mode immediately (reliable — does not depend on
                  // the user pressing Enter on a pre-filled textarea).
                  const resizeMatch = cmd.match(/^\/resize\((\d+)\)$/);
                  if (resizeMatch) {
                    setImageMode({ mode: 'resize', dim: parseInt(resizeMatch[1], 10) });
                  } else if (cmd === '/no_figures') {
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
                }}
              />
            ) : msg.subtype === 'context_too_long' ? (
              /* ── Context too long — advisory notice ─────────── */
              <div className="ds-ctx-too-long">
                <span className="ds-ctx-too-long-icon">⚠️</span>
                <div className="ds-ctx-too-long-body">
                  <p className="ds-ctx-too-long-title">Context too large</p>
                  <p className="ds-ctx-too-long-desc">
                    Your prompt exceeded the model&apos;s token limit.
                    {msg.errorHasImages
                      ? ' The context includes figures — try '
                      : ' This is caused by text (chat history, code, outputs), not by images. Try '}
                  </p>
                  {msg.errorHasImages && (
                    <div className="ds-ctx-too-long-actions">
                      <button
                        className="ds-ctx-too-long-btn"
                        onClick={() => {
                          setImageMode({ mode: 'no_figures' });
                          setInput(msg.content);
                          requestAnimationFrame(() => textareaRef.current?.focus());
                        }}
                      >
                        /no_figures
                      </button>
                      <span className="ds-ctx-too-long-or">or clear the chat history below.</span>
                    </div>
                  )}
                  {!msg.errorHasImages && (
                    <span className="ds-ctx-too-long-hint">clearing the chat history (trash icon) or asking about fewer cells.</span>
                  )}
                </div>
              </div>
            ) : msg.role === 'disambiguation' ? (
              /* ── Disambiguation card ───────────────────────────── */
              <DisambiguationCard
                originalMessage={msg.content}
                msgId={msg.id}
                onChoice={(mode, id) => {
                  // Remove the disambiguation message
                  setMessages(prev => prev.filter(m => m.id !== id));
                  if (mode === 'chat') {
                    // Re-send with /chat prefix so the backend uses advisory mode
                    void handleSend(`/chat ${msg.content}`, msg.content, true);
                  } else {
                    // Re-send plain — skip the advisory check this time
                    void handleSend(msg.content, undefined, true);
                  }
                }}
              />
            ) : msg.role === 'report' && msg.reportMeta ? (
              <div className="ds-report-card">
                <div className="ds-report-card-header">
                  <span className="ds-report-card-icon">📄</span>
                  <span className="ds-report-card-title">Report ready</span>
                </div>
                <div className="ds-report-card-filename">{msg.reportMeta.filename}</div>
                <div className="ds-report-card-stats">
                  <span>{msg.reportMeta.wordCount.toLocaleString()} words</span>
                  <span>·</span>
                  <span>{msg.reportMeta.imagesCount} image{msg.reportMeta.imagesCount !== 1 ? 's' : ''}</span>
                  <span>·</span>
                  <span>{msg.reportMeta.stats.total} cells</span>
                </div>
                <a
                  className="ds-report-card-download"
                  href={`${window.location.origin}/files/${msg.reportMeta.relativePath}`}
                  target="_blank"
                  rel="noreferrer"
                  download={msg.reportMeta.filename}
                >📥 Download report</a>
              </div>
            ) : msg.role === 'code-review' ? (
              /* ── Code-review message ──────────────────────────────────── */
              <div className={`ds-code-review-message ds-msg-collapsible-wrap${collapsedMsgs.has(msg.id) ? ' ds-msg-collapsed' : ''}`}>
                {collapsedMsgs.has(msg.id) && <div className="ds-msg-fade" aria-hidden="true" />}
                <div
                  className="ds-assistant-message-content ds-markdown"
                  dangerouslySetInnerHTML={{ __html: renderMarkdown(msg.content) }}
                />
                {msg.codeReviewSteps && msg.codeReviewSteps.length > 0 && (
                  <div className="ds-fix-panel">
                    <div className="ds-fix-panel-header">
                      🔧 Available Fixes ({msg.codeReviewSteps.length})
                    </div>
                    {msg.codeReviewSteps.map((step, i) => {
                      const applied = appliedFixes.get(msg.id)?.has(i) ?? false;
                      return (
                        <div
                          key={i}
                          className={`ds-fix-card${applied ? ' ds-fix-card--applied' : ''}`}
                        >
                          <div className="ds-fix-card-desc">
                            {step.description ?? `Fix for cell ${step.cellIndex}`}
                          </div>
                          <details className="ds-fix-card-toggle">
                            <summary>View code</summary>
                            <pre className="ds-fix-card-code">{step.content}</pre>
                          </details>
                          <button
                            className="ds-fix-card-btn"
                            disabled={applied}
                            onClick={() => handleApplyFix(msg.id, i, step)}
                          >
                            {applied ? '✓ Applied' : 'Apply Fix'}
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}
                {(msg.content?.length ?? 0) >= COLLAPSE_THRESHOLD && (
                  <button
                    className="ds-msg-toggle-btn"
                    title={collapsedMsgs.has(msg.id) ? 'Expand' : 'Collapse'}
                    onClick={() => toggleCollapse(msg.id)}
                  >
                    {collapsedMsgs.has(msg.id) ? '⌄' : '⌃'}
                  </button>
                )}
              </div>
            ) : (
              <>
                {/* ── Top toolbar (assistant only, hidden while streaming) ── */}
                {(() => {
                  if (msg.role !== 'assistant' || msg.id === activeStreamId) return null;
                  const isLong = (msg.content?.length ?? 0) >= COLLAPSE_THRESHOLD;
                  return (
                    <div className="ds-bubble-toolbar">
                      <div className="ds-bubble-toolbar-right ds-bubble-toolbar-actions">
                        {/* push-to-cell removed — use per-code-block copy buttons instead */}
                        <button
                          className="ds-bubble-tool-btn ds-bubble-copy-btn"
                          data-tip="Copy response"
                          onClick={() => {
                            const text = (msg.displayContent ?? msg.content ?? '').trim();
                            void navigator.clipboard.writeText(text);
                          }}
                        >
                          <svg viewBox="0 0 16 16" width="13" height="13" fill="none" xmlns="http://www.w3.org/2000/svg">
                            <rect x="5" y="5" width="8" height="9" rx="1.2" stroke="currentColor" strokeWidth="1.5"/>
                            <path d="M3 11V3a1 1 0 0 1 1-1h7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                          </svg>
                        </button>
                        {isLong && (
                          <button
                            className="ds-bubble-tool-btn"
                            data-tip={collapsedMsgs.has(msg.id) ? 'Expand' : 'Collapse'}
                            onClick={() => toggleCollapse(msg.id)}
                          >
                            <svg viewBox="0 0 16 16" width="13" height="13" fill="none" xmlns="http://www.w3.org/2000/svg">
                              {collapsedMsgs.has(msg.id)
                                ? <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
                                : <path d="M4 10l4-4 4 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
                              }
                            </svg>
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })()}
                {/* ── Bubble content ── */}
                {(() => {
                  const isStreaming = msg.id === activeStreamId;
                  const isLong = (msg.content?.length ?? 0) >= COLLAPSE_THRESHOLD;
                  const collapsed = !isStreaming && isLong && collapsedMsgs.has(msg.id);

                  // Inline editor for user messages — click bubble to edit,
                  // Enter to resend, Escape or click-outside to cancel
                  if (msg.role === 'user' && msg.id === editingMsgId) {
                    const doSend = () => {
                      const text = editingText.trim();
                      if (!text) return;
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
                    return (
                      <div className="ds-msg-edit-wrap">
                        <textarea
                          className="ds-msg-edit-textarea"
                          value={editingText}
                          autoFocus
                          ref={el => {
                            if (el) {
                              el.style.height = 'auto';
                              el.style.height = el.scrollHeight + 'px';
                            }
                          }}
                          onChange={e => {
                            setEditingText(e.target.value);
                            e.target.style.height = 'auto';
                            e.target.style.height = e.target.scrollHeight + 'px';
                          }}
                          onKeyDown={e => {
                            if (e.key === 'Enter' && !e.shiftKey) {
                              e.preventDefault();
                              doSend();
                            } else if (e.key === 'Escape') {
                              setEditingMsgId(null);
                            }
                          }}
                        />
                        <div className="ds-msg-edit-hint">↵ send · Shift+↵ newline · Esc cancel</div>
                      </div>
                    );
                  }

                  return (
                    <div className={`ds-msg-collapsible-wrap${collapsed ? ' ds-msg-collapsed' : ''}`}>
                      {/* Reasoning trace — streams live, always visible above the answer */}
                      {msg.role === 'assistant' && msg.thoughts && (() => {
                        // While streaming: locked open (full height).
                        // When done: collapsed by default; user can click to expand.
                        const thinkIsCollapsed = isStreaming
                          ? false
                          : (thinkCollapsed.get(msg.id) ?? true);
                        return (
                          <div className={`ds-thinking-section${isStreaming ? ' ds-thinking-section--active' : ''}`}>
                            <button
                              className="ds-thinking-header"
                              onClick={() => { if (!isStreaming) toggleThinkCollapsed(msg.id); }}
                              title={isStreaming ? 'Thinking…' : (thinkIsCollapsed ? 'Show thought' : 'Hide thought')}
                              style={isStreaming ? { cursor: 'default' } : undefined}
                            >
                              <span className="ds-thinking-icon">🧠</span>
                              <span className="ds-thinking-label">
                                {isStreaming ? 'Thinking…' : 'Thought'}
                              </span>
                              <span className="ds-thinking-chevron">
                                {thinkIsCollapsed ? '▸' : '▾'}
                              </span>
                            </button>
                            {!thinkIsCollapsed && (
                              <div
                                className="ds-thinking-body"
                                ref={el => {
                                  if (el) thinkingBodyRefs.current.set(msg.id, el);
                                  else thinkingBodyRefs.current.delete(msg.id);
                                }}
                              >
                                {msg.thoughts}
                              </div>
                            )}
                          </div>
                        );
                      })()}
                      {msg.role === 'user' ? (
                        <div
                          className={`ds-assistant-message-content ds-markdown${!isLoading ? ' ds-user-editable' : ''}`}
                          onClick={!isLoading ? () => {
                            setEditingMsgId(msg.id);
                            setEditingText((msg.content ?? '').trim());
                          } : undefined}
                          dangerouslySetInnerHTML={{
                            __html: msg.displayContent
                              ? `<span class="ds-user-text">${_escHtml(msg.displayContent.trim())}</span>`
                              : renderUserContent((msg.content ?? '').trim()),
                          }}
                        />
                      ) : (
                        <div
                          className="ds-assistant-message-content ds-markdown"
                          dangerouslySetInnerHTML={{ __html: renderMarkdown((msg.displayContent ?? msg.content).replace(/[\r\n\s]+$/, '')) }}
                        />
                      )}
                      {msg.role === 'user' && msg.contextChip && (
                        <ContextChipBubble chip={msg.contextChip} />
                      )}
                      {msg.role === 'user' && !isLoading && msg.id !== editingMsgId && (
                        <button
                          className="ds-user-copy-btn"
                          aria-label="Copy message"
                          onClick={e => {
                            e.stopPropagation();
                            void navigator.clipboard.writeText((msg.content ?? '').trim());
                          }}
                        >
                          <svg viewBox="0 0 16 16" width="12" height="12" fill="none" xmlns="http://www.w3.org/2000/svg">
                            <rect x="5" y="5" width="8" height="9" rx="1.2" stroke="currentColor" strokeWidth="1.5"/>
                            <path d="M3 11V3a1 1 0 0 1 1-1h7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                          </svg>
                        </button>
                      )}
                      {isStreaming && isWritingCode && (
                        <div className="ds-generating-hint">
                          <span className="ds-generating-icon">✍</span>
                          {' Writing code'}
                          {elapsedSecs > 0 && (
                            <span className="ds-generating-count"> · {elapsedSecs}s</span>
                          )}
                          <span className="ds-thinking-dots" aria-hidden="true">
                            <span /><span /><span />
                          </span>
                        </div>
                      )}
                      {isStreaming && (
                        <span className="ds-typing-cursor" aria-hidden="true"><span /></span>
                      )}
                      {collapsed && <div className="ds-msg-fade" aria-hidden="true" />}
                    </div>
                  );
                })()}
              </>
            )}
          {/* File-agent FileChangeCards — inline inside the triggering assistant
              bubble so all output (text + diffs) lives in one visual unit. */}
          {msg.id === agentMsgId && agentResultsReady && agentFileChanges.length > 0 && (
            <div className="ds-agent-file-cards">
              {agentFileChanges.map(fc => (
                <FileChangeCard
                  key={fc.change_id}
                  event={fc}
                  operationId={agentOperationId}
                  apiBaseUrl=""
                  xsrfToken={getXsrfToken()}
                  onResolved={(changeId, accepted) => {
                    const newResolved = { ...agentResolved, [changeId]: accepted };
                    setAgentResolved(newResolved);
                    const changed = agentFileChanges.find(f => f.change_id === changeId);
                    if (!changed) return;
                    if (!accepted && changed.change_type === 'modified' && reloadFile) {
                      reloadFile(changed.file_path);
                    }
                  }}
                />
              ))}
              {agentFileChanges.length > 1 && (
                <div className="ds-agent-bulk-actions">
                  <button
                    className="ds-assistant-btn ds-assistant-btn-accept"
                    onClick={async () => {
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
                            if (data.success) setAgentResolved(prev => ({ ...prev, [fc.change_id]: true }));
                          } catch { /* ignore per-item errors */ }
                        }
                      }
                    }}
                  >✓ Accept All</button>
                  <button
                    className="ds-assistant-btn ds-assistant-btn-undo"
                    onClick={async () => {
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
                              setAgentResolved(prev => ({ ...prev, [fc.change_id]: false }));
                              if (fc.change_type === 'modified' && reloadFile) reloadFile(fc.file_path);
                            }
                          } catch { /* ignore per-item errors */ }
                        }
                      }
                    }}
                  >✕ Reject All</button>
                </div>
              )}
            </div>
          )}

          {/* Inline DiffView — lives INSIDE the assistant bubble so the code
              block is visually attached to the explanation text above it.
              Unresolved: shows Accept / Reject buttons.
              Resolved:   shows a static collapsed strip with a 2-line preview (no buttons). */}
          {msg.role === 'assistant' && msg.operationId && (() => {
            // Primary: diffs stored directly on the message (survive refreshes).
            // Fallback: live pendingOps entry covers the window before the next save.
            const op = pendingOps.find(o => o.operationId === msg.operationId);
            const diffsToShow = (msg.diffs && msg.diffs.length > 0)
              ? msg.diffs
              : (op?.diffs ?? []);
            // Reorder ops have no cell diffs but still need Accept/Undo buttons.
            const isReorderOp = op?.steps.some(s => s.type === 'reorder') ?? false;
            if (!diffsToShow.length && !isReorderOp && !msg.diffResolved) return null;
            const resolvedStatus = msg.diffResolved ?? op?.resolved;
            return (
              <DiffView
                key={msg.operationId}
                operationId={msg.operationId}
                description={op?.description ?? msg.content?.split('\n')[0]}
                diffs={diffsToShow}
                onAccept={handleAccept}
                onUndo={handleUndo}
                resolved={resolvedStatus}
              />
            );
          })()}
          </div>
          </React.Fragment>
        ))}

        {isLoading && progressText && !activeStreamId && (
          <div className="ds-assistant-message ds-assistant-message-system">
            <span className="ds-assistant-loading">
              {progressText}
              <span className="ds-thinking-dots" aria-hidden="true">
                <span /><span /><span />
              </span>
            </span>
          </div>
        )}

        {agentBadgeVisible && (
          <div className="ds-agent-badge ds-agent-badge--active">
            <span className="ds-agent-badge__label">Varys File Agent</span>
          </div>
        )}

        {/* System warning banners (billing errors, scan failures) */}
        {sysWarnings.length > 0 && !warningsDismissed && (
          <div className="ds-sys-warnings">
            {sysWarnings.map((w, i) => (
              <div key={i} className={`ds-sys-warning ds-sys-warning--${w.level}`}>
                <span className="ds-sys-warning__icon">{w.level === 'error' ? '⚠️' : 'ℹ️'}</span>
                <span className="ds-sys-warning__msg">{w.message}</span>
                <button
                  className="ds-sys-warning__dismiss"
                  onClick={() => {
                    const remaining = sysWarnings.filter((_, j) => j !== i);
                    setSysWarnings(remaining);
                    if (remaining.length === 0) setWarningsDismissed(true);
                  }}
                  aria-label="Dismiss"
                >✕</button>
              </div>
            ))}
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Agent results section — shown after any /file_agent run */}
      {/* File-agent auxiliary banners — only rendered when there is actually
          something worth surfacing (error, warnings, incomplete, bash activity).
          The title, context chips, and config button are removed: they were
          redundant since the user already knows which file is in focus. */}
      {agentResultsReady && (agentToolError || agentIncomplete || agentBashCount > 0 ||
          agentBashWarnings.length > 0 || agentBlockedCmds.length > 0) && (
        <div className="ds-agent-results">
          {agentToolError && (
            <AgentToolErrorBanner
              error={agentToolError}
              onOpenAgentSettings={() => setSettingsOpenToAgent(true)}
            />
          )}

          {agentIncomplete && (
            <div className="ds-agent-incomplete-banner">
              ⚠ Task reached the turn limit — results may be incomplete.
            </div>
          )}

          {agentBashCount > 0 && (
            <div className="ds-agent-bash-banner">
              🔧 Shell commands were run during this task.
            </div>
          )}

          {agentBashWarnings.map((reason, i) => !bashWarnDismissed[i] && (
            <div key={`bwarn-${i}`} className="ds-agent-bash-warn-chip">
              <span className="ds-agent-bash-warn-icon">⚠</span>
              <span className="ds-agent-bash-warn-text">Potentially destructive command: {reason}</span>
              <button
                className="ds-agent-bash-warn-dismiss"
                onClick={() => setBashWarnDismissed(prev => ({ ...prev, [i]: true }))}
                title="Dismiss"
              >✕</button>
            </div>
          ))}

          {agentBlockedCmds.map((bc, i) => !blockedCmdDismissed[i] && (
            <div key={`bblock-${i}`} className="ds-agent-blocked-chip">
              <span className="ds-agent-blocked-icon">🚫</span>
              <span className="ds-agent-blocked-text">Command blocked: {bc.reason}</span>
              <button
                className="ds-agent-blocked-dismiss"
                onClick={() => setBlockedCmdDismissed(prev => ({ ...prev, [i]: true }))}
                title="Dismiss"
              >✕</button>
            </div>
          ))}
        </div>
      )}

      {/* Input area */}
      <div className="ds-assistant-input-area">
        {/* Drag handle — drag upward to expand the textarea */}
        <div
          className="ds-input-resize-handle"
          onMouseDown={handleResizeMouseDown}
          title="Drag to resize input"
          aria-label="Resize input area"
        >
          <span className="ds-input-resize-grip" />
        </div>
        {/* Slash-command autocomplete popup */}
        {showCmdPopup && (
          <CommandAutocomplete
            commands={commands}
            query={input}
            onSelect={cmd => {
              if (cmd.command === '/resize') {
                // Place cursor inside the parentheses so the user types the number directly
                setInput('/resize(');
                setShowCmdPopup(false);
                requestAnimationFrame(() => {
                  const el = textareaRef.current;
                  if (el) { el.focus(); moveCECursorToEnd(el); }
                });
              } else if (
                cmd.command === '/file_agent' ||
                cmd.command === '/file_agent_find' ||
                cmd.command === '/file_agent_save'
              ) {
                // Agent commands require a task argument — fill input so user can type it
                setInput(cmd.command + ' ');
                setActiveCommand(cmd);
                setShowCmdPopup(false);
                requestAnimationFrame(() => {
                  const el = textareaRef.current;
                  if (el) { el.focus(); moveCECursorToEnd(el); }
                });
              } else if (cmd.type === 'builtin') {
                // Handle built-ins immediately without going to the backend
                handleBuiltinCommand(cmd.command);
                setInput('');
                setShowCmdPopup(false);
              } else {
                // Fill the input with the command prefix so the user can add args
                setInput(cmd.command + ' ');
                setActiveCommand(cmd);
                setShowCmdPopup(false);
              }
            }}
            onClose={() => setShowCmdPopup(false)}
          />
        )}
        {/* Active command badge */}
        {activeCommand && (
          <div className="ds-cmd-active-badge">
            <span className="ds-cmd-active-name">{activeCommand.command}</span>
            <span className="ds-cmd-active-desc">{activeCommand.description}</span>
            <span
              className="ds-cmd-active-clear"
              onClick={() => {
                setActiveCommand(null);
                setInput('');
              }}
              data-tip="Clear command"
            >✕</span>
          </div>
        )}
        {/* Context chip — shown when "Edit with AI" (or similar) attaches code context */}
        {contextChip && (
          <div className="ds-ctx-chip">
            <span className="ds-ctx-chip-icon">📎</span>
            <span className="ds-ctx-chip-label">{contextChip.label}</span>
            <button
              className="ds-ctx-chip-toggle"
              onClick={() => setChipExpanded(x => !x)}
              data-tip={chipExpanded ? 'Collapse' : 'Expand context'}
              aria-label={chipExpanded ? 'Collapse context' : 'Expand context'}
            >{chipExpanded ? '▲' : '▼'}</button>
            <button
              className="ds-ctx-chip-remove"
              onClick={() => { setContextChip(null); contextPrefixRef.current = ''; }}
              data-tip="Remove context"
              aria-label="Remove context"
            >✕</button>
            {chipExpanded && (
              <pre className="ds-ctx-chip-preview">{contextChip.preview}</pre>
            )}
          </div>
        )}
        {/* Image mode indicator — shown when /no_figures or /resize(DIM) is active */}
        {imageMode && (
          <div className="ds-image-mode-badge">
            <span className="ds-image-mode-icon">{imageMode.mode === 'no_figures' ? '🚫' : '🔬'}</span>
            <span className="ds-image-mode-label">
              {imageMode.mode === 'no_figures'
                ? 'no figures'
                : `resize(${(imageMode as { mode: 'resize'; dim: number }).dim}px)`}
            </span>
            <button
              className="ds-image-mode-clear"
              onClick={() => {
                setImageMode(null);
                addMessage('system', '✓ Image mode cleared — figures will be sent as normal.');
              }}
              title="Clear image mode"
              aria-label="Clear image mode"
            >✕</button>
          </div>
        )}
        {/* @notebook chip + textarea share a relative wrapper so the chip
            can be pinned to the top-left corner of the input box */}
        <div className="ds-input-body">
          <div className="ds-nb-ctx-row">
            <span className="ds-nb-ctx-label">context:</span>
            {currentFilePath ? (
              <span
                className="ds-nb-ctx-chip ds-nb-ctx-chip--on ds-nb-ctx-chip--file"
                data-tip={`File included as context: ${currentFilePath}`}
                aria-label={`File context: ${currentFilePath}`}
                title={currentFilePath}
              >
                <span className="ds-nb-ctx-sign">×</span>
                {currentFilePath.split('/').pop()}
              </span>
            ) : (
              <button
                className={`ds-nb-ctx-chip${notebookAware ? ' ds-nb-ctx-chip--on' : ' ds-nb-ctx-chip--off'}`}
                onClick={handleToggleNotebookAware}
                data-tip={notebookAware
                  ? `${currentNotebookPath || 'Notebook'} included as context — click to exclude`
                  : `${currentNotebookPath || 'Notebook'} excluded from context — click to include`}
                aria-label={notebookAware ? 'Notebook included' : 'Notebook excluded'}
                title={currentNotebookPath}
              >
                <span className="ds-nb-ctx-sign">{notebookAware ? '×' : '+'}</span>
                {currentNotebookPath ? currentNotebookPath.split('/').pop() : 'notebook'}
              </button>
            )}
            {/* Cell-reference chips — appear live as the user types "cell #N<sep>" */}
            {extractCellRefs(input).map(ref => (
              <span
                key={ref}
                className="ds-nb-ctx-chip ds-nb-ctx-chip--on ds-cell-ref-ctx-chip"
                title={`"${ref}" referenced in your query`}
                aria-label={ref}
              >
                {ref}
              </span>
            ))}
            <div className="ds-reasoning-dropdown" ref={reasoningDropdownRef}>
              <button
                className={`ds-thinking-chip${
                  reasoningMode === 'sequential' ? ' ds-thinking-chip--on'
                  : reasoningMode === 'cot'      ? ' ds-thinking-chip--cot'
                  :                                ' ds-thinking-chip--off'
                }`}
                onClick={() => setReasoningDropdownOpen(v => !v)}
                aria-label={`Chain-of-Thought mode: ${reasoningMode}`}
                aria-haspopup="listbox"
                aria-expanded={reasoningDropdownOpen}
              >
                🧠{' '}
                {reasoningMode === 'sequential' ? 'Sequential'
                  : reasoningMode === 'cot'     ? 'CoT'
                  :                               'CoT: off'}
                <span className="ds-reasoning-chevron">{reasoningDropdownOpen ? '▴' : '▾'}</span>
              </button>
              {reasoningDropdownOpen && (
                <div className="ds-reasoning-menu" role="listbox">
                  {([
                    { value: 'off',        label: 'Off',        sub: 'No extra reasoning calls',       mod: '' },
                    { value: 'cot',        label: 'CoT',        sub: '1 call · steps inline',          mod: 'cot' },
                    { value: 'sequential', label: 'Sequential', sub: 'Multi-step · 🧠 panel',          mod: 'seq' },
                  ] as { value: ReasoningMode; label: string; sub: string; mod: string }[]).map(opt => (
                    <button
                      key={opt.value}
                      role="option"
                      aria-selected={reasoningMode === opt.value}
                      className={`ds-reasoning-item ds-reasoning-item--${opt.mod || 'off'}${reasoningMode === opt.value ? ' ds-reasoning-item--active' : ''}`}
                      onClick={() => {
                        setReasoningMode(opt.value);
                        reasoningModeRef.current = opt.value;
                        threadReasoningMapRef.current.set(currentThreadIdRef.current, opt.value);
                        try { localStorage.setItem('ds-varys-reasoning-mode', opt.value); } catch { /* ignore */ }
                        setReasoningDropdownOpen(false);
                        // Persist immediately so a refresh before the next message
                        // does not lose the selection.
                        const tid   = currentThreadIdRef.current;
                        const tName = threadsRef.current.find(t => t.id === tid)?.name ?? 'Thread';
                        void _saveThread(tid, tName, messagesRef.current);
                      }}
                    >
                      <span className="ds-reasoning-item-label">{opt.label}</span>
                      <span className="ds-reasoning-item-sub">{opt.sub}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
          {/* contenteditable div replaces <textarea> so "cell #N" tokens can
              be styled inline (italic + blue) without any transparency tricks.
              Plain text is kept in the `input` state; innerHTML carries the
              highlighting.  The useEffect above syncs innerHTML when `input`
              is changed by code (send, command autocomplete, etc.). */}
          <div
            ref={textareaRef}
            role="textbox"
            aria-multiline="true"
            contentEditable={isLoading ? 'false' : 'true'}
            className="ds-assistant-input ds-assistant-ce"
            style={{ minHeight: MIN_INPUT_HEIGHT, maxHeight: inputHeight }}
            data-placeholder={contextChip ? `Describe your edit for ${contextChip.label}…` : "Ask Varys… (use @varName · /command · Enter to send)"}
            suppressContentEditableWarning
            onInput={() => {
              const el = textareaRef.current;
              if (!el) return;
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
              } else {
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
                const nbPath = ctx?.notebookPath ?? '';
                if (nbPath) {
                  const activeIdx = ctx?.activeCellIndex ?? -1;
                  const cellIds = (ctx?.cells ?? [])
                    .filter((_, i) => activeIdx < 0 || i <= activeIdx)
                    .map(c => c.cellId ?? '')
                    .filter(Boolean);
                  apiClient.fetchSymbols(nbPath, cellIds).then(syms => setAtSymbols(syms)).catch(() => {/* ignore */});
                }
              } else if (before.endsWith('@')) {
                const anchor = before.length - 1;
                setAtAnchorPos(anchor);
                setAtQuery('');
                setAtFocusIdx(0);
                const ctx = notebookReader.getFullContext();
                const nbPath = ctx?.notebookPath ?? '';
                if (nbPath) {
                  const activeIdx = ctx?.activeCellIndex ?? -1;
                  const cellIds = (ctx?.cells ?? [])
                    .filter((_, i) => activeIdx < 0 || i <= activeIdx)
                    .map(c => c.cellId ?? '')
                    .filter(Boolean);
                  apiClient.fetchSymbols(nbPath, cellIds).then(syms => setAtSymbols(syms)).catch(() => {/* ignore */});
                }
              } else {
                setAtAnchorPos(-1);
              }
              // Update inline cell-ref highlighting when the pattern changes
              const newHtml = buildHighlightHtml(val);
              if (newHtml !== ceHtmlRef.current) {
                const pos = getCursorCharOffset(el);
                el.innerHTML = newHtml;
                ceHtmlRef.current = newHtml;
                setCursorCharOffset(el, pos);
              }
            }}
            onKeyDown={handleKeyDown}
          />
          {/* @-mention autocomplete dropdown */}
          {atAnchorPos >= 0 && atFiltered.length > 0 && (
            <div className="ds-at-menu" ref={atDropdownRef} role="listbox">
              {atFiltered.map((sym, i) => (
                <button
                  key={sym.name}
                  role="option"
                  aria-selected={i === atFocusIdx}
                  className={`ds-at-item${i === atFocusIdx ? ' ds-at-item--focused' : ''}`}
                  onMouseDown={e => { e.preventDefault(); insertAtSuggestion(sym.name); }}
                  onMouseEnter={() => setAtFocusIdx(i)}
                >
                  <span className="ds-at-item-name">@{sym.name}</span>
                  {sym.vtype && <span className="ds-at-item-type">{sym.vtype}</span>}
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="ds-assistant-input-bottom">
          <ModelSwitcher
            provider={chatProvider}
            model={chatModel}
            zoo={chatZoo}
            saving={modelSwitching}
            onSelect={m => void handleModelSelect(m)}
          />
          {(() => {
            const usage = threads.find(t => t.id === currentThreadId)?.tokenUsage;
            const hasUsage = usage && (usage.input > 0 || usage.output > 0);
            const fmt = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
            const tip = hasUsage
              ? `In: ${usage!.input.toLocaleString()} · Out: ${usage!.output.toLocaleString()} tokens (this thread)`
              : 'Token usage — accumulates across all turns in this thread';
            return (
              <span className={`ds-token-counter${hasUsage ? '' : ' ds-token-counter--empty'}`} data-tip={tip}>
                <span className="ds-token-in">↑{hasUsage ? fmt(usage!.input) : '0'}</span>
                <span className="ds-token-out">↓{hasUsage ? fmt(usage!.output) : '0'}</span>
              </span>
            );
          })()}
          <div className="ds-input-controls">
            {(notebookAware || !!currentFilePath) && (
              <select
                className="ds-cell-mode-select"
                value={cellMode}
                title={CELL_MODE_TITLE[cellMode]}
                onChange={e => {
                  const next = e.target.value as CellMode;
                  setCellMode(next);
                  cellModeRef.current = next;
                  threadModeMapRef.current.set(currentThreadIdRef.current, next);
                  try { localStorage.setItem('ds-assistant-cell-mode', next); } catch { /* ignore */ }
                  // Persist immediately so a refresh before the next message
                  // does not lose the selection.
                  const tid   = currentThreadIdRef.current;
                  const tName = threadsRef.current.find(t => t.id === tid)?.name ?? 'Thread';
                  void _saveThread(tid, tName, messagesRef.current);
                }}
              >
                <option value="chat">💬 Chat</option>
                <option value="agent">✨ Agent</option>
              </select>
            )}
          </div>
          {isLoading && (
            /* Stop button — circle with a filled square inside */
            <button
              className="ds-assistant-send-btn ds-send-stop"
              onClick={handleStop}
              title="Stop generation"
              aria-label="Stop generation"
            >
              <svg viewBox="0 0 24 24" width="10" height="10" fill="none"
                   xmlns="http://www.w3.org/2000/svg">
                <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2"/>
                <rect x="8" y="8" width="8" height="8" rx="1" fill="currentColor"/>
              </svg>
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Lumino widget wrapper
// ---------------------------------------------------------------------------

export class DSAssistantSidebar extends ReactWidget {
  private _props: SidebarProps;

  constructor(props: SidebarProps) {
    super();
    this._props = props;
    this.addClass('jp-ReactWidget');
  }

  /**
   * Send a message into the chat panel.
   * If autoSend is true the message is submitted immediately (e.g. context-menu
   * actions); if false the text is pre-filled so the user can review/edit it.
   */
  sendMessage(
    text: string,
    autoSend = true,
    displayText?: string,
    contextPrefix?: string,
    contextChip?: { label: string; preview: string },
    selectedOutput?: ExternalMessage['selectedOutput'],
  ): void {
    _dispatchExternalMessage({ text, autoSend, displayText, contextPrefix, contextChip, selectedOutput });
  }

  /** Convenience: send a specific notebook output to the chat input. */
  sendOutputToChat(output: import('../outputs/outputOverlay').SelectedOutput): void {
    const chip = { label: output.label, preview: output.preview };
    _dispatchExternalMessage({
      text:           '',
      autoSend:       false,
      contextChip:    chip,
      selectedOutput: output,
    });
  }

  /** Open the Tags & Metadata panel inside the sidebar. */
  openTagsPanel(): void {
    _dispatchExternalMessage({ text: '', autoSend: false, openTags: true });
  }

  render(): JSX.Element {
    return <DSAssistantChat {...this._props} />;
  }
}

/**
 * Output Overlay — D + C + E
 *
 * E: Numbered badges injected onto every individual output object in a cell.
 * C: Semantic labels extracted from the cell source (plt.title, ax.set_title,
 *    variable name being plotted, function name).
 * D: Right-click "Ask Varys" context menu on each output element,
 *    sending only that specific output as a chip to the chat input.
 */
import { INotebookTracker } from '@jupyterlab/notebook';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SelectedOutput {
  /** Human-readable label, e.g. "Price Distribution — cell 45, output 2" */
  label: string;
  /** Short preview shown in the collapsed chip */
  preview: string;
  /** Dominant MIME type of the output */
  mimeType: string;
  /** Raw base64 string for image/png outputs (no data-URI prefix) */
  imageData?: string;
  /** HTML or plain-text for table/text outputs */
  textData?: string;
  cellIndex: number;
  outputIndex: number;
}

export type OnSendOutputToChat = (output: SelectedOutput) => void;

// ─── C: Semantic label extraction from source code ───────────────────────────

/**
 * Split cell source into "plot segments" by detecting plt.show() / plt.close()
 * calls, then extract a semantic label for each segment.
 *
 * Returns an array of labels — one per image output, in order.
 * Labels fall back to '' when nothing useful can be extracted.
 */
export function extractPlotLabels(source: string): string[] {
  // Patterns that signal the end of one plot and the start of the next
  const showSplit = /plt\s*\.\s*(?:show|close|figure)\s*\(/g;
  const segments: string[] = [];
  let last = 0;
  let m: RegExpExecArray | null;

  while ((m = showSplit.exec(source)) !== null) {
    segments.push(source.slice(last, m.index));
    last = m.index + m[0].length;
  }
  // Don't push the trailing segment (it's after the last plt.show)

  return segments.map(seg => {
    // 1. plt.title('…') or plt.suptitle('…')
    let match = seg.match(/plt\s*\.\s*(?:title|suptitle)\s*\(\s*['"`]([^'"`\n]+)['"`]/);
    if (match) return match[1].trim();

    // 2. ax.set_title('…') or axes.set_title('…')
    match = seg.match(/\.\s*set_title\s*\(\s*['"`]([^'"`\n]+)['"`]/);
    if (match) return match[1].trim();

    // 3. seaborn title= keyword
    match = seg.match(/\btitle\s*=\s*['"`]([^'"`\n]+)['"`]/);
    if (match) return match[1].trim();

    // 4. f-string or variable title: title=f'…'  (simplified)
    match = seg.match(/\btitle\s*=\s*f['"`]([^'"`\n]+)['"`]/);
    if (match) return match[1].replace(/\{[^}]+\}/g, '…').trim();

    // 5. df['col'].hist/plot/bar/scatter → "col histogram"
    match = seg.match(/\[['"`]([^'"`]+)['"`]\]\s*\.\s*(hist|plot|bar|scatter|boxplot|violinplot|kde)/);
    if (match) return `${match[1]} ${match[2]}`;

    // 6. sns.xxx(…, y='col', …) or sns.xxx(…, x='col', …)
    match = seg.match(/sns\s*\.\s*\w+\s*\([^)]*?[yx]\s*=\s*['"`]([^'"`]+)['"`]/);
    if (match) return match[1].trim();

    // 7. Well-known function name → humanise it
    match = seg.match(/\b(plot_\w+|draw_\w+|show_\w+|visualize_\w+|display_\w+)\s*\(/);
    if (match) return match[1].replace(/_/g, ' ');

    return '';
  });
}

/** Determine the dominant MIME type for a single output model object. */
function dominantMime(output: any): string {
  // JupyterLab wraps nbformat dicts in IOutputModel objects.
  // toJSON() returns the underlying plain nbformat dict with all fields intact.
  const raw: any = typeof output.toJSON === 'function' ? output.toJSON() : output;
  const type: string = raw.output_type ?? raw.type ?? output.output_type ?? output.type ?? '';
  if (type === 'stream') return 'text/plain';
  if (type === 'error') return 'error';
  const data = raw.data ?? output.data ?? {};
  if (data['image/png'])       return 'image/png';
  if (data['image/jpeg'])      return 'image/jpeg';
  if (data['image/svg+xml'])   return 'image/svg+xml';
  if (data['text/html'])       return 'text/html';
  if (data['application/vnd.plotly.v1+json']) return 'application/vnd.plotly.v1+json';
  if (data['text/plain'])      return 'text/plain';
  return 'unknown';
}

/** Extract a plain-text representation of a table/HTML output for the LLM. */
function tableToText(output: any): string {
  const data = output.data ?? {};
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
  const plain = data['text/plain'] ?? '';
  const text = Array.isArray(plain) ? plain.join('') : String(plain);
  return text.slice(0, 3000).trim();
}

/** Extract raw base64 from an image output (strips data-URI prefix). */
function extractBase64(output: any): string | undefined {
  // JupyterLab wraps nbformat dicts in IOutputModel objects whose .data
  // property may not be a plain dict.  toJSON() returns the raw nbformat
  // dict reliably — same pattern used in NotebookReader._extractOutputImpl.
  const raw: any = typeof output.toJSON === 'function' ? output.toJSON() : output;
  const data = raw.data ?? output.data ?? {};
  const png  = data['image/png'];
  const jpeg = data['image/jpeg'];
  const src  = png ?? jpeg;
  if (!src) return undefined;
  const str = Array.isArray(src) ? src.join('') : String(src);
  return str.replace(/^data:image\/[^;]+;base64,/, '').trim();
}

// ─── E: Badge injection ───────────────────────────────────────────────────────

const BADGE_ATTR  = 'data-ds-output-idx';
const MENU_CLASS  = 'ds-output-ctx-menu';

function makeBadge(idx: number, label: string, mime: string): HTMLElement {
  const badge = document.createElement('div');
  badge.className = mime === 'error'
    ? 'ds-output-badge ds-output-badge--error'
    : 'ds-output-badge';
  badge.setAttribute(BADGE_ATTR, String(idx));

  const typeIcon = mime.startsWith('image') ? '📊'
    : mime === 'text/html'   ? '📋'
    : mime === 'error'       ? '🔴'
    : '📝';

  badge.innerHTML =
    `<span class="ds-output-badge-num">[${idx + 1}]</span>` +
    `<span class="ds-output-badge-icon">${typeIcon}</span>` +
    (label ? `<span class="ds-output-badge-label">${label}</span>` : '');

  return badge;
}

// ─── D: Context menu ─────────────────────────────────────────────────────────

let _activeMenu: HTMLElement | null = null;

function closeActiveMenu(): void {
  _activeMenu?.remove();
  _activeMenu = null;
}

function showOutputContextMenu(
  x: number, y: number,
  outputInfo: SelectedOutput,
  onSend: OnSendOutputToChat,
): void {
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
  const close = (e: MouseEvent) => {
    if (!menu.contains(e.target as Node)) {
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
function setupCellOutputs(
  cellNode: HTMLElement,
  cellModel: any,
  cellIndex: number,
  onSend: OnSendOutputToChat,
): void {
  const outputArea = cellNode.querySelector('.jp-Cell-outputWrapper .jp-OutputArea');
  if (!outputArea) return;

  const children = outputArea.querySelectorAll(':scope > .jp-OutputArea-child');
  if (!children.length) return;

  // Collect outputs from model
  const rawOutputs: any[] = [];
  const modelOutputs = cellModel?.outputs;
  if (modelOutputs) {
    const len = typeof modelOutputs.length === 'number' ? modelOutputs.length : 0;
    for (let i = 0; i < len; i++) {
      const o = modelOutputs.get ? modelOutputs.get(i) : modelOutputs[i];
      if (o) rawOutputs.push(o);
    }
  }

  // Derive semantic labels for image outputs
  const source: string = cellModel?.value?.text ?? cellModel?.source ?? '';
  const plotLabels = extractPlotLabels(source);
  let imageCount = 0;

  children.forEach((child, domIdx) => {
    const el = child as HTMLElement;
    // Skip if already decorated
    if (el.querySelector('.ds-output-badge')) return;

    const rawOutput = rawOutputs[domIdx];
    const mime = rawOutput ? dominantMime(rawOutput) : 'unknown';

    // Skip completely unknown outputs (no data to send)
    if (mime === 'unknown') return;

    // Derive label
    let semanticLabel = '';
    if (mime.startsWith('image')) {
      semanticLabel = plotLabels[imageCount] ?? '';
      imageCount++;
    } else if (mime === 'text/html') {
      semanticLabel = 'DataFrame';
    } else if (mime === 'error') {
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
    const buildPayload = (): SelectedOutput => {
      if (mime === 'error') {
        // Extract error text from the raw output model
        const raw: any = rawOutput && typeof rawOutput.toJSON === 'function'
          ? rawOutput.toJSON() : (rawOutput ?? {});
        const ename  = raw.ename  ?? 'Error';
        const evalue = raw.evalue ?? '';
        const rawTb  = raw.traceback;
        // eslint-disable-next-line no-control-regex
        const tbClean = Array.isArray(rawTb)
          ? (rawTb as string[]).join('\n').replace(/\x1b\[[0-9;]*m/g, '')
          : '';
        const errorText = `${ename}: ${evalue}\n${tbClean}`.trim();
        return {
          label:    fullLabel,
          preview:  `${ename}: ${evalue}`.slice(0, 80),
          mimeType: mime,
          textData: errorText,
          cellIndex,
          outputIndex: domIdx,
        };
      } else if (mime.startsWith('image')) {
        const imgData = rawOutput ? extractBase64(rawOutput) : undefined;
        return {
          label:      fullLabel,
          preview:    semanticLabel ? `[${mime === 'image/png' ? 'PNG' : 'Image'}: ${semanticLabel}]` : `[Image]`,
          mimeType:   mime,
          imageData:  imgData,
          cellIndex,
          outputIndex: domIdx,
        };
      } else {
        const text = rawOutput ? tableToText(rawOutput) : '';
        const firstLine = text.split('\n')[0].slice(0, 80);
        return {
          label:    fullLabel,
          preview:  firstLine || '[table/text output]',
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
    badge.addEventListener('click', (e: MouseEvent) => {
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
export function initOutputOverlay(
  tracker: INotebookTracker,
  onSend: OnSendOutputToChat,
): void {
  // Observers per cell node, keyed by node identity
  const cellObservers = new WeakMap<Element, MutationObserver>();

  function decorateCell(cellWidget: any, cellIndex: number): void {
    const node: HTMLElement = cellWidget.node;
    const model = cellWidget.model;

    // Only decorate code cells that have outputs
    if (model?.type !== 'code') return;

    setupCellOutputs(node, model, cellIndex, onSend);

    // Watch for output changes (re-execution) on this cell's output area
    const outputArea = node.querySelector('.jp-Cell-outputWrapper');
    if (!outputArea) return;

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

  function decorateNotebook(notebook: any): void {
    if (!notebook?.widgets) return;
    notebook.widgets.forEach((cell: any, idx: number) => decorateCell(cell, idx));

    // Watch for cell additions/deletions
    notebook.model?.cells?.changed?.connect(() => {
      setTimeout(() => {
        if (!notebook.widgets) return;
        notebook.widgets.forEach((cell: any, idx: number) => decorateCell(cell, idx));
      }, 200);
    });
  }

  // Current notebook
  if (tracker.currentWidget) {
    decorateNotebook(tracker.currentWidget.content);
  }

  // Notebook switches / new notebooks
  tracker.currentChanged.connect((_, widget) => {
    if (!widget) return;
    widget.context.ready.then(() => {
      decorateNotebook(widget.content);
      // Also re-decorate when any cell is executed
      widget.content.activeCellChanged.connect(() => {
        if (!widget.content.widgets) return;
        widget.content.widgets.forEach((cell: any, idx: number) =>
          decorateCell(cell, idx)
        );
      });
    });
  });
}

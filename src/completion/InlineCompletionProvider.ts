/**
 * DSAssistantInlineProvider — implements JupyterLab's IInlineCompletionProvider
 * interface so JupyterLab handles all ghost text rendering, debouncing,
 * Tab/Esc/Alt+Right keyboard shortcuts, and settings UI natively.
 */

import { Cell } from '@jupyterlab/cells';
import {
  CompletionHandler,
  IInlineCompletionContext,
  IInlineCompletionItem,
  IInlineCompletionList,
  IInlineCompletionProvider,
} from '@jupyterlab/completer';
import { INotebookTracker, NotebookPanel } from '@jupyterlab/notebook';
import { JSONValue } from '@lumino/coreutils';
import { APIClient } from '../api/client';

export class DSAssistantInlineProvider
  implements IInlineCompletionProvider<IInlineCompletionItem>
{
  readonly name = 'Varys';
  readonly identifier = 'varys-inline';

  /**
   * Schema contributed to JupyterLab's Inline Completer settings panel.
   * Only the toggle is exposed here — model selection is done in .env.
   */
  readonly schema = {
    type: 'object' as const,
    properties: {
      enabled: {
        title: 'Enable Varys Inline Completion',
        description:
          'Show ghost-text suggestions as you type. ' +
          'Model and provider are configured in .env.',
        type: 'boolean' as const,
        default: true
      }
    }
  };

  private _enabled = true;
  private _apiClient: APIClient;
  private _tracker: INotebookTracker;

  // ── Stale-completion guard (workaround for jupyterlab/jupyterlab `RangeError:
  //    Invalid line number N in K-line document` race) ──────────────────────
  // When the user edits a cell while a completion request is in flight, the
  // cached response can later be rendered against a now-shorter document and
  // crash JL's inline completer.  We can't fix JL's renderer from here, but we
  // can prevent stale suggestions from ever reaching it: cancel the in-flight
  // request the moment the active cell's content changes, and re-validate the
  // prefix before returning a result.
  private _inFlight: AbortController | null = null;
  private _watchedCell: Cell | null = null;

  constructor(apiClient: APIClient, tracker: INotebookTracker) {
    this._apiClient = apiClient;
    this._tracker = tracker;
    tracker.activeCellChanged.connect(this._onActiveCellChanged, this);
    this._onActiveCellChanged(tracker, tracker.activeCell);
  }

  /**
   * Re-wire the cell-content listener whenever the active cell changes so we
   * always cancel the right cell's in-flight completion on edit.
   */
  private _onActiveCellChanged(_: INotebookTracker, cell: Cell | null): void {
    if (this._watchedCell) {
      this._watchedCell.model.sharedModel.changed.disconnect(
        this._onCellContentChanged, this);
    }
    this._watchedCell = cell;
    if (cell) {
      cell.model.sharedModel.changed.connect(this._onCellContentChanged, this);
    }
  }

  /**
   * The active cell's content changed.  If a completion request is in flight,
   * abort it so JL never gets a suggestion to render against the mutated doc.
   */
  private _onCellContentChanged(): void {
    if (this._inFlight) {
      this._inFlight.abort();
      this._inFlight = null;
    }
  }

  /** Called by JupyterLab when user changes settings for this provider. */
  configure(settings: { [property: string]: JSONValue }): void {
    this._enabled = (settings['enabled'] as boolean) ?? true;
  }

  /**
   * Main entry point called by JupyterLab on each inline completion request.
   *
   * JupyterLab already handles:
   *  - Debouncing (configurable via Inline Completer settings, default 200ms)
   *  - Ghost text rendering
   *  - Tab / Esc / Alt+Right keyboard shortcuts
   *  - Cancellation of in-flight requests when user keeps typing
   */
  async fetch(
    request: CompletionHandler.IRequest,
    context: IInlineCompletionContext
  ): Promise<IInlineCompletionList<IInlineCompletionItem>> {
    const empty: IInlineCompletionList<IInlineCompletionItem> = { items: [] };

    if (!this._enabled) {
      return empty;
    }

    const prefix = request.text.slice(0, request.offset);
    const suffix = request.text.slice(request.offset);

    // Skip trivially short prefixes to avoid noisy requests
    if (prefix.replace(/\s+$/, '').length < 2) {
      return empty;
    }

    // Map JupyterLab mimeType to a language hint for the backend
    const language = request.mimeType === 'text/x-python'
      ? 'python'
      : request.mimeType === 'text/x-r-source'
        ? 'r'
        : request.mimeType === 'text/x-julia'
          ? 'julia'
          : 'python';

    const previousCells = this._gatherPreviousCells(context);

    // Cancel any previous in-flight completion (covers the rapid-typing case;
    // the active-cell signal handler covers cell-structure edits).
    if (this._inFlight) {
      this._inFlight.abort();
    }
    const ctrl = new AbortController();
    this._inFlight = ctrl;

    try {
      const result = await this._apiClient.fetchCompletion({
        prefix,
        suffix,
        language,
        previousCells,
      }, ctrl.signal);

      // Clear in-flight pointer only if we're still the latest request.
      if (this._inFlight === ctrl) {
        this._inFlight = null;
      }

      if (!result.suggestion) {
        return empty;
      }

      // Belt-and-suspenders: verify the active cell still has the prefix we
      // computed against.  Catches the millisecond between fetch resolution
      // and abort handler, plus active-cell switches mid-request.
      const activeCell = this._tracker.activeCell;
      if (activeCell) {
        const currentText = activeCell.model.sharedModel.getSource();
        if (!currentText.startsWith(prefix)) {
          return empty;
        }
      }

      return { items: [{ insertText: result.suggestion }] };
    } catch (err) {
      if (this._inFlight === ctrl) {
        this._inFlight = null;
      }
      // AbortError fires when the user edited mid-request — that's the
      // intended outcome of this workaround, not an error worth logging.
      if ((err as Error)?.name === 'AbortError') {
        return empty;
      }
      console.error('[DSAssistant] completion fetch error:', err);
      return empty;
    }
  }

  /** Collect the last 5 cells before the active one for context. */
  private _gatherPreviousCells(
    context: IInlineCompletionContext
  ): Array<{ index: number; type: string; source: string }> {
    const widget = context.widget;
    if (!(widget instanceof NotebookPanel)) {
      // Fall back to tracker's current widget
      const panel = this._tracker.currentWidget;
      if (!panel) {
        return [];
      }
      return this._extractCells(panel);
    }
    return this._extractCells(widget);
  }

  private _extractCells(
    panel: NotebookPanel
  ): Array<{ index: number; type: string; source: string }> {
    const notebook = panel.content;
    const active = notebook.activeCellIndex;
    const start = Math.max(0, active - 5);
    const cells: Array<{ index: number; type: string; source: string }> = [];
    for (let i = start; i < active; i++) {
      const cell = notebook.widgets[i];
      if (cell) {
        cells.push({
          index: i,
          type: cell.model.type,
          source: cell.model.sharedModel.getSource()
        });
      }
    }
    return cells;
  }
}

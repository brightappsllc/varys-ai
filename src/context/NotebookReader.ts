/**
 * NotebookReader - Extracts full context from the active JupyterLab notebook.
 */

import { INotebookTracker, NotebookPanel } from '@jupyterlab/notebook';
import { CodeEditor } from '@jupyterlab/codeeditor';
import { CellInfo, NotebookContext, TextSelection } from '../api/client';

/**
 * Maximum characters captured from each cell's output before truncation.
 * Must match CELL_CONTENT_LIMIT in varys/llm/context_utils.py
 * so the backend and frontend agree on the same cap.
 */
const CELL_OUTPUT_MAX_CHARS = 2_000;

export class NotebookReader {
  private tracker: INotebookTracker;

  constructor(tracker: INotebookTracker) {
    this.tracker = tracker;
  }

  /**
   * Returns the full context of the currently active notebook.
   * Returns null if no notebook is open.
   */
  getFullContext(): NotebookContext | null {
    const panel = this.tracker.currentWidget;
    if (!panel) {
      return null;
    }
    return this._extractContext(panel);
  }

  private _extractContext(panel: NotebookPanel): NotebookContext {
    const notebook = panel.content;
    const activeCellIndex = notebook.activeCellIndex;
    const cells: CellInfo[] = [];

    notebook.widgets.forEach((cell, index) => {
      const model = cell.model;
      // model.id is the stable nbformat cell_id UUID (assigned by JupyterLab,
      // survives cell moves and insertions — changes only on explicit cell delete+recreate).
      const cellId: string | undefined =
        (model as any).id ??
        (model as any).sharedModel?.id ??
        undefined;

      const imgInfo = model.type === 'code' ? this._extractImage(model) : null;
      cells.push({
        index,
        type: model.type as 'code' | 'markdown',
        source: model.sharedModel.getSource(),
        executionCount:
          model.type === 'code'
            ? (model as any).executionCount ?? null
            : null,
        output: model.type === 'code' ? this._extractOutput(model) : null,
        imageOutput: imgInfo ? imgInfo.data : null,
        imageOutputMime: imgInfo ? imgInfo.mime : null,
        cellId,
      });
    });

    // Stable UUID of the currently focused cell (for Smart Cell Context focal
    // cell detection).  Sent alongside activeCellIndex for backward compat.
    const activeCell = notebook.activeCell;
    const activeCellId: string | undefined =
      activeCell
        ? ((activeCell.model as any).id ??
           (activeCell.model as any).sharedModel?.id ??
           undefined)
        : undefined;

    // Full (untruncated) output of the active/focal cell.  The backend uses
    // this verbatim for the focal cell instead of the stored 1 000-char summary.
    const focalCellOutput: string | null =
      activeCell && activeCell.model.type === 'code'
        ? this._extractFullOutput(activeCell.model)
        : null;

    return {
      cells,
      activeCellIndex,
      activeCellId,
      focalCellOutput,
      notebookPath: panel.context.path,
      kernelName: panel.sessionContext.session?.kernel?.name ?? undefined,
      selection: this._getSelection(panel)
    };
  }

  /**
   * Returns the text currently selected by the user in the active code cell,
   * or null when there is no meaningful selection (cursor only / empty).
   */
  private _getSelection(panel: NotebookPanel): TextSelection | null {
    const notebook = panel.content;
    const activeCell = notebook.activeCell;
    if (!activeCell) {
      return null;
    }

    const editor = activeCell.editor;
    if (!editor) {
      return null;
    }

    const selection: CodeEditor.IRange = editor.getSelection();
    const { start, end } = selection;

    // A cursor position (no text selected) has start === end
    if (start.line === end.line && start.column === end.column) {
      return null;
    }

    const source = activeCell.model.sharedModel.getSource();
    const lines = source.split('\n');

    // Extract the selected lines (inclusive)
    const selectedLines = lines.slice(start.line, end.line + 1);

    // Trim partial first/last lines to the exact column boundaries
    if (selectedLines.length > 0) {
      selectedLines[selectedLines.length - 1] = selectedLines[
        selectedLines.length - 1
      ].slice(0, end.column);
      selectedLines[0] = selectedLines[0].slice(start.column);
    }

    const text = selectedLines.join('\n');
    if (!text.trim()) {
      return null;
    }

    return {
      cellIndex: notebook.activeCellIndex,
      text,
      startLine: start.line,
      endLine: end.line
    };
  }

  /**
   * Extracts a full (untruncated) plain-text representation of a code cell's
   * outputs.  Used for the focal cell's focalCellOutput payload field — the
   * backend assembler injects this verbatim rather than the stored summary.
   */
  private _extractFullOutput(model: any): string | null {
    return this._extractOutputImpl(model, false);
  }

  /**
   * Extracts a plain-text representation of a code cell's outputs.
   * Handles: execute_result, display_data, stream (stdout/stderr), error.
   * Caps at 2000 chars to keep context size reasonable.
   */
  private _extractOutput(model: any): string | null {
    return this._extractOutputImpl(model, true);
  }

  private _extractOutputImpl(model: any, applyCapLimit: boolean): string | null {
    const outputs = model.outputs;
    if (!outputs || outputs.length === 0) {
      return null;
    }

    // Non-error outputs and error outputs are budgeted separately so a
    // long traceback is never silently dropped when stdout fills the limit.
    const regularParts: string[] = [];
    const errorParts: string[] = [];

    for (let i = 0; i < outputs.length; i++) {
      const output = outputs.get ? outputs.get(i) : outputs[i];
      if (!output) continue;

      // JupyterLab wraps raw nbformat dicts in IOutputModel objects.
      // ename / evalue / traceback are NOT direct properties on the model —
      // toJSON() returns the underlying nbformat dict with all fields intact.
      const raw: any = typeof output.toJSON === 'function' ? output.toJSON() : output;
      const outputType: string = raw.output_type ?? raw.type ?? output.output_type ?? output.type ?? '';


      if (outputType === 'stream') {
        const text = raw.text ?? output.text ?? '';
        const content = Array.isArray(text) ? text.join('') : String(text);
        if (content.trim()) regularParts.push(content.trim());

      } else if (outputType === 'execute_result' || outputType === 'display_data') {
        const data = raw.data ?? output.data ?? {};
        const plain = data['text/plain'] ?? '';
        const content = Array.isArray(plain) ? plain.join('') : String(plain);
        if (content.trim()) regularParts.push(content.trim());

      } else if (outputType === 'error') {
        const ename = raw.ename ?? output.ename ?? 'Error';
        const evalue = raw.evalue ?? output.evalue ?? '';
        const rawTb: unknown = raw.traceback ?? output.traceback;
        if (rawTb && Array.isArray(rawTb) && rawTb.length > 0) {
          // eslint-disable-next-line no-control-regex
          const tbClean = (rawTb as string[]).join('\n').replace(/\x1b\[[0-9;]*m/g, '');
          errorParts.push(`${ename}: ${evalue}\n${tbClean}`);
        } else {
          errorParts.push(`${ename}: ${evalue}`);
        }
      }
    }

    if (regularParts.length === 0 && errorParts.length === 0) return null;

    const regularText = regularParts.join('\n');
    const errorText   = errorParts.join('\n');

    const cappedRegular = (applyCapLimit && regularText.length > CELL_OUTPUT_MAX_CHARS)
      ? regularText.slice(0, CELL_OUTPUT_MAX_CHARS) + '\n[...output truncated]'
      : regularText;
    const cappedError = (applyCapLimit && errorText.length > CELL_OUTPUT_MAX_CHARS)
      ? errorText.slice(0, CELL_OUTPUT_MAX_CHARS) + '\n[...traceback truncated]'
      : errorText;

    const hasRegular = cappedRegular.trim().length > 0;
    const hasError   = cappedError.trim().length > 0;

    // When both regular output and error exist, label them as separate indexed
    // objects so the LLM can reference each independently:
    //   [1] = stdout / execute_result (the short result line)
    //   [2] = error traceback (the detailed exception, usually the most important)
    if (hasRegular && hasError) {
      return `[1]\n${cappedRegular.trim()}\n\n[2]\n${cappedError.trim()}`;
    }
    if (hasError) {
      // Error only — still label it [1] so the LLM knows it's an indexed object
      return `[1]\n${cappedError.trim()}`;
    }
    return cappedRegular.trim() || null;
  }

  /**
   * Extracts the first image/png output from a code cell, returned as a
   * base64 string (no data-URI prefix).  Returns null if no image present.
   */
  private _extractImage(model: any): { data: string; mime: string } | null {
    const outputs = model.outputs;
    if (!outputs || outputs.length === 0) return null;

    // Preferred formats in order: PNG is lossless and most common for plots;
    // JPEG and WEBP are also supported by both Anthropic and OpenAI vision APIs.
    const IMAGE_MIMES = [
      'image/png',
      'image/jpeg',
      'image/webp',
      'image/gif',
    ] as const;

    for (let i = 0; i < outputs.length; i++) {
      const output = outputs.get ? outputs.get(i) : outputs[i];
      if (!output) continue;
      const data = output.data ?? {};

      for (const mime of IMAGE_MIMES) {
        const raw_val = data[mime];
        if (!raw_val) continue;
        const raw = Array.isArray(raw_val) ? raw_val.join('') : String(raw_val);
        // Strip any data-URI prefix (data:image/png;base64,...) before storing
        return { data: raw.replace(/^data:[^;]+;base64,/, '').trim(), mime };
      }
    }
    return null;
  }

  /**
   * Returns a single cell by index, or null if out of bounds.
   */
  getCell(index: number): CellInfo | null {
    const context = this.getFullContext();
    if (!context) {
      return null;
    }
    return context.cells[index] ?? null;
  }

  /**
   * Returns an inclusive slice of cells from start to end.
   */
  getCellRange(start: number, end: number): CellInfo[] {
    const context = this.getFullContext();
    if (!context) {
      return [];
    }
    return context.cells.slice(start, end + 1);
  }

  /**
   * Finds cells whose source matches the given regex pattern.
   */
  findCells(pattern: RegExp): CellInfo[] {
    const context = this.getFullContext();
    if (!context) {
      return [];
    }
    return context.cells.filter(cell => pattern.test(cell.source));
  }

  /**
   * Returns the index of the currently active cell in the notebook.
   */
  getCurrentCellIndex(): number {
    const panel = this.tracker.currentWidget;
    if (!panel) {
      return 0;
    }
    return panel.content.activeCellIndex;
  }
}

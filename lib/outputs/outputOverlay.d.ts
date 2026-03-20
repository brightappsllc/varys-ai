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
/**
 * Split cell source into "plot segments" by detecting plt.show() / plt.close()
 * calls, then extract a semantic label for each segment.
 *
 * Returns an array of labels — one per image output, in order.
 * Labels fall back to '' when nothing useful can be extracted.
 */
export declare function extractPlotLabels(source: string): string[];
/**
 * Initialise the output overlay system for all notebooks managed by
 * `tracker`.  Re-decorates cells whenever:
 *   - A new notebook is opened
 *   - A cell is executed (outputs change)
 *   - Cells are added or removed
 */
export declare function initOutputOverlay(tracker: INotebookTracker, onSend: OnSendOutputToChat): void;
//# sourceMappingURL=outputOverlay.d.ts.map
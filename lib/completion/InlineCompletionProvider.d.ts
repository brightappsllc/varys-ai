/**
 * DSAssistantInlineProvider — implements JupyterLab's IInlineCompletionProvider
 * interface so JupyterLab handles all ghost text rendering, debouncing,
 * Tab/Esc/Alt+Right keyboard shortcuts, and settings UI natively.
 */
import { CompletionHandler, IInlineCompletionContext, IInlineCompletionItem, IInlineCompletionList, IInlineCompletionProvider } from '@jupyterlab/completer';
import { INotebookTracker } from '@jupyterlab/notebook';
import { JSONValue } from '@lumino/coreutils';
import { APIClient } from '../api/client';
export declare class DSAssistantInlineProvider implements IInlineCompletionProvider<IInlineCompletionItem> {
    readonly name = "Varys";
    readonly identifier = "varys-inline";
    /**
     * Schema contributed to JupyterLab's Inline Completer settings panel.
     * Only the toggle is exposed here — model selection is done in .env.
     */
    readonly schema: {
        type: "object";
        properties: {
            enabled: {
                title: string;
                description: string;
                type: "boolean";
                default: boolean;
            };
        };
    };
    private _enabled;
    private _apiClient;
    private _tracker;
    constructor(apiClient: APIClient, tracker: INotebookTracker);
    /** Called by JupyterLab when user changes settings for this provider. */
    configure(settings: {
        [property: string]: JSONValue;
    }): void;
    /**
     * Main entry point called by JupyterLab on each inline completion request.
     *
     * JupyterLab already handles:
     *  - Debouncing (configurable via Inline Completer settings, default 200ms)
     *  - Ghost text rendering
     *  - Tab / Esc / Alt+Right keyboard shortcuts
     *  - Cancellation of in-flight requests when user keeps typing
     */
    fetch(request: CompletionHandler.IRequest, context: IInlineCompletionContext): Promise<IInlineCompletionList<IInlineCompletionItem>>;
    /** Collect the last 5 cells before the active one for context. */
    private _gatherPreviousCells;
    private _extractCells;
}
//# sourceMappingURL=InlineCompletionProvider.d.ts.map
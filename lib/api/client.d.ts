/**
 * API client for communicating with the Varys backend.
 */
export interface SlashCommand {
    command: string;
    description: string;
    type: 'builtin' | 'skill';
    skill_name?: string;
}
/** A single saved message inside a chat thread. */
export interface SavedDiff {
    cellIndex: number;
    opType: 'insert' | 'modify' | 'delete';
    cellType: 'code' | 'markdown';
    original: string;
    modified: string;
    description?: string;
}
export interface SavedMessage {
    id: string;
    role: 'user' | 'assistant' | 'system' | 'warning';
    content: string;
    timestamp: string;
    /** Reasoning trace from sequential thinking — displayed but never sent as LLM context. */
    thoughts?: string;
    /** operationId of the cell-edit operation this assistant turn produced, if any. */
    operationId?: string;
    /** Persisted diff data for the cell-edit operation — enables restoring the DiffView on reload. */
    diffs?: SavedDiff[];
    /** Resolution status — set after the user accepts or rejects the diff. */
    diffResolved?: 'accepted' | 'undone';
    /** Error sub-type for special system messages (context_too_long, error_recovery). */
    subtype?: 'error_recovery' | 'context_too_long';
    /** Provider name associated with an error_recovery prompt. */
    errorProvider?: string;
    /** Whether images were part of a context_too_long error. */
    errorHasImages?: boolean;
}
/** Accumulated token counts for a thread. */
export interface TokenUsage {
    input: number;
    output: number;
}
/** A named conversation thread for a notebook. */
export interface ChatThread {
    id: string;
    name: string;
    createdAt: string;
    updatedAt: string;
    messages: SavedMessage[];
    /** Cumulative token usage across all turns in this thread. */
    tokenUsage?: TokenUsage;
    /** Whether to include notebook cells as context in every request (default true). */
    notebookAware?: boolean;
    /** Interaction mode for this thread: 'agent' (default) or 'chat'. */
    cellMode?: 'chat' | 'agent';
    /** Reasoning mode for this thread: 'off' (default), 'cot', or 'sequential'. */
    reasoningMode?: 'off' | 'cot' | 'sequential';
}
/** The persisted chat file containing all threads for one notebook. */
export interface ChatFile {
    notebookPath: string;
    lastThreadId: string | null;
    threads: ChatThread[];
}
export interface CellInfo {
    index: number;
    type: 'code' | 'markdown';
    source: string;
    executionCount?: number | null;
    /** Plain-text representation of the cell output (stdout + text/plain), capped at 2000 chars. */
    output?: string | null;
    /** Base64-encoded image from the cell output (plots/figures), if present. */
    imageOutput?: string | null;
    /** MIME type of imageOutput, e.g. "image/png" or "image/jpeg". */
    imageOutputMime?: string | null;
    /** Stable nbformat cell_id UUID — survives cell moves/insertions. First 8 hex chars used as display tag. */
    cellId?: string;
}
export interface TextSelection {
    cellIndex: number;
    text: string;
    startLine: number;
    endLine: number;
}
/**
 * Schema metadata for a single pandas DataFrame live in the kernel.
 * Collected by NotebookReader.getDataFrameSchemas() and injected into every
 * task request so the LLM always sees current column names and types.
 */
export interface DataFrameSchema {
    /** Python variable name in the kernel namespace */
    name: string;
    /** [rows, columns] */
    shape: [number, number];
    /** Ordered list of column names */
    columns: string[];
    /** column → dtype string, e.g. { price: 'float64', name: 'object' } */
    dtypes: Record<string, string>;
    /** Up to 3 sample rows as plain objects (non-serialisable values stringified) */
    sample: Record<string, unknown>[];
    /** Approximate memory usage in MB */
    memoryMb?: number;
}
export interface NotebookContext {
    cells: CellInfo[];
    kernelName?: string;
    notebookPath?: string;
    activeCellIndex?: number;
    /**
     * Stable JupyterLab UUID of the currently focused cell.
     * Used by the Smart Cell Context assembler to identify the focal cell.
     * Sent alongside activeCellIndex for backward compatibility.
     */
    activeCellId?: string;
    /**
     * Full (untruncated) plain-text output of the focal cell, sent at chat
     * request time.  The backend assembler injects this verbatim for the focal
     * cell instead of the 1 000-char stored summary output.
     */
    focalCellOutput?: string | null;
    /** Text currently selected by the user, if any. */
    selection?: TextSelection | null;
    /**
     * Live DataFrame schemas fetched from the kernel before the request.
     * Empty array when no DataFrames are in the kernel or detection is disabled.
     */
    dataframes?: DataFrameSchema[];
    /**
     * A specific output the user right-clicked and sent to the chat.
     * When present the LLM should focus its response on this output only.
     */
    selectedOutput?: {
        label: string;
        mimeType: string;
        imageData?: string;
        textData?: string;
        cellIndex: number;
        outputIndex: number;
    } | null;
    /**
     * Path of a non-notebook file (e.g. utils.py) that is currently active in
     * the main area. When set, the backend reads the file from disk and injects
     * its content into the LLM context instead of notebook cells.
     */
    fileContextPath?: string;
}
export interface ChatTurn {
    role: 'user' | 'assistant';
    content: string;
}
/**
 * A single @variable_name reference resolved from the chat message.
 * `summary` is the structured object returned by the kernel introspection
 * script — shape, dtypes, stats, sample rows, etc.
 */
export interface ResolvedVariable {
    /** Expression without the leading @, e.g. "df" or "df.head(10)" */
    expr: string;
    summary: Record<string, any>;
}
/**
 * Active image mode set by /no_figures or /resize(DIM).
 * Persisted in localStorage per notebook and included in every request until cleared.
 */
export type ImageMode = {
    mode: 'no_figures';
} | {
    mode: 'resize';
    dim: number;
};
export interface TaskRequest {
    message: string;
    notebookContext: NotebookContext;
    operationId?: string;
    chatHistory?: ChatTurn[];
    /**
     * Resolved @variable_ref objects attached to this request.
     * Populated by VariableResolver before the request is sent.
     */
    variables?: ResolvedVariable[];
    /**
     * When true, the backend forces cell_insertion_mode to "auto" regardless of
     * skill settings.  Used by the composite pipeline orchestrator so each step's
     * cells are applied immediately (the frontend shows one composite diff at end).
     */
    forceAutoMode?: boolean;
    /**
     * Slash command typed by the user (e.g. "/eda").
     * When present the backend loads the skill registered for that command
     * instead of using keyword-based Tier-2 detection.
     * The frontend strips this prefix from the message before including it here.
     */
    command?: string;
    /**
     * User-controlled cell-writing mode.
     * 'chat'  — never write cells, keep everything in chat (user preference wins)
     * 'auto'  — skill/heuristic decides (default behaviour)
     * 'doc'   — always write cells freely regardless of skill settings
     */
    cellMode?: 'chat' | 'agent';
    /**
     * When true, the backend injects sequential-thinking instructions so the LLM
     * reasons step-by-step before answering.  Thought tokens are streamed as
     * separate 'thought' SSE events and returned in response.thoughts.
     */
    thinkingEnabled?: boolean;
    /**
     * Active image mode for this request.
     * Set by /no_figures (strips all figures) or /resize(DIM) (downscales figures).
     * Persisted per notebook in localStorage; included on every request until changed.
     */
    imageMode?: ImageMode;
}
/** One step in a composite pipeline skill. */
export interface CompositeStep {
    /** Raw folder name of the child skill (e.g. "eda", "readme_gen") */
    skill_name: string;
    /** Prompt sent to the LLM for this step (variables already substituted) */
    prompt: string;
}
export interface OperationStep {
    type: 'insert' | 'modify' | 'delete' | 'run_cell' | 'reorder';
    /** Required for insert/modify/delete/run_cell. Not used for reorder. */
    cellIndex: number;
    /** For reorder only: cell short IDs in desired final order. */
    newOrder?: string[];
    cellType?: 'code' | 'markdown';
    content?: string;
    autoExecute?: boolean;
    description?: string;
}
export interface TaskResponse {
    operationId: string;
    steps: OperationStep[];
    requiresApproval: boolean;
    clarificationNeeded?: string | null;
    summary?: string;
    /** Non-fatal warnings the backend wants to surface to the user (e.g. vision not supported). */
    warnings?: string[];
    /**
     * True when the user's "Chat Only" toggle was active but the triggered skill
     * would normally have created cells.  Frontend uses this to show an advisory
     * note so the user knows they can switch mode to get the cells.
     */
    skillWantedCells?: boolean;
    /**
     * Drives frontend behaviour after receiving cell operations.
     * - "auto"      : insert immediately, no Accept/Undo confirmation
     * - "preview"   : insert with green border + Accept/Undo (default)
     * - "manual"    : advisory text in chat + individually applicable fix buttons
     * - "chat"      : advisory response only; chatResponse is populated, steps is empty
     * - "composite" : pipeline plan returned; compositePlan is populated
     */
    cellInsertionMode?: 'auto' | 'preview' | 'manual' | 'chat' | 'composite';
    /**
     * Complete reasoning trace produced when thinkingEnabled=true.
     * Contains the full <thinking> block content, plain text, ready for display.
     */
    thoughts?: string;
    /** Populated when cellInsertionMode === "chat" or "manual". Free-form markdown. */
    chatResponse?: string;
    /** Populated when cellInsertionMode === "composite". Ordered list of pipeline steps. */
    compositePlan?: CompositeStep[];
    /** Display name of the triggered composite skill. */
    compositeName?: string;
    /** Token usage for this response (input + output). */
    tokenUsage?: TokenUsage;
    /**
     * Set when the backend detected an image-too-large API error.
     * Value is "image_too_large" | "context_too_long" | "tool_use_not_supported".
     * Frontend renders the recovery prompt.
     */
    errorType?: string;
    /**
     * Populated when errorType === "tool_use_not_supported".
     */
    agentToolErrorDetails?: {
        provider: string;
        model: string;
        message: string;
        suggestion: string;
    };
    /**
     * LLM provider name when errorType === "image_too_large" (e.g. "anthropic", "openai").
     * Used by the frontend to show only the relevant resize option.
     */
    errorProvider?: string;
    /**
     * True when errorType === "context_too_long" and the context contained at
     * least one cell image.  Lets the frontend decide whether to offer the image
     * recovery options alongside the token-limit message.
     */
    errorHasImages?: boolean;
    /**
     * Populated when resize mode was active and at least one image was processed.
     * Frontend uses this to show a post-action confirmation notice.
     */
    imageResizeInfo?: {
        count: number;
        warnings: string[];
    };
}
export interface CompletionRequest {
    prefix: string;
    suffix: string;
    language: string;
    previousCells: Array<{
        index: number;
        type: string;
        source: string;
    }>;
}
export interface CompletionResult {
    suggestion: string;
    type: string;
    lines: string[];
    cached?: boolean;
}
export declare class APIClient {
    private baseUrl;
    constructor(baseUrl?: string);
    executeTask(request: TaskRequest): Promise<TaskResponse>;
    /**
     * Execute a task with optional SSE streaming for chat/advisory mode.
     *
     * - If the backend returns `text/event-stream` (chat mode), `onChunk` is
     *   called progressively with each text token, and the resolved promise
     *   contains the final `TaskResponse`.
     * - For all other modes the backend returns JSON; `onChunk` is never called
     *   and the resolved promise contains the complete response directly.
     */
    executeTaskStreaming(request: TaskRequest, onChunk: (text: string) => void, onProgress?: (text: string) => void, onJsonDelta?: (partial: string) => void, signal?: AbortSignal, onThought?: (text: string) => void): Promise<TaskResponse>;
    fetchCompletion(request: CompletionRequest): Promise<CompletionResult>;
    getSettings(): Promise<Record<string, {
        value: string;
        masked: boolean;
    } | string | boolean>>;
    getAgentSettings(notebookPath: string): Promise<Record<string, string>>;
    saveAgentSettings(notebookPath: string, settings: Record<string, string>): Promise<{
        status: string;
        path?: string;
        error?: string;
    }>;
    checkToolSupport(provider: string, model: string): Promise<{
        supported: boolean;
        reason: string | null;
    }>;
    saveSettings(settings: Record<string, string>): Promise<{
        status: string;
        updated?: string[];
        error?: string;
    }>;
    generateReport(notebookPath: string): Promise<{
        status: string;
        filename: string;
        relativePath: string;
        preview: string;
        stats: {
            total: number;
            markdown: number;
            code: number;
            with_outputs: number;
            errors: number;
        };
        imagesCount: number;
        wordCount: number;
    }>;
    getSkills(notebookPath?: string): Promise<{
        skills: Array<{
            name: string;
            enabled: boolean;
        }>;
        skills_dir: string;
    }>;
    refreshSkills(notebookPath?: string): Promise<{
        skills: Array<{
            name: string;
            enabled: boolean;
        }>;
        skills_dir: string;
    }>;
    getSkillContent(name: string, notebookPath?: string): Promise<{
        name: string;
        content: string;
        readme: string;
        enabled: boolean;
    }>;
    saveSkill(name: string, updates: {
        content?: string;
        readme?: string;
        enabled?: boolean;
    }, notebookPath?: string): Promise<{
        status: string;
    }>;
    getBundledSkills(notebookPath?: string): Promise<{
        bundled: Array<{
            name: string;
            command: string | null;
            description: string | null;
            imported: boolean;
        }>;
    }>;
    importBundledSkill(name: string, notebookPath?: string, overwrite?: boolean): Promise<{
        status: string;
        error?: string;
    }>;
    analyzeReproducibility(payload: {
        notebookPath: string;
        cells: CellInfo[];
    }): Promise<{
        issues: import('../reproducibility/types').ReproIssue[];
    }>;
    dismissReproIssue(payload: {
        notebookPath: string;
        issueId: string;
    }): Promise<{
        ok: boolean;
    }>;
    getReproIssues(notebookPath: string): Promise<{
        issues: import('../reproducibility/types').ReproIssue[];
    }>;
    /** Fetch all available slash commands (built-ins + skill commands). */
    getCommands(): Promise<SlashCommand[]>;
    /** Load all threads for a notebook. Returns empty chat file if none saved yet. */
    loadChatHistory(notebookPath: string): Promise<ChatFile>;
    /** Upsert a thread (create or update) and set it as the last active thread. */
    saveChatThread(notebookPath: string, thread: ChatThread): Promise<void>;
    /** Delete a thread by id. */
    deleteChatThread(notebookPath: string, threadId: string): Promise<void>;
    /**
     * Fire-and-forget: notify the backend that a cell was executed.
     * The backend builds a summary and persists it to the SummaryStore.
     * Returns immediately — never awaited in the call-site.
     */
    cellExecuted(payload: {
        cell_id: string;
        notebook_path: string;
        source: string;
        output: string | null;
        execution_count: number | null;
        had_error: boolean;
        error_text: string | null;
        cell_type: string;
        kernel_snapshot: Record<string, unknown>;
        tags: string[];
        execution_ms: number | null;
    }): void;
    /**
     * Fire-and-forget: notify the backend of a cell lifecycle event.
     * - deleted / restored: cell added to or removed from the notebook.
     * - tags_changed: tag list mutated (add, remove, or auto-tag); the full
     *   current tag list must be provided so the backend can patch in place.
     */
    cellLifecycle(payload: {
        cell_id: string;
        notebook_path: string;
        action: 'deleted' | 'restored' | 'tags_changed';
        tags?: string[];
    }): void;
    healthCheck(): Promise<Record<string, unknown>>;
    getMCPStatus(): Promise<{
        servers: Record<string, {
            status: 'connected' | 'connecting' | 'disconnected' | 'error' | 'disabled';
            error: string;
            tools: string[];
            config: {
                command: string;
                args: string[];
                env: Record<string, string>;
                disabled: boolean;
            };
        }>;
        totalTools: number;
        configRaw: string;
    }>;
    reloadMCP(): Promise<void>;
    addMCPServer(name: string, command: string, args: string[], env?: Record<string, string>): Promise<{
        status: string;
        error: string;
    }>;
    removeMCPServer(name: string): Promise<void>;
    /**
     * Fetch symbol names visible at the current cursor position.
     *
     * cellIds should be the ordered list of cell UUIDs from the notebook,
     * pre-sliced to cells at or before the active cell index.  The backend
     * returns only symbols defined in those cells (last definition wins).
     * Pass an empty array to fall back to all symbols in the notebook.
     * Returns [] on any error so callers never need to handle exceptions.
     */
    fetchSymbols(notebookPath: string, cellIds?: string[]): Promise<{
        name: string;
        vtype: string;
    }[]>;
    /**
     * Ask the backend to suggest tags for a single cell.
     * Uses the background-task LLM (or falls back to the chat provider).
     * Always resolves — returns { tags: [] } on any error.
     */
    autoTagCell(cellSource: string, cellOutput?: string | null): Promise<{
        tags: string[];
    }>;
    toggleMCPServer(name: string, disabled: boolean): Promise<void>;
    private getXSRFToken;
}
//# sourceMappingURL=client.d.ts.map
/**
 * API client for communicating with the Varys backend.
 */
export class APIClient {
    constructor(baseUrl) {
        this.baseUrl = baseUrl || '/varys';
    }
    async executeTask(request) {
        const response = await fetch(`${this.baseUrl}/task`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-XSRFToken': this.getXSRFToken()
            },
            body: JSON.stringify(request)
        });
        if (!response.ok) {
            const error = await response.text();
            throw new Error(`Task failed: ${response.status} - ${error}`);
        }
        return response.json();
    }
    /**
     * Execute a task with optional SSE streaming for chat/advisory mode.
     *
     * - If the backend returns `text/event-stream` (chat mode), `onChunk` is
     *   called progressively with each text token, and the resolved promise
     *   contains the final `TaskResponse`.
     * - For all other modes the backend returns JSON; `onChunk` is never called
     *   and the resolved promise contains the complete response directly.
     */
    async executeTaskStreaming(request, onChunk, onProgress, onJsonDelta, signal, onThought) {
        var _a, _b, _c, _d, _e, _f, _g, _h, _j;
        const response = await fetch(`${this.baseUrl}/task`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-XSRFToken': this.getXSRFToken()
            },
            body: JSON.stringify(Object.assign(Object.assign({}, request), { stream: true })),
            signal,
        });
        if (!response.ok) {
            const error = await response.text();
            throw new Error(`Task failed: ${response.status} - ${error}`);
        }
        const contentType = response.headers.get('content-type') || '';
        if (contentType.includes('text/event-stream') && response.body) {
            // Parse SSE stream
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            let lastDone = null;
            while (true) {
                const { done, value } = await reader.read();
                if (done)
                    break;
                buffer += decoder.decode(value, { stream: true });
                const parts = buffer.split('\n\n');
                buffer = (_a = parts.pop()) !== null && _a !== void 0 ? _a : '';
                for (const part of parts) {
                    if (!part.startsWith('data: '))
                        continue;
                    try {
                        const event = JSON.parse(part.slice(6));
                        if (event.type === 'chunk' && event.text) {
                            onChunk(event.text);
                        }
                        else if (event.type === 'thought' && event.text) {
                            // Reasoning token from sequential thinking — surface as progress
                            // indicator so the user knows the LLM is working.
                            onThought === null || onThought === void 0 ? void 0 : onThought(event.text);
                            onProgress === null || onProgress === void 0 ? void 0 : onProgress('🧠 Thinking...');
                        }
                        else if (event.type === 'progress' && event.text) {
                            onProgress === null || onProgress === void 0 ? void 0 : onProgress(event.text);
                        }
                        else if (event.type === 'json_delta' && event.text) {
                            onJsonDelta === null || onJsonDelta === void 0 ? void 0 : onJsonDelta(event.text);
                        }
                        else if (event.type === 'done') {
                            console.debug('[Varys] done event tokenUsage:', event.tokenUsage);
                            lastDone = event;
                        }
                        else if (event.type === 'image_too_large') {
                            // Image dimension error — return as structured response so the
                            // caller can render the recovery prompt instead of a plain error.
                            lastDone = {
                                operationId: 'image_error',
                                steps: [],
                                requiresApproval: false,
                                cellInsertionMode: 'chat',
                                errorType: 'image_too_large',
                                errorProvider: (_b = event.provider) !== null && _b !== void 0 ? _b : '',
                            };
                        }
                        else if (event.type === 'context_too_long') {
                            // Context budget exceeded — distinct from image-size errors.
                            lastDone = {
                                operationId: 'context_error',
                                steps: [],
                                requiresApproval: false,
                                cellInsertionMode: 'chat',
                                errorType: 'context_too_long',
                                errorHasImages: (_c = event.has_images) !== null && _c !== void 0 ? _c : false,
                            };
                        }
                        else if (event.type === 'agent_tool_error') {
                            lastDone = {
                                operationId: (_d = event.operationId) !== null && _d !== void 0 ? _d : 'tool_error',
                                steps: [],
                                requiresApproval: false,
                                cellInsertionMode: 'chat',
                                errorType: 'tool_use_not_supported',
                                agentToolErrorDetails: {
                                    provider: (_e = event.provider) !== null && _e !== void 0 ? _e : '',
                                    model: (_f = event.model) !== null && _f !== void 0 ? _f : '',
                                    message: (_g = event.message) !== null && _g !== void 0 ? _g : '',
                                    suggestion: (_h = event.suggestion) !== null && _h !== void 0 ? _h : '',
                                },
                            };
                        }
                        else if (event.type === 'error') {
                            // Surface API-level errors (billing, rate-limit, auth, etc.) as
                            // a real throw so the caller shows the actual message to the user
                            // rather than falling through to "Done — no cell changes".
                            const errMsg = (_j = event.error) !== null && _j !== void 0 ? _j : 'An API error occurred.';
                            throw new Error(errMsg);
                        }
                    }
                    catch (e) {
                        // Re-throw intentional API errors; silently drop JSON parse failures.
                        if (e instanceof Error)
                            throw e;
                    }
                }
            }
            return lastDone !== null && lastDone !== void 0 ? lastDone : {
                operationId: 'unknown',
                steps: [],
                requiresApproval: false,
                cellInsertionMode: 'chat',
            };
        }
        // Regular JSON response (non-chat modes ignore stream: true)
        return response.json();
    }
    async fetchCompletion(request) {
        const response = await fetch(`${this.baseUrl}/complete`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-XSRFToken': this.getXSRFToken()
            },
            body: JSON.stringify(request)
        });
        if (!response.ok) {
            throw new Error(`Completion failed: ${response.status}`);
        }
        return response.json();
    }
    async getSettings() {
        const response = await fetch(`${this.baseUrl}/settings`, {
            headers: { 'X-XSRFToken': this.getXSRFToken() }
        });
        if (!response.ok)
            throw new Error(`Failed to load settings: ${response.status}`);
        return response.json();
    }
    async getAgentSettings(notebookPath) {
        const url = `${this.baseUrl}/agent-settings?notebook_path=${encodeURIComponent(notebookPath)}`;
        const response = await fetch(url, {
            headers: { 'X-XSRFToken': this.getXSRFToken() }
        });
        if (!response.ok)
            throw new Error(`Failed to load agent settings: ${response.status}`);
        return response.json();
    }
    async saveAgentSettings(notebookPath, settings) {
        const response = await fetch(`${this.baseUrl}/agent-settings`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-XSRFToken': this.getXSRFToken()
            },
            body: JSON.stringify({ notebook_path: notebookPath, settings })
        });
        if (!response.ok)
            throw new Error(`Failed to save agent settings: ${response.status}`);
        return response.json();
    }
    async checkToolSupport(provider, model) {
        const url = `${this.baseUrl}/agent-settings/tool-support?provider=${encodeURIComponent(provider)}&model=${encodeURIComponent(model)}`;
        const response = await fetch(url, {
            headers: { 'X-XSRFToken': this.getXSRFToken() }
        });
        if (!response.ok)
            throw new Error(`Failed to check tool support: ${response.status}`);
        return response.json();
    }
    async saveSettings(settings) {
        const response = await fetch(`${this.baseUrl}/settings`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-XSRFToken': this.getXSRFToken()
            },
            body: JSON.stringify(settings)
        });
        if (!response.ok)
            throw new Error(`Failed to save settings: ${response.status}`);
        return response.json();
    }
    // ── Report generation ───────────────────────────────────────────────────
    async generateReport(notebookPath) {
        const response = await fetch(`${this.baseUrl}/report`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-XSRFToken': this.getXSRFToken()
            },
            body: JSON.stringify({ notebookPath })
        });
        if (!response.ok) {
            const err = await response.json().catch(() => ({ error: response.statusText }));
            throw new Error(err.error || `Report failed: ${response.status}`);
        }
        return response.json();
    }
    // ── Skills ──────────────────────────────────────────────────────────────
    async getSkills(notebookPath = '') {
        const qs = notebookPath ? `?notebookPath=${encodeURIComponent(notebookPath)}` : '';
        const response = await fetch(`${this.baseUrl}/skills${qs}`, {
            headers: { 'X-XSRFToken': this.getXSRFToken() }
        });
        if (!response.ok)
            throw new Error(`Failed to load skills: ${response.status}`);
        return response.json();
    }
    async refreshSkills(notebookPath = '') {
        const qs = notebookPath ? `?notebookPath=${encodeURIComponent(notebookPath)}` : '';
        const response = await fetch(`${this.baseUrl}/skills${qs}`, {
            method: 'POST',
            headers: { 'X-XSRFToken': this.getXSRFToken() }
        });
        if (!response.ok)
            throw new Error(`Failed to refresh skills: ${response.status}`);
        return response.json();
    }
    async getSkillContent(name, notebookPath = '') {
        const qs = notebookPath ? `?notebookPath=${encodeURIComponent(notebookPath)}` : '';
        const response = await fetch(`${this.baseUrl}/skills/${encodeURIComponent(name)}${qs}`, {
            headers: { 'X-XSRFToken': this.getXSRFToken() }
        });
        if (!response.ok)
            throw new Error(`Failed to load skill '${name}': ${response.status}`);
        return response.json();
    }
    async saveSkill(name, updates, notebookPath = '') {
        const qs = notebookPath ? `?notebookPath=${encodeURIComponent(notebookPath)}` : '';
        const response = await fetch(`${this.baseUrl}/skills/${encodeURIComponent(name)}${qs}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-XSRFToken': this.getXSRFToken()
            },
            body: JSON.stringify(updates)
        });
        if (!response.ok) {
            let msg = `Failed to save skill '${name}': ${response.status}`;
            try {
                const body = await response.json();
                if (body === null || body === void 0 ? void 0 : body.error)
                    msg = body.error;
            }
            catch ( /* ignore */_a) { /* ignore */ }
            throw new Error(msg);
        }
        return response.json();
    }
    // ── Bundled skill library ─────────────────────────────────────────────────
    async getBundledSkills(notebookPath = '') {
        const qs = notebookPath ? `?notebookPath=${encodeURIComponent(notebookPath)}` : '';
        const response = await fetch(`${this.baseUrl}/bundled-skills${qs}`, {
            headers: { 'X-XSRFToken': this.getXSRFToken() }
        });
        if (!response.ok)
            throw new Error(`Failed to load bundled skills: ${response.status}`);
        return response.json();
    }
    async importBundledSkill(name, notebookPath = '', overwrite = false) {
        const response = await fetch(`${this.baseUrl}/bundled-skills`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-XSRFToken': this.getXSRFToken()
            },
            body: JSON.stringify({ name, notebookPath, overwrite })
        });
        if (!response.ok)
            throw new Error(`Failed to import bundled skill '${name}': ${response.status}`);
        return response.json();
    }
    // ── Reproducibility Guardian ──────────────────────────────────────────────
    async analyzeReproducibility(payload) {
        const response = await fetch(`${this.baseUrl}/reproducibility/analyze`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-XSRFToken': this.getXSRFToken(),
            },
            body: JSON.stringify(payload),
        });
        if (!response.ok)
            throw new Error(`Reproducibility analysis failed: ${response.status}`);
        return response.json();
    }
    async dismissReproIssue(payload) {
        const response = await fetch(`${this.baseUrl}/reproducibility/dismiss`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-XSRFToken': this.getXSRFToken(),
            },
            body: JSON.stringify({ notebookPath: payload.notebookPath, issueId: payload.issueId }),
        });
        if (!response.ok)
            throw new Error(`Dismiss failed: ${response.status}`);
        return response.json();
    }
    async getReproIssues(notebookPath) {
        const response = await fetch(`${this.baseUrl}/reproducibility?notebook_path=${encodeURIComponent(notebookPath)}`, { headers: { 'X-XSRFToken': this.getXSRFToken() } });
        if (!response.ok)
            throw new Error(`Load issues failed: ${response.status}`);
        return response.json();
    }
    // ── Slash commands ─────────────────────────────────────────────────────────
    /** Fetch all available slash commands (built-ins + skill commands). */
    async getCommands() {
        var _a;
        try {
            const response = await fetch(`${this.baseUrl}/commands`, {
                headers: { 'X-XSRFToken': this.getXSRFToken() },
            });
            if (!response.ok)
                return [];
            const data = await response.json();
            return ((_a = data.commands) !== null && _a !== void 0 ? _a : []);
        }
        catch (_b) {
            return [];
        }
    }
    // ── Chat thread persistence ────────────────────────────────────────────────
    /** Load all threads for a notebook. Returns empty chat file if none saved yet. */
    async loadChatHistory(notebookPath) {
        var _a, _b, _c;
        const response = await fetch(`${this.baseUrl}/chat-history?notebook=${encodeURIComponent(notebookPath)}`, { headers: { 'X-XSRFToken': this.getXSRFToken() } });
        if (!response.ok)
            throw new Error(`loadChatHistory failed: ${response.status}`);
        const raw = await response.json();
        // normalise snake_case from Python → camelCase
        return {
            notebookPath: (_a = raw.notebook_path) !== null && _a !== void 0 ? _a : notebookPath,
            lastThreadId: (_b = raw.last_thread_id) !== null && _b !== void 0 ? _b : null,
            threads: ((_c = raw.threads) !== null && _c !== void 0 ? _c : []).map((t) => {
                var _a, _b, _c, _d, _e;
                return ({
                    id: t.id,
                    name: t.name,
                    createdAt: (_a = t.created_at) !== null && _a !== void 0 ? _a : '',
                    updatedAt: (_b = t.updated_at) !== null && _b !== void 0 ? _b : '',
                    messages: ((_c = t.messages) !== null && _c !== void 0 ? _c : []),
                    tokenUsage: t.token_usage
                        ? { input: (_d = t.token_usage.input) !== null && _d !== void 0 ? _d : 0,
                            output: (_e = t.token_usage.output) !== null && _e !== void 0 ? _e : 0 }
                        : undefined,
                    notebookAware: t.notebook_aware !== undefined ? Boolean(t.notebook_aware) : undefined,
                });
            }),
        };
    }
    /** Upsert a thread (create or update) and set it as the last active thread. */
    async saveChatThread(notebookPath, thread) {
        const response = await fetch(`${this.baseUrl}/chat-history`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-XSRFToken': this.getXSRFToken(),
            },
            body: JSON.stringify({
                notebookPath,
                thread: Object.assign(Object.assign({ id: thread.id, name: thread.name, created_at: thread.createdAt, messages: thread.messages }, (thread.tokenUsage ? { token_usage: thread.tokenUsage } : {})), (thread.notebookAware !== undefined ? { notebook_aware: thread.notebookAware } : {})),
            }),
        });
        if (!response.ok)
            throw new Error(`saveChatThread failed: ${response.status}`);
    }
    /** Delete a thread by id. */
    async deleteChatThread(notebookPath, threadId) {
        const response = await fetch(`${this.baseUrl}/chat-history?notebook=${encodeURIComponent(notebookPath)}&threadId=${encodeURIComponent(threadId)}`, {
            method: 'DELETE',
            headers: { 'X-XSRFToken': this.getXSRFToken() },
        });
        if (!response.ok)
            throw new Error(`deleteChatThread failed: ${response.status}`);
    }
    // ── Smart Cell Context ─────────────────────────────────────────────────
    /**
     * Fire-and-forget: notify the backend that a cell was executed.
     * The backend builds a summary and persists it to the SummaryStore.
     * Returns immediately — never awaited in the call-site.
     */
    cellExecuted(payload) {
        fetch(`${this.baseUrl}/cell-executed`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-XSRFToken': this.getXSRFToken() },
            body: JSON.stringify(payload),
        }).catch(() => { });
    }
    /**
     * Fire-and-forget: notify the backend of a cell lifecycle event.
     * - deleted / restored: cell added to or removed from the notebook.
     * - tags_changed: tag list mutated (add, remove, or auto-tag); the full
     *   current tag list must be provided so the backend can patch in place.
     */
    cellLifecycle(payload) {
        fetch(`${this.baseUrl}/cell-lifecycle`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-XSRFToken': this.getXSRFToken() },
            body: JSON.stringify(payload),
        }).catch(() => { });
    }
    async healthCheck() {
        try {
            const response = await fetch(`${this.baseUrl}/health`);
            if (!response.ok)
                return { status: 'error' };
            return response.json();
        }
        catch (_a) {
            return { status: 'error' };
        }
    }
    // ── RAG knowledge-base ─────────────────────────────────────────────────
    /**
     * Index a file or directory into the local knowledge base.
     * Returns an EventSource-compatible response (SSE).
     * Calls onProgress(msg) for each progress event, resolves with the
     * final result object on "done".
     */
    async ragLearn(path, onProgress, force = false, notebookPath = '') {
        var _a, _b, _c;
        const response = await fetch(`${this.baseUrl}/rag/learn`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-XSRFToken': this.getXSRFToken(),
            },
            body: JSON.stringify({ path, force, notebookPath }),
        });
        if (!response.ok) {
            throw new Error(`RAG learn failed: ${response.status}`);
        }
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let result = null;
        while (true) {
            const { done, value } = await reader.read();
            if (done)
                break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = (_a = lines.pop()) !== null && _a !== void 0 ? _a : '';
            for (const line of lines) {
                if (!line.startsWith('data: '))
                    continue;
                try {
                    const evt = JSON.parse(line.slice(6));
                    if (evt.type === 'progress') {
                        onProgress((_b = evt.text) !== null && _b !== void 0 ? _b : '');
                    }
                    else if (evt.type === 'done') {
                        result = evt.result;
                    }
                    else if (evt.type === 'error') {
                        throw new Error((_c = evt.text) !== null && _c !== void 0 ? _c : 'RAG learn error');
                    }
                }
                catch (e) {
                    if (e instanceof Error && e.message.startsWith('RAG'))
                        throw e;
                }
            }
        }
        return result !== null && result !== void 0 ? result : { total: 0, processed: 0, skipped: 0, errors: [] };
    }
    /** Return a summary of the current knowledge-base index. */
    async ragStatus(notebookPath = '') {
        const qs = notebookPath ? `?notebookPath=${encodeURIComponent(notebookPath)}` : '';
        const response = await fetch(`${this.baseUrl}/rag/status${qs}`, {
            headers: { 'X-XSRFToken': this.getXSRFToken() },
        });
        if (!response.ok)
            throw new Error(`RAG status failed: ${response.status}`);
        return response.json();
    }
    /** Remove a specific file from the knowledge-base index. */
    async ragForget(path, notebookPath = '') {
        const response = await fetch(`${this.baseUrl}/rag/forget`, {
            method: 'DELETE',
            headers: {
                'Content-Type': 'application/json',
                'X-XSRFToken': this.getXSRFToken(),
            },
            body: JSON.stringify({ path, notebookPath }),
        });
        if (!response.ok)
            throw new Error(`RAG forget failed: ${response.status}`);
        return response.json();
    }
    // ── MCP server management ──────────────────────────────────────────────
    async getMCPStatus() {
        const r = await fetch(`${this.baseUrl}/mcp`, {
            headers: { 'X-XSRFToken': this.getXSRFToken() },
        });
        if (!r.ok)
            throw new Error(`getMCPStatus failed: ${r.status}`);
        return r.json();
    }
    async reloadMCP() {
        const r = await fetch(`${this.baseUrl}/mcp/reload`, {
            method: 'POST',
            headers: { 'X-XSRFToken': this.getXSRFToken() },
        });
        if (!r.ok)
            throw new Error(`reloadMCP failed: ${r.status}`);
    }
    async addMCPServer(name, command, args, env = {}) {
        const r = await fetch(`${this.baseUrl}/mcp/servers`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-XSRFToken': this.getXSRFToken() },
            body: JSON.stringify({ name, command, args, env }),
        });
        if (!r.ok)
            throw new Error(`addMCPServer failed: ${r.status}`);
        return r.json();
    }
    async removeMCPServer(name) {
        const r = await fetch(`${this.baseUrl}/mcp/servers`, {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json', 'X-XSRFToken': this.getXSRFToken() },
            body: JSON.stringify({ name }),
        });
        if (!r.ok)
            throw new Error(`removeMCPServer failed: ${r.status}`);
    }
    /**
     * Fetch symbol names visible at the current cursor position.
     *
     * cellIds should be the ordered list of cell UUIDs from the notebook,
     * pre-sliced to cells at or before the active cell index.  The backend
     * returns only symbols defined in those cells (last definition wins).
     * Pass an empty array to fall back to all symbols in the notebook.
     * Returns [] on any error so callers never need to handle exceptions.
     */
    async fetchSymbols(notebookPath, cellIds = []) {
        try {
            const r = await fetch(`${this.baseUrl}/symbols`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-XSRFToken': this.getXSRFToken(),
                },
                body: JSON.stringify({ notebook_path: notebookPath, cell_ids: cellIds }),
            });
            if (!r.ok)
                return [];
            const data = await r.json();
            return Array.isArray(data.symbols) ? data.symbols : [];
        }
        catch (_a) {
            return [];
        }
    }
    /**
     * Ask the backend to suggest tags for a single cell.
     * Uses the simple-tasks LLM (or falls back to the chat provider).
     * Always resolves — returns { tags: [] } on any error.
     */
    async autoTagCell(cellSource, cellOutput) {
        try {
            const r = await fetch(`${this.baseUrl}/auto-tag`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-XSRFToken': this.getXSRFToken(),
                },
                body: JSON.stringify({ cellSource, cellOutput: cellOutput !== null && cellOutput !== void 0 ? cellOutput : null }),
            });
            if (!r.ok)
                return { tags: [] };
            return r.json();
        }
        catch (_a) {
            return { tags: [] };
        }
    }
    async toggleMCPServer(name, disabled) {
        const r = await fetch(`${this.baseUrl}/mcp/servers`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json', 'X-XSRFToken': this.getXSRFToken() },
            body: JSON.stringify({ name, disabled }),
        });
        if (!r.ok)
            throw new Error(`toggleMCPServer failed: ${r.status}`);
    }
    getXSRFToken() {
        const cookies = document.cookie.split(';');
        for (const cookie of cookies) {
            const trimmed = cookie.trim();
            const sep = trimmed.indexOf('=');
            if (sep === -1)
                continue;
            const name = trimmed.slice(0, sep);
            if (name === '_xsrf') {
                return decodeURIComponent(trimmed.slice(sep + 1));
            }
        }
        return '';
    }
}

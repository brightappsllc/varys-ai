# Varys — Complete Capabilities Reference

> Version: dev0.7.0 | Last updated: March 2026

---

## Table of Contents

1. [What is Varys?](#1-what-is-varys)
2. [Architecture Overview](#2-architecture-overview)
3. [LLM Providers](#3-llm-providers)
4. [Chat Interface](#4-chat-interface)
5. [Context Assembly — How Varys Understands Your Notebook](#5-context-assembly)
6. [Chat Mode](#6-chat-mode)
7. [Agent Mode](#7-agent-mode)
8. [File Agent](#8-file-agent)
9. [Skills System](#9-skills-system)
10. [Bundled Skills](#10-bundled-skills)
11. [Reproducibility Guardian](#11-reproducibility-guardian)
12. [Long-Term Memory & Preference Inference](#12-long-term-memory--preference-inference)
13. [RAG — Knowledge Base](#13-rag--knowledge-base)
14. [MCP — Model Context Protocol](#14-mcp--model-context-protocol)
15. [Inline Code Completion](#15-inline-code-completion)
16. [Cell Tags & Auto-Tagging](#16-cell-tags--auto-tagging)
17. [Thread Management](#17-thread-management)
18. [Token Usage Tracking](#18-token-usage-tracking)
19. [Settings & Configuration](#19-settings--configuration)
20. [Remote Kernel Support (EC2)](#20-remote-kernel-support-ec2)

---

## 1. What is Varys?

Varys is a JupyterLab extension that embeds an AI-powered data science assistant directly into the notebook environment. Unlike generic AI chat tools, Varys has deep awareness of the notebook it is running inside: it sees the cells, their outputs, the variables alive in the kernel, the execution order, and the history of every edit. It can answer questions, generate and insert code, run multi-step agentic workflows, analyze reproducibility problems, learn from a project's knowledge base, and maintain long-term memory of a user's coding preferences — all without leaving JupyterLab.

The core philosophy is that the assistant should understand context automatically. You should not have to copy-paste code into a chat window or explain what `df` is. Varys already knows.

---

## 2. Architecture Overview

Varys has two main layers that communicate over HTTP.

**Backend (Python, Jupyter Server extension):** A set of Tornado handlers registered under the `/varys` URL prefix on the JupyterLab server process. These handlers receive requests from the frontend, call LLM providers, read and write the notebook's `.jupyter-assistant/` directory, interact with the kernel snapshot, and return responses. All handlers are authenticated via the standard Jupyter token mechanism.

**Frontend (TypeScript / React):** A JupyterLab sidebar panel built with React. It listens to JupyterLab events (cell execution, active cell changes, notebook switching, file focus), builds rich context objects, and sends them to the backend. The sidebar renders the chat UI, diff views, thread management, reproducibility panel, settings, and all other interactive elements.

**Per-notebook persistence:** Each notebook keeps its own `.jupyter-assistant/` folder in the same directory. This folder stores chat histories (one JSON file per thread), the cell summary store, the vector knowledge base, long-term preferences, reproducibility issue records, and assembler scoring logs. There is no shared global state across different notebooks.

---

## 3. LLM Providers

Varys supports seven distinct LLM provider backends, configured via a `.env` file (typically `~/.jupyter/varys.env`). All providers are hot-reloadable — changing the settings file takes effect without restarting the JupyterLab server.

**Anthropic** uses the Claude family of models. Extended thinking (longer internal reasoning chains) can be enabled or disabled per deployment. Prompt caching can be turned on for cost reduction on repeated context.

**OpenAI** uses the GPT family and any OpenAI-compatible API.

**Google** supports Gemini models via API key or service-account credentials. Thinking budget and extended thinking flags can be set independently.

**AWS Bedrock** supports models hosted on Amazon Bedrock, including multi-region inference profiles. Authentication can use a named AWS profile, static credentials, or auto-refresh. Per-task model selection and maximum token budget are configurable.

**Azure OpenAI** connects to an Azure-hosted OpenAI deployment. Requires the endpoint URL, API key, and API version in addition to model names.

**Ollama** connects to a locally-running Ollama server. The URL is configurable so it works with Ollama on localhost or on a remote machine. Varys can query available models from the Ollama server and report whether Ollama is installed and running.

**OpenRouter** routes requests through the OpenRouter aggregator, which provides access to dozens of models from multiple providers through a single API key.

Each provider is selected **per task role**. There are four independent role slots:

- `DS_CHAT_PROVIDER` — the main conversational model used in the chat sidebar
- `DS_COMPLETION_PROVIDER` — the model used for inline tab-completion suggestions
- `DS_SIMPLE_TASKS_PROVIDER` — a lighter, faster model for quick internal tasks such as auto-tagging, markdown summarization, and preference inference
- `DS_EMBED_PROVIDER` — the model used to generate embeddings for the RAG knowledge base

This means you can, for example, run Claude Sonnet for chat, use a local Ollama model for completions to save cost, and use Gemini Flash for simple tasks.

---

## 4. Chat Interface

The Varys sidebar is a full-featured chat UI rendered as a JupyterLab panel. It contains the following structural elements from top to bottom:

A **header bar** with the Varys logo, a theme toggle (dark/light mode), a reproducibility shield button, a help button, and a settings gear button.

A **thread bar** directly below the header, showing named thread pills for quick switching. Up to four threads are shown as clickable tabs; additional threads overflow into a `···` menu that provides full management (rename, duplicate, delete, create new). The thread bar also hosts the reproducibility issue count badge.

The **message list**, which is the main scrollable area. Messages alternate between user bubbles and assistant bubbles. Code blocks inside assistant responses have one-click copy buttons. Reasoning/thinking content from models that support extended thinking is shown in collapsible "Thought" bubbles. Diff views (accept/reject blocks) appear inline within assistant messages when Agent mode produces edits.

A **mode selector and input area** at the bottom. The mode dropdown switches between Chat and Agent. The input field is a multi-line textarea with drag-and-drop support for adding cell context chips. The send button triggers the request.

---

## 5. Context Assembly

Every time the user sends a message, Varys assembles a rich context string from the notebook and sends it to the LLM. This is one of Varys's most important capabilities — it does this automatically, without the user needing to paste code.

**Cell summaries:** Varys maintains a `summary_store.json` file that records a structured summary for every cell that has been executed. Each entry records the cell type, a source snippet, cell output (truncated to 1,000 characters), the list of variable names defined by the cell, the list of variable names consumed (loaded) from outside the cell, actual runtime values for scalars and short collections, human-readable type descriptions for DataFrames and arrays, the kernel execution counter, whether the cell produced an error and what the error was, whether the cell is import-only, and the cell's metadata tags.

**Cell scoring:** Before sending cells to the LLM, Varys scores each cell for relevance to the current query using a multi-signal weighted scorer. The signals are:
- A strong boost for cells that define variables explicitly mentioned with `@variable` in the query (proportional to specificity)
- A recency signal based on execution count (higher execution count = more recent = more relevant)
- An error bonus for cells that produced an error on their last run
- A fan-out bonus for cells whose defined symbols are consumed by many downstream cells
- A small import-cell penalty (low information density)
- A dead-symbol penalty for cells whose defined names are no longer alive in the kernel

Scores are normalized to a 0–1 range. Cells below the pruning threshold are excluded from the context to stay within the token budget, unless doing so would leave too few cells.

**Focal cell:** The cell that anchors the context. Determined in priority order: an explicit `#N` reference in the query, the currently focused cell in JupyterLab, a cell that defines a variable referenced with `@name` in the query. The focal cell always appears in full (including full output) and is never pruned. Non-focal cells appear as compact summaries.

**Context chips:** When a user drags a cell reference or variable into the chat input, a context chip is attached to the message. The chip label appears in the input box, and the corresponding cell content is injected verbatim into the message.

**Agent mode context:** In agent mode the visible-window cutoff is removed and all cells are scored and sent. This is required so the agent has accurate cell index arithmetic for multi-cell plans.

**`@variable` references:** The user can type `@varname` in any message to anchor the context search to the cell that most recently defined that variable. Varys resolves the reference to the defining cell and boosts it in the score.

**`#N` references:** The user can refer to `#3` or `cell 3` to explicitly target the cell at position 3 in the notebook. Varys resolves this to the stable cell UUID and pins it as the focal cell.

**Kernel variable snapshot:** When a cell is executed, the frontend captures a live snapshot of the kernel namespace and sends it to the backend. This snapshot records type, shape (for arrays/DataFrames), column names, dtypes, and sample values (for scalars, short strings, small lists and dicts). This information is stored in the summary store and used to populate `symbol_values` and `symbol_types` in the cell summaries that are sent to the LLM.

---

## 6. Chat Mode

In Chat mode, Varys acts as a knowledgeable collaborator. The user asks questions or requests analysis, and Varys responds with text, explanations, code suggestions, and markdown. No edits are made to the notebook automatically.

The conversation is aware of the full notebook context as described above. The user can ask "what does `df` look like?" or "why is cell 5 throwing a KeyError?" or "explain what the correlation heatmap is telling me" and Varys will answer with reference to the actual cell content and output.

Each message is sent with a system prompt that includes the assembled cell context, kernel variable information, any retrieved RAG chunks (if the knowledge base has been populated), long-term user preferences inferred from past notebooks, and any MCP tool results.

Responses stream token by token into the chat window to avoid the appearance of stalling. Reasoning tokens from extended-thinking models stream into a separate collapsible "Thought" bubble in real time.

---

## 7. Agent Mode

Agent mode is the most powerful Varys capability. Instead of just replying with text, the agent plans and executes a multi-step workflow that directly edits the notebook.

**How it works:** The user describes a task ("run EDA on this dataframe", "add error handling to the model training cell", "insert a unit test for the `clean_data` function"). Varys calls the LLM with a structured JSON tool schema. The model returns a **plan** — an ordered list of operations, each specifying whether to insert a new cell, modify an existing cell, delete a cell, or run a cell. Each operation includes the full source code and whether the cell should auto-execute after insertion.

**Diff view:** Before any changes are committed to the notebook, the plan is shown as an interactive diff view in the chat window. For each cell that would be modified, the diff shows the old source and the new source side by side with line-level additions and deletions highlighted. The user sees `✓ Accept` and `↩ Reject` buttons. Accepting applies all changes; rejecting restores the cells to their original state. Resolved diffs collapse to a `✓ Changes accepted N cells +X / −Y` summary strip.

**Auto-execute:** Individual cells in a plan can be marked `autoExecute: true`. When the user accepts a plan that contains auto-execute cells, those cells run immediately in sequence (respecting the notebook kernel). This is used by skills like EDA where all analysis cells are safe to run immediately.

**Multi-cell plans:** Agent mode supports coordinated operations across many cells in a single plan — for example, inserting a markdown heading before each analysis section and inserting code cells after each heading, all in one acceptance step.

**`requiresApproval: false`:** Skills can declare that a plan is safe to run without user review (for fully read-only operations). In this case the plan executes immediately without showing the diff review UI.

**Tool support detection:** The agent automatically checks whether the active LLM supports structured tool use. If the model does not support tool calling, the agent falls back to a text-based extraction mode.

---

## 8. File Agent

The File Agent is a separate agent mode focused on **project files on disk** (`.py`, `.md`, `.yaml`, `.toml`, `.txt`, etc.) rather than notebook cells. It is activated via the `/file_agent` slash command.

The File Agent has access to a set of filesystem tools: `Glob` (find files by pattern), `Grep` (search file contents), `Read` (read a file), `Write` (write a new file), and `Edit` (make targeted changes to an existing file). Bash execution is off by default and must be explicitly enabled in settings.

A typical File Agent session proceeds as: the user describes a task ("add type annotations to `utils.py`"), the agent uses Glob to locate the file, uses Read to read its contents, formulates edits, and presents the changes as a staged diff. The user reviews and approves.

Two companion commands provide read-only modes: `/file_agent_find` for searching and exploring the project (no writes), and `/file_agent_save` for generating and writing a new file that does not yet exist (for example, creating a `README.md`).

The File Agent works from the directory of the currently focused file, with `working_dir` set accordingly. It can be invoked from a notebook to edit Python files in the project — for example, to refactor a utility module while keeping the notebook open.

---

## 9. Skills System

Skills are reusable, parameterized workflows defined in Markdown files. When a user types a slash command (such as `/eda` or `/plot`), Varys looks up the matching skill, reads its `SKILL.md` file, and injects the skill's instructions into the system prompt for that turn. The LLM then follows the skill's specific rules for how to structure the response, what tools to use, and how to format the output.

**Skill discovery:** Skills are loaded from two locations:
1. **Bundled skills** — shipped with Varys, always available
2. **User skills** — stored in `~/.jupyter/skills/`, making them available across all projects and notebooks without any per-project setup. Adding a skill once makes it globally available.

Skills with a `command:` field in their front matter register as slash commands. When new skills are added, the command list updates automatically.

**Skill structure:** Each `SKILL.md` begins with a YAML front matter block that declares the command name, a short description, keywords that trigger auto-detection, and the cell insertion mode. The body of the skill file is free-form Markdown that the LLM reads as instructions.

**Auto-detection:** Skills can declare keywords. If the user's message matches the keywords without typing a slash command, Varys automatically activates the skill.

---

## 10. Bundled Skills

Varys ships with seventeen bundled skills covering the full data science workflow.

**`/eda` — Exploratory Data Analysis:** Generates a minimum of six cells covering a markdown title, imports, `df.info()`/`df.describe()`/null counts, numerical distributions with histograms and box plots, a correlation heatmap, and categorical analysis with bar plots. A seventh time-series plot cell is added if datetime columns are present. All cells auto-execute. Each analysis section is strictly one cell — never combined.

**`/plot` — Single Visualization:** Generates one publication-quality visualization cell. Detects the intended chart type (histogram, line, bar, scatter, heatmap, and others) from the user's description. Library preference: Plotly Express first, then Seaborn, then Matplotlib; never mixed in one cell. If the user asks to analyze an existing chart rather than create a new one, it responds in the chat without producing code.

**`/load-dataframe` — Load DataFrame:** Generates a cell to load data from a file path or source detected in the notebook context, with appropriate error handling. Inserts at the cursor position.

**`/notebook-annotation` — Add Section Headers:** Annotates a notebook with structured markdown section headings. Inserts one markdown cell before each major section, calculating correct cell indices accounting for cumulative insertion shifts.

**`/notebook-code-review` — Code Review:** Performs a code quality review of the notebook: style, naming, efficiency, error handling, and redundancy. Does not cover data science methodology (that is `/ds-review`).

**`/ds-review` — Data Science Review:** Performs a methodology review focused on data leakage, reproducibility problems, train/test issues, cross-validation correctness, hypothesis testing assumptions, time series pitfalls, data quality, and feature engineering soundness. Issues are classified on a severity scale from Critical to Informational. Can produce fix suggestions that reference the Reproducibility Guardian panel.

**`/notebook-report-generation` — Generate Report:** Converts notebook content into a structured prose report with narrative sections, figures, and findings.

**`/generate-notebook` — Generate Notebook:** Creates a new notebook from scratch given a description of the goal, dataset, and analysis requirements.

**`/notebook_to_module` — Convert to Module:** Refactors notebook code into a proper Python module structure (`.py` files with functions, classes, and a clean public API), using the File Agent tools to write the files to disk.

**`/readme_gen` — Generate README:** Generates a `README.md` for the project based on the notebook contents, inferring purpose, dependencies, usage instructions, and outputs. Always inserts as a new file at position 0.

**`/unittest` — Generate Unit Tests:** Generates pytest-style unit tests for functions defined in the notebook. Inserts the test code one position after the source cell and adds an assertion-style assertion framework.

**`/code_style` — Code Style Improvements:** Applies PEP 8 formatting, better naming, type hints, and pandas/numpy best practices to the selected cells.

**`/safe_operations` — Safe Operations Audit:** Reviews cells for potential side effects (file writes, in-place mutations, irreversible operations) and wraps them with guards, confirmations, or backups.

**`/reorganize_cell` — Cell Reorganization:** Rearranges notebook cells to improve logical flow — groups imports, moves setup cells up, reorders analysis cells.

**`/dataframe-context` — DataFrame Context Injection:** Injects a rich description of the active DataFrame (schema, dtypes, sample rows, statistics) as a context chip so the LLM has full DataFrame awareness for the next question.

**`/file_agent` — File Agent:** (See Section 8.)

**`varys` persona skill** — Not a slash command. This skill defines Varys's base persona and behavioral standards: expert data scientist and Python engineer, rigorous on statistical claims, honest about uncertainty, business-aware, and following PEP 8 and idiomatic pandas/numpy practices.

---

## 11. Reproducibility Guardian

The Reproducibility Guardian is a notebook analysis panel that detects and helps fix reproducibility problems. It is accessed via the shield icon (🛡️) in the thread bar.

**How it works:** The user clicks "Analyze" to trigger a full analysis of the current notebook. The backend runs a set of rule-based checks against the cell source code and execution metadata, then stores the results in a SQLite database under `.jupyter-assistant/`. Issues persist across sessions; dismissed issues are recorded and not shown again.

**Automatic triggering:** The Guardian also runs automatically when cells are executed, catching new issues as they arise.

**Issue structure:** Each issue has a severity (Critical, Warning, or Info), a title, a message describing what was found, an explanation of why it matters for reproducibility, a suggestion for how to fix it, and optionally a `fix_code` field containing the corrected cell source. Issues reference the cell index where they were found.

**Fix workflow:** Issues with fix code show a `⚡ Fix` button. Clicking it applies the fix directly to the cell using the agent's cell editor. The issue is then dismissed automatically.

**Issue count badge:** The number of active issues appears as a red badge on the shield button in the thread bar, updating after every analysis run.

**Rules — Critical:**

- **Variable used before definition:** Detects cells that consume a variable that is not defined in any preceding cell. On a clean kernel restart this will raise a `NameError`.

- **Undefined before definition (cross-cell):** Notebook-wide check that a symbol is consumed before any cell that defines it.

- **Cells executed out of order:** Compares execution counts across cells. If the counts are not monotonically non-decreasing from top to bottom, cells were run out of order and the notebook will behave differently on a clean run.

- **Hardcoded absolute paths:** Detects strings matching local machine paths (e.g., `/home/username/data/file.csv`). These paths break on any other machine or cloud environment.

- **CUDA without CPU fallback:** Detects code that calls `.cuda()` or sends tensors to GPU without a `torch.device` fallback check.

**Rules — Warning:**

- **`train_test_split` without `random_state`:** Every call to `sklearn.model_selection.train_test_split` should specify `random_state` so the split is reproducible across runs.

- **Sklearn/ML estimators without `random_state`:** Stochastic estimators (Random Forest, Gradient Boosting, MLP, SVM with certain kernels, and many others) that do not set `random_state` produce different results on every run. The fix suggestion adds `random_state=42`.

- **NumPy random without seed:** If any cell uses `np.random` functions but no cell sets `np.random.seed()`, results vary between runs.

- **Python `random` without seed:** Same for the standard library `random` module.

- **Unpinned packages:** `pip install` calls without version pins mean the installed version can change and break the notebook.

**Rules — Info:**

- **In-place variable transformation chain:** When the same DataFrame variable (`df`) is mutated across three or more cells (filtered, columns added/removed, etc.) without being saved to intermediate variables, it becomes hard to debug and re-run partial sections. Suggests using named intermediate variables.

---

## 12. Long-Term Memory & Preference Inference

Varys builds a long-term model of a user's coding patterns by observing notebook cell executions over time. This memory system has two phases: pattern detection and preference inference.

**Pattern detection:** After every ten new cell versions are recorded in the summary store (configurable threshold), an inference pipeline runs in the background. It analyzes the stored summaries looking for recurring patterns:

- **Symbol value consistency:** If the same variable name consistently holds the same value across three or more distinct cells (for example, a `SEED = 42` constant used everywhere), this is detected as a stable preference.

- **Import frequency:** If the same library alias (e.g., `pd`, `np`, `sns`) appears in three or more distinct import cells across different notebooks, it is recorded as a library preference.

**Preference generation:** Detected patterns are sent to the Simple Tasks LLM model with a prompt asking it to generate structured preference entries. Each preference has a type (`coding_style` or `library`), content (a natural language description), and keywords for matching. If the LLM is unavailable, deterministic template-based preferences are generated instead. Preferences are stored in a `PreferenceStore` at the project scope.

**Legacy migration:** The system can migrate older text-based `preferences.md` files from earlier Varys versions into the structured preference format automatically using the Simple Tasks model, with a fallback to a synchronous text-parsing approach.

**Usage:** Preferences are injected into the system prompt for every chat message, so over time the assistant starts to reflect the user's actual patterns — using `pd.read_csv`, `sns.set_style`, `random_state=42`, etc., without being told.

---

## 13. RAG — Knowledge Base

Varys can index a project knowledge base and retrieve relevant chunks to inject into the LLM context. This enables Varys to answer questions about project-specific documentation, data dictionaries, domain knowledge, business rules, or any other text content.

**Knowledge base location:** Documents are placed in the `.jupyter-assistant/knowledge/` folder. Any text files, Markdown, PDFs, or CSVs placed there can be indexed.

**Indexing:** The user triggers indexing via the `/varys/rag/learn` endpoint (or from the UI). The indexer reads all eligible files, splits them into chunks, generates embeddings using the configured embed provider, and stores the vectors in a ChromaDB collection scoped to that notebook's base directory. Progress is streamed back as server-sent events.

**Retrieval:** On every chat message, the user's query is embedded and a top-k similarity search retrieves the most relevant chunks. By default `k=5`. Retrieved chunks are prepended to the LLM context. The `/varys/rag/ask` endpoint supports retrieval-only queries for debugging.

**Per-notebook isolation:** Each notebook's RAG index lives in its own base directory under `.jupyter-assistant/`. There is no cross-notebook leakage.

**Forgetting:** Individual files can be removed from the index via the `/varys/rag/forget` endpoint, which deletes their chunks from the vector store without affecting other indexed files.

**Status:** The `/varys/rag/status` endpoint reports whether the index is available, the total chunk count, and the list of indexed files.

---

## 14. MCP — Model Context Protocol

Varys includes an MCP (Model Context Protocol) client that connects to external MCP servers. MCP servers expose tools to the LLM — for example, a database query tool, a web search tool, or a custom business API.

**Configuration:** MCP servers are registered by name with a command, optional arguments, and optional environment variables. The MCP manager starts all registered servers on JupyterLab launch.

**Dynamic management:** Servers can be added, toggled (enabled/disabled), removed, and reloaded at runtime via the `/varys/mcp/servers` and `/varys/mcp/reload` endpoints without restarting JupyterLab.

**Tool exposure:** Registered tools from all active MCP servers are available to the LLM during chat sessions. The `/varys/mcp` status endpoint lists all servers and their tool counts.

---

## 15. Inline Code Completion

Varys provides inline tab-completion suggestions in JupyterLab notebook cells, similar to GitHub Copilot's ghost-text completions.

The completion system uses a separate provider and model from the main chat (configured via `DS_COMPLETION_PROVIDER`). When the user pauses typing in a code cell, Varys sends the preceding code context to the completion model and receives a suggested continuation. The suggestion appears as greyed-out ghost text; pressing Tab accepts it.

Inline completion is enabled or disabled via the settings panel. `COMPLETION_MAX_TOKENS` controls the maximum length of suggestions.

The completion system registers as a JupyterLab inline completion provider via the standard JupyterLab plugin API, so it integrates cleanly with the editor's existing completion infrastructure.

---

## 16. Cell Tags & Auto-Tagging

JupyterLab cells support metadata tags. Varys integrates with this system in two ways.

**Manual tags:** Tags set via JupyterLab's built-in tag UI are read by Varys and stored in the summary store (without triggering a new version bump, since tags are independent of cell source). The `patch_tags()` method in the summary store allows tag updates in-place.

**Auto-tagging:** The `/varys/auto-tag` endpoint accepts a cell's source code and optional output and returns up to three suggested tags from a predefined library. The tag library is defined in `varys/tags/library.yaml`. Tags are categorized by topic. The Simple Tasks LLM model is used to pick appropriate tags from the eligible set only — no hallucinated tags can be returned.

**`skip-execution` tag:** Cells tagged with `skip-execution` are excluded from automatic execution in plan workflows, allowing users to mark cells that should never be auto-run.

**`important` tag:** Cells tagged with `important` receive a scoring boost in the context assembler, ensuring they are more likely to be included in the LLM context even if their relevance score is otherwise low.

**Cell lifecycle tracking:** The `/varys/cell-lifecycle` endpoint receives events for cell creation, deletion, and move operations from the frontend. On deletion, the summary store marks the cell as deleted (soft delete) so its history is preserved but it is excluded from context assembly. On restore (undo), the deleted flag is cleared.

---

## 17. Thread Management

Varys supports multiple independent conversation threads per notebook. Each thread has its own complete chat history, token usage record, and reasoning mode setting.

Up to four threads are visible as named pills in the thread bar. Additional threads appear in the overflow `···` menu. From this menu, threads can be renamed, duplicated, and deleted. New threads are created with a single click.

**Persistence:** Each thread's history is saved to a JSON file under `.jupyter-assistant/chats/` using an atomic write strategy (write to a temp file first, then rename), so a crash can never corrupt the history file.

**Notebook-scoped:** Threads are scoped to the notebook. When the user switches to a different notebook in JupyterLab, the thread bar updates to show that notebook's threads. The chat history of the previous notebook remains intact.

**Reasoning mode per thread:** Each thread independently remembers whether extended thinking was on or off when it was last used, so switching between a thinking thread and a fast thread does not require re-toggling the mode.

**Token usage:** Cumulative input and output token counts are tracked per thread and displayed in the sidebar, persisted to disk immediately when they change so they survive browser refreshes.

---

## 18. Token Usage Tracking

Varys tracks LLM token consumption at the thread level. After every response, the token counts returned by the provider are accumulated into the active thread's running total. Both input (prompt) tokens and output (completion) tokens are recorded separately.

The accumulated counts are displayed in the sidebar header and persist to disk immediately so they are not lost if the browser is refreshed before the debounced history save fires.

All seven provider backends include token-usage extraction logic, normalizing different provider response formats into a consistent `input_tokens` / `output_tokens` structure.

---

## 19. Settings & Configuration

All configuration lives in a plain `.env` file. The default path is `~/.jupyter/varys.env`. This can be changed to any other path, with the pointer stored in `~/.jupyter/.varys_env_path`. The Settings UI inside Varys reads and writes this file directly without requiring a JupyterLab restart.

Settings are organized into the following groups:

**Provider routing:** Which provider to use for each of the four task roles (chat, completion, simple tasks, embed).

**API credentials:** Keys for Anthropic, OpenAI, Google, AWS Bedrock, Azure OpenAI, and OpenRouter. Sensitive values are masked in the UI.

**Per-provider model selection:** Each provider has independent model names for each task role. Comma-separated model lists can be configured for the UI dropdowns.

**Anthropic-specific:** Enable or disable extended thinking; enable or disable prompt caching.

**Google-specific:** Thinking budget and extended thinking flags configurable independently.

**AWS Bedrock-specific:** Auth method (profile, static credentials, auto-refresh), region, models, thinking settings, and max tokens override.

**Ollama-specific:** Server URL and model names. Varys can discover available models from the running Ollama server.

**Agent settings:** `VARYS_AGENT_PROVIDER` (which provider the file agent uses), `VARYS_AGENT_PROMPT_CACHING` (cache agent prompts for cost savings), `VARYS_AGENT_ENABLED`, `VARYS_AGENT_ALLOWED_TOOLS`, `VARYS_AGENT_MAX_TURNS`, `VARYS_AGENT_MAX_TOKENS`.

**Remote kernel:** `VARYS_KERNEL_IS_REMOTE=true` signals that the kernel is running on a remote machine (e.g., EC2), enabling EC2-aware guidance in the context.

**Advisory phrases:** Custom disambiguation phrases that Varys uses to guide its response style can be configured in `.jupyter-assistant/rules/advisory-phrases.md`.

**Scorer thresholds:** Minimum relevance score and minimum number of cells to keep for context pruning are configurable.

---

## 20. Remote Kernel Support (EC2)

Varys has awareness of remote kernel deployments, such as a JupyterLab UI running locally connected to a kernel executing on an AWS EC2 instance via `remote_ikernel`.

**Detection:** A kernel is treated as remote either when `VARYS_KERNEL_IS_REMOTE=true` is set in the env file, or when the kernel spec name starts with `rnk_` (the remote_ikernel naming convention).

**EC2-aware context injection:** When a remote kernel is detected, the context assembler injects an additional note into the LLM prompt reminding it that the kernel is running on EC2. This prevents the assistant from suggesting local file paths, local package installation patterns, or other advice that would only apply to a local kernel.

The full EC2 deployment workflow is documented separately in `documentation/varys_on_ec2.md`, covering kernel spec configuration, SSH tunneling, and the `remote_ikernel` setup process.

---

*This document covers the capabilities of Varys as of dev0.7.0. The system is under active development; new capabilities are added frequently.*

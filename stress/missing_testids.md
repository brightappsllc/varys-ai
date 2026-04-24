# Primitive Extraction — Manual Follow-Ups

This file tracks items found during primitive extraction that need human review
or a follow-up PR.  It was generated alongside `primitives.yaml` at SHA
`14b0a526f38f64a5fe755aedde67de4fc13d6fb9`.

---

## Elements Needing `data-testid`

The following user-facing elements were identified from onClick / onChange
handlers in the tsx source but do not have a `data-testid` attribute.
Primitives for these elements currently use CSS class selectors, which are
more fragile under refactors.  A follow-up PR should add testids for each.

### `src/sidebar/SidebarWidget.tsx`

- [ ] `ThreadBar` — `button.ds-thread-add-btn` (line ~4015) — onClick={onNew}
  — suggested `data-testid="varys-new-thread-button"`
  - Rationale: core thread-management action; CSS class is stable now but
    "new thread" is a frequent stress-test entry point

- [ ] `ThreadBar` — `.ds-thread-pill-name` (line ~3966) — onClick={() => onSwitch(t.id)}
  — suggested `data-testid="varys-thread-pill"` (with `data-thread-id` attribute)
  - Rationale: thread switching is required for multi-thread stress scenarios

- [ ] `ThreadBar` — `.ds-thread-pill-btn:first-child` pen icon (line ~3976) — rename
  — suggested `data-testid="varys-thread-rename-btn"`

- [ ] `ThreadBar` — `.ds-thread-pill-btn:nth-child(2)` duplicate icon (line ~3986)
  — suggested `data-testid="varys-thread-duplicate-btn"`

- [ ] `ThreadBar` — `.ds-thread-pill-btn--delete` (line ~3998)
  — suggested `data-testid="varys-thread-delete-btn"`

- [ ] `DSAssistantChat` — `button.ds-nb-ctx-chip` (line ~7864) — handleToggleNotebookAware
  — suggested `data-testid="varys-notebook-context-toggle"`
  - Rationale: toggling context is tested in every prompt-assembly scenario

- [ ] `DSAssistantChat` — `button.ds-settings-gear-btn` (line ~7103)
  — suggested `data-testid="varys-settings-button"`

- [ ] `DSAssistantChat` — `button.ds-repro-shield-btn` (line ~7126)
  — suggested `data-testid="varys-repro-panel-button"`

- [ ] `DSAssistantChat` — `button.ds-graph-open-btn` (line ~7150)
  — suggested `data-testid="varys-graph-panel-button"`

- [ ] `DSAssistantChat` — `button.ds-tags-panel-btn` (line ~7070)
  — suggested `data-testid="varys-tags-panel-button"`

- [ ] `DSAssistantChat` — `button.ds-theme-toggle-btn` (line ~7076)
  — suggested `data-testid="varys-theme-toggle-button"`

- [ ] `DSAssistantChat` — `select.ds-cell-mode-select` (line ~8075) — cell mode
  — suggested `data-testid="varys-cell-mode-select"`
  - Rationale: chat vs. agent mode affects response shape; needs explicit coverage

- [ ] `DSAssistantChat` — `button.ds-thinking-chip` (line ~7905) — CoT dropdown trigger
  — suggested `data-testid="varys-reasoning-mode-button"`

- [ ] `ModelSwitcher` — `button.ds-model-switcher-btn` (line ~3752)
  — suggested `data-testid="varys-model-switcher-button"`
  - Rationale: model switching is a first-class stress axis

### `src/ui/DiffView.tsx`

- [ ] `DiffView` — `.ds-assistant-btn-accept` (Apply button, line ~258)
  — suggested `data-testid="varys-diff-apply-button"`
  - Rationale: the AI-edit acceptance path must be exercised explicitly

- [ ] `DiffView` — `.ds-assistant-btn-undo` (Undo button, line ~263)
  — suggested `data-testid="varys-diff-undo-button"`

### `src/ui/FileChangeCard.tsx`

- [ ] `FileChangeCard` — `.ds-assistant-btn-accept` (Apply, line ~249)
  — suggested `data-testid="varys-file-change-apply-button"`

- [ ] `FileChangeCard` — `.ds-assistant-btn-undo` (Undo, line ~252)
  — suggested `data-testid="varys-file-change-reject-button"`

### `src/reproducibility/ReproPanel.tsx`

- [ ] `ReproPanel` — `button.ds-repro-btn--analyze` (line ~222)
  — suggested `data-testid="varys-repro-analyze-button"`

- [ ] `ReproIssueCard` — `button.ds-repro-btn--fix` (line ~76)
  — suggested `data-testid="varys-repro-fix-button"`

- [ ] `ReproPanel` — `button.ds-repro-btn--fixall` (line ~277)
  — suggested `data-testid="varys-repro-fix-all-button"`

- [ ] `ReproIssueCard` — `button.ds-repro-btn--dismiss` (line ~84)
  — suggested `data-testid="varys-repro-dismiss-button"`

### `src/graph/GraphPanel.tsx`

- [ ] `GraphPanel` — `button.ds-graph-refresh-btn` (line ~175)
  — suggested `data-testid="varys-graph-refresh-button"`

### `src/graph/GraphNode.tsx`

- [ ] `GraphNode` — `div.ds-graph-node` (line ~99) — onClick={handleNodeClick}
  — suggested `data-testid="varys-graph-node"` (with `data-cell-uuid` attribute)
  - Rationale: node selection is the primary interaction in graph stress scenarios

### `src/tags/TagsPanel.tsx`

- [ ] `TagPill` — `button.ds-tp-pill` (line ~183) — tag application
  — suggested `data-testid="varys-tag-pill"` (with `data-tag-value` attribute)

- [ ] `TagsPanel` — `button.ds-tp-create-btn` (line ~331)
  — suggested `data-testid="varys-tag-create-button"`

---

## Registry / SKILL Mismatches

No mismatches found.  All `command:` keys in SKILL.md correspond to a bundled
skill, and all skills with a command key are present in `varys/bundled_skills/`.

Note: `/file_agent_find` and `/file_agent_save`, referenced in the v0.5.0
changelog, no longer have corresponding SKILL.md files.  These commands appear
to have been removed or consolidated into `/file_agent`.  If they still work
via some other mechanism, add them manually to `primitives.yaml` and document
their invocation here.

---

## Needs Manual Primitive Entry

The following operations were identified during the extraction pass but could
not be extracted deterministically (no testid, ambiguous selector, or
requires runtime context):

- [ ] **Varys context-menu "Edit with AI"** — triggered by right-clicking a
  notebook cell and selecting "Edit with AI" from the JupyterLab context menu.
  The handler calls `sendMessage()` on the sidebar widget.  No stable CSS
  selector; depends on JupyterLab's context-menu DOM which varies by version.

- [ ] **Varys inline completion acceptance** — the ghost-text completion is
  accepted by pressing `Tab` while the completion is visible.  This is keyboard-
  only and has no DOM element to select.  Invocation would be:
  `{ type: "playwright", steps: [{ action: "press", selector: ".jp-Cell.jp-mod-selected .cm-content", content: "Tab" }] }`
  Include as `varys.inline_completion.accept` if inline completion stress is in scope.

- [ ] **Image mode activation** (`/no_figures`, `/resize(DIM)`) — these are
  typed as prefixes in the chat input but parsed client-side before send.
  The `imageMode` state is set by regex matching in the input handler, not by
  a distinct button click.  They can be tested via `varys.send_prompt` with
  the appropriate prefix, but do not warrant a separate primitive.

---

## Coverage Concerns

- **Settings panel sub-tabs** (Providers, MCP, Skills, Routing, Agent, Tags,
  Context, Commands): each sub-tab has save/cancel actions.  These are
  intentionally excluded from the first pass — they are configuration, not
  notebook-workflow primitives.  Add them in a future iteration if settings-
  mutation scenarios are needed.

- **Scroll-to-bottom / copy-code** buttons inside assistant message bubbles
  are micro-interactions that do not warrant a top-level primitive.

- **Kernel restart with output clearing** (`notebook:restart-kernel-and-clear-output`)
  is a common JupyterLab command worth adding if kernel-state reset scenarios
  become frequent in stress campaigns.

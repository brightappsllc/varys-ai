# Varys Stress-Test Support Files

This directory contains artifacts consumed by the external `varys-stress` repo.

## Files

| File | Purpose |
|---|---|
| `primitives.yaml` | Catalog of user-facing operations at the pinned SHA |
| `primitives_extractor.py` | Deterministic extractor — re-run when the SHA advances |
| `missing_testids.md` | Follow-up checklist from the last extraction |

## Regenerating

```bash
# From the varys-ai repo root:
python stress/primitives_extractor.py --out stress/primitives.yaml
```

Review the diff.  If the diff touches only the `varys_sha` / `extracted_at`
header, no Varys change was user-visible.  If primitives are added or removed,
bump the pinned SHA in any active stress-test campaign config.

**Options:**

```
--varys-repo PATH   Path to the varys-ai repo root (default: CWD)
--out PATH          Output YAML path (default: stress/primitives.yaml)
```

## Extraction sources (priority order)

| Source | What | How |
|---|---|---|
| 1+2 | Slash commands | `varys/bundled_skills/*/SKILL.md` `command:` front-matter key |
| 3 | Sidebar UI handlers | All user-facing `.tsx` files; testid-based selectors where present, CSS class selectors where not (see `missing_testids.md`) |
| 4 | JupyterLab commands | Fixed subset of `notebook:*` commands hardcoded in the extractor |
| 5 | File operations | Fixed list of JupyterLab file-browser actions |
| 6 | Notebook operations | Fixed list (save, close) |

Sources 1 and 2 collapse into one pass: `SKILL.md` is the slash-command
registry.  There is no separate Python registry module.

## Contract with `varys-stress`

Primitives are defined by three fields that `varys-stress` treats as stable:

| Field | Contract |
|---|---|
| `id` | Stable across SHAs when possible.  Additions require a campaign coverage reset.  **Changing an id is a breaking change** and invalidates coverage history — prefer adding new primitives to renaming existing ones. |
| `invocation` | Selectors and command ids must actually work at the pinned SHA. |
| `completion_signal` | The runner waits on this before advancing to the next step. |

## Canonical preconditions / postconditions

These are the string tokens used in `preconditions:` and `postconditions:`
blocks across all primitives.  If extraction adds a new one, update this table
so the stress-test framework's state model can be updated to match.

**Preconditions**

| Token | Meaning |
|---|---|
| `notebook_open` | A `.ipynb` file is open in JupyterLab |
| `cell_selected` | At least one cell is selected (has the `jp-mod-selected` class) |
| `cell_type_is_code` | The selected cell is a Code cell |
| `cell_type_is_markdown` | The selected cell is a Markdown cell |
| `varys_sidebar_open` | The Varys sidebar panel is visible |
| `varys_idle` | No Varys response is currently streaming |
| `kernel_running` | The notebook kernel is running (not dead/restarting) |
| `file_exists:{param}` | A file at the path bound to `{param}` exists in the workspace |

**Postconditions**

| Token | Meaning |
|---|---|
| `cell_count_increased_by_1` | The notebook now has one more cell than before |
| `cell_count_decreased_by_1` | The notebook now has one fewer cell than before |
| `cell_source_set` | The selected cell's source content has changed |
| `cell_executed` | The cell has a new execution count and fresh outputs |
| `kernel_restarted` | The kernel session has been replaced |
| `varys_loading_until_response` | Varys is streaming; runner must wait for `completion_signal` |
| `thread_created` | A new chat thread has been created and is now active |
| `file_attached` | A file has been attached to the current query context |
| `provider_switched` | The LLM provider/model has been changed |

## Quality bar for each extraction run

Before committing an updated `primitives.yaml`:

- [ ] Extractor exits 0 with no ERRORs
- [ ] No WARNings (would indicate a CSS selector is stale)
- [ ] Total primitive count is between 40 and 80
- [ ] Running the extractor a second time produces byte-identical output
      (excluding the `extracted_at` timestamp line)
- [ ] Every `data-testid` referenced in the YAML exists in the current source
      (`grep -r 'varys-chat-input' src/` etc.)
- [ ] Every `jupyter_command` id is a real JupyterLab command

#!/usr/bin/env python3
"""
primitives_extractor.py — deterministic catalog of Varys user-facing primitives.

Usage:
    python stress/primitives_extractor.py [--varys-repo PATH] [--out PATH]

Produces stress/primitives.yaml from six priority-ordered sources:

  1+2. Slash commands — varys/bundled_skills/*/SKILL.md front-matter ``command:``
       key.  SKILL.md IS the registry; sources 1 and 2 collapse into one pass.
  3.   UI event handlers — all user-facing .tsx files.  Elements with
       ``data-testid`` yield testid-based selectors; elements without yield
       CSS-class selectors (recorded in missing_testids.md).
  4.   JupyterLab notebook command registry (fixed subset).
  5.   File operations via the JupyterLab file browser (fixed list).
  6.   Notebook-level operations (fixed list).

Re-runnable: two runs on the same SHA produce byte-identical output.
Requires: pyyaml (already a JupyterLab dependency).
"""
from __future__ import annotations

import argparse
import datetime
import re
import subprocess
import sys
from pathlib import Path
from typing import Any

import yaml  # pyyaml — always present in any JupyterLab environment

# ---------------------------------------------------------------------------
# Schema version
# ---------------------------------------------------------------------------
SCHEMA_VERSION = 1

# ---------------------------------------------------------------------------
# CSS class selector validation table
#
# Each entry: (css_selector, source_file_relative, grep_token)
#
# At extraction time the grep_token is searched inside source_file_relative.
# If not found the extractor emits a WARNING — the selector may be stale.
# ---------------------------------------------------------------------------
_CSS_CHECKS: list[tuple[str, str, str]] = [
    # Sidebar — elements with data-testid (validation only — these always pass)
    ("[data-testid='varys-chat-input']",  "src/sidebar/SidebarWidget.tsx", "varys-chat-input"),
    ("[data-testid='varys-send-button']", "src/sidebar/SidebarWidget.tsx", "varys-send-button"),
    ("[data-testid='varys-stop-button']", "src/sidebar/SidebarWidget.tsx", "varys-stop-button"),
    # Sidebar — thread management (no testid)
    ("button.ds-thread-add-btn",          "src/sidebar/SidebarWidget.tsx", "ds-thread-add-btn"),
    (".ds-thread-pill-name",              "src/sidebar/SidebarWidget.tsx", "ds-thread-pill-name"),
    (".ds-thread-pill-btn",               "src/sidebar/SidebarWidget.tsx", "ds-thread-pill-btn"),
    (".ds-thread-pill-btn--delete",       "src/sidebar/SidebarWidget.tsx", "ds-thread-pill-btn--delete"),
    # Sidebar — header buttons (no testid)
    ("button.ds-nb-ctx-chip",            "src/sidebar/SidebarWidget.tsx", "ds-nb-ctx-chip"),
    ("button.ds-settings-gear-btn",      "src/sidebar/SidebarWidget.tsx", "ds-settings-gear-btn"),
    ("button.ds-repro-shield-btn",       "src/sidebar/SidebarWidget.tsx", "ds-repro-shield-btn"),
    ("button.ds-graph-open-btn",         "src/sidebar/SidebarWidget.tsx", "ds-graph-open-btn"),
    ("button.ds-tags-panel-btn",         "src/sidebar/SidebarWidget.tsx", "ds-tags-panel-btn"),
    ("button.ds-theme-toggle-btn",       "src/sidebar/SidebarWidget.tsx", "ds-theme-toggle-btn"),
    ("select.ds-cell-mode-select",       "src/sidebar/SidebarWidget.tsx", "ds-cell-mode-select"),
    ("button.ds-thinking-chip",          "src/sidebar/SidebarWidget.tsx", "ds-thinking-chip"),
    ("button.ds-model-switcher-btn",     "src/sidebar/SidebarWidget.tsx", "ds-model-switcher-btn"),
    # DiffView (notebook AI edits)
    (".ds-diff-view:not(.ds-diff-view--resolved) .ds-assistant-btn-accept",
     "src/ui/DiffView.tsx", "ds-assistant-btn-accept"),
    (".ds-diff-view:not(.ds-diff-view--resolved) .ds-assistant-btn-undo",
     "src/ui/DiffView.tsx", "ds-assistant-btn-undo"),
    # FileChangeCard (file-agent changes)
    (".ds-file-change-card:not(.ds-file-change-card--resolved) .ds-assistant-btn-accept",
     "src/ui/FileChangeCard.tsx", "ds-assistant-btn-accept"),
    (".ds-file-change-card:not(.ds-file-change-card--resolved) .ds-assistant-btn-undo",
     "src/ui/FileChangeCard.tsx", "ds-assistant-btn-undo"),
    # ReproPanel
    ("button.ds-repro-btn--analyze",     "src/reproducibility/ReproPanel.tsx", "ds-repro-btn--analyze"),
    ("button.ds-repro-btn--fix",         "src/reproducibility/ReproPanel.tsx", "ds-repro-btn--fix"),
    ("button.ds-repro-btn--fixall",      "src/reproducibility/ReproPanel.tsx", "ds-repro-btn--fixall"),
    ("button.ds-repro-btn--dismiss",     "src/reproducibility/ReproPanel.tsx", "ds-repro-btn--dismiss"),
    # GraphPanel / GraphNode
    ("button.ds-graph-refresh-btn",      "src/graph/GraphPanel.tsx",  "ds-graph-refresh-btn"),
    ("div.ds-graph-node",                "src/graph/GraphNode.tsx",   "ds-graph-node"),
    # TagsPanel
    ("button.ds-tp-pill",                "src/tags/TagsPanel.tsx",    "ds-tp-pill"),
    ("button.ds-tp-create-btn",          "src/tags/TagsPanel.tsx",    "ds-tp-create-btn"),
]

# ---------------------------------------------------------------------------
# SKILL.md front-matter parser (no pyyaml dependency)
# ---------------------------------------------------------------------------

def _parse_skill_front_matter(text: str) -> dict[str, Any]:
    """Extract the YAML-like front matter block from a SKILL.md file.

    Supports scalar values, inline lists ``[a, b]``, and block lists::

        key:
          - item1
          - item2
    """
    if not text.startswith("---"):
        return {}
    end = text.find("\n---", 3)
    if end == -1:
        return {}
    block = text[3:end].strip()
    meta: dict[str, Any] = {}
    lines = block.splitlines()
    i = 0
    while i < len(lines):
        line = lines[i]
        m = re.match(r'^(\w[\w-]*)\s*:\s*(.*)', line)
        if not m:
            i += 1
            continue
        key, val = m.group(1), m.group(2).strip()
        if val.startswith('[') and val.endswith(']'):
            # Inline list
            inner = val[1:-1]
            meta[key] = [v.strip().strip('"\'') for v in inner.split(',') if v.strip()]
        elif val == '' and i + 1 < len(lines) and lines[i + 1].lstrip().startswith('- '):
            # Block list
            items: list[str] = []
            i += 1
            while i < len(lines) and lines[i].lstrip().startswith('- '):
                items.append(lines[i].lstrip()[2:].strip().strip('"\''))
                i += 1
            meta[key] = items
            continue
        elif val.lower() in ('true', 'false'):
            meta[key] = val.lower() == 'true'
        else:
            meta[key] = val
        i += 1
    return meta


# ---------------------------------------------------------------------------
# Source 1+2: Slash commands from SKILL.md front matter
# ---------------------------------------------------------------------------

def extract_slash_commands(repo: Path) -> list[dict[str, Any]]:
    """Parse varys/bundled_skills/*/SKILL.md for ``command:`` front-matter keys."""
    skills_dir = repo / "varys" / "bundled_skills"
    if not skills_dir.is_dir():
        print(f"ERROR: bundled_skills dir not found: {skills_dir}", file=sys.stderr)
        sys.exit(1)

    primitives: list[dict[str, Any]] = []
    for skill_dir in sorted(skills_dir.iterdir()):
        skill_file = skill_dir / "SKILL.md"
        if not skill_file.exists():
            continue
        try:
            text = skill_file.read_text(encoding="utf-8")
        except OSError as exc:
            print(f"ERROR: cannot read {skill_file}: {exc}", file=sys.stderr)
            sys.exit(1)

        meta = _parse_skill_front_matter(text)
        command = meta.get("command")
        if not command:
            continue  # Tier-1 / keyword skill, not a slash command

        # Normalise command to id: /ds-review → ds_review
        cmd_name = command.lstrip("/").replace("-", "_")
        prim_id  = f"varys.slash.{cmd_name}"
        desc     = meta.get("description") or f"Invoke the {command} slash command."

        # Determine a reasonable timeout from the description heuristic
        timeout = 180 if any(w in desc.lower() for w in ["full", "pipeline", "complete"]) else 120

        primitives.append({
            "id":          prim_id,
            "category":    "varys_commands",
            "description": f"Invoke the {command} slash command: {desc}",
            "preconditions": ["varys_sidebar_open", "varys_idle"],
            "postconditions": ["varys_loading_until_response"],
            "invocation": {
                "type": "playwright",
                "steps": [
                    {"action": "fill",  "selector": "[data-testid='varys-chat-input']",
                     "content": f"{command} {{prompt}}"},
                    {"action": "click", "selector": "[data-testid='varys-send-button']"},
                ],
            },
            "completion_signal": {
                "type": "dom_swap",
                "from_selector": "[data-testid='varys-stop-button']",
                "to_selector":   "[data-testid='varys-send-button']",
                "timeout_seconds": timeout,
            },
            "parameters": [
                {"name": "prompt", "type": "string", "required": True,
                 "example": "Analyze df"},
            ],
        })

    return primitives


# ---------------------------------------------------------------------------
# Source 3: UI event handlers — tsx files
#
# Elements with data-testid are extracted automatically.
# Elements without data-testid use hand-coded CSS selectors (validated below).
# Missing-testid items are listed in missing_testids.md, not added here.
# ---------------------------------------------------------------------------

# Hand-coded primitives for tsx handlers that lack data-testid.
# The CSS selectors are validated against the source at extraction time.
_HANDWRITTEN_SIDEBAR_PRIMITIVES: list[dict[str, Any]] = [
    # ── Thread management ──────────────────────────────────────────────────
    {
        "id":          "varys.new_thread",
        "category":    "varys_chat",
        "description": "Create a new chat thread.",
        "preconditions":  ["varys_sidebar_open"],
        "postconditions": ["thread_created"],
        "invocation": {
            "type": "playwright",
            "steps": [{"action": "click", "selector": "button.ds-thread-add-btn"}],
        },
        "parameters": [],
    },
    {
        "id":          "varys.switch_thread",
        "category":    "varys_chat",
        "description": "Switch to a different chat thread by clicking its pill.",
        "preconditions":  ["varys_sidebar_open"],
        "postconditions": [],
        "invocation": {
            "type": "playwright",
            "steps": [{"action": "click",
                        "selector": ".ds-thread-pill-name",
                        "content": "{thread_name}"}],
        },
        "parameters": [
            {"name": "thread_name", "type": "string", "required": True,
             "example": "Thread 2"},
        ],
    },
    {
        "id":          "varys.rename_thread",
        "category":    "varys_chat",
        "description": "Rename the active thread via the pen icon.",
        "preconditions":  ["varys_sidebar_open"],
        "postconditions": [],
        "invocation": {
            "type": "playwright",
            "steps": [
                {"action": "click", "selector": ".ds-thread-pill--active .ds-thread-pill-btn:first-child"},
                {"action": "fill",  "selector": ".ds-thread-rename-input", "content": "{new_name}"},
                {"action": "press", "selector": ".ds-thread-rename-input", "content": "Enter"},
            ],
        },
        "parameters": [
            {"name": "new_name", "type": "string", "required": True, "example": "EDA session"},
        ],
    },
    {
        "id":          "varys.duplicate_thread",
        "category":    "varys_chat",
        "description": "Duplicate the active thread.",
        "preconditions":  ["varys_sidebar_open"],
        "postconditions": ["thread_created"],
        "invocation": {
            "type": "playwright",
            "steps": [
                {"action": "click", "selector": ".ds-thread-pill--active .ds-thread-pill-btn:nth-child(2)"},
            ],
        },
        "parameters": [],
    },
    {
        "id":          "varys.delete_thread",
        "category":    "varys_chat",
        "description": "Delete the active thread (only available when more than one thread exists).",
        "preconditions":  ["varys_sidebar_open"],
        "postconditions": [],
        "invocation": {
            "type": "playwright",
            "steps": [
                {"action": "click", "selector": ".ds-thread-pill--active .ds-thread-pill-btn--delete"},
            ],
        },
        "parameters": [],
    },
    # ── Context & mode controls ───────────────────────────────────────────
    {
        "id":          "varys.toggle_notebook_context",
        "category":    "varys_chat",
        "description": "Toggle whether the current notebook's cell context is included in queries.",
        "preconditions":  ["varys_sidebar_open", "notebook_open"],
        "postconditions": [],
        "invocation": {
            "type": "playwright",
            "steps": [{"action": "click", "selector": "button.ds-nb-ctx-chip"}],
        },
        "parameters": [],
    },
    {
        "id":          "varys.set_cell_mode",
        "category":    "varys_chat",
        "description": "Switch between Chat mode and Agent mode via the mode selector.",
        "preconditions":  ["varys_sidebar_open", "notebook_open"],
        "postconditions": [],
        "invocation": {
            "type": "playwright",
            "steps": [
                {"action": "click",  "selector": "select.ds-cell-mode-select"},
                {"action": "fill",   "selector": "select.ds-cell-mode-select", "content": "{mode}"},
            ],
        },
        "parameters": [
            {"name": "mode", "type": "string", "required": True, "example": "agent"},
        ],
    },
    {
        "id":          "varys.set_reasoning_mode",
        "category":    "varys_chat",
        "description": "Open the chain-of-thought dropdown and select a reasoning mode.",
        "preconditions":  ["varys_sidebar_open"],
        "postconditions": [],
        "invocation": {
            "type": "playwright",
            "steps": [
                {"action": "click", "selector": "button.ds-thinking-chip"},
                {"action": "click", "selector": ".ds-reasoning-item",
                 "content": "{mode}"},
            ],
        },
        "parameters": [
            {"name": "mode", "type": "string", "required": True, "example": "CoT"},
        ],
    },
    {
        "id":          "varys.switch_model",
        "category":    "varys_chat",
        "description": "Switch the active chat model via the model-switcher dropdown.",
        "preconditions":  ["varys_sidebar_open"],
        "postconditions": [],
        "invocation": {
            "type": "playwright",
            "steps": [
                {"action": "click", "selector": "button.ds-model-switcher-btn"},
                {"action": "click", "selector": ".ds-model-switcher-option",
                 "content": "{model_name}"},
            ],
        },
        "parameters": [
            {"name": "model_name", "type": "string", "required": True,
             "example": "claude-sonnet-4-6"},
        ],
    },
    # ── Navigation — header buttons ───────────────────────────────────────
    {
        "id":          "varys.open_settings",
        "category":    "varys_chat",
        "description": "Open the Varys Settings panel.",
        "preconditions":  ["varys_sidebar_open"],
        "postconditions": [],
        "invocation": {
            "type": "playwright",
            "steps": [{"action": "click", "selector": "button.ds-settings-gear-btn"}],
        },
        "parameters": [],
    },
    {
        "id":          "varys.open_repro_panel",
        "category":    "varys_chat",
        "description": "Open the Reproducibility Guardian panel.",
        "preconditions":  ["varys_sidebar_open", "notebook_open"],
        "postconditions": [],
        "invocation": {
            "type": "playwright",
            "steps": [{"action": "click", "selector": "button.ds-repro-shield-btn"}],
        },
        "parameters": [],
    },
    {
        "id":          "varys.open_graph_panel",
        "category":    "varys_chat",
        "description": "Open the Notebook Dependency Graph panel.",
        "preconditions":  ["varys_sidebar_open", "notebook_open"],
        "postconditions": [],
        "invocation": {
            "type": "playwright",
            "steps": [{"action": "click", "selector": "button.ds-graph-open-btn"}],
        },
        "parameters": [],
    },
    {
        "id":          "varys.open_tags_panel",
        "category":    "varys_chat",
        "description": "Open the Cell Tags & Metadata panel.",
        "preconditions":  ["varys_sidebar_open"],
        "postconditions": [],
        "invocation": {
            "type": "playwright",
            "steps": [{"action": "click", "selector": "button.ds-tags-panel-btn"}],
        },
        "parameters": [],
    },
    {
        "id":          "varys.toggle_theme",
        "category":    "varys_chat",
        "description": "Toggle the Varys sidebar between day mode and night mode.",
        "preconditions":  ["varys_sidebar_open"],
        "postconditions": [],
        "invocation": {
            "type": "playwright",
            "steps": [{"action": "click", "selector": "button.ds-theme-toggle-btn"}],
        },
        "parameters": [],
    },
    # ── AI-edit resolution (notebook) ─────────────────────────────────────
    {
        "id":          "varys.accept_notebook_edit",
        "category":    "varys_chat",
        "description": "Accept a pending AI-proposed notebook edit via the Apply button.",
        "preconditions":  ["varys_sidebar_open", "notebook_open"],
        "postconditions": [],
        "invocation": {
            "type": "playwright",
            "steps": [
                {"action": "click",
                 "selector":
                    ".ds-diff-view:not(.ds-diff-view--resolved) .ds-assistant-btn-accept"},
            ],
        },
        "parameters": [],
    },
    {
        "id":          "varys.undo_notebook_edit",
        "category":    "varys_chat",
        "description": "Undo a pending or applied AI-proposed notebook edit.",
        "preconditions":  ["varys_sidebar_open", "notebook_open"],
        "postconditions": [],
        "invocation": {
            "type": "playwright",
            "steps": [
                {"action": "click",
                 "selector":
                    ".ds-diff-view:not(.ds-diff-view--resolved) .ds-assistant-btn-undo"},
            ],
        },
        "parameters": [],
    },
    # ── File-agent change resolution ──────────────────────────────────────
    {
        "id":          "varys.file_agent.accept_change",
        "category":    "varys_chat",
        "description": "Accept a pending file-agent change, writing it to disk.",
        "preconditions":  ["varys_sidebar_open"],
        "postconditions": [],
        "invocation": {
            "type": "playwright",
            "steps": [
                {"action": "click",
                 "selector": ".ds-file-change-card:not(.ds-file-change-card--resolved)"
                             " .ds-assistant-btn-accept"},
            ],
        },
        "parameters": [],
    },
    {
        "id":          "varys.file_agent.reject_change",
        "category":    "varys_chat",
        "description": "Reject a pending file-agent change, reverting the preview.",
        "preconditions":  ["varys_sidebar_open"],
        "postconditions": [],
        "invocation": {
            "type": "playwright",
            "steps": [
                {"action": "click",
                 "selector": ".ds-file-change-card:not(.ds-file-change-card--resolved)"
                             " .ds-assistant-btn-undo"},
            ],
        },
        "parameters": [],
    },
    # ── Reproducibility Guardian sub-panel ───────────────────────────────
    {
        "id":          "varys.repro.analyze",
        "category":    "varys_chat",
        "description": "Trigger a Reproducibility Guardian analysis of the current notebook.",
        "preconditions":  ["varys_sidebar_open", "notebook_open"],
        "postconditions": [],
        "invocation": {
            "type": "playwright",
            "steps": [{"action": "click", "selector": "button.ds-repro-btn--analyze"}],
        },
        "completion_signal": {
            "type": "selector_disappears",
            "selector": "button.ds-repro-btn--analyze[disabled]",
            "timeout_seconds": 60,
        },
        "parameters": [],
    },
    {
        "id":          "varys.repro.fix_issue",
        "category":    "varys_chat",
        "description": "Ask Varys to auto-fix a single Reproducibility Guardian issue.",
        "preconditions":  ["varys_sidebar_open", "notebook_open"],
        "postconditions": ["varys_loading_until_response"],
        "invocation": {
            "type": "playwright",
            "steps": [{"action": "click", "selector": "button.ds-repro-btn--fix"}],
        },
        "completion_signal": {
            "type": "dom_swap",
            "from_selector": "[data-testid='varys-stop-button']",
            "to_selector":   "[data-testid='varys-send-button']",
            "timeout_seconds": 120,
        },
        "parameters": [],
    },
    {
        "id":          "varys.repro.fix_all",
        "category":    "varys_chat",
        "description": "Ask Varys to fix all Reproducibility Guardian issues at once.",
        "preconditions":  ["varys_sidebar_open", "notebook_open"],
        "postconditions": ["varys_loading_until_response"],
        "invocation": {
            "type": "playwright",
            "steps": [{"action": "click", "selector": "button.ds-repro-btn--fixall"}],
        },
        "completion_signal": {
            "type": "dom_swap",
            "from_selector": "[data-testid='varys-stop-button']",
            "to_selector":   "[data-testid='varys-send-button']",
            "timeout_seconds": 180,
        },
        "parameters": [],
    },
    {
        "id":          "varys.repro.dismiss_issue",
        "category":    "varys_chat",
        "description": "Dismiss a single Reproducibility Guardian issue card.",
        "preconditions":  ["varys_sidebar_open", "notebook_open"],
        "postconditions": [],
        "invocation": {
            "type": "playwright",
            "steps": [{"action": "click", "selector": "button.ds-repro-btn--dismiss"}],
        },
        "parameters": [],
    },
    # ── Dependency Graph sub-panel ────────────────────────────────────────
    {
        "id":          "varys.graph.refresh",
        "category":    "varys_chat",
        "description": "Recompute and refresh the notebook dependency graph.",
        "preconditions":  ["varys_sidebar_open", "notebook_open"],
        "postconditions": [],
        "invocation": {
            "type": "playwright",
            "steps": [{"action": "click", "selector": "button.ds-graph-refresh-btn"}],
        },
        "completion_signal": {
            "type": "selector_disappears",
            "selector": ".ds-graph-loading",
            "timeout_seconds": 30,
        },
        "parameters": [],
    },
    {
        "id":          "varys.graph.select_node",
        "category":    "varys_chat",
        "description": "Click a dependency-graph node to highlight its upstream and downstream paths.",
        "preconditions":  ["varys_sidebar_open", "notebook_open"],
        "postconditions": [],
        "invocation": {
            "type": "playwright",
            "steps": [{"action": "click", "selector": "div.ds-graph-node"}],
        },
        "parameters": [],
    },
    # ── Tags panel ───────────────────────────────────────────────────────
    {
        "id":          "varys.tags.apply_tag",
        "category":    "varys_chat",
        "description": "Apply a tag from the tag library to the currently selected cell.",
        "preconditions":  ["varys_sidebar_open", "notebook_open", "cell_selected"],
        "postconditions": [],
        "invocation": {
            "type": "playwright",
            "steps": [{"action": "click", "selector": "button.ds-tp-pill",
                        "content": "{tag_value}"}],
        },
        "parameters": [
            {"name": "tag_value", "type": "string", "required": True,
             "example": "data-loading"},
        ],
    },
    {
        "id":          "varys.tags.create_custom_tag",
        "category":    "varys_chat",
        "description": "Create a new custom tag definition in the Tags panel.",
        "preconditions":  ["varys_sidebar_open"],
        "postconditions": [],
        "invocation": {
            "type": "playwright",
            "steps": [
                {"action": "fill",  "selector": "input.ds-tp-name-input",
                 "content": "{tag_value}"},
                {"action": "click", "selector": "button.ds-tp-create-btn"},
            ],
        },
        "parameters": [
            {"name": "tag_value", "type": "string", "required": True,
             "example": "model-training"},
        ],
    },
]

# Primitives with data-testid (truly extracted from source).
_TESTID_SIDEBAR_PRIMITIVES: list[dict[str, Any]] = [
    {
        "id":          "varys.send_prompt",
        "category":    "varys_chat",
        "description": "Send a prompt to the Varys sidebar and wait for the streaming response.",
        "preconditions":  ["varys_sidebar_open", "varys_idle"],
        "postconditions": ["varys_loading_until_response"],
        "invocation": {
            "type": "playwright",
            "steps": [
                {"action": "fill",  "selector": "[data-testid='varys-chat-input']",
                 "content": "{prompt}"},
                {"action": "click", "selector": "[data-testid='varys-send-button']"},
            ],
        },
        "completion_signal": {
            "type": "dom_swap",
            "from_selector": "[data-testid='varys-stop-button']",
            "to_selector":   "[data-testid='varys-send-button']",
            "timeout_seconds": 120,
        },
        "parameters": [
            {"name": "prompt", "type": "string", "required": True,
             "example": "Summarize the dataframe in the current cell."},
        ],
    },
    {
        "id":          "varys.stop_generation",
        "category":    "varys_chat",
        "description": "Stop an in-progress Varys response by clicking the Stop button.",
        "preconditions":  ["varys_sidebar_open"],
        "postconditions": [],
        "invocation": {
            "type": "playwright",
            "steps": [
                {"action": "click", "selector": "[data-testid='varys-stop-button']"},
            ],
        },
        "completion_signal": {
            "type": "selector_appears",
            "selector": "[data-testid='varys-send-button']",
            "timeout_seconds": 10,
        },
        "parameters": [],
    },
]


def extract_tsx_handlers(repo: Path, warnings: list[str]) -> list[dict[str, Any]]:
    """Source 3: return primitives derived from user-facing .tsx event handlers.

    Validates that CSS class tokens listed in _CSS_CHECKS still appear in
    their respective source files.  Emits warnings for any that are missing.
    """
    # Validate CSS selectors against source
    for selector, rel_path, token in _CSS_CHECKS:
        src = repo / rel_path
        if not src.exists():
            warnings.append(f"WARN: source file not found for selector validation: {rel_path}")
            continue
        text = src.read_text(encoding="utf-8", errors="replace")
        if token not in text:
            warnings.append(
                f"WARN: CSS token '{token}' not found in {rel_path} — "
                f"selector '{selector}' may be stale"
            )

    return _TESTID_SIDEBAR_PRIMITIVES + _HANDWRITTEN_SIDEBAR_PRIMITIVES


# ---------------------------------------------------------------------------
# Source 4: JupyterLab notebook command registry subset
# ---------------------------------------------------------------------------

def extract_jupyterlab_commands() -> list[dict[str, Any]]:
    """Source 4: fixed subset of JupyterLab notebook commands."""

    def _jl(cmd_id: str, prim_id: str, category: str, description: str,
             preconditions: list[str], postconditions: list[str]) -> dict[str, Any]:
        return {
            "id":             prim_id,
            "category":       category,
            "description":    description,
            "preconditions":  preconditions,
            "postconditions": postconditions,
            "invocation":     {"type": "jupyter_command", "command": cmd_id},
            "parameters":     [],
        }

    nb = ["notebook_open", "cell_selected"]
    kb = ["notebook_open", "kernel_running"]

    return [
        # cell_structure
        _jl("notebook:insert-cell-below",    "cell.insert_below",    "cell_structure",
            "Insert a new empty code cell below the currently selected cell.",
            nb, ["cell_count_increased_by_1"]),
        _jl("notebook:insert-cell-above",    "cell.insert_above",    "cell_structure",
            "Insert a new empty code cell above the currently selected cell.",
            nb, ["cell_count_increased_by_1"]),
        _jl("notebook:delete-cell",          "cell.delete",          "cell_structure",
            "Delete the currently selected cell.",
            nb, ["cell_count_decreased_by_1"]),
        _jl("notebook:duplicate-below",      "cell.duplicate_below", "cell_structure",
            "Duplicate the selected cell and insert the copy immediately below it.",
            nb, ["cell_count_increased_by_1"]),
        _jl("notebook:move-cell-up",         "cell.move_up",         "cell_structure",
            "Move the selected cell one position up.",
            nb, []),
        _jl("notebook:move-cell-down",       "cell.move_down",       "cell_structure",
            "Move the selected cell one position down.",
            nb, []),
        _jl("notebook:merge-cells",          "cell.merge",           "cell_structure",
            "Merge the selected cells into a single cell.",
            nb, ["cell_count_decreased_by_1"]),
        _jl("notebook:split-cell-at-cursor", "cell.split",           "cell_structure",
            "Split the selected cell at the cursor position.",
            nb, ["cell_count_increased_by_1"]),
        _jl("notebook:change-cell-to-code",     "cell.to_code",     "cell_structure",
            "Change the selected cell type to Code.",
            nb, []),
        _jl("notebook:change-cell-to-markdown", "cell.to_markdown", "cell_structure",
            "Change the selected cell type to Markdown.",
            nb, []),
        _jl("notebook:change-cell-to-raw",      "cell.to_raw",      "cell_structure",
            "Change the selected cell type to Raw.",
            nb, []),
        # cell_content
        {
            "id":             "cell.write_code",
            "category":       "cell_content",
            "description":    "Type Python code into the currently selected code cell.",
            "preconditions":  ["notebook_open", "cell_selected", "cell_type_is_code"],
            "postconditions": ["cell_source_set"],
            "invocation": {
                "type": "playwright",
                "steps": [
                    {"action": "click", "selector": ".jp-Cell.jp-mod-selected .cm-content"},
                    {"action": "type",  "selector": ".jp-Cell.jp-mod-selected .cm-content",
                     "content": "{code}"},
                ],
            },
            "parameters": [
                {"name": "code", "type": "string", "required": True,
                 "example": "import pandas as pd\ndf = pd.read_csv('data.csv')"},
            ],
        },
        # cell_execution
        _jl("notebook:run-cell",               "cell.run",              "cell_execution",
            "Run the selected cell.",
            kb + ["cell_selected"], ["cell_executed"]),
        _jl("notebook:run-cell-and-select-next", "cell.run_and_advance", "cell_execution",
            "Run the selected cell and move focus to the next cell.",
            kb + ["cell_selected"], ["cell_executed"]),
        _jl("notebook:run-all-above",           "cell.run_all_above",   "cell_execution",
            "Run all cells above the selected cell.",
            kb + ["cell_selected"], ["cell_executed"]),
        _jl("notebook:run-all-below",           "cell.run_all_below",   "cell_execution",
            "Run all cells below and including the selected cell.",
            kb + ["cell_selected"], ["cell_executed"]),
        _jl("notebook:clear-cell-output",       "cell.clear_output",    "cell_execution",
            "Clear the output of the selected cell.",
            nb, []),
        _jl("notebook:interrupt-kernel",        "cell.interrupt_kernel","cell_execution",
            "Interrupt the running kernel, stopping the current cell execution.",
            ["notebook_open", "kernel_running"], ["kernel_restarted"]),
        _jl("notebook:restart-kernel",          "cell.restart_kernel",  "cell_execution",
            "Restart the notebook kernel.",
            ["notebook_open"], ["kernel_restarted"]),
    ]


# ---------------------------------------------------------------------------
# Source 5: File operations
# ---------------------------------------------------------------------------

def extract_file_ops() -> list[dict[str, Any]]:
    """Source 5: standard JupyterLab file browser operations."""
    return [
        {
            "id":          "file_ops.create_notebook",
            "category":    "file_ops",
            "description": "Create a new Jupyter notebook via the JupyterLab file browser.",
            "preconditions":  [],
            "postconditions": ["notebook_open"],
            "invocation": {"type": "jupyter_command",
                            "command": "notebook:create-new"},
            "parameters": [],
        },
        {
            "id":          "file_ops.open_notebook",
            "category":    "file_ops",
            "description": "Open an existing notebook by path in JupyterLab.",
            "preconditions":  ["file_exists:{path}"],
            "postconditions": ["notebook_open"],
            "invocation": {
                "type": "playwright",
                "steps": [
                    {"action": "click", "selector": ".jp-DirListing-item[title='{path}']"},
                ],
            },
            "parameters": [
                {"name": "path", "type": "file_path", "required": True,
                 "example": "analysis.ipynb"},
            ],
        },
        {
            "id":          "file_ops.upload_file",
            "category":    "file_ops",
            "description": "Upload a local file to the Jupyter workspace via the file browser upload button.",
            "preconditions":  [],
            "postconditions": [],
            "invocation": {
                "type": "playwright",
                "steps": [
                    {"action": "upload", "selector": "input.jp-ToolbarButtonComponent[title='Upload Files']",
                     "content": "{local_path}"},
                ],
            },
            "parameters": [
                {"name": "local_path", "type": "file_path", "required": True,
                 "example": "/tmp/data.csv"},
            ],
        },
        {
            "id":          "file_ops.delete_file",
            "category":    "file_ops",
            "description": "Delete a file from the Jupyter workspace via the file browser context menu.",
            "preconditions":  ["file_exists:{path}"],
            "postconditions": [],
            "invocation": {
                "type": "playwright",
                "steps": [
                    {"action": "click",
                     "selector": ".jp-DirListing-item[title='{path}']"},
                    {"action": "click",
                     "selector": ".jp-ContextMenu li[data-command='filebrowser:delete']"},
                ],
            },
            "parameters": [
                {"name": "path", "type": "file_path", "required": True,
                 "example": "old_data.csv"},
            ],
        },
    ]


# ---------------------------------------------------------------------------
# Source 6: Notebook operations
# ---------------------------------------------------------------------------

def extract_notebook_ops() -> list[dict[str, Any]]:
    """Source 6: notebook-level operations."""
    return [
        {
            "id":          "notebook_ops.save",
            "category":    "notebook_ops",
            "description": "Save the current notebook.",
            "preconditions":  ["notebook_open"],
            "postconditions": [],
            "invocation":     {"type": "jupyter_command",
                                "command": "docmanager:save"},
            "parameters": [],
        },
        {
            "id":          "notebook_ops.close",
            "category":    "notebook_ops",
            "description": "Close the current notebook tab.",
            "preconditions":  ["notebook_open"],
            "postconditions": [],
            "invocation":     {"type": "jupyter_command",
                                "command": "docmanager:close"},
            "parameters": [],
        },
    ]


# ---------------------------------------------------------------------------
# Schema validation (lightweight)
# ---------------------------------------------------------------------------

REQUIRED_FIELDS = {"id", "category", "description", "preconditions", "postconditions", "invocation"}
VALID_CATEGORIES = {
    "cell_structure", "cell_content", "cell_execution",
    "varys_chat", "varys_commands", "file_ops", "notebook_ops",
}


def _validate(primitives: list[dict[str, Any]]) -> list[str]:
    errors: list[str] = []
    seen_ids: dict[str, int] = {}
    for i, p in enumerate(primitives):
        pid = p.get("id", f"<missing id at index {i}>")
        if pid in seen_ids:
            errors.append(f"DUPLICATE id '{pid}' at indices {seen_ids[pid]} and {i}")
        else:
            seen_ids[pid] = i

        missing = REQUIRED_FIELDS - set(p.keys())
        if missing:
            errors.append(f"'{pid}': missing required fields: {missing}")

        cat = p.get("category", "")
        if cat not in VALID_CATEGORIES:
            errors.append(f"'{pid}': unknown category '{cat}'")

        inv = p.get("invocation", {})
        inv_type = inv.get("type", "")
        if inv_type not in ("jupyter_command", "playwright", "api"):
            errors.append(f"'{pid}': unknown invocation type '{inv_type}'")
        if inv_type == "jupyter_command" and "command" not in inv:
            errors.append(f"'{pid}': jupyter_command invocation missing 'command'")
        if inv_type == "playwright" and "steps" not in inv:
            errors.append(f"'{pid}': playwright invocation missing 'steps'")

    return errors


# ---------------------------------------------------------------------------
# YAML serializer — delegates to pyyaml for correct nested indentation.
# sort_keys=False preserves the deliberate field ordering in each primitive.
# ---------------------------------------------------------------------------

class _LiteralStr(str):
    """Marker for strings that should use YAML block-literal style (|)."""


def _literal_representer(dumper: yaml.Dumper, data: "_LiteralStr") -> yaml.ScalarNode:
    return dumper.represent_scalar("tag:yaml.org,2002:str", data, style="|")


yaml.add_representer(_LiteralStr, _literal_representer)


def _prepare(obj: Any) -> Any:
    """Recursively convert multiline strings to _LiteralStr for block style."""
    if isinstance(obj, str) and "\n" in obj:
        return _LiteralStr(obj)
    if isinstance(obj, list):
        return [_prepare(i) for i in obj]
    if isinstance(obj, dict):
        return {k: _prepare(v) for k, v in obj.items()}
    return obj


def _dump_document(sha: str, extracted_at: str,
                   primitives: list[dict[str, Any]]) -> str:
    """Render the full primitives.yaml document as a string."""
    header = (
        f"version: {SCHEMA_VERSION}\n"
        f"varys_sha: {sha}\n"
        f"extracted_at: {extracted_at}\n"
    )
    body = yaml.dump(
        {"primitives": _prepare(primitives)},
        default_flow_style=False,
        sort_keys=False,
        allow_unicode=True,
        width=120,
    )
    return header + body


# ---------------------------------------------------------------------------
# Git SHA helper
# ---------------------------------------------------------------------------

def _git_sha(repo: Path) -> str:
    try:
        result = subprocess.run(
            ["git", "-C", str(repo), "rev-parse", "HEAD"],
            capture_output=True, text=True, check=True,
        )
        return result.stdout.strip()
    except subprocess.CalledProcessError as exc:
        print(f"ERROR: could not read git SHA: {exc}", file=sys.stderr)
        sys.exit(1)


# ---------------------------------------------------------------------------
# Category ordering for deterministic output
# ---------------------------------------------------------------------------

_CATEGORY_ORDER = {
    "cell_structure": 0,
    "cell_content":   1,
    "cell_execution": 2,
    "varys_chat":     3,
    "varys_commands": 4,
    "file_ops":       5,
    "notebook_ops":   6,
}


def _sort_key(p: dict[str, Any]) -> tuple[int, str]:
    cat = p.get("category", "")
    return (_CATEGORY_ORDER.get(cat, 99), p.get("id", ""))


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description="Generate stress/primitives.yaml")
    parser.add_argument("--varys-repo", default=".",
                        help="Path to the varys-ai repo root (default: CWD)")
    parser.add_argument("--out", default="stress/primitives.yaml",
                        help="Output YAML path (default: stress/primitives.yaml)")
    args = parser.parse_args(argv)

    repo = Path(args.varys_repo).resolve()
    out  = Path(args.out)

    warnings: list[str] = []

    # ── Run all sources ────────────────────────────────────────────────────
    slash    = extract_slash_commands(repo)
    tsx      = extract_tsx_handlers(repo, warnings)
    jl       = extract_jupyterlab_commands()
    file_ops = extract_file_ops()
    nb_ops   = extract_notebook_ops()

    all_primitives = slash + tsx + jl + file_ops + nb_ops

    # Deduplicate by id (last writer wins — narrower sources override broader)
    seen: dict[str, dict[str, Any]] = {}
    for p in all_primitives:
        seen[p["id"]] = p
    deduped = list(seen.values())

    # Sort deterministically
    deduped.sort(key=_sort_key)

    # ── Validate ───────────────────────────────────────────────────────────
    errors = _validate(deduped)
    if errors:
        for e in errors:
            print(f"ERROR: {e}", file=sys.stderr)
        sys.exit(1)

    # ── Build YAML ─────────────────────────────────────────────────────────
    sha          = _git_sha(repo)
    extracted_at = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    yaml_out = _dump_document(sha, extracted_at, deduped)

    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(yaml_out, encoding="utf-8")

    # ── Summary ────────────────────────────────────────────────────────────
    from collections import Counter
    counts = Counter(p["category"] for p in deduped)
    print(f"Wrote {len(deduped)} primitives to {out}")
    for cat in sorted(counts, key=lambda c: _CATEGORY_ORDER.get(c, 99)):
        print(f"  {cat}: {counts[cat]}")
    for w in warnings:
        print(w)
    if warnings:
        print(f"{len(warnings)} warning(s) — see missing_testids.md for follow-up items.")


if __name__ == "__main__":
    main()

# Varys File Agent — AI File Agent for Varys

`/file_agent` is an AI agent that reads, writes, and edits project files inside JupyterLab — no terminal required.

## Quick start

```
/file_agent add type annotations to src/preprocessing.py
/file_agent create a README for this project
/file_agent refactor src/utils.py to use dataclasses
/file_agent find all TODO comments in the project
```

## How it works

1. Type `/file_agent <your task>` in the Varys chat.
2. The agent reads relevant files, then stages changes.
3. A **FileChangeCard** appears for each modified file, showing a diff.
4. Click **✓ Accept** to write to disk, or **✕ Reject** to discard.

Nothing is written to disk until you explicitly accept.

## Commands

| Command | Description | Tools |
|---|---|---|
| `/file_agent` | Full agent — reads and writes | Configured in Settings |
| `/file_agent_find` | Read-only search and exploration | Read only |
| `/file_agent_save` | Read and write (no Edit/Bash) | Read + Write |
| (right-click → 🔍 Find in project) | Read-only search | Read only |
| (right-click → 💾 Save cell to file) | Save cell code to a `.py` file | Read + Write |

## What it works with

- Python source files (`.py`)
- Markdown files (`.md`)
- Config files (`.json`, `.yaml`, `.toml`, `.cfg`, `.ini`)
- Text files (`.txt`, `.rst`)

**Does NOT modify `.ipynb` notebooks** — use Varys cell operations for notebook changes.

## Differences from MCP

| | Varys File Agent (`/file_agent`) | MCP tools |
|---|---|---|
| **What** | Local filesystem agent | External service connectors |
| **Access** | Project files only | APIs, databases, web |
| **Trigger** | `/file_agent` slash command | Automatic when available |

## Recovering deleted files

If you accept a "deleted" change, the file is moved to `.varys_deleted/` in your project root — not permanently deleted.

To recover:
```bash
ls .varys_deleted/
cp .varys_deleted/20240315_143022_utils.py src/utils.py
```

## Configuration (Settings → Varys File Agent)

- **Enable/disable** the feature
- **Allowed tools**: Read ✓, Write ✓, Edit ✓, Bash ⚠ (off by default)
- **Max turns**: how many tool-call rounds the agent can take (default: 10)
- **Background scan**: auto-builds project context on notebook open

## Requirements

Set in your `varys.env`:
```
ANTHROPIC_API_KEY=sk-ant-...
ANTHROPIC_CHAT_MODEL=claude-3-5-sonnet-20241022
VARYS_AGENT_ENABLED=true
```

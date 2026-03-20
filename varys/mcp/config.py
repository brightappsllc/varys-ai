"""MCP config — reads/writes ~/.jupyter/varys-mcp.json.

File format mirrors the Cursor / Claude Desktop MCP config so users can
copy-paste server entries directly:

    {
      "mcpServers": {
        "filesystem": {
          "command": "npx",
          "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
        },
        "aws": {
          "command": "uvx",
          "args": ["awslabs.core-mcp-server@latest"],
          "env": {"AWS_PROFILE": "default"}
        }
      }
    }

Each server entry supports:
  command  — executable to run (npx, uvx, python, node, …)
  args     — list of arguments
  env      — optional dict of extra environment variables
  disabled — boolean; skip this server when true
"""
import json
import logging
from pathlib import Path
from typing import Any, Dict

log = logging.getLogger(__name__)

MCP_CONFIG_PATH = Path.home() / ".jupyter" / "varys-mcp.json"


def _empty_config() -> Dict[str, Any]:
    """Return a fresh empty config dict (never reuses a shared object)."""
    return {"mcpServers": {}}


def load_mcp_config() -> Dict[str, Any]:
    """Return the MCP server config dict, or an empty default if absent."""
    if not MCP_CONFIG_PATH.exists():
        return _empty_config()
    try:
        data = json.loads(MCP_CONFIG_PATH.read_text(encoding="utf-8"))
        if "mcpServers" not in data:
            data["mcpServers"] = {}
        return data
    except (json.JSONDecodeError, OSError) as exc:
        log.warning("Varys MCP: could not read config at %s: %s — using empty config", MCP_CONFIG_PATH, exc)
        return _empty_config()


def save_mcp_config(config: Dict[str, Any]) -> None:
    """Persist the MCP config, creating the directory if needed."""
    MCP_CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
    MCP_CONFIG_PATH.write_text(
        json.dumps(config, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )

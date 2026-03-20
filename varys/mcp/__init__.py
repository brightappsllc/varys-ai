"""Varys MCP client subsystem.

Manages connections to external MCP servers configured in
~/.jupyter/varys-mcp.json and exposes their tools to the LLM.
"""
from .manager import MCPManager
from .config import load_mcp_config, save_mcp_config, MCP_CONFIG_PATH

__all__ = ["MCPManager", "load_mcp_config", "save_mcp_config", "MCP_CONFIG_PATH"]

"""MCPManager — singleton that owns all MCP server connections.

Stored in handler.settings["ds_mcp_manager"] by app.py at startup.
Handlers retrieve it via self.settings["ds_mcp_manager"].
"""
import asyncio
import logging
from typing import Any, Dict, List, Optional

from .config import load_mcp_config, save_mcp_config, MCP_CONFIG_PATH
from .server import MCPServerConnection

log = logging.getLogger(__name__)


class MCPManager:
    """Manages a pool of MCP server connections.

    Usage in handlers:
        mgr: MCPManager = self.settings.get("ds_mcp_manager")
        if mgr:
            tools = mgr.get_all_tools()   # Anthropic-schema list
    """

    def __init__(self) -> None:
        self._servers: Dict[str, MCPServerConnection] = {}

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    async def start_all(self) -> None:
        """Read the config and connect to every enabled server.

        Called once at JupyterLab startup from app.initialize_settings().
        Each server connects in parallel; failures are logged but don't
        prevent other servers from starting.
        """
        config = load_mcp_config()
        servers_cfg = config.get("mcpServers", {})
        if not servers_cfg:
            log.info("Varys MCP: no servers configured")
            return

        tasks = []
        for name, cfg in servers_cfg.items():
            if cfg.get("disabled"):
                log.info("Varys MCP: skipping disabled server '%s'", name)
                continue
            conn = MCPServerConnection(name, cfg)
            self._servers[name] = conn
            tasks.append(conn.connect())

        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)

        connected = [n for n, s in self._servers.items() if s.status == "connected"]
        log.info("Varys MCP: %d/%d server(s) connected: %s", len(connected), len(tasks), connected)

    async def stop_all(self) -> None:
        """Disconnect all servers (called on extension shutdown)."""
        tasks = [s.disconnect() for s in self._servers.values()]
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        self._servers.clear()

    # ------------------------------------------------------------------
    # Hot-reload
    # ------------------------------------------------------------------

    async def reload(self) -> Dict[str, Any]:
        """Stop all servers, re-read the config, and reconnect.

        Returns a status dict suitable for returning from the HTTP handler.
        """
        await self.stop_all()
        await self.start_all()
        return self.get_status()

    async def add_server(self, name: str, cfg: Dict[str, Any]) -> Dict[str, Any]:
        """Add a new server at runtime and persist it to config."""
        # Disconnect any existing connection with the same name to avoid leaking
        # the old subprocess before overwriting it.
        if name in self._servers:
            await self._servers[name].disconnect()

        # Persist
        config = load_mcp_config()
        config["mcpServers"][name] = cfg
        save_mcp_config(config)

        # Connect
        conn = MCPServerConnection(name, cfg)
        self._servers[name] = conn
        await conn.connect()

        return {"name": name, "status": conn.status, "error": conn.error}

    async def remove_server(self, name: str) -> None:
        """Disconnect and remove a server, then persist."""
        if name in self._servers:
            await self._servers[name].disconnect()
            del self._servers[name]

        config = load_mcp_config()
        config["mcpServers"].pop(name, None)
        save_mcp_config(config)

    async def toggle_server(self, name: str, disabled: bool) -> Dict[str, Any]:
        """Enable or disable a server without removing it from config.

        Disabling disconnects the subprocess but keeps the config entry so it
        can be re-enabled later without re-entering the command/args/env.
        """
        config = load_mcp_config()
        if name not in config.get("mcpServers", {}):
            raise RuntimeError(f"Server '{name}' not found in config")

        config["mcpServers"][name]["disabled"] = disabled
        save_mcp_config(config)

        if disabled:
            if name in self._servers:
                await self._servers[name].disconnect()
                del self._servers[name]
            return {"name": name, "status": "disabled", "error": "", "disabled": True}
        else:
            cfg = config["mcpServers"][name]
            conn = MCPServerConnection(name, cfg)
            self._servers[name] = conn
            await conn.connect()
            return {"name": name, "status": conn.status, "error": conn.error, "disabled": False}

    # ------------------------------------------------------------------
    # Tool access
    # ------------------------------------------------------------------

    def get_all_tools(self) -> List[Dict[str, Any]]:
        """Return Anthropic-schema tool defs from ALL connected servers."""
        tools: List[Dict[str, Any]] = []
        for conn in self._servers.values():
            if conn.status == "connected":
                tools.extend(conn.get_tools())
        return tools

    def has_tools(self) -> bool:
        return any(
            conn.status == "connected" and conn.get_tools()
            for conn in self._servers.values()
        )

    def find_server_for_tool(self, tool_name: str) -> Optional[MCPServerConnection]:
        """Return the server that owns the given prefixed tool name."""
        for name, conn in self._servers.items():
            if tool_name.startswith(f"{name}__") and conn.status == "connected":
                return conn
        return None

    async def call_tool(self, tool_name: str, arguments: Dict[str, Any]) -> str:
        """Route a tool call to the correct server."""
        conn = self.find_server_for_tool(tool_name)
        if not conn:
            raise RuntimeError(
                f"No connected MCP server found for tool '{tool_name}'. "
                "Check that the server is running and the tool name is correct."
            )
        return await conn.call_tool(tool_name, arguments)

    # ------------------------------------------------------------------
    # Status reporting (for the UI)
    # ------------------------------------------------------------------

    def get_status(self) -> Dict[str, Any]:
        """Return a JSON-serialisable status dict for the HTTP handler.

        Includes ALL servers from the config file (both active and disabled)
        so the UI can show disabled ones and let the user re-enable them.
        """
        # Start from the persisted config so disabled servers are visible.
        config = load_mcp_config()
        all_cfg = config.get("mcpServers", {})

        servers: Dict[str, Any] = {}
        for name, cfg in all_cfg.items():
            if name in self._servers:
                conn = self._servers[name]
                servers[name] = {
                    "status": conn.status,
                    "error": conn.error,
                    "tools": [t["name"] for t in conn.get_tools()],
                    "config": {
                        "command": conn.config.get("command", ""),
                        "args": conn.config.get("args", []),
                        "env": conn.config.get("env", {}),
                        "disabled": False,
                    },
                }
            else:
                servers[name] = {
                    "status": "disabled",
                    "error": "",
                    "tools": [],
                    "config": {
                        "command": cfg.get("command", ""),
                        "args": cfg.get("args", []),
                        "env": cfg.get("env", {}),
                        "disabled": True,
                    },
                }

        # Raw config file content for the read-only viewer in the UI
        try:
            config_raw = MCP_CONFIG_PATH.read_text(encoding="utf-8") if MCP_CONFIG_PATH.exists() else ""
        except OSError:
            config_raw = ""

        return {
            "servers": servers,
            "totalTools": len(self.get_all_tools()),
            "configRaw": config_raw,
        }

"""MCPServerConnection — manages one MCP server subprocess lifecycle.

Uses contextlib.AsyncExitStack to keep the stdio_client + ClientSession
context managers alive across multiple requests (the subprocess stays
running between tool calls).
"""
import asyncio
import contextlib
import logging
import os
from typing import Any, Dict, List, Optional

log = logging.getLogger(__name__)

# ── availability guard ────────────────────────────────────────────────────────
try:
    from mcp import ClientSession
    from mcp.client.stdio import stdio_client, StdioServerParameters
    _MCP_AVAILABLE = True
except ImportError:
    _MCP_AVAILABLE = False
    ClientSession = None  # type: ignore
    stdio_client = None   # type: ignore
    StdioServerParameters = None  # type: ignore


class MCPServerConnection:
    """Manages a single MCP server subprocess and its ClientSession.

    Call await connect() to start the server; the subprocess stays alive
    until await disconnect() is called.  Reconnection is attempted
    automatically on the next get_tools() or call_tool() if the session
    is found to be dead.
    """

    def __init__(self, name: str, config: Dict[str, Any]) -> None:
        self.name = name
        self.config = config
        self.status: str = "disconnected"   # disconnected | connecting | connected | error
        self.error: str = ""
        self._session: Optional[Any] = None  # mcp.ClientSession
        self._exit_stack: contextlib.AsyncExitStack = contextlib.AsyncExitStack()
        self._tools: List[Dict[str, Any]] = []  # cached tool list (Anthropic schema)

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    async def connect(self) -> None:
        """Start the server subprocess and initialise the MCP session."""
        if not _MCP_AVAILABLE:
            self.status = "error"
            self.error = "mcp package not installed — run: pip install mcp"
            return

        if self.status == "connected":
            return

        self.status = "connecting"
        self.error = ""

        command = self.config.get("command", "")
        args    = self.config.get("args", [])
        env_override = self.config.get("env", {})

        try:
            if not command:
                raise ValueError("Missing 'command' in MCP server config")

            # Merge user-supplied env overrides with current environment
            merged_env = {**os.environ, **env_override} if env_override else None

            params = StdioServerParameters(
                command=command,
                args=args,
                env=merged_env,
            )

            read, write = await self._exit_stack.enter_async_context(
                stdio_client(params)
            )
            session = await self._exit_stack.enter_async_context(
                ClientSession(read, write)
            )
            await session.initialize()
            self._session = session
            self.status = "connected"
            log.info("Varys MCP: connected to '%s'", self.name)

            # Eagerly discover tools
            await self._refresh_tools()

        except Exception as exc:
            self.status = "error"
            # Generic "Connection closed" / "EOF" errors carry no useful detail.
            # Probe the subprocess independently with stderr captured so we can
            # surface the actual startup error (missing module, wrong Node version, …).
            raw = str(exc)
            if _is_generic_connection_error(raw):
                stderr_out = await _probe_stderr(command, args, env_override)
                if stderr_out:
                    raw = f"Connection closed.\nServer stderr:\n{stderr_out}"
                else:
                    raw = (
                        f"Connection closed. The server process started but exited immediately. "
                        f"Check the JupyterLab terminal for more detail, or run:\n"
                        f"  {command} {' '.join(args)}"
                    )
            self.error = raw
            log.warning("Varys MCP: failed to connect '%s': %s", self.name, raw)
            # Clean up any partially-entered contexts
            try:
                await self._exit_stack.aclose()
            except Exception:
                pass
            self._exit_stack = contextlib.AsyncExitStack()

    async def disconnect(self) -> None:
        """Shut down the server subprocess."""
        try:
            await self._exit_stack.aclose()
        except Exception as exc:
            log.debug("Varys MCP: disconnect error for '%s': %s", self.name, exc)
        finally:
            self._session = None
            self._tools = []
            self.status = "disconnected"
            self._exit_stack = contextlib.AsyncExitStack()

    # ------------------------------------------------------------------
    # Tool discovery
    # ------------------------------------------------------------------

    async def _refresh_tools(self) -> None:
        """Fetch the tool list from the server and cache it."""
        if not self._session:
            return
        try:
            result = await self._session.list_tools()
            self._tools = [
                _mcp_tool_to_anthropic(t, self.name)
                for t in (result.tools or [])
            ]
            log.info(
                "Varys MCP: '%s' exposes %d tool(s): %s",
                self.name,
                len(self._tools),
                [t["name"] for t in self._tools],
            )
        except Exception as exc:
            log.warning("Varys MCP: list_tools failed for '%s': %s", self.name, exc)

    def get_tools(self) -> List[Dict[str, Any]]:
        """Return cached Anthropic-schema tool definitions."""
        return list(self._tools)

    # ------------------------------------------------------------------
    # Tool execution
    # ------------------------------------------------------------------

    async def call_tool(self, tool_name: str, arguments: Dict[str, Any]) -> str:
        """Call a tool on this server and return the result as a string."""
        if self.status != "connected" or not self._session:
            raise RuntimeError(
                f"MCP server '{self.name}' is not connected (status: {self.status})"
            )

        # Strip the server-name prefix we add to avoid collisions
        bare_name = _strip_prefix(tool_name, self.name)

        try:
            result = await self._session.call_tool(bare_name, arguments)
        except Exception as exc:
            raise RuntimeError(
                f"MCP tool '{bare_name}' on server '{self.name}' failed: {exc}"
            ) from exc

        # Flatten content blocks to a single string
        parts: List[str] = []
        for block in result.content or []:
            if hasattr(block, "text"):
                parts.append(block.text)
            elif hasattr(block, "data"):
                parts.append(f"[binary data, {len(block.data)} bytes]")
            else:
                parts.append(str(block))

        return "\n".join(parts) if parts else "(empty result)"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _mcp_tool_to_anthropic(tool: Any, server_name: str) -> Dict[str, Any]:
    """Convert an MCP Tool object to an Anthropic tool-schema dict.

    Tool names are prefixed with the server name to avoid collisions between
    servers that expose tools with the same name.
    """
    name = f"{server_name}__{tool.name}"

    # inputSchema is already a JSON-schema dict — pass it through directly.
    schema = tool.inputSchema if hasattr(tool, "inputSchema") else {"type": "object", "properties": {}}
    if not isinstance(schema, dict):
        try:
            schema = dict(schema)
        except Exception:
            schema = {"type": "object", "properties": {}}

    return {
        "name": name,
        "description": (tool.description or f"Tool '{tool.name}' from MCP server '{server_name}'"),
        "input_schema": schema,
    }


def _strip_prefix(tool_name: str, server_name: str) -> str:
    """Remove the 'servername__' prefix to recover the bare MCP tool name."""
    prefix = f"{server_name}__"
    return tool_name[len(prefix):] if tool_name.startswith(prefix) else tool_name


_GENERIC_ERRORS = frozenset({
    "connection closed", "eof", "stream closed",
    "broken pipe", "end of file", "connection reset",
})


def _is_generic_connection_error(msg: str) -> bool:
    """Return True when the error gives no useful detail (pure transport failure)."""
    lower = msg.lower().strip()
    return any(g in lower for g in _GENERIC_ERRORS) or len(lower) < 20


async def _probe_stderr(command: str, args: list, env_override: dict) -> str:
    """Spawn the server command briefly with stderr captured.

    Waits up to 4 seconds for the process to either exit (and emit an error
    message) or timeout (meaning it started successfully — no stderr).
    Returns the first 600 chars of stderr, or '' if nothing useful was found.
    """
    if not command:
        return ""
    merged_env = {**os.environ, **env_override} if env_override else dict(os.environ)
    try:
        proc = await asyncio.create_subprocess_exec(
            command, *args,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=merged_env,
        )
    except FileNotFoundError:
        return f"Command not found: '{command}'. Make sure it is installed and on PATH."
    except Exception as exc:
        return str(exc)

    try:
        # Close stdin immediately — a well-behaved MCP server keeps running;
        # a broken one will crash and write to stderr within a few seconds.
        if proc.stdin:
            proc.stdin.close()
        _, stderr_bytes = await asyncio.wait_for(proc.communicate(), timeout=4.0)
        text = stderr_bytes.decode("utf-8", errors="replace").strip()
        return text[:600] if text else ""
    except asyncio.TimeoutError:
        # Process is still alive after 4 s — it started fine; no stderr error.
        try:
            proc.kill()
            await proc.wait()
        except Exception:
            pass
        return ""
    except Exception as exc:
        return str(exc)

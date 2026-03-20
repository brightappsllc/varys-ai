"""MCP management HTTP handler — /varys/mcp

GET  /varys/mcp          → return status of all configured MCP servers + tools
POST /varys/mcp/reload   → stop all servers, re-read config, reconnect
POST /varys/mcp/servers  → add a new server  {name, command, args, env}
DELETE /varys/mcp/servers → remove a server by name in body {name}
"""
import json
import traceback

from jupyter_server.base.handlers import JupyterHandler
from tornado.web import authenticated


class MCPStatusHandler(JupyterHandler):
    """GET /varys/mcp — return status of all MCP servers and their tools."""

    @authenticated
    async def get(self):
        self.set_header("Content-Type", "application/json")
        try:
            mgr = self.settings.get("ds_mcp_manager")
            if mgr is None:
                self.finish(json.dumps({"servers": {}, "totalTools": 0}))
                return
            self.finish(json.dumps(mgr.get_status()))
        except Exception as e:
            self.log.error("MCP status error: %s", traceback.format_exc())
            self.set_status(500)
            self.finish(json.dumps({"error": str(e)}))


class MCPReloadHandler(JupyterHandler):
    """POST /varys/mcp/reload — hot-reload all MCP servers from config."""

    @authenticated
    async def post(self):
        self.set_header("Content-Type", "application/json")
        try:
            mgr = self.settings.get("ds_mcp_manager")
            if mgr is None:
                self.set_status(503)
                self.finish(json.dumps({"error": "MCPManager not initialised"}))
                return
            status = await mgr.reload()
            self.finish(json.dumps(status))
        except Exception as e:
            self.log.error("MCP reload error: %s", traceback.format_exc())
            self.set_status(500)
            self.finish(json.dumps({"error": str(e)}))


class MCPServersHandler(JupyterHandler):
    """POST /varys/mcp/servers — add a server.
       DELETE /varys/mcp/servers — remove a server by name in body."""

    @authenticated
    async def post(self):
        self.set_header("Content-Type", "application/json")
        try:
            body = json.loads(self.request.body.decode("utf-8"))
        except json.JSONDecodeError as exc:
            self.set_status(400)
            self.finish(json.dumps({"error": f"Invalid JSON body: {exc}"}))
            return

        try:
            name    = body.get("name", "").strip()
            command = body.get("command", "").strip()
            args    = body.get("args", [])
            env     = body.get("env", {})

            if not name or not command:
                self.set_status(400)
                self.finish(json.dumps({"error": "'name' and 'command' are required"}))
                return

            mgr = self.settings.get("ds_mcp_manager")
            if mgr is None:
                self.set_status(503)
                self.finish(json.dumps({"error": "MCPManager not initialised"}))
                return

            result = await mgr.add_server(name, {"command": command, "args": args, "env": env})
            self.finish(json.dumps(result))
        except Exception as e:
            self.log.error("MCP add server error: %s", traceback.format_exc())
            self.set_status(500)
            self.finish(json.dumps({"error": str(e)}))

    @authenticated
    async def patch(self):
        """PATCH /varys/mcp/servers — toggle a server's disabled flag."""
        self.set_header("Content-Type", "application/json")
        try:
            body = json.loads(self.request.body.decode("utf-8"))
        except json.JSONDecodeError as exc:
            self.set_status(400)
            self.finish(json.dumps({"error": f"Invalid JSON body: {exc}"}))
            return

        try:
            name     = body.get("name", "").strip()
            disabled = bool(body.get("disabled", False))

            if not name:
                self.set_status(400)
                self.finish(json.dumps({"error": "'name' is required"}))
                return

            mgr = self.settings.get("ds_mcp_manager")
            if mgr is None:
                self.set_status(503)
                self.finish(json.dumps({"error": "MCPManager not initialised"}))
                return

            result = await mgr.toggle_server(name, disabled)
            self.finish(json.dumps(result))
        except Exception as e:
            self.log.error("MCP toggle server error: %s", traceback.format_exc())
            self.set_status(500)
            self.finish(json.dumps({"error": str(e)}))

    @authenticated
    async def delete(self):
        self.set_header("Content-Type", "application/json")
        try:
            body = json.loads(self.request.body.decode("utf-8"))
        except json.JSONDecodeError as exc:
            self.set_status(400)
            self.finish(json.dumps({"error": f"Invalid JSON body: {exc}"}))
            return

        try:
            name = body.get("name", "").strip()
            if not name:
                self.set_status(400)
                self.finish(json.dumps({"error": "'name' is required"}))
                return

            mgr = self.settings.get("ds_mcp_manager")
            if mgr is None:
                self.set_status(503)
                self.finish(json.dumps({"error": "MCPManager not initialised"}))
                return

            await mgr.remove_server(name)
            self.finish(json.dumps({"removed": name}))
        except Exception as e:
            self.log.error("MCP remove server error: %s", traceback.format_exc())
            self.set_status(500)
            self.finish(json.dumps({"error": str(e)}))

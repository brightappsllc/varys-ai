"""POST /varys/symbols — return symbols defined in cells up to the active cell.

Used by the frontend @-mention autocomplete.  The frontend sends the notebook
cell UUIDs *in notebook order, pre-filtered to cells at or before the active
cell*, so only variables that are reachable at the current cursor position are
suggested.

Request body (JSON):
  {
    "notebook_path": "relative/path/to/notebook.ipynb",
    "cell_ids":      ["<uuid1>", "<uuid2>", ...]   // ordered, already sliced
  }

When ``cell_ids`` is empty or omitted the handler falls back to the full
store order (all cells), preserving the original GET behaviour.

Response:
  { "symbols": [{"name": "df", "vtype": "DataFrame(1000, 5)"}, ...] }

Symbol order: notebook order, last definition wins for duplicate names.
"""
import json
import logging

from jupyter_server.base.handlers import JupyterHandler
from tornado.web import authenticated

log = logging.getLogger(__name__)


class SymbolsHandler(JupyterHandler):
    """Return live symbol names for @-mention autocomplete."""

    @authenticated
    def post(self) -> None:
        self.set_header("Content-Type", "application/json")

        try:
            body: dict = json.loads(self.request.body.decode())
        except (json.JSONDecodeError, UnicodeDecodeError):
            self.finish(json.dumps({"symbols": []}))
            return

        notebook_path = body.get("notebook_path", "")
        cell_ids: list[str] = body.get("cell_ids") or []

        if not notebook_path:
            self.finish(json.dumps({"symbols": []}))
            return

        root_dir = self.settings.get("ds_assistant_root_dir", ".")
        try:
            from ..context.summary_store import SummaryStore
            store   = SummaryStore(root_dir, notebook_path)
            current = store.get_all_current()   # {cell_id: summary}

            # Order to iterate: caller-supplied (already ≤ active cell) or
            # full store insertion order as fallback.
            if cell_ids:
                ordered = cell_ids
            else:
                ordered = [k for k in store._load().keys() if k != "_meta"]

            # Walk in order; last definition of each name wins.
            name_to_info: dict[str, dict] = {}
            for cell_id in ordered:
                summary = current.get(cell_id)
                if not summary:
                    continue
                sym_types = summary.get("symbol_types") or {}
                for name in summary.get("symbols_defined") or []:
                    name_to_info[name] = {
                        "name":  name,
                        "vtype": sym_types.get(name, ""),
                    }

            self.finish(json.dumps({"symbols": list(name_to_info.values())}))

        except Exception as exc:
            log.debug("SymbolsHandler error: %s", exc)
            self.finish(json.dumps({"symbols": []}))

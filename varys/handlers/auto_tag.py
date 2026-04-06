"""Auto-tag handler — infers cell tags using a small/fast LLM.

POST /varys/auto-tag
  body: { "cellSource": str, "cellOutput": str | null }
  response: { "tags": [str, ...] }   (0–3 tag values from library.json)
"""
import json
import logging
from pathlib import Path

from jupyter_server.base.handlers import JupyterHandler
from tornado.web import authenticated

log = logging.getLogger(__name__)

# Resolved once at module load; stays fixed for the lifetime of the server.
# library.json is the runtime source of truth; library.yaml is the human-editable
# source that can be re-compiled to JSON with: python -c "import json,yaml;
#   json.dump(yaml.safe_load(open('library.yaml')), open('library.json','w'), indent=2)"
_LIBRARY_PATH = Path(__file__).parent.parent / "tags" / "library.json"


# ── Library helpers ────────────────────────────────────────────────────────

def _load_library() -> dict:
    """Load library.json and return its parsed content.

    Falls back to a minimal hardcoded set if the file cannot be read,
    so auto-tagging degrades gracefully.
    """
    try:
        with open(_LIBRARY_PATH, encoding="utf-8") as fh:
            return json.load(fh) or {}
    except Exception as exc:
        log.warning("auto_tag: could not load tag library (%s) — using fallback", exc)
        return {
            "max_suggestions": 3,
            "tags": [
                {"value": "data-loading",  "topic": "ML Pipeline", "description": "Cells that load data."},
                {"value": "training",       "topic": "ML Pipeline", "description": "Model training."},
                {"value": "evaluation",     "topic": "ML Pipeline", "description": "Model evaluation."},
                {"value": "figure",         "topic": "Report",      "description": "Cell that generates a figure."},
                {"value": "todo",           "topic": "Quality",     "description": "Cell needs attention."},
            ],
        }


def _eligible_tags(library: dict) -> list[dict]:
    """Return only tags the LLM is allowed to suggest."""
    return [t for t in library.get("tags", []) if t.get("llm_eligible", True)]


# ── Prompt construction ────────────────────────────────────────────────────

def _build_prompt(
    cell_source: str,
    cell_output: str,
    library: dict,
) -> tuple[str, str]:
    """Return (system_prompt, user_message) for the tagging call."""
    eligible      = _eligible_tags(library)
    max_sug       = int(library.get("max_suggestions", 3))

    tag_lines = "\n".join(
        f"  {t['value']} ({t['topic']}): {t['description']}"
        for t in eligible
    )

    system = (
        "You are a tag selector for Jupyter notebook cells.\n"
        "Given a cell's source code and optional output, choose the most "
        "appropriate tags from the fixed list below.\n\n"
        "## Rules\n"
        f"- Return at most {max_sug} tags.\n"
        "- Use ONLY tag values that appear in the list — do NOT invent new ones.\n"
        "- When in doubt, return []. An empty list is always acceptable.\n"
        "- Respond with ONLY a valid JSON array of tag value strings.\n"
        "  No explanation, no markdown fences, no extra text.\n\n"
        "## Available tags\n"
        f"{tag_lines}"
    )

    parts = [f"Cell source:\n```\n{cell_source.strip()}\n```"]
    if cell_output and cell_output.strip():
        # Cap output to avoid blowing up the context
        parts.append(f"Cell output:\n```\n{cell_output.strip()[:1500]}\n```")
    parts.append("JSON array of tag values:")

    user = "\n\n".join(parts)
    return system, user


# ── Response parsing ───────────────────────────────────────────────────────

def _parse_response(raw: str, eligible_values: set[str], max_sug: int) -> list[str]:
    """Extract tag values from the LLM response string.

    Strips markdown fences if present, parses as JSON, then filters to only
    values that exist in *eligible_values*.  Returns [] on any parse error.
    """
    text = raw.strip()
    # Strip ```json ... ``` or ``` ... ``` fences
    if text.startswith("```"):
        lines = text.splitlines()
        text  = "\n".join(
            ln for ln in lines if not ln.startswith("```")
        ).strip()
    try:
        parsed = json.loads(text)
        if not isinstance(parsed, list):
            return []
        return [t for t in parsed if isinstance(t, str) and t in eligible_values][:max_sug]
    except Exception:
        return []


# ── Handler ────────────────────────────────────────────────────────────────

class AutoTagHandler(JupyterHandler):
    """GET  /varys/auto-tag — return the full tag library (presets + metadata).
    POST /varys/auto-tag — suggest tags for a single notebook cell.
    """

    @authenticated
    async def get(self) -> None:
        """Return library.json so the frontend can build presets dynamically."""
        library = _load_library()
        self.set_header("Content-Type", "application/json")
        self.finish(json.dumps(library))

    @authenticated
    async def post(self) -> None:
        # ── Parse body ──────────────────────────────────────────────────────
        try:
            body = json.loads(self.request.body)
        except json.JSONDecodeError:
            self.set_status(400)
            self.set_header("Content-Type", "application/json")
            self.finish(json.dumps({"error": "Invalid JSON body"}))
            return

        cell_source = (body.get("cellSource") or "").strip()
        cell_output = (body.get("cellOutput") or "").strip()

        if not cell_source:
            self.set_header("Content-Type", "application/json")
            self.finish(json.dumps({"tags": []}))
            return

        # ── Load tag library ─────────────────────────────────────────────────
        library       = _load_library()
        eligible      = _eligible_tags(library)
        eligible_vals = {t["value"] for t in eligible}
        max_sug       = int(library.get("max_suggestions", 3))

        # ── Build prompt ─────────────────────────────────────────────────────
        system, user = _build_prompt(cell_source, cell_output, library)

        # ── Resolve provider: background-task first, chat as fallback ───────────
        from ..llm.factory import create_bg_task_provider, create_provider

        provider = create_bg_task_provider(self.settings)
        if provider is None:
            try:
                provider = create_provider(self.settings, task="chat")
            except Exception as exc:
                log.warning("auto_tag: no LLM provider available — %s", exc)
                self.set_header("Content-Type", "application/json")
                self.finish(json.dumps({"tags": [], "error": "No LLM provider configured"}))
                return

        # ── Call LLM ─────────────────────────────────────────────────────────
        try:
            raw  = await provider.chat(system=system, user=user)
            tags = _parse_response(raw, eligible_vals, max_sug)
            log.debug("auto_tag: source=%r → tags=%r", cell_source[:60], tags)
        except Exception as exc:
            log.warning("auto_tag: LLM call failed — %s", exc)
            tags = []

        self.set_header("Content-Type", "application/json")
        self.finish(json.dumps({"tags": tags}))

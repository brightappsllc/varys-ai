"""Synchronous (non-SSE) task handler for the %%ai magic command.

POST /varys/magic
Request body:
  {
    "message":        str,
    "dataframes":     list[DataFrameSchema],   # from kernel namespace
    "model_override": str | null,
    "skill_override": str | null
  }

Response:
  {
    "text":          str,   # markdown response from LLM
    "model_used":    str,
    "provider_used": str,
    "skills_used":   list[str]
  }

Unlike the main /task endpoint, this handler:
  - Uses the provider's .chat() method (free-form text, no tool calls)
  - Returns a plain JSON response (no SSE streaming)
  - Accepts DataFrame metadata sent directly from the kernel namespace
    (more efficient than the frontend's kernel.requestExecute approach)
"""
from __future__ import annotations

import json
import logging

from jupyter_server.base.handlers import JupyterHandler

from ..llm.context_utils import format_dataframe_context
from ..llm.factory import create_provider
from ..memory.manager import MemoryManager
from ..skills.loader import SkillLoader

log = logging.getLogger(__name__)

# ── System prompt for the magic (advisory / conversational mode) ──────────────

_MAGIC_SYSTEM_TEMPLATE = """\
You are an expert data scientist and Python developer embedded in a JupyterLab notebook.
The user is running you via the %%ai cell magic, so your response will be rendered
as Markdown directly in the cell output.

Guidelines:
- Answer clearly and concisely.
- Use Markdown formatting: headers, bullet lists, bold, italics where helpful.
- For code snippets, always wrap them in fenced code blocks (```python … ```).
- Do NOT insert or modify any notebook cells — your output is the cell output.
- Tailor suggestions to the exact variable/column names visible in the
  live DataFrame context (if provided).
- Never invent column names that are not in the context.

{skills_section}

{memory_section}
"""


def _build_system(skills: list[dict], memory: str) -> str:
    skills_section = ""
    if skills:
        skill_texts = "\n\n".join(
            f"### Skill: {s.get('name', '?')}\n{s.get('content', '')}"
            for s in skills
        )
        skills_section = f"## Active Skills\n\n{skill_texts}"

    memory_section = ""
    if memory and memory.strip():
        memory_section = f"## User Preferences & Memory\n\n{memory}"

    return _MAGIC_SYSTEM_TEMPLATE.format(
        skills_section=skills_section,
        memory_section=memory_section,
    ).strip()


def _build_user(message: str, dataframes: list[dict]) -> str:
    df_section = format_dataframe_context(dataframes)
    if df_section:
        return f"{message}\n\n{df_section}"
    return message


# ── Handler ───────────────────────────────────────────────────────────────────

class MagicTaskHandler(JupyterHandler):
    """Synchronous chat endpoint for the %%ai IPython magic."""

    async def post(self) -> None:
        try:
            body: dict = json.loads(self.request.body.decode())
        except json.JSONDecodeError:
            self.set_status(400)
            self.finish(json.dumps({"error": "Invalid JSON body"}))
            return

        message: str = body.get("message", "").strip()
        if not message:
            self.set_status(400)
            self.finish(json.dumps({"error": "'message' is required"}))
            return

        dataframes: list[dict] = body.get("dataframes") or []
        model_override: str | None = body.get("model_override") or None
        skill_override: str | None = body.get("skill_override") or None

        root_dir: str = self.settings.get("ds_assistant_root_dir", ".")

        # ── Skills ────────────────────────────────────────────────────────────
        skill_loader: SkillLoader = (
            self.settings.get("ds_assistant_skill_loader")
            or SkillLoader(root_dir=root_dir)
        )

        if skill_override:
            # Load by exact name; fall back to keyword-matching if not found
            skill = skill_loader._make_skill(skill_override)  # noqa: SLF001
            skills = [skill] if skill.get("content") else skill_loader.load_relevant_skills(message)
        else:
            skills = skill_loader.load_relevant_skills(message)

        skill_names = [s.get("name", "") for s in skills if s.get("name")]

        # ── Memory ────────────────────────────────────────────────────────────
        memory = MemoryManager(root_dir=root_dir).load()

        # ── Provider ──────────────────────────────────────────────────────────
        # Temporarily override the model in settings if requested
        settings = self.settings
        if model_override:
            # Shallow-copy settings and patch the chat model key for this request
            provider_name = settings.get("ds_assistant_chat_provider", "anthropic")
            settings = dict(settings)
            settings[f"ds_assistant_{provider_name}_chat_model"] = model_override
        else:
            provider_name = settings.get("ds_assistant_chat_provider", "anthropic")

        provider = create_provider(settings, task="chat")

        # ── Build prompt ──────────────────────────────────────────────────────
        system = _build_system(skills, memory)
        user = _build_user(message, dataframes)

        # ── LLM call (blocking, no streaming) ────────────────────────────────
        try:
            response_text = await provider.chat(
                system=system,
                user=user,
                chat_history=[],
            )
        except Exception as exc:
            log.error("Varys magic task error: %s", exc, exc_info=True)
            self.set_status(500)
            self.finish(json.dumps({"error": str(exc)}))
            return

        model_used = getattr(provider, "_model", "") or getattr(provider, "model", "") or ""

        self.set_header("Content-Type", "application/json")
        self.finish(json.dumps({
            "text": response_text,
            "model_used": model_used,
            "provider_used": provider_name,
            "skills_used": skill_names,
        }))

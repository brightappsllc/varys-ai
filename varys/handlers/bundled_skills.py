"""Bundled skills handler — list and import factory-default skills.

Skills are shipped inside the Python package at:
  varys/bundled_skills/<name>/SKILL.md
                              README.md   (optional)

GET  /varys/bundled-skills
    Returns the full catalogue: name, description, command, whether it is
    already present in the global ~/.jupyter/skills/ directory.

POST /varys/bundled-skills
    Body: {"name": "<skill_name>", "notebookPath": "..."}
    Copies the bundled skill into the global ~/.jupyter/skills/<name>/ so that
    it is immediately visible in the Skills UI and available to the loader.
    Skips if a skill with the same name already exists (safe by default);
    pass {"overwrite": true} to replace it.
"""
import json
import shutil
from pathlib import Path

from jupyter_server.base.handlers import JupyterHandler
from tornado.web import authenticated

from ..skills.loader import _parse_front_matter


# Bundled skills live next to this handler file.
_BUNDLED_DIR = Path(__file__).parent.parent / "bundled_skills"

# Global skills directory — same root used by skills.py and the loader.
_GLOBAL_SKILLS_DIR = Path.home() / ".jupyter" / "skills"


def _bundled_skill_meta(name: str) -> dict:
    """Return metadata dict for one bundled skill."""
    skill_file = _BUNDLED_DIR / name / "SKILL.md"
    readme_file = _BUNDLED_DIR / name / "README.md"
    meta = {}
    description = None
    command = None
    if skill_file.exists():
        try:
            meta, _ = _parse_front_matter(skill_file.read_text(encoding="utf-8"))
            command = str(meta.get("command", "")).strip() or None
            description = str(meta.get("description", "")).strip() or None
        except Exception:
            pass
    return {
        "name": name,
        "command": command,
        "description": description,
        "hasReadme": readme_file.exists(),
    }


def _list_bundled() -> list:
    """Return all bundled skills, annotated with whether they are imported."""
    if not _BUNDLED_DIR.exists():
        return []
    installed = {
        d.name
        for d in _GLOBAL_SKILLS_DIR.iterdir()
        if d.is_dir() and (d / "SKILL.md").exists()
    } if _GLOBAL_SKILLS_DIR.exists() else set()

    result = []
    for entry in sorted(_BUNDLED_DIR.iterdir()):
        if entry.is_dir() and (entry / "SKILL.md").exists():
            meta = _bundled_skill_meta(entry.name)
            meta["imported"] = entry.name in installed
            result.append(meta)
    return result


class BundledSkillsHandler(JupyterHandler):
    """GET  → catalogue of bundled skills.
       POST → import one bundled skill into the global skills directory.
    """

    @authenticated
    def get(self):
        self.set_header("Content-Type", "application/json")
        self.finish(json.dumps({"bundled": _list_bundled()}))

    @authenticated
    def post(self):
        self.set_header("Content-Type", "application/json")
        try:
            body = json.loads(self.request.body)
        except json.JSONDecodeError:
            self.set_status(400)
            self.finish(json.dumps({"error": "Invalid JSON"}))
            return

        name = str(body.get("name", "")).strip()
        overwrite = bool(body.get("overwrite", False))

        if not name or not (src := _BUNDLED_DIR / name).is_dir():
            self.set_status(404)
            self.finish(json.dumps({"error": f"Bundled skill '{name}' not found"}))
            return

        dest = _GLOBAL_SKILLS_DIR / name
        dest.parent.mkdir(parents=True, exist_ok=True)

        if dest.exists() and not overwrite:
            self.finish(json.dumps({"status": "already_exists", "name": name}))
            return

        if dest.exists():
            shutil.rmtree(dest)
        shutil.copytree(src, dest)

        # Refresh the in-memory skill cache so the new skill is available immediately.
        loader = self.settings.get("ds_assistant_skill_loader")
        if loader is not None:
            loader.refresh()

        self.finish(json.dumps({"status": "ok", "name": name}))

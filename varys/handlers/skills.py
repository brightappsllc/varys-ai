"""Skills handler

Storage layout (global — same regardless of which project is open):
  ~/.jupyter/skills/
    <name>/
      SKILL.md    ← LLM-facing skill content
      README.md   ← optional user documentation

GET  /varys/skills               → list all skills with enabled status + command
POST /varys/skills               → refresh loader cache; return fresh list
GET  /varys/skills/{name}        → read SKILL.md + README.md content + enabled flag
POST /varys/skills/{name}        → update SKILL.md and/or README.md and/or enabled state
                                           (validates command: field for collisions before saving)

GET  /varys/commands             → return all slash commands (built-ins + skill commands)

The enabled/disabled state is stored in ~/.jupyter/varys_skills.env as DS_SKILLS_DISABLED=a,b,c
"""
import json
import os
import re
from pathlib import Path
from typing import Optional

from jupyter_server.base.handlers import JupyterHandler
from tornado.web import authenticated

from ..skills.loader import BUILTIN_COMMANDS, _parse_front_matter


def _skills_dir(_settings: dict = None, _notebook_path: str = "") -> Path:
    """Global skills directory — always ~/.jupyter/skills/ regardless of project."""
    return Path.home() / ".jupyter" / "skills"


def _env_path(_settings: dict = None) -> Path:
    """Global disabled-skills state — ~/.jupyter/varys_skills.env."""
    path = Path.home() / ".jupyter" / "varys_skills.env"
    path.parent.mkdir(parents=True, exist_ok=True)
    return path


def _get_disabled(_settings: dict = None) -> set:
    raw = os.environ.get("DS_SKILLS_DISABLED", "")
    return {s.strip() for s in raw.split(",") if s.strip()}


def _save_disabled(disabled: set, env_path: Path) -> None:
    val = ",".join(sorted(disabled))
    if not env_path.exists():
        env_path.write_text(f"DS_SKILLS_DISABLED={val}\n", encoding="utf-8")
        os.environ["DS_SKILLS_DISABLED"] = val
        return

    lines = env_path.read_text(encoding="utf-8").splitlines()
    found = False
    new_lines = []
    for line in lines:
        if re.match(r"^DS_SKILLS_DISABLED\s*=", line):
            new_lines.append(f"DS_SKILLS_DISABLED={val}")
            found = True
        else:
            new_lines.append(line)
    if not found:
        new_lines.append(f"DS_SKILLS_DISABLED={val}")

    env_path.write_text("\n".join(new_lines) + "\n", encoding="utf-8")
    os.environ["DS_SKILLS_DISABLED"] = val


def _safe_name(name: str) -> bool:
    """Only allow alphanumeric, underscore, hyphen — prevents path traversal."""
    return bool(re.fullmatch(r"[\w\-]+", name))


def _parse_command_from_content(content: str) -> Optional[str]:
    """Extract the command: field from SKILL.md front matter, if present."""
    meta, _ = _parse_front_matter(content)
    cmd = str(meta.get("command", "")).strip().lower()
    return cmd if cmd.startswith("/") else None


def _all_skill_commands(skills_dir: Path) -> dict:
    """Scan all SKILL.md files and return {command: skill_name} map."""
    cmd_map = {}
    if not skills_dir.exists():
        return cmd_map
    for entry in sorted(skills_dir.iterdir()):
        if not entry.is_dir():
            continue
        skill_file = entry / "SKILL.md"
        if not skill_file.exists():
            continue
        try:
            cmd = _parse_command_from_content(skill_file.read_text(encoding="utf-8"))
            if cmd:
                cmd_map[cmd] = entry.name
        except Exception:
            pass
    return cmd_map


def _list_skills(settings: dict = None, notebook_path: str = "") -> dict:
    """Shared helper used by both GET and POST on the list endpoint."""
    d = _skills_dir()
    disabled = _get_disabled(settings)
    skills = []
    if d.exists():
        for entry in sorted(d.iterdir()):
            if entry.is_dir() and (entry / "SKILL.md").exists():
                name = entry.name
                try:
                    content = (entry / "SKILL.md").read_text(encoding="utf-8")
                    meta, _ = _parse_front_matter(content)
                    cmd  = str(meta.get("command", "")).strip() or None
                    desc = str(meta.get("description", "")).strip() or None
                except Exception:
                    cmd, desc = None, None
                skills.append({
                    "name": name,
                    "enabled": name not in disabled,
                    "command": cmd,
                    "description": desc,
                })
    return {"skills": skills, "skills_dir": str(d)}


class SkillsListHandler(JupyterHandler):
    """GET  → return all skills with name + enabled flag.
       POST → refresh the in-memory skill cache then return the fresh list.
    """

    @authenticated
    def get(self):
        nb = self.get_query_argument("notebookPath", "")
        self.set_header("Content-Type", "application/json")
        self.finish(json.dumps(_list_skills(self.settings, nb)))

    @authenticated
    def post(self):
        """Refresh the loader cache and return the updated skill list."""
        nb = self.get_query_argument("notebookPath", "")
        self.set_header("Content-Type", "application/json")
        loader = self.settings.get("ds_assistant_skill_loader")
        if loader is not None:
            loader.refresh()
        self.finish(json.dumps(_list_skills(self.settings, nb)))


class SkillHandler(JupyterHandler):
    """GET  /skills/{name} → read SKILL.md + README.md content + enabled.
       POST /skills/{name} → save SKILL.md and/or README.md and/or toggle enabled.
    """

    @authenticated
    def get(self, name):
        self.set_header("Content-Type", "application/json")
        if not _safe_name(name):
            self.set_status(400)
            self.finish(json.dumps({"error": "Invalid skill name"}))
            return

        skill_dir = _skills_dir() / name
        skill_file = skill_dir / "SKILL.md"
        if not skill_file.exists():
            self.set_status(404)
            self.finish(json.dumps({"error": f"Skill '{name}' not found"}))
            return

        readme_file = skill_dir / "README.md"
        disabled = _get_disabled(self.settings)
        self.finish(json.dumps({
            "name": name,
            "content": skill_file.read_text(encoding="utf-8"),
            "readme": readme_file.read_text(encoding="utf-8") if readme_file.exists() else "",
            "enabled": name not in disabled,
        }))

    @authenticated
    def post(self, name):
        self.set_header("Content-Type", "application/json")
        if not _safe_name(name):
            self.set_status(400)
            self.finish(json.dumps({"error": "Invalid skill name"}))
            return

        try:
            body = json.loads(self.request.body)
        except json.JSONDecodeError:
            self.set_status(400)
            self.finish(json.dumps({"error": "Invalid JSON"}))
            return

        skill_dir = _skills_dir() / name
        skill_dir.mkdir(parents=True, exist_ok=True)

        if "content" in body:
            new_content = str(body["content"])
            # Collision check before writing: if a command: field is present,
            # ensure no other skill already owns that command.
            new_cmd = _parse_command_from_content(new_content)
            if new_cmd:
                if new_cmd in BUILTIN_COMMANDS:
                    self.set_status(409)
                    self.finish(json.dumps({
                        "error": f"'{new_cmd}' is a built-in command and cannot be used by a skill"
                    }))
                    return
                cmd_map = _all_skill_commands(_skills_dir())
                owner = cmd_map.get(new_cmd)
                if owner and owner != name:
                    self.set_status(409)
                    self.finish(json.dumps({
                        "error": f"Command '{new_cmd}' is already used by skill '{owner}'"
                    }))
                    return
            (skill_dir / "SKILL.md").write_text(new_content, encoding="utf-8")

        if "readme" in body:
            (skill_dir / "README.md").write_text(str(body["readme"]), encoding="utf-8")

        if "enabled" in body:
            disabled = _get_disabled(self.settings)
            if body["enabled"]:
                disabled.discard(name)
            else:
                disabled.add(name)
            _save_disabled(disabled, _env_path())

        # Refresh the in-memory skill cache so the change takes effect immediately.
        loader = self.settings.get("ds_assistant_skill_loader")
        if loader is not None:
            loader.refresh()

        self.finish(json.dumps({"status": "ok", "name": name}))


class CommandsHandler(JupyterHandler):
    """GET /varys/commands → all slash commands (built-ins + skills)."""

    @authenticated
    def get(self):
        self.set_header("Content-Type", "application/json")
        loader = self.settings.get("ds_assistant_skill_loader")
        if loader is not None:
            commands = loader.list_commands()
        else:
            # Fallback: built-ins only if loader not available
            commands = [
                {"command": cmd, "description": desc, "type": "builtin"}
                for cmd, desc in BUILTIN_COMMANDS.items()
            ]
        self.finish(json.dumps({"commands": commands}))

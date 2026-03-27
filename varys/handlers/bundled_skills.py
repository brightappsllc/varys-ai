"""Bundled skills handler — list and import factory-default skills.

Skills are shipped inside the Python package at:
  varys/bundled_skills/<name>/SKILL.md
                              README.md   (optional)

The canonical storage location for ALL skills (imported or user-created) is:
  ~/.jupyter/skills/<name>/

GET  /varys/bundled-skills
    Returns the full catalogue: name, description, command, whether it is
    already present in the global ~/.jupyter/skills/ directory.

POST /varys/bundled-skills
    Body: {"name": "<skill_name>", "notebookPath": "...", "overwrite": false}
    Copies the bundled skill into the global ~/.jupyter/skills/<name>/ and
    validates the copy.  If the destination folder already exists but is empty
    or corrupt (no SKILL.md), the import proceeds as if the folder were absent.
    Pass {"overwrite": true} to force-replace a valid existing import.
    Returns detailed error messages on failure so the UI can surface them.
"""
import hashlib
import json
import logging
import shutil
from pathlib import Path

from jupyter_server.base.handlers import JupyterHandler
from tornado.web import authenticated

from ..skills.loader import _parse_front_matter

log = logging.getLogger(__name__)

# Bundled skills live next to this handler file.
_BUNDLED_DIR = Path(__file__).parent.parent / "bundled_skills"

# Global skills directory — single canonical location for all user skills.
_GLOBAL_SKILLS_DIR = Path.home() / ".jupyter" / "skills"

# Legacy per-project location written by older Varys versions.  We clean it up
# during import so stale files do not confuse the loader.
_LEGACY_SUBDIR = ".jupyter-assistant" / Path("skills")


def _file_sha256(path: Path) -> str:
    """Return the SHA-256 hex digest of a file's contents."""
    h = hashlib.sha256()
    h.update(path.read_bytes())
    return h.hexdigest()


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


def _dest_is_valid(dest: Path) -> bool:
    """Return True only when the destination folder contains a non-empty SKILL.md."""
    skill = dest / "SKILL.md"
    return dest.is_dir() and skill.exists() and skill.stat().st_size > 0


def _list_bundled() -> list:
    """Return all bundled skills, annotated with whether they are imported."""
    if not _BUNDLED_DIR.exists():
        return []
    installed = {
        d.name
        for d in _GLOBAL_SKILLS_DIR.iterdir()
        if _dest_is_valid(d)
    } if _GLOBAL_SKILLS_DIR.exists() else set()

    result = []
    for entry in sorted(_BUNDLED_DIR.iterdir()):
        if entry.is_dir() and (entry / "SKILL.md").exists():
            meta = _bundled_skill_meta(entry.name)
            meta["imported"] = entry.name in installed
            result.append(meta)
    return result


def _cleanup_legacy(name: str, notebook_path: str) -> None:
    """Remove stale skill files from the old per-project location, if present."""
    if not notebook_path:
        return
    notebook_dir = Path(notebook_path).parent
    legacy_dir = notebook_dir / _LEGACY_SUBDIR / name
    if legacy_dir.exists():
        try:
            shutil.rmtree(legacy_dir)
            log.info(
                "Varys skills: removed legacy skill copy at %s (files are now in ~/.jupyter/skills/)",
                legacy_dir,
            )
        except Exception as exc:
            log.warning("Varys skills: could not remove legacy skill dir %s — %s", legacy_dir, exc)


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
        notebook_path = str(body.get("notebookPath", "")).strip()

        if not name or not (src := _BUNDLED_DIR / name).is_dir():
            self.set_status(404)
            self.finish(json.dumps({"error": f"Bundled skill '{name}' not found"}))
            return

        src_skill = src / "SKILL.md"
        if not src_skill.exists():
            self.set_status(500)
            self.finish(json.dumps({"error": f"Bundled skill '{name}' is missing SKILL.md — package may be corrupt"}))
            return

        dest = _GLOBAL_SKILLS_DIR / name

        # A folder that exists but lacks a valid SKILL.md is treated as an
        # incomplete/failed previous import and re-imported unconditionally.
        dest_valid = _dest_is_valid(dest)
        if dest_valid and not overwrite:
            self.finish(json.dumps({"status": "already_exists", "name": name}))
            return

        # Ensure the parent directory exists.
        _GLOBAL_SKILLS_DIR.mkdir(parents=True, exist_ok=True)

        # Remove the destination (valid or corrupt) before copying.
        if dest.exists():
            try:
                shutil.rmtree(dest)
            except Exception as exc:
                self.set_status(500)
                self.finish(json.dumps({"error": f"Could not remove existing skill folder: {exc}"}))
                return

        # Copy bundled skill to the global location.
        try:
            shutil.copytree(src, dest)
        except Exception as exc:
            self.set_status(500)
            self.finish(json.dumps({"error": f"Failed to copy skill '{name}': {exc}"}))
            return

        # Post-copy validation: verify SKILL.md exists and content matches source.
        errors: list[str] = []
        dest_skill = dest / "SKILL.md"
        if not dest_skill.exists():
            errors.append("SKILL.md is missing after copy")
        elif dest_skill.stat().st_size == 0:
            errors.append("SKILL.md is empty after copy")
        else:
            try:
                if _file_sha256(src_skill) != _file_sha256(dest_skill):
                    errors.append("SKILL.md content mismatch after copy (file may be corrupt)")
            except Exception as exc:
                errors.append(f"Could not verify SKILL.md integrity: {exc}")

        # Check README if the source has one.
        src_readme = src / "README.md"
        if src_readme.exists():
            dest_readme = dest / "README.md"
            if not dest_readme.exists():
                errors.append("README.md is missing after copy")
            elif _file_sha256(src_readme) != _file_sha256(dest_readme):
                errors.append("README.md content mismatch after copy")

        if errors:
            # Clean up the failed/corrupt destination.
            try:
                shutil.rmtree(dest)
            except Exception:
                pass
            error_msg = f"Import of '{name}' failed validation: " + "; ".join(errors)
            log.error("Varys skills: %s", error_msg)
            self.set_status(500)
            self.finish(json.dumps({"error": error_msg}))
            return

        # Clean up any stale legacy files from the old per-project location.
        _cleanup_legacy(name, notebook_path)

        # Refresh the in-memory skill cache so the new skill is available immediately.
        loader = self.settings.get("ds_assistant_skill_loader")
        if loader is not None:
            loader.refresh()

        log.info("Varys skills: imported bundled skill '%s' → %s", name, dest)
        self.finish(json.dumps({"status": "ok", "name": name}))

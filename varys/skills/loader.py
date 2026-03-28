"""Dynamic 3-tier skills loader for DS Assistant.

Storage layout (per skill):
  .jupyter-assistant/skills/
    <name>/
      SKILL.md    ← content injected into the LLM system prompt
      README.md   ← optional user-facing documentation (not sent to LLM)

Tier 1 — always injected into the system prompt
  • Any enabled skill folder whose name is NOT in the Tier-2 keyword map.

Tier 2 — auto-detected from user-message keywords
  • Any enabled skill folder whose name IS in TIER2_KEYWORDS.
  • Injected only when the user message matches at least one keyword.

Tier 3 — explicit reference ("use the X skill")
  • Any enabled skill folder named X, loaded on-demand.

Disabled skills
  • Read from DS_SKILLS_DISABLED env-var (comma-separated names).
  • Also controlled via the Skills UI which writes that env-var.

All SKILL.md content is cached in memory once (at preload time) and
refreshed only when explicitly invalidated.
"""
import logging
import os
import re
from pathlib import Path
from typing import Dict, List, Optional

log = logging.getLogger(__name__)

# Bundled skills shipped inside the package (always available, no import needed).
_BUNDLED_SKILLS_DIR = Path(__file__).parent.parent / "bundled_skills"

# Legacy Tier-2 keyword map.
#
# ⚠️  DEPRECATED — do not add new entries here.
#
# The preferred way to declare trigger keywords is in the skill's own SKILL.md
# front matter:
#
#   ---
#   cell_insertion_mode: auto
#   keywords: [eda, exploratory, visualiz]
#   ---
# Skills are self-describing via SKILL.md front matter:
#   - keywords: [...] → Tier 2 (keyword-triggered, no command)
#   - command: /cmd   → loaded only via slash command
#   - neither         → Tier 1 (always loaded)
# The old TIER2_KEYWORDS fallback dict has been removed.  All current skills
# declare their keywords directly in their SKILL.md front matter.


def _parse_front_matter(content: str):
    """Parse optional YAML-like front matter delimited by --- at the top of a file.

    Returns (metadata: dict, body: str).

    Supported value types
    ─────────────────────
    Scalar:   key: value          → str / bool / int / float
    Inline list: keywords: [a, b, c]   → list[str]
    Block list (YAML-style):
        keywords:
          - a
          - b                     → list[str]

    Example front matter::

        ---
        cell_insertion_mode: auto
        keywords: [readme, overview, describe the notebook]
        ---
        # Skill content…
    """
    if not content.startswith("---"):
        return {}, content

    end = content.find("\n---", 3)
    if end == -1:
        return {}, content

    fm_text = content[3:end].strip()
    body    = content[end + 4:].lstrip("\n")

    metadata: Dict[str, object] = {}
    lines = fm_text.splitlines()
    i = 0
    while i < len(lines):
        line = lines[i].strip()
        i += 1
        if not line or line.startswith("#"):
            continue
        if ":" not in line:
            continue
        key, _, val = line.partition(":")
        key = key.strip()
        val = val.strip()

        # Inline list:  key: [item1, item2, item3]
        if val.startswith("[") and val.endswith("]"):
            items = [v.strip().strip('"').strip("'")
                     for v in val[1:-1].split(",") if v.strip()]
            metadata[key] = items
            continue

        # Block list: key: (empty val, next lines are "  - item")
        if val == "":
            block_items = []
            while i < len(lines):
                peek = lines[i]
                stripped = peek.strip()
                if stripped.startswith("- "):
                    block_items.append(stripped[2:].strip().strip('"').strip("'"))
                    i += 1
                elif stripped == "" or not peek.startswith(" "):
                    break
                else:
                    break
            if block_items:
                metadata[key] = block_items
                continue
            # Empty value, not a list — fall through

        # Scalar
        if val.lower() == "true":
            metadata[key] = True
        elif val.lower() == "false":
            metadata[key] = False
        else:
            for coerce in (int, float):
                try:
                    metadata[key] = coerce(val)
                    break
                except ValueError:
                    pass
            else:
                metadata[key] = val

    return metadata, body


# ── Built-in slash commands ────────────────────────────────────────────────
# These are handled entirely by the frontend and can NEVER be claimed by a
# skill SKILL.md.  Keys are lowercase (matching after lowercasing input).
BUILTIN_COMMANDS: Dict[str, str] = {
    "/help":              "Show all available commands",
    "/skills":            "List installed skills and their commands",
    "/chat":              "Answer in the chat window only — no notebook cells created (e.g. /chat compute the diff for this table…)",
    "/ask":               "Search the knowledge base (RAG) and answer using indexed documents",
    "/learn":             "Save a preference or fact to long-term memory",
    "/index":             "Index files in .jupyter-assistant/knowledge/ (or a sub-path inside it)",
    "/rag":               "Show knowledge-base status (indexed files, total chunks)",
    "/clear":             "Start a new chat thread",
    "/no_figures":        "Exclude all notebook figures/plots from the next messages sent to the LLM",
    "/resize":            "Downscale figures before sending — /resize(DIM) sets the max pixel dimension (e.g. /resize(7800))",
    "/file_agent":       "Read, write, and edit project files with Varys File Agent",
    "/file_agent_find":  "Search and read project files with Varys File Agent (read-only)",
    "/file_agent_save":  "Read and write project files with Varys File Agent",
}


class SkillLoader:
    """Scans .jupyter-assistant/skills/ subdirectories and caches SKILL.md content."""

    def __init__(self, root_dir: str, notebook_path: str = "") -> None:
        self.root_dir      = Path(root_dir)
        self.notebook_path = notebook_path
        self.skills_dir    = self._find_skills_dir()
        # name → SKILL.md content (front matter stripped)
        self._cache: Dict[str, str] = {}
        # name → front matter metadata dict
        self._meta:  Dict[str, Dict[str, object]] = {}
        self._scanned = False
        # /command → skill name (built once during preload, checked for collisions)
        self._command_map: Dict[str, str] = {}
        # mtime of skills_dir at last preload — used to detect newly-added skills
        self._skills_dir_mtime: Optional[float] = None
        # per-file mtimes — used by _make_skill to detect edits to existing files
        self._file_mtimes: Dict[str, float] = {}

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def preload(self) -> None:
        """Eagerly read every enabled SKILL.md into the cache.

        Also builds ``_command_map`` (/command → skill name) and detects
        collisions (two skills claiming the same command, or a skill trying
        to claim a built-in command).

        Called once at server startup from app.initialize_settings().
        """
        if self.skills_dir is None or not self.skills_dir.exists():
            log.info("Varys skills: directory not found at %s", self._expected_dir())
            return

        disabled = self._get_disabled()
        new_command_map: Dict[str, str] = {}
        loaded = []

        for entry in sorted(self.skills_dir.iterdir()):
            if not entry.is_dir():
                continue
            skill_file = entry / "SKILL.md"
            if not skill_file.exists():
                continue
            name = entry.name
            if name in disabled:
                log.debug("Varys skills: skipping disabled skill %s", name)
                continue
            try:
                raw = skill_file.read_text(encoding="utf-8")
                meta, body = _parse_front_matter(raw)
                self._cache[name] = body
                self._meta[name]  = meta

                # Register command if declared
                cmd = str(meta.get("command", "")).strip().lower() if meta.get("command") else ""
                if cmd:
                    if cmd in BUILTIN_COMMANDS:
                        log.warning(
                            "Varys skills: skill '%s' tries to claim built-in command"
                            " '%s' — ignoring", name, cmd
                        )
                    elif cmd in new_command_map:
                        log.warning(
                            "Varys skills: command '%s' collision — "
                            "claimed by both '%s' and '%s'; '%s' wins",
                            cmd, new_command_map[cmd], name, new_command_map[cmd],
                        )
                    else:
                        new_command_map[cmd] = name

                loaded.append(name)
            except Exception as exc:
                log.warning("Varys skills: could not read %s — %s", skill_file, exc)

        self._command_map = new_command_map
        self._scanned = True
        # Record directory mtime so list_commands() can auto-detect new additions.
        try:
            self._skills_dir_mtime = self.skills_dir.stat().st_mtime
        except OSError:
            self._skills_dir_mtime = None
        log.info(
            "Varys skills: pre-loaded %d skill(s): %s; commands: %s",
            len(loaded), loaded, list(new_command_map.keys()),
        )

    def refresh(self) -> None:
        """Force a cache refresh (re-read all files from disk)."""
        self._cache.clear()
        self._meta.clear()
        self._command_map.clear()
        self._file_mtimes.clear()
        self._scanned = False
        self._skills_dir_mtime = None
        self.skills_dir = self._find_skills_dir()
        self.preload()

    # ------------------------------------------------------------------
    # Command-based public API
    # ------------------------------------------------------------------

    def load_by_command(self, command: str) -> List[Dict[str, str]]:
        """Return Tier-1 skills PLUS the skill registered for *command*.

        ``command`` must start with ``/`` (e.g. "/eda").  If no skill is
        registered for the command an empty list is returned (Tier-1 skills
        are still included — they are returned regardless).

        The skill mapped to the command is tagged ``tier=2`` in the output
        so callers can identify it.
        """
        if not self._scanned:
            self.preload()

        disabled  = self._get_disabled()
        cmd_lower = command.strip().lower()

        result: List[Dict[str, str]] = []
        loaded_names: set = set()

        # Always include Tier-1 skills (no keywords, no command)
        tier1_names = sorted(
            n for n in self._cache
            if not self._keywords_for(n) and not self._command_for(n)
        )
        for name in tier1_names:
            if name not in disabled:
                result.append(self._make_skill(name, tier=1))
                loaded_names.add(name)

        # Add the skill that owns this command (project-level first)
        skill_name = self._command_map.get(cmd_lower)
        if skill_name and skill_name not in loaded_names and skill_name not in disabled:
            result.append(self._make_skill(skill_name, tier=2))
            log.debug("Varys skills: command '%s' → project skill '%s'", cmd_lower, skill_name)
        elif not skill_name:
            # Fall back to bundled skills — works without manual import
            bundled_skill = self._load_bundled_by_command(cmd_lower)
            if bundled_skill:
                result.append(bundled_skill)
                loaded_names.add(bundled_skill["name"])
                log.debug("Varys skills: command '%s' → bundled skill '%s'",
                          cmd_lower, bundled_skill["name"])
            else:
                log.warning("Varys skills: unknown command '%s'", cmd_lower)

        # Always include Tier-1 bundled skills (no keywords, no command) so rules
        # like safe_operations are injected regardless of how the skill is triggered.
        result.extend(self._load_bundled_tier1(loaded_names, disabled))

        return result

    def _load_bundled_by_command(self, command: str) -> Optional[Dict[str, str]]:
        """Return a skill dict for a bundled skill that declares *command*, or None."""
        if not _BUNDLED_SKILLS_DIR.exists():
            return None
        for entry in sorted(_BUNDLED_SKILLS_DIR.iterdir()):
            if not entry.is_dir():
                continue
            skill_file = entry / "SKILL.md"
            if not skill_file.exists():
                continue
            try:
                meta, body = _parse_front_matter(skill_file.read_text(encoding="utf-8"))
                cmd = str(meta.get("command", "")).strip().lower()
                if cmd == command:
                    return {"name": entry.name, "content": body, "tier": 2}
            except Exception:
                pass
        return None

    def _iter_bundled(self):
        """Yield (name, meta, body) for every valid bundled skill entry."""
        if not _BUNDLED_SKILLS_DIR.exists():
            return
        for entry in sorted(_BUNDLED_SKILLS_DIR.iterdir()):
            if not entry.is_dir():
                continue
            skill_file = entry / "SKILL.md"
            if not skill_file.exists():
                continue
            try:
                meta, body = _parse_front_matter(skill_file.read_text(encoding="utf-8"))
                yield entry.name, meta, body
            except Exception:
                pass

    def _load_bundled_tier1(self, loaded_names: set, disabled: set) -> List[Dict[str, str]]:
        """Return Tier-1 bundled skills (no keywords, no command) not already loaded.

        Bundled Tier-1 skills are automatically injected into every request
        without any manual import step.  User-imported skills with the same
        name take precedence and are skipped here.
        """
        result = []
        for name, meta, body in self._iter_bundled():
            if name in loaded_names or name in disabled:
                continue
            kws = meta.get("keywords")
            cmd = str(meta.get("command", "")).strip().lower()
            has_keywords = isinstance(kws, list) and kws
            if not has_keywords and not cmd:
                result.append({"name": name, "content": body, "tier": 1})
                loaded_names.add(name)
        return result

    def _load_bundled_by_keywords(
        self, msg_lower: str, loaded_names: set, disabled: set
    ) -> List[Dict[str, str]]:
        """Return bundled skills whose keywords match *msg_lower* and are not yet loaded.

        Skills that declare a command: are command-gated and are not triggered
        by keywords, consistent with how user-imported skills work.
        """
        result = []
        for name, meta, body in self._iter_bundled():
            if name in loaded_names or name in disabled:
                continue
            kws = meta.get("keywords")
            cmd = str(meta.get("command", "")).strip().lower()
            if not isinstance(kws, list) or not kws:
                continue
            if cmd:
                continue  # command-gated — only via /command
            keywords = [str(k).lower() for k in kws]
            if any(kw in msg_lower for kw in keywords):
                result.append({"name": name, "content": body, "tier": 2})
                loaded_names.add(name)
        return result

    def validate_command(self, command: str, skill_name: str) -> Optional[str]:
        """Check *command* for the named skill.  Return an error string or None.

        Called by the skills save handler before writing a SKILL.md.
        """
        if not self._scanned:
            self.preload()

        cmd = command.strip().lower()
        if not cmd.startswith("/"):
            return f"Command must start with '/' (got '{cmd}')"

        if cmd in BUILTIN_COMMANDS:
            return f"'{cmd}' is a built-in command and cannot be used by a skill"

        existing_owner = self._command_map.get(cmd)
        if existing_owner and existing_owner != skill_name:
            return f"'{cmd}' is already used by skill '{existing_owner}'"

        return None  # OK

    def list_commands(self) -> List[Dict[str, str]]:
        """Return all slash commands: built-ins first, then imported skill commands.

        Only skills that have been explicitly imported into the project's
        .jupyter-assistant/skills/ directory are included.  Bundled skills that
        have not been imported are intentionally omitted so the command palette
        stays clean.

        Auto-detects newly added skill folders by comparing the skills
        directory mtime against the value recorded at the last preload; a
        lightweight refresh is triggered automatically when a change is found.

        Each entry: {command, description, type ('builtin' | 'skill'), skill_name?}
        """
        # Auto-refresh if a skill folder was added or removed since last scan.
        if self._scanned and self.skills_dir is not None:
            try:
                current_mtime = self.skills_dir.stat().st_mtime
                if current_mtime != self._skills_dir_mtime:
                    log.info("Varys skills: directory changed, refreshing command list")
                    self.refresh()
            except OSError:
                pass

        if not self._scanned:
            self.preload()

        disabled = self._get_disabled()
        result: List[Dict[str, str]] = [
            {"command": cmd, "description": desc, "type": "builtin"}
            for cmd, desc in BUILTIN_COMMANDS.items()
        ]

        # Project-level (explicitly imported) skills — take priority over bundled ones
        imported_cmds: set = set()
        for cmd, skill_name in sorted(self._command_map.items()):
            if skill_name in disabled:
                continue
            desc = str(self._meta.get(skill_name, {}).get("description", skill_name))
            result.append({
                "command": cmd,
                "description": desc,
                "type": "skill",
                "skill_name": skill_name,
            })
            imported_cmds.add(cmd)

        # Bundled skills with a command: always visible in the palette, no import needed.
        # Skip any command already registered by an imported skill above.
        for name, meta, _body in self._iter_bundled():
            if name in disabled:
                continue
            cmd = str(meta.get("command", "")).strip().lower()
            if not cmd or cmd in imported_cmds:
                continue
            desc = str(meta.get("description", name)).strip() or name
            result.append({
                "command": cmd,
                "description": desc,
                "type": "skill",
                "skill_name": name,
            })

        return result

    def _command_for(self, name: str) -> Optional[str]:
        """Return the /command slug for a skill, or None."""
        cmd = str(self._meta.get(name, {}).get("command", "")).strip().lower()
        return cmd if cmd else None

    def get_skill_meta_for_command(self, command: str) -> Optional[Dict[str, object]]:
        """Return the front-matter metadata dict for the skill registered to *command*.

        Returns None if no skill is registered for the command.
        ``command`` must include the leading slash (e.g. "/powerpoint").
        Auto-refreshes if the skills directory has been modified since last scan.
        """
        # Re-scan if the directory has changed (same check as list_commands)
        if self._scanned and self.skills_dir is not None:
            try:
                current_mtime = self.skills_dir.stat().st_mtime
                if current_mtime != self._skills_dir_mtime:
                    log.info("Varys skills: directory changed, refreshing (get_skill_meta)")
                    self.refresh()
            except OSError:
                pass

        if not self._scanned:
            self.preload()
        skill_name = self._command_map.get(command.strip().lower())
        if skill_name is None:
            return None
        return dict(self._meta.get(skill_name, {}))

    def list_skills(self) -> List[Dict[str, object]]:
        """Return metadata for every skill folder in the directory.

        Each entry includes: name, enabled, command (if any), description (if any).
        """
        if not self._scanned:
            self.preload()
        if self.skills_dir is None or not self.skills_dir.exists():
            return []

        disabled = self._get_disabled()
        skills = []
        for entry in sorted(self.skills_dir.iterdir()):
            if entry.is_dir() and (entry / "SKILL.md").exists():
                name = entry.name
                meta = self._meta.get(name, {})
                skills.append({
                    "name": name,
                    "enabled": name not in disabled,
                    "command": str(meta.get("command", "")).strip() or None,
                    "description": str(meta.get("description", "")).strip() or None,
                })
        return skills

    def _keywords_for(self, name: str) -> List[str]:
        """Return the trigger keywords for a skill from its SKILL.md front matter.

        Returns an empty list when the skill has no keywords, which makes it
        Tier 1 (always loaded) as long as it also has no command:.
        """
        fm_kws = self._meta.get(name, {}).get("keywords")
        if isinstance(fm_kws, list) and fm_kws:
            return [str(k).lower() for k in fm_kws]
        return []

    def load_relevant_skills(self, user_message: str, tier1_only: bool = False) -> List[Dict[str, str]]:
        """Return skills that should be injected for this user message.

        Tier classification:
          - Tier 1: skills with NO command AND no keywords → always loaded.
          - Tier 2: skills with a ``command:`` field → loaded only via slash command
                    (NOT loaded here — call ``load_by_command`` instead).
                    Skills with keywords but no command still use keyword matching
                    as a legacy fallback.
          - Tier 3: removed — each skill is self-describing via front matter.

        Use ``load_by_command(cmd)`` when a /command was typed by the user.
        """
        if not self._scanned:
            self.preload()

        disabled  = self._get_disabled()
        msg_lower = user_message.lower()
        result: List[Dict[str, str]] = []
        loaded_names: set = set()

        available = set(self._cache.keys())

        # Tier 1: skills with no command and no keywords
        tier1_names = sorted(
            n for n in available
            if not self._keywords_for(n) and not self._command_for(n)
        )
        for name in tier1_names:
            if name not in disabled:
                result.append(self._make_skill(name, tier=1))
                loaded_names.add(name)

        if tier1_only:
            return result

        # Tier 2: skills that declare keywords in front matter but have NO command
        # (skills WITH a command are loaded exclusively via /command, never by keyword)
        tier2_names = sorted(
            n for n in available
            if self._keywords_for(n) and not self._command_for(n)
        )
        for name in tier2_names:
            if name in loaded_names or name in disabled:
                continue
            keywords = self._keywords_for(name)
            if any(kw in msg_lower for kw in keywords):
                result.append(self._make_skill(name, tier=2))
                loaded_names.add(name)

        # Note: Tier-3 "use the X skill" regex was removed.
        # Every skill that has a command: is loaded exclusively via /command.
        # Every skill without a command: is Tier-1 (always loaded).
        # There is no skill reachable only by the regex.

        # Bundled skills: auto-available without manual import.
        # Tier-1 bundled skills (no keywords, no command) are always injected.
        # Tier-2 bundled skills are injected when their keywords match.
        # User-imported skills with the same name take priority (already in loaded_names).
        result.extend(self._load_bundled_tier1(loaded_names, disabled))
        if not tier1_only:
            result.extend(self._load_bundled_by_keywords(msg_lower, loaded_names, disabled))

        log.debug(
            "Varys skills: injecting %d skill(s) for message=%r",
            len(result), user_message[:60],
        )
        return result

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _find_skills_dir(self) -> Optional[Path]:
        # Skills are user-global: ~/.jupyter/skills/
        # A single location regardless of which project or notebook is open.
        candidate = Path.home() / ".jupyter" / "skills"
        if candidate.exists():
            return candidate
        return None

    def _expected_dir(self) -> Path:
        return Path.home() / ".jupyter" / "skills"

    @staticmethod
    def _get_disabled() -> set:
        raw = os.environ.get("DS_SKILLS_DISABLED", "")
        return {s.strip() for s in raw.split(",") if s.strip()}

    def get_insertion_mode(self, loaded_skills: List[Dict]) -> str:
        """Determine the effective cell_insertion_mode for this set of loaded skills.

        Rules:
        - Skills are ordered Tier 1 → Tier 2 → Tier 3 in the loaded list.
        - The LAST skill that declares a ``cell_insertion_mode`` wins, giving
          Tier-2/3 triggered skills precedence over always-loaded Tier-1 skills.
        - Default when no skill declares a mode: ``"preview"`` (current behaviour).

        Safety override (enforced in task handler, not here):
        - If requiresApproval is True, the frontend always falls back to preview.
        """
        _VALID = {"auto", "preview", "manual", "chat"}
        mode = "preview"
        for skill in loaded_skills:
            candidate = skill.get("cell_insertion_mode")
            if candidate in _VALID:
                mode = candidate
        return mode

    # ------------------------------------------------------------------
    # Composite skill support
    # ------------------------------------------------------------------

    def is_composite(self, name: str) -> bool:
        """Return True if this skill is a pipeline composite (composite: true in front matter)."""
        return bool(self._meta.get(name, {}).get("composite"))

    def get_composite_steps(self, composite_name: str, user_message: str) -> List[Dict[str, str]]:
        """Return the ordered list of {skill_name, prompt} dicts for a composite skill.

        Step prompts are taken from the ``step_prompts`` list in the composite
        skill's front matter; if that list is absent or shorter than ``steps``,
        a generic fallback prompt is used for missing entries.

        Variable substitution is applied to each prompt:
          {file_path}     → first file path found in the user message (e.g. /data/sales.csv)
          {user_message}  → the full original user message (always available)
        """
        import re
        meta = self._meta.get(composite_name, {})
        step_names: List[str] = [str(s) for s in (meta.get("steps") or [])]
        step_prompts: List[str] = [str(p) for p in (meta.get("step_prompts") or [])]

        if not step_names:
            return []

        # Variable extraction
        variables = {"user_message": user_message}
        fp_match = re.search(
            r'["\']?([./\w\-]+\.(?:csv|xlsx?|parquet|json|tsv|feather|hdf5?))["\']?',
            user_message, re.I,
        )
        variables["file_path"] = fp_match.group(1) if fp_match else "the data file"

        steps = []
        for i, skill_name in enumerate(step_names):
            if skill_name not in self._cache:
                log.warning("Varys composite: step skill %r not found — skipping", skill_name)
                continue

            # Use step_prompts[i] if available, else generic fallback
            if i < len(step_prompts):
                prompt_template = step_prompts[i]
            else:
                display = skill_name.replace("-", " ").replace("_", " ")
                prompt_template = (
                    f"Execute the {display} task for this notebook. "
                    f"Original request: {{user_message}}"
                )

            # Variable substitution
            prompt = prompt_template
            for var, val in variables.items():
                prompt = prompt.replace(f"{{{var}}}", val)

            steps.append({"skill_name": skill_name, "prompt": prompt})

        log.debug(
            "Varys composite: %s resolved to %d step(s): %s",
            composite_name, len(steps), [s["skill_name"] for s in steps],
        )
        return steps

    def get_triggered_composite(self, loaded_skills: List[Dict]) -> Optional[str]:
        """Return the raw folder name of the first composite skill in the list, or None."""
        for skill in loaded_skills:
            raw_id: str = skill.get("id", "")
            if raw_id and self.is_composite(raw_id):
                return raw_id
        return None

    def _make_skill(self, name: str, tier: int = 1) -> Dict[str, str]:
        # Re-read the SKILL.md if it has been modified since it was cached.
        # The directory-mtime check in list_commands() only catches folder
        # additions/removals; editing an existing SKILL.md doesn't change the
        # directory mtime, so stale content would otherwise be served forever.
        if self.skills_dir is not None:
            skill_file = self.skills_dir / name / "SKILL.md"
            try:
                current_mtime = skill_file.stat().st_mtime
                cached_mtime  = self._file_mtimes.get(name)
                if cached_mtime is None or current_mtime != cached_mtime:
                    raw  = skill_file.read_text(encoding="utf-8")
                    meta_fresh, body_fresh = _parse_front_matter(raw)
                    self._cache[name] = body_fresh
                    self._meta[name]  = meta_fresh
                    self._file_mtimes[name] = current_mtime
                    log.debug("Varys skills: reloaded '%s' (file modified)", name)
            except OSError:
                pass

        content = self._cache.get(name, "")
        meta    = self._meta.get(name, {})
        display = name.replace("_", " ").replace("-", " ").title()
        skill: Dict[str, object] = {
            "name":     display,
            "id":       name,          # raw folder name — used for composite detection
            "content":  content,
            "filename": f"{name}/SKILL.md",
            "tier":     tier,
        }
        # Propagate cell_insertion_mode from front matter if present
        if "cell_insertion_mode" in meta:
            skill["cell_insertion_mode"] = meta["cell_insertion_mode"]
        return skill

"""Preference Store — structured, versioned YAML registry of user preferences.

Three scope files, all rooted at ``~/.jupyter-assistant/memory/``:

  global_memory.yaml
  projects/{project_id}/project_memory.yaml
  projects/{project_id}/notebooks/{stem}_memory.yaml

``project_id`` is the first 8 hex digits of MD5(str(Path(root_dir).resolve())).

Each file contains a YAML list of preference objects:

  - id:              pref_a1b2           # 8-char hex UUID fragment
    type:            coding_style        # coding_style | library | workflow | data_handling
    content:         "Always sets random_state=42 on stochastic estimators"
    keywords:
      include:       [random_state, seed, stochastic]
      exclude:       []
    always_inject:   false
    confidence:      0.91
    evidence_count:  8
    consistent_count: 7
    source:          inferred            # explicit | inferred
    overrides:       null
    conflicts_with:  null
    first_seen:      "2026-02-10T09:00:00"
    last_reinforced: "2026-03-06T10:15:00"
"""
from __future__ import annotations

import datetime
import hashlib
import logging
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

log = logging.getLogger(__name__)

# Module-level mtime cache: absolute path → (mtime, list[dict])
_YAML_CACHE: Dict[str, Tuple[float, List[Dict[str, Any]]]] = {}

_MEMORY_ROOT = Path.home() / ".jupyter-assistant" / "memory"
_CONFIDENCE_THRESHOLD = 0.7   # minimum confidence to include in selection
_MAX_INJECTED = 15             # hard cap on preferences sent to LLM


def _project_id(root_dir: str) -> str:
    """MD5 of the absolute root_dir path → first 8 hex chars."""
    return hashlib.md5(str(Path(root_dir).resolve()).encode()).hexdigest()[:8]


def _scope_paths(root_dir: str, notebook_path: str) -> Dict[str, Path]:
    """Return the three YAML paths for the given root_dir / notebook_path pair."""
    pid = _project_id(root_dir)
    base = _MEMORY_ROOT

    global_p = base / "global_memory.yaml"
    project_p = base / "projects" / pid / "project_memory.yaml"

    if notebook_path:
        stem = Path(notebook_path).stem
        notebook_p: Optional[Path] = (
            base / "projects" / pid / "notebooks" / f"{stem}_memory.yaml"
        )
    else:
        notebook_p = None

    return {"global": global_p, "project": project_p, "notebook": notebook_p}


# ---------------------------------------------------------------------------
# Low-level YAML read / write with mtime cache
# ---------------------------------------------------------------------------

def _load_yaml_file(path: Path) -> List[Dict[str, Any]]:
    """Load a YAML preference list from *path* using an mtime cache.

    Returns an empty list when the file does not exist or cannot be parsed.
    """
    if not path.exists():
        return []

    try:
        import yaml as _yaml  # pyyaml
    except ImportError:
        log.warning("pyyaml not installed — PreferenceStore disabled. Run: pip install pyyaml")
        return []

    key = str(path)
    try:
        mtime = path.stat().st_mtime
        cached = _YAML_CACHE.get(key)
        if cached and cached[0] == mtime:
            return list(cached[1])

        raw = _yaml.safe_load(path.read_text(encoding="utf-8"))
        entries: List[Dict[str, Any]] = raw if isinstance(raw, list) else []
        _YAML_CACHE[key] = (mtime, entries)
        return list(entries)
    except Exception as exc:
        log.warning("PreferenceStore: could not read %s: %s", path, exc)
        return []


def _save_yaml_file(path: Path, entries: List[Dict[str, Any]]) -> None:
    """Write *entries* as a YAML list to *path*, creating parent dirs as needed."""
    try:
        import yaml as _yaml
    except ImportError:
        log.warning("pyyaml not installed — cannot save preferences")
        return

    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        text = _yaml.dump(entries, allow_unicode=True, default_flow_style=False, sort_keys=False)
        path.write_text(text, encoding="utf-8")
        # Invalidate cache
        _YAML_CACHE.pop(str(path), None)
    except Exception as exc:
        log.warning("PreferenceStore: could not write %s: %s", path, exc)


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

class PreferenceStore:
    """Read/write interface for the three-scope preference YAML files."""

    def __init__(self, root_dir: str, notebook_path: str = ""):
        self.root_dir = root_dir
        self.notebook_path = notebook_path
        self._paths = _scope_paths(root_dir, notebook_path)

    # ------------------------------------------------------------------
    # Migration helpers
    # ------------------------------------------------------------------

    def legacy_preferences_path(self) -> Optional[Path]:
        """Return the path to the old flat preferences.md, or None if absent."""
        from ..utils.paths import nb_base
        p = nb_base(self.root_dir, self.notebook_path) / "memory" / "preferences.md"
        return p if p.exists() else None

    def needs_migration(self) -> bool:
        """True when preferences.md exists but no YAML scope files have been written yet."""
        if self.legacy_preferences_path() is None:
            return False
        # Migration complete sentinel: any YAML file present → already migrated
        for path in self._paths.values():
            if path is not None and path.exists():
                return False
        # Also check migration-in-progress sentinel
        sentinel = _MEMORY_ROOT / ".migration_in_progress"
        if sentinel.exists():
            return False
        return True

    def migrate_sync(self) -> None:
        """Wrap the entire preferences.md content as a single explicit entry.

        Synchronous fallback used when the Simple Tasks model is not configured.
        Archives preferences.md to preferences.md.bak on completion.
        """
        legacy = self.legacy_preferences_path()
        if legacy is None:
            return

        try:
            content = legacy.read_text(encoding="utf-8").strip()
            if not content:
                legacy.rename(legacy.with_suffix(".md.bak"))
                return

            entry = _make_entry(
                pref_type="workflow",
                content=content,
                source="explicit",
                keywords_include=[],
                evidence_count=1,
                consistent_count=1,
            )
            # Write to notebook scope (most specific scope)
            scope = "notebook" if self._paths.get("notebook") else "project"
            self._upsert_entry(scope, entry)

            # Archive
            legacy.rename(legacy.with_suffix(".md.bak"))
            log.info("PreferenceStore: migrated preferences.md → %s scope", scope)
        except Exception as exc:
            log.warning("PreferenceStore: sync migration failed: %s", exc)

    def set_migration_in_progress(self) -> None:
        """Create sentinel file so concurrent requests skip re-triggering migration."""
        try:
            _MEMORY_ROOT.mkdir(parents=True, exist_ok=True)
            (_MEMORY_ROOT / ".migration_in_progress").touch()
        except Exception:
            pass

    def clear_migration_sentinel(self) -> None:
        """Remove migration-in-progress sentinel and archive preferences.md."""
        try:
            (_MEMORY_ROOT / ".migration_in_progress").unlink(missing_ok=True)
        except Exception:
            pass

        legacy = self.legacy_preferences_path()
        if legacy and legacy.exists():
            try:
                legacy.rename(legacy.with_suffix(".md.bak"))
            except Exception:
                pass

    def get_legacy_text(self) -> str:
        """Return raw preferences.md content (used as fallback until migration completes)."""
        legacy = self.legacy_preferences_path()
        if legacy and legacy.exists():
            try:
                return legacy.read_text(encoding="utf-8").strip()
            except Exception:
                pass
        # Also check .bak in case migration happened this session
        if legacy:
            bak = legacy.with_suffix(".md.bak")
            if bak.exists():
                try:
                    return bak.read_text(encoding="utf-8").strip()
                except Exception:
                    pass
        return ""

    # ------------------------------------------------------------------
    # Read API
    # ------------------------------------------------------------------

    def get_all(self, min_confidence: float = 0.0) -> List[Dict[str, Any]]:
        """Return all preferences across all scopes, ordered global → project → notebook.

        Entries below *min_confidence* are filtered out.  Duplicates (same id across
        scopes) are kept — narrower scopes override broader ones.
        """
        seen_ids: Dict[str, int] = {}  # id → position in result
        result: List[Dict[str, Any]] = []

        for scope in ("global", "project", "notebook"):
            path = self._paths.get(scope)
            if path is None:
                continue
            for entry in _load_yaml_file(path):
                if not isinstance(entry, dict):
                    continue
                conf = float(entry.get("confidence", 0.0))
                if conf < min_confidence:
                    continue
                eid = entry.get("id", "")
                if eid and eid in seen_ids:
                    # Narrower scope wins — overwrite
                    result[seen_ids[eid]] = dict(entry, _scope=scope)
                else:
                    idx = len(result)
                    result.append(dict(entry, _scope=scope))
                    if eid:
                        seen_ids[eid] = idx

        return result

    def get_always_inject(self) -> List[Dict[str, Any]]:
        """Return entries with ``always_inject: true`` regardless of confidence."""
        return [p for p in self.get_all() if p.get("always_inject")]

    def get_version_history(self, pref_id: str) -> List[Dict[str, Any]]:  # noqa: ARG002
        """Return the changelog for *pref_id*. Not yet implemented; returns empty list."""
        return []

    # ------------------------------------------------------------------
    # Write API
    # ------------------------------------------------------------------

    def upsert(self, entry: Dict[str, Any], scope: str = "notebook") -> str:
        """Insert or update a preference entry in *scope*.

        If an entry with the same ``id`` already exists in that scope file it is
        replaced; otherwise a new entry is appended.

        Returns the entry id.
        """
        if "id" not in entry or not entry["id"]:
            entry = dict(entry, id=_new_pref_id())
        self._upsert_entry(scope, entry)
        return entry["id"]

    def reinforce(self, pref_id: str, scope: str = "notebook") -> bool:
        """Increment evidence_count and consistent_count for *pref_id* in *scope*.

        Recomputes confidence and updates last_reinforced timestamp.
        Returns True if the entry was found and updated.
        """
        from .confidence import compute_confidence

        path = self._paths.get(scope)
        if path is None:
            return False

        entries = _load_yaml_file(path)
        for entry in entries:
            if entry.get("id") == pref_id:
                entry["evidence_count"] = int(entry.get("evidence_count", 1)) + 1
                entry["consistent_count"] = int(entry.get("consistent_count", 1)) + 1
                entry["last_reinforced"] = _now_iso()
                entry["confidence"] = compute_confidence(entry)
                _save_yaml_file(path, entries)
                return True
        return False

    def mark_conflict(self, pref_id: str, conflicts_with: str, scope: str = "notebook") -> bool:
        """Record a conflict between *pref_id* and another entry.

        Reduces consistent_count and recomputes confidence.
        Returns True if the entry was found.
        """
        from .confidence import compute_confidence

        path = self._paths.get(scope)
        if path is None:
            return False

        entries = _load_yaml_file(path)
        for entry in entries:
            if entry.get("id") == pref_id:
                entry["evidence_count"] = int(entry.get("evidence_count", 1)) + 1
                # Consistent_count does NOT increment on conflict
                entry["conflicts_with"] = conflicts_with
                entry["last_reinforced"] = _now_iso()
                entry["confidence"] = compute_confidence(entry)
                _save_yaml_file(path, entries)
                return True
        return False

    def delete(self, pref_id: str, scope: str = "notebook") -> bool:
        """Remove *pref_id* from *scope*. Returns True if found and removed."""
        path = self._paths.get(scope)
        if path is None:
            return False

        entries = _load_yaml_file(path)
        new_entries = [e for e in entries if e.get("id") != pref_id]
        if len(new_entries) == len(entries):
            return False
        _save_yaml_file(path, new_entries)
        return True

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _upsert_entry(self, scope: str, entry: Dict[str, Any]) -> None:
        """Low-level: insert or replace entry in the *scope* YAML file."""
        from .confidence import compute_confidence

        path = self._paths.get(scope)
        if path is None:
            log.debug("PreferenceStore: scope '%s' unavailable (no notebook path?)", scope)
            return

        entries = _load_yaml_file(path)
        eid = entry.get("id")
        replaced = False
        if eid:
            for i, existing in enumerate(entries):
                if existing.get("id") == eid:
                    entries[i] = entry
                    replaced = True
                    break
        if not replaced:
            entries.append(entry)

        # Always recompute confidence before persisting
        if "evidence_count" in entry:
            entry["confidence"] = compute_confidence(entry)

        _save_yaml_file(path, entries)


# ---------------------------------------------------------------------------
# Factory helpers
# ---------------------------------------------------------------------------

def make_preference(
    pref_type: str,
    content: str,
    source: str = "inferred",
    keywords_include: Optional[List[str]] = None,
    keywords_exclude: Optional[List[str]] = None,
    evidence_count: int = 1,
    consistent_count: int = 1,
    always_inject: bool = False,
) -> Dict[str, Any]:
    """Create a new preference dict ready for ``PreferenceStore.upsert()``."""
    from .confidence import compute_confidence

    now = _now_iso()
    entry: Dict[str, Any] = {
        "id":              _new_pref_id(),
        "type":            pref_type,
        "content":         content,
        "keywords": {
            "include": list(keywords_include or []),
            "exclude": list(keywords_exclude or []),
        },
        "always_inject":   always_inject,
        "evidence_count":  evidence_count,
        "consistent_count": consistent_count,
        "source":          source,
        "overrides":       None,
        "conflicts_with":  None,
        "first_seen":      now,
        "last_reinforced": now,
        "confidence":      0.0,
    }
    entry["confidence"] = compute_confidence(entry)
    return entry


# Keep an internal alias used inside this module before the public function exists
_make_entry = make_preference


def _new_pref_id() -> str:
    return f"pref_{uuid.uuid4().hex[:8]}"


def _now_iso() -> str:
    return datetime.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%S")

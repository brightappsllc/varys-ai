"""Action stem detector — maps code patterns to semantic action labels.

The stem dictionary lives at:
  <project_base>/config/action_stems.json

On first use the file is written from DEFAULT_STEMS so the user can edit it.
The inference pipeline extends the file automatically when it encounters cells
whose source doesn't match any known stem (see varys/memory/inference.py).
"""
from __future__ import annotations

import json
import logging
import os
import re
import tempfile
from pathlib import Path
from typing import Dict, List, Optional, Tuple

log = logging.getLogger(__name__)

# ── Default stem vocabulary ────────────────────────────────────────────────────

DEFAULT_STEMS: Dict[str, List[str]] = {
    "Load data":    ["pd.read_csv(", "pd.read_excel(", "pd.read_parquet(",
                     "pd.read_json(", "pd.read_feather(", "pd.read_table(",
                     "pd.read_hdf(", "open("],
    "Export data":  [".to_csv(", ".to_excel(", ".to_parquet(",
                     ".to_json(", ".to_sql(", ".to_pickle("],
    "Filter rows":  [".query(", ".dropna(", ".drop_duplicates(", ".loc[", ".iloc["],
    "Fill missing": [".fillna(", ".interpolate(", ".ffill(", ".bfill("],
    "Cast types":   [".astype(", "pd.to_datetime(", "pd.to_numeric(", "pd.Categorical("],
    "Aggregate":    [".groupby(", ".pivot_table(", "pd.crosstab(", ".agg(", ".resample("],
    "Merge":        [".merge(", ".join(", "pd.concat("],
    "Reshape":      [".melt(", ".pivot(", ".stack(", ".unstack(", ".transpose("],
    "Apply fn":     [".apply(", ".map(", ".applymap("],
    "Sort":         [".sort_values(", ".sort_index(", ".nlargest(", ".nsmallest("],
    "Train model":  [".fit(", ".fit_transform(", ".partial_fit("],
    "Predict":      [".predict(", ".score(", ".predict_proba(", ".decision_function("],
    "Evaluate":     ["classification_report(", "confusion_matrix(",
                     "mean_squared_error(", "accuracy_score(", "r2_score(",
                     "roc_auc_score(", "f1_score("],
    "Visualize":    ["plt.", "sns.", ".plot(", "fig.", "ax."],
    "Display":      ["print(", "display(", "IPython.display"],
}


# ── Atomic write helper ────────────────────────────────────────────────────────

def _atomic_write(path: Path, content: str) -> None:
    parent = path.parent
    fd, tmp = tempfile.mkstemp(dir=parent, prefix=".tmp_stems_", suffix=".json")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(content)
        os.replace(tmp, path)
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


# ── Comment stripping ─────────────────────────────────────────────────────────

def _strip_comments(source: str) -> str:
    """Remove # comment lines and inline comments from source.

    Lines whose stripped form starts with '#' are dropped entirely.
    Inline comments (anything after a bare '#' not inside a string) are trimmed.
    Uses a lightweight regex approach — not a full tokeniser.
    """
    lines = []
    for line in source.splitlines():
        stripped = line.strip()
        if stripped.startswith("#"):
            continue
        # Remove inline comments: # not preceded by a quote on the same line.
        # This heuristic covers the vast majority of data-science notebook patterns.
        line = re.sub(r'\s*#(?!["\']).*$', "", line)
        lines.append(line)
    return "\n".join(lines)


# ── Definition-cell detection ─────────────────────────────────────────────────

def _is_definition_cell(source: str) -> Tuple[bool, List[str]]:
    """Return (True, [name, ...]) when *source* is a pure function/class definition.

    A cell is a "definition cell" when every top-level (unindented) non-blank
    line is a ``def``, ``async def``, ``class``, or decorator line.  The cell
    body (indented lines) is ignored.

    Returns (False, []) for anything else.
    """
    lines = [ln for ln in source.splitlines() if ln.strip()]
    if not lines:
        return False, []

    for line in lines:
        # Indented lines are inside a block — skip
        if line[0] in (" ", "\t"):
            continue
        stripped = line.strip()
        if not (
            stripped.startswith("def ")
            or stripped.startswith("async def ")
            or stripped.startswith("class ")
            or stripped.startswith("@")
        ):
            return False, []

    names = re.findall(
        r'^(?:async\s+)?(?:def|class)\s+(\w+)',
        source,
        re.MULTILINE,
    )
    return bool(names), names


# ── Action detector ───────────────────────────────────────────────────────────

def detect_actions(
    source: str,
    is_import_cell: bool,
    stems: Dict[str, List[str]],
) -> List[str]:
    """Return the list of semantic action labels that match *source*.

    Rules (applied in order):
      1. Import cells           → ["Import"]
      2. Pure def/class cells   → ["Define · name1, name2"]
      3. Stem matching          → all matching action names (preserve dict order)
      4. Fallback               → ["Compute"]

    Stems are matched against the comment-stripped source so that a commented-out
    ``# df.dropna()`` does not trigger "Filter rows".
    """
    if is_import_cell:
        return ["Import"]

    cleaned = _strip_comments(source)

    is_def, names = _is_definition_cell(cleaned)
    if is_def:
        label = "Define · " + ", ".join(names) if names else "Define"
        return [label]

    matched: List[str] = []
    for action, stem_list in stems.items():
        if any(stem in cleaned for stem in stem_list):
            matched.append(action)

    return matched if matched else ["Compute"]


# ── Stem loader / updater ─────────────────────────────────────────────────────

class ActionStemLoader:
    """Loads and persists the project-scoped action_stems.json file."""

    def __init__(self, root_dir: str, notebook_path: str = "") -> None:
        from ..utils.paths import project_base
        cfg_dir = project_base(root_dir, notebook_path) / "config"
        cfg_dir.mkdir(parents=True, exist_ok=True)
        self._path = cfg_dir / "action_stems.json"

    def load(self) -> Dict[str, List[str]]:
        """Return the stem dict.  Writes DEFAULT_STEMS to disk on first call."""
        if self._path.exists():
            try:
                return json.loads(self._path.read_text(encoding="utf-8"))
            except Exception as exc:
                log.warning("ActionStemLoader: could not read %s — %s", self._path, exc)
                return dict(DEFAULT_STEMS)
        # First use — persist defaults so the user can edit them
        try:
            _atomic_write(
                self._path,
                json.dumps(DEFAULT_STEMS, indent=2, ensure_ascii=False),
            )
        except Exception as exc:
            log.warning("ActionStemLoader: could not write defaults — %s", exc)
        return dict(DEFAULT_STEMS)

    def save(self, stems: Dict[str, List[str]]) -> None:
        try:
            _atomic_write(
                self._path,
                json.dumps(stems, indent=2, ensure_ascii=False),
            )
        except Exception as exc:
            log.warning("ActionStemLoader: could not save %s — %s", self._path, exc)

    def update(self, new_entries: Dict[str, List[str]]) -> None:
        """Merge *new_entries* into the current stem dict and save."""
        stems = self.load()
        for action, new_stem_list in new_entries.items():
            if action in stems:
                existing = stems[action]
                for stem in new_stem_list:
                    if stem not in existing:
                        existing.append(stem)
            else:
                stems[action] = list(new_stem_list)
        self.save(stems)

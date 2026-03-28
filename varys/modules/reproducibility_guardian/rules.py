"""Rule-based reproducibility checks.

Each public ``check_*`` function accepts a cell dict and the full notebook
cells list, and returns a list of Issue dicts (empty if no issue found).

A cell dict has:
    index          : int   — position in notebook
    type           : str   — "code" | "markdown"
    source         : str   — raw cell text
    executionCount : int?  — the [N] counter (None if never run)

All checks are pure functions: no I/O, no side effects.
"""
from __future__ import annotations

import ast
import builtins
import re
import uuid
from dataclasses import dataclass, field
from typing import List, Optional, Set

from ...utils.config import get_config as _get_cfg

# Python built-in names that are always available without definition.
_BUILTINS: Set[str] = set(dir(builtins)) | {
    # IPython / Jupyter globals that are injected automatically
    'In', 'Out', 'get_ipython', 'exit', 'quit', 'display',
    # Common magic-command results
    '_', '__', '___',
    # Dunder module-level names
    '__name__', '__file__', '__doc__', '__package__', '__spec__',
    '__builtins__', '__loader__', '__cached__',
}


def _default_seed() -> int:
    return _get_cfg().getint("seeds", "default_seed", 42)


def _stochastic_estimators() -> List[str]:
    _builtin = [
        'RandomForestClassifier', 'RandomForestRegressor',
        'ExtraTreesClassifier', 'ExtraTreesRegressor',
        'GradientBoostingClassifier', 'GradientBoostingRegressor',
        'HistGradientBoostingClassifier', 'HistGradientBoostingRegressor',
        'BaggingClassifier', 'BaggingRegressor',
        'AdaBoostClassifier', 'AdaBoostRegressor',
        'SGDClassifier', 'SGDRegressor',
        'LogisticRegression',
        'KMeans', 'MiniBatchKMeans',
        'ShuffleSplit', 'StratifiedShuffleSplit',
        'cross_val_score',
        'XGBClassifier', 'XGBRegressor',
        'LGBMClassifier', 'LGBMRegressor',
        'CatBoostClassifier', 'CatBoostRegressor',
    ]
    return _get_cfg().getlist("estimators", "stochastic_estimators", _builtin)


def _abs_path_prefixes() -> List[str]:
    _builtin = ['/home/', '/Users/', '/root/', '/tmp/', '/data/',
                '/mnt/', '/workspace/', '/opt/', '/srv/']
    return _get_cfg().getlist("paths", "abs_path_prefixes", _builtin)


# ---------------------------------------------------------------------------
# Issue dataclass
# ---------------------------------------------------------------------------

@dataclass
class Issue:
    rule_id:         str
    severity:        str        # "critical" | "warning" | "info"
    cell_index:      int
    title:           str
    message:         str
    explanation:     str
    suggestion:      str
    fix_code:        Optional[str] = None
    fix_description: Optional[str] = None
    id:              str = field(default_factory=lambda: uuid.uuid4().hex[:12])


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _source_lines(source: str) -> List[str]:
    return source.splitlines()


def _strip_comments(source: str) -> str:
    """Remove Python inline comments to avoid false positives."""
    return re.sub(r'#[^\n]*', '', source)


def _add_kwarg(source: str, func_pattern: str, kwarg: str = '') -> Optional[str]:
    if not kwarg:
        kwarg = f'random_state={_default_seed()}'
    """
    Insert *kwarg* into the first call matching *func_pattern* that does not
    already have it.  Works for single-line calls only; returns None when the
    call spans multiple lines or the pattern is not found.
    """
    pattern = re.compile(
        rf'({func_pattern}\s*\()([^)]*)\)',
        re.IGNORECASE
    )
    match = pattern.search(source)
    if match is None:
        return None
    prefix = match.group(1)
    inner  = match.group(2).rstrip(', \t')
    new_call = f"{prefix}{inner + ', ' if inner else ''}{kwarg})"
    return source[:match.start()] + new_call + source[match.end():]


# ---------------------------------------------------------------------------
# RULE 1 — train_test_split without random_state
# ---------------------------------------------------------------------------

_TTS_CALL   = re.compile(r'train_test_split\s*\(')
_RAND_STATE = re.compile(r'random_state\s*=')


def check_train_test_split(cell: dict, _cells: list) -> List[Issue]:
    if cell['type'] != 'code':
        return []
    src = _strip_comments(cell['source'])
    if not _TTS_CALL.search(src):
        return []
    if _RAND_STATE.search(src):
        return []

    fix = _add_kwarg(cell['source'], r'train_test_split')
    return [Issue(
        rule_id='missing_random_state_tts',
        severity='warning',
        cell_index=cell['index'],
        title='Missing random_state in train_test_split',
        message='train_test_split() called without random_state parameter.',
        explanation=(
            'Every execution will produce a different train/test split, '
            'making results impossible to reproduce. Debugging and sharing '
            'this notebook will produce inconsistent metrics.'
        ),
        suggestion=f'Add random_state={_default_seed()} (or any fixed integer).',
        fix_code=fix,
        fix_description=f'Add random_state={_default_seed()} to train_test_split()',
    )]


# ---------------------------------------------------------------------------
# RULE 2 — sklearn estimators without random_state
# ---------------------------------------------------------------------------

def check_sklearn_estimators(cell: dict, _cells: list) -> List[Issue]:
    if cell['type'] != 'code':
        return []
    src = _strip_comments(cell['source'])
    issues = []
    seed = _default_seed()
    for estimator in _stochastic_estimators():
        pattern = re.compile(rf'\b{estimator}\s*\(')
        if pattern.search(src) and not _RAND_STATE.search(src):
            fix = _add_kwarg(cell['source'], estimator)
            issues.append(Issue(
                rule_id=f'missing_random_state_{estimator.lower()}',
                severity='warning',
                cell_index=cell['index'],
                title=f'Missing random_state in {estimator}',
                message=f'{estimator}() instantiated without random_state.',
                explanation=(
                    f'{estimator} uses randomisation internally. Without a fixed '
                    'random_state the model weights, tree structure, or cluster '
                    'assignments will differ between runs, making results '
                    'irreproducible.'
                ),
                suggestion=f'Add random_state={seed} to the constructor.',
                fix_code=fix,
                fix_description=f'Add random_state={seed} to {estimator}()',
            ))
    return issues


# ---------------------------------------------------------------------------
# RULE 3 — CUDA device without is_available() fallback
# ---------------------------------------------------------------------------

_CUDA_HARD  = re.compile(r'''torch\.device\s*\(\s*['"]cuda['"]\s*\)''')
_CUDA_CHECK = re.compile(r'cuda\.is_available\s*\(')


def check_cuda_no_fallback(cell: dict, _cells: list) -> List[Issue]:
    if cell['type'] != 'code':
        return []
    src = _strip_comments(cell['source'])
    if not _CUDA_HARD.search(src):
        return []
    if _CUDA_CHECK.search(src):
        return []

    fix = re.sub(
        r"""torch\.device\s*\(\s*['"]cuda['"]\s*\)""",
        "torch.device('cuda' if torch.cuda.is_available() else 'cpu')",
        cell['source']
    )
    return [Issue(
        rule_id='cuda_no_fallback',
        severity='warning',
        cell_index=cell['index'],
        title='GPU/CUDA dependency without CPU fallback',
        message="torch.device('cuda') used without checking cuda.is_available().",
        explanation=(
            'This will crash with RuntimeError on any machine without a GPU. '
            'Other team members, CI servers, or cloud instances may not have '
            'CUDA available.'
        ),
        suggestion="Use torch.device('cuda' if torch.cuda.is_available() else 'cpu').",
        fix_code=fix,
        fix_description='Add CPU fallback to device selection',
    )]


# ---------------------------------------------------------------------------
# RULE 4 — Hardcoded absolute path
# ---------------------------------------------------------------------------

def _abs_path_regex() -> re.Pattern:
    prefixes = _abs_path_prefixes()
    # Build alternation from the list; also keep Windows drive letter pattern
    unix_alt = "|".join(re.escape(p) for p in prefixes if p.startswith("/"))
    pattern = rf'''(['"])({unix_alt}|[A-Za-z]:\\\\[^'"{{5,}})[^'"]*\1'''
    try:
        return re.compile(pattern)
    except re.error:
        # Fallback to a safe static pattern if the generated one fails
        return re.compile(r'''(['"])(/home/|/Users/|/root/|/tmp/)[^'"]*\1''')


def check_hardcoded_path(cell: dict, _cells: list) -> List[Issue]:
    if cell['type'] != 'code':
        return []
    src = _strip_comments(cell['source'])
    match = _abs_path_regex().search(src)
    if not match:
        return []
    path = match.group(2) + '…'
    return [Issue(
        rule_id='hardcoded_absolute_path',
        severity='warning',
        cell_index=cell['index'],
        title='Hardcoded absolute path',
        message=f'Absolute path detected: {path!r}',
        explanation=(
            'Absolute paths are machine-specific. This notebook will fail '
            'for anyone whose home directory or project location differs from '
            'yours.'
        ),
        suggestion=(
            'Use pathlib.Path.cwd() / "relative/path" or pass the path '
            'via a variable at the top of the notebook.'
        ),
        fix_code=None,
        fix_description=None,
    )]


# ---------------------------------------------------------------------------
# RULE 5 — Execution order violation (non-monotonic execution counts)
# ---------------------------------------------------------------------------

def check_execution_order(cells: list) -> List[Issue]:
    """
    Notebook-level rule (not per-cell): checks whether code cells were
    executed in top-to-bottom order by comparing their execution counts.
    Execution counts are global sequential integers; if they are NOT
    monotonically increasing in notebook-position order, cells were run
    out of order.
    """
    executed = [
        c for c in cells
        if c.get('type') == 'code' and c.get('executionCount')
    ]
    if len(executed) < 2:
        return []

    counts_in_order = [c['executionCount'] for c in executed]
    if counts_in_order == sorted(counts_in_order):
        return []

    # Find the first offending cell
    prev = counts_in_order[0]
    for i, count in enumerate(counts_in_order[1:], 1):
        if count < prev:
            offending = executed[i]
            return [Issue(
                rule_id='execution_order_violation',
                severity='critical',
                cell_index=offending['index'],
                title='Cells executed out of order',
                message=(
                    f"Cell at position {offending['index']} has execution "
                    f"count {offending['executionCount']} but a preceding cell "
                    f"has count {prev}."
                ),
                explanation=(
                    'Cells were not run sequentially from top to bottom. '
                    'The notebook will likely fail if you click '
                    '"Restart kernel & run all cells", because some cells '
                    'depended on state produced by later cells.'
                ),
                suggestion='Run Kernel → Restart Kernel and Run All Cells to verify.',
                fix_code=None,
            )]
        prev = max(prev, count)
    return []


# ---------------------------------------------------------------------------
# RULE 6 — NumPy / Python random used but no seed set anywhere
# ---------------------------------------------------------------------------

_NP_RANDOM_USE  = re.compile(r'np\.random\.|numpy\.random\.')
_NP_SEED        = re.compile(r'np\.random\.seed\s*\(|np\.random\.default_rng\s*\(')
_PY_RANDOM_USE  = re.compile(r'\brandom\.(shuffle|sample|choice|randint|random)\s*\(')
_PY_SEED        = re.compile(r'random\.seed\s*\(')


def check_numpy_seed(cells: list) -> List[Issue]:
    """Notebook-level rule: any numpy.random use without a seed anywhere."""
    all_src = '\n'.join(
        c.get('source', '') for c in cells if c.get('type') == 'code'
    )
    if not _NP_RANDOM_USE.search(all_src):
        return []
    if _NP_SEED.search(all_src):
        return []

    # Find the first cell that uses np.random
    for cell in cells:
        if cell.get('type') != 'code':
            continue
        if _NP_RANDOM_USE.search(_strip_comments(cell.get('source', ''))):
            return [Issue(
                rule_id='missing_numpy_seed',
                severity='info',
                cell_index=cell['index'],
                title='NumPy random used without a seed',
                message='numpy.random operations found but np.random.seed() is never called.',
                explanation=(
                    'NumPy random operations will produce different results '
                    'on every run unless the seed is fixed.'
                ),
                suggestion='Add np.random.seed(42) in your imports cell.',
                fix_code='import numpy as np\nnp.random.seed(42)',
                fix_description='Insert seed cell (add after your import cell)',
            )]
    return []


def check_python_random_seed(cells: list) -> List[Issue]:
    """Notebook-level rule: Python random module used without seed."""
    all_src = '\n'.join(
        c.get('source', '') for c in cells if c.get('type') == 'code'
    )
    if not _PY_RANDOM_USE.search(all_src):
        return []
    if _PY_SEED.search(all_src):
        return []

    for cell in cells:
        if cell.get('type') != 'code':
            continue
        if _PY_RANDOM_USE.search(_strip_comments(cell.get('source', ''))):
            return [Issue(
                rule_id='missing_python_random_seed',
                severity='info',
                cell_index=cell['index'],
                title='Python random module used without a seed',
                message='random.shuffle/sample/choice found but random.seed() is never called.',
                explanation=(
                    'Python random operations produce different results each run '
                    'without a fixed seed.'
                ),
                suggestion='Add import random; random.seed(42) in your imports cell.',
                fix_code='import random\nrandom.seed(42)',
                fix_description='Insert seed cell',
            )]
    return []


# ---------------------------------------------------------------------------
# AST helpers for RULE 8
# ---------------------------------------------------------------------------

def _ast_definitions(source: str) -> Set[str]:
    """Return all names bound at the module level in *source*.

    Covers: simple assignments, augmented/annotated assignments, imports,
    ``for`` loop targets, ``with`` statement targets, function/class defs.
    Only module-scope nodes are inspected (no recursion into function bodies).
    """
    try:
        tree = ast.parse(source)
    except SyntaxError:
        return set()

    names: Set[str] = set()
    for node in ast.iter_child_nodes(tree):
        if isinstance(node, ast.Assign):
            for t in node.targets:
                _collect_name_targets(t, names)
        elif isinstance(node, (ast.AugAssign, ast.AnnAssign)):
            _collect_name_targets(node.target, names)
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            names.add(node.name)
        elif isinstance(node, ast.Import):
            for alias in node.names:
                names.add(alias.asname or alias.name.split('.')[0])
        elif isinstance(node, ast.ImportFrom):
            for alias in node.names:
                if alias.name != '*':
                    names.add(alias.asname or alias.name)
        elif isinstance(node, ast.For):
            _collect_name_targets(node.target, names)
        elif isinstance(node, ast.With):
            for item in node.items:
                if item.optional_vars:
                    _collect_name_targets(item.optional_vars, names)
    return names


def _collect_name_targets(node: ast.AST, names: Set[str]) -> None:
    """Recursively collect Name ids from assignment targets."""
    if isinstance(node, ast.Name):
        names.add(node.id)
    elif isinstance(node, (ast.Tuple, ast.List)):
        for elt in node.elts:
            _collect_name_targets(elt, names)
    elif isinstance(node, ast.Starred):
        _collect_name_targets(node.value, names)


def _ast_top_level_loads(source: str) -> Set[str]:
    """Return Name nodes that are *loaded* (read) at module scope.

    Only nodes that are direct children of the module are inspected —
    names used exclusively inside function or class bodies are excluded
    to reduce false positives (they run in their own scope).
    """
    try:
        tree = ast.parse(source)
    except SyntaxError:
        return set()

    names: Set[str] = set()
    for node in ast.iter_child_nodes(tree):
        # Skip pure definitions — we only want the right-hand-side loads
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            continue
        for child in ast.walk(node):
            if isinstance(child, ast.Name) and isinstance(child.ctx, ast.Load):
                names.add(child.id)
    return names


def _ast_comprehension_vars(source: str) -> Set[str]:
    """Return all names bound as loop variables inside comprehensions or generators.

    In Python 3, these live in their own scope and will never appear in the
    module-level namespace, so they must not be flagged as undefined names.
    Example: ``[item.age for item in df.itertuples()]`` → {item}
    """
    try:
        tree = ast.parse(source)
    except SyntaxError:
        return set()
    names: Set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, (ast.ListComp, ast.SetComp, ast.GeneratorExp, ast.DictComp)):
            for gen in node.generators:
                _collect_name_targets(gen.target, names)
    return names


def _has_wildcard_import(cells: list) -> bool:
    """Return True if any code cell contains a ``from X import *`` statement.

    When a wildcard import is present, static analysis cannot know which names
    are in scope, so Rules 8 and 9 would produce unreliable results.
    """
    for cell in cells:
        if cell.get('type') != 'code':
            continue
        try:
            tree = ast.parse(cell.get('source', ''))
        except SyntaxError:
            continue
        for node in ast.walk(tree):
            if isinstance(node, ast.ImportFrom):
                for alias in node.names:
                    if alias.name == '*':
                        return True
    return False


# Common import alias → canonical import statement.
# Used to generate fix_code suggestions for Rule 9.
_IMPORT_SUGGESTIONS: dict[str, str] = {
    # Data & numerics
    'pd':        'import pandas as pd',
    'np':        'import numpy as np',
    'sp':        'import scipy as sp',
    # Visualisation
    'plt':       'import matplotlib.pyplot as plt',
    'mpl':       'import matplotlib as mpl',
    'sns':       'import seaborn as sns',
    'px':        'import plotly.express as px',
    'go':        'import plotly.graph_objects as go',
    # ML / DL
    'sklearn':   'import sklearn',
    'tf':        'import tensorflow as tf',
    'keras':     'import keras',
    'torch':     'import torch',
    'nn':        'import torch.nn as nn',
    'F':         'import torch.nn.functional as F',
    'xgb':       'import xgboost as xgb',
    'lgb':       'import lightgbm as lgb',
    'cb':        'import catboost as cb',
    # Computer vision / NLP
    'cv2':       'import cv2',
    'PIL':       'from PIL import Image',
    'Image':     'from PIL import Image',
    'skimage':   'import skimage',
    'spacy':     'import spacy',
    'nltk':      'import nltk',
    # Data engineering
    'bs4':       'from bs4 import BeautifulSoup',
    'BeautifulSoup': 'from bs4 import BeautifulSoup',
    'requests':  'import requests',
    'httpx':     'import httpx',
    # Standard library shortcuts
    'os':        'import os',
    'sys':       'import sys',
    're':        'import re',
    'json':      'import json',
    'io':        'import io',
    'copy':      'import copy',
    'time':      'import time',
    'datetime':  'from datetime import datetime',
    'Path':      'from pathlib import Path',
    'partial':   'from functools import partial',
    'defaultdict': 'from collections import defaultdict',
    'Counter':   'from collections import Counter',
    # Typing
    'List':      'from typing import List',
    'Dict':      'from typing import Dict',
    'Optional':  'from typing import Optional',
    'Tuple':     'from typing import Tuple',
    'Any':       'from typing import Any',
}


# ---------------------------------------------------------------------------
# RULE 8 — Variable used before it is defined (static analysis)
# ---------------------------------------------------------------------------

def check_undefined_before_definition(cells: list) -> List[Issue]:
    """Notebook-level rule: flag names used in cell N that are only defined
    in a later cell M > N, meaning a top-to-bottom restart would raise
    NameError at cell N.

    Only simple module-scope definitions are tracked (assignments, imports,
    function/class defs).  Python builtins and IPython globals are excluded.
    At most one issue is emitted per offending cell to keep the report clean.
    """
    code_cells = [
        c for c in cells
        if c.get('type') == 'code' and c.get('source', '').strip()
    ]
    if len(code_cells) < 2:
        return []

    # Pass 1: map name → first cell index where it is defined.
    first_def: dict[str, int] = {}
    for cell in code_cells:
        for name in _ast_definitions(cell.get('source', '')):
            if name not in first_def:
                first_def[name] = cell['index']

    issues: List[Issue] = []
    cumulative_defs: Set[str] = set()

    for cell in code_cells:
        src   = cell.get('source', '')
        defs  = _ast_definitions(src)
        loads = _ast_top_level_loads(src)

        # Names that are read but not yet available at this position
        unknown = (
            loads
            - cumulative_defs   # defined in a prior cell
            - defs              # defined in this cell (e.g. x = x + 1 is fine)
            - _BUILTINS
        )

        # Only report names that ARE eventually defined later — otherwise
        # they might be external library attributes or injected by magic.
        flagged = sorted(
            name for name in unknown
            if first_def.get(name, -1) > cell['index']
        )

        if flagged:
            first_name = flagged[0]
            later_idx  = first_def[first_name]
            issues.append(Issue(
                rule_id=f'var_used_before_def_{first_name}',
                severity='critical',
                cell_index=cell['index'],
                title=f"'{first_name}' used before it is defined",
                message=(
                    f"'{first_name}' is referenced in cell {cell['index']} "
                    f"but first assigned in cell {later_idx}."
                ),
                explanation=(
                    f"Running the notebook top-to-bottom (Restart & Run All) will "
                    f"raise a NameError at cell {cell['index']} because "
                    f"'{first_name}' is not yet defined — it appears for the first "
                    f"time in cell {later_idx}."
                ),
                suggestion=(
                    f"Move the definition of '{first_name}' to a cell before "
                    f"cell {cell['index']}, or reorder the cells so imports and "
                    f"assignments come first."
                ),
                fix_code=None,
            ))

        cumulative_defs |= defs

    return issues


# ---------------------------------------------------------------------------
# RULE 9 — Used but never imported / defined (static analysis)
# ---------------------------------------------------------------------------

def check_used_but_never_imported(cells: list) -> List[Issue]:
    """Notebook-level rule: flag names that are read somewhere in the notebook
    but never imported, assigned, or defined anywhere in it.

    This catches the "works interactively because the kernel already has the
    name from a previous session" pattern.  On a clean restart (Kernel →
    Restart & Run All) the notebook will raise NameError immediately.

    Differences from Rule 8:
      Rule 8 — name IS defined, but in a LATER cell (order problem).
      Rule 9 — name is NEVER defined or imported anywhere (missing import).

    Bail-out conditions (to avoid unreliable results):
      • Any cell contains ``from X import *`` (unknown namespace injection).

    False-positive mitigations:
      • Python builtins and IPython globals are excluded (_BUILTINS).
      • Single-character names are excluded (overwhelmingly loop vars).
      • Comprehension loop variables (Python 3 scoped) are excluded.
      • Function / class bodies are not inspected for the "load" side.
      • Each missing name is reported at most once (first cell that uses it).

    Known limitations (documented, not detected):
      • Names injected by ``%run``, ``%load``, ``exec()``, ``globals()``,
        or ``from X import *`` will be missed (false negatives).
      • Names expected from the environment (e.g. ``spark`` in PySpark)
        will be flagged incorrectly (false positives).  Add an allowlist
        when user reports justify the complexity.
    """
    code_cells = [
        c for c in cells
        if c.get('type') == 'code' and c.get('source', '').strip()
    ]
    if len(code_cells) < 1:
        return []

    # Bail out when wildcard imports are present — we can't know what's in scope.
    if _has_wildcard_import(code_cells):
        return []

    # Build the complete set of every name defined anywhere in the notebook.
    # This includes imports, assignments, function/class defs, and for-loop targets.
    all_defs: Set[str] = set()
    for cell in code_cells:
        all_defs |= _ast_definitions(cell.get('source', ''))

    issues: List[Issue] = []
    reported: Set[str] = set()  # emit each missing name only once

    for cell in code_cells:
        src = cell.get('source', '')
        loads     = _ast_top_level_loads(src)
        comp_vars = _ast_comprehension_vars(src)

        # Names used in this cell that are nowhere in the notebook
        missing = (
            loads
            - all_defs      # defined/imported anywhere in the notebook
            - comp_vars     # comprehension loop vars (Python 3 scoped)
            - _BUILTINS
        )

        for name in sorted(missing):
            if name in reported:
                continue
            # Single-character names are overwhelmingly loop vars / throwaway args
            if len(name) <= 1:
                continue
            reported.add(name)

            fix = _IMPORT_SUGGESTIONS.get(name)
            issues.append(Issue(
                rule_id=f'used_not_imported_{name}',
                severity='critical',
                cell_index=cell['index'],
                title=f"'{name}' used but never imported or defined",
                message=(
                    f"'{name}' is referenced in cell {cell['index']} "
                    f"but has no import statement or assignment anywhere "
                    f"in the notebook."
                ),
                explanation=(
                    f"This works interactively because '{name}' is already "
                    f"in the kernel namespace from a prior run or session.  "
                    f"A clean restart (Kernel \u2192 Restart \u2026 Run All) will "
                    f"raise NameError at cell {cell['index']}."
                ),
                suggestion=(
                    f"Add the missing import or assignment for '{name}' to "
                    f"a cell before cell {cell['index']}.  "
                    + (f"Suggested fix: ``{fix}``." if fix else
                       f"Check which package provides '{name}' and add the import.")
                ),
                fix_code=fix,
                fix_description=f"Add missing import: {fix}" if fix else None,
            ))

    return issues

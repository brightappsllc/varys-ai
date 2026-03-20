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

import re
import uuid
from dataclasses import dataclass, field
from typing import List, Optional

from ...utils.config import get_config as _get_cfg


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

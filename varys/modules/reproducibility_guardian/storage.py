"""SQLite persistence for reproducibility issues.

DB location: <project_root>/.jupyter-assistant/reproducibility.db
Table: issues
"""
from __future__ import annotations

import asyncio
import json
import sqlite3
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict
from pathlib import Path
from typing import List

from .rules import Issue

_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix='repro_db')

_DDL = """
CREATE TABLE IF NOT EXISTS issues (
    id              TEXT PRIMARY KEY,
    notebook_path   TEXT NOT NULL,
    rule_id         TEXT NOT NULL,
    severity        TEXT NOT NULL,
    cell_index      INTEGER NOT NULL,
    title           TEXT NOT NULL,
    message         TEXT NOT NULL,
    explanation     TEXT,
    suggestion      TEXT,
    fix_code        TEXT,
    fix_description TEXT,
    status          TEXT DEFAULT 'active',
    detected_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_issues_nb ON issues (notebook_path, status);
"""


def _db_path(root_dir: str, notebook_path: str) -> Path:
    """Derive DB path from the notebook's project root."""
    nb = Path(notebook_path)
    if nb.is_absolute():
        project = nb.parent
    else:
        project = Path(root_dir) / nb.parent if notebook_path else Path(root_dir)
    db_dir = project / '.jupyter-assistant'
    db_dir.mkdir(parents=True, exist_ok=True)
    return db_dir / 'reproducibility.db'


def _connect(db_file: Path) -> sqlite3.Connection:
    conn = sqlite3.connect(str(db_file))
    conn.row_factory = sqlite3.Row
    conn.executescript(_DDL)
    conn.commit()
    return conn


def _issue_to_row(issue: Issue, notebook_path: str) -> dict:
    d = asdict(issue)
    d['notebook_path'] = notebook_path
    import datetime
    d['detected_at'] = datetime.datetime.utcnow().isoformat()
    d['status'] = 'active'
    return d


def _upsert_issues(db_file: Path, notebook_path: str, issues: List[Issue]) -> None:
    """Replace all active issues for this notebook with the new set."""
    conn = _connect(db_file)
    try:
        conn.execute(
            "DELETE FROM issues WHERE notebook_path = ? AND status = 'active'",
            (notebook_path,)
        )
        for issue in issues:
            row = _issue_to_row(issue, notebook_path)
            conn.execute(
                """INSERT OR REPLACE INTO issues
                   (id, notebook_path, rule_id, severity, cell_index, title,
                    message, explanation, suggestion, fix_code, fix_description,
                    status, detected_at)
                   VALUES (:id, :notebook_path, :rule_id, :severity, :cell_index,
                           :title, :message, :explanation, :suggestion, :fix_code,
                           :fix_description, :status, :detected_at)""",
                row
            )
        conn.commit()
    finally:
        conn.close()


def _dismiss_issue(db_file: Path, issue_id: str) -> None:
    import datetime
    conn = _connect(db_file)
    try:
        conn.execute(
            "UPDATE issues SET status='dismissed', detected_at=? WHERE id=?",
            (datetime.datetime.utcnow().isoformat(), issue_id)
        )
        conn.commit()
    finally:
        conn.close()


def _load_active_issues(db_file: Path, notebook_path: str) -> List[dict]:
    conn = _connect(db_file)
    try:
        rows = conn.execute(
            "SELECT * FROM issues WHERE notebook_path = ? AND status = 'active' "
            "ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, cell_index",
            (notebook_path,)
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


async def _run(fn, *args):
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(_executor, fn, *args)


class ReproducibilityStorage:
    def __init__(self, root_dir: str, notebook_path: str):
        self._db = _db_path(root_dir, notebook_path)
        self._nb  = notebook_path

    async def save(self, issues: List[Issue]) -> None:
        await _run(_upsert_issues, self._db, self._nb, issues)

    async def dismiss(self, issue_id: str) -> None:
        await _run(_dismiss_issue, self._db, issue_id)

    async def load(self) -> List[dict]:
        return await _run(_load_active_issues, self._db, self._nb)

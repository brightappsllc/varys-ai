"""Kernel-execution assertion: run nbconvert on a copy of the notebook."""

from __future__ import annotations

import shutil
import subprocess
import tempfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import List, Optional

import nbformat


@dataclass
class ExecutionResult:
    passed: bool
    exit_code: int
    error_cells: List[int] = field(default_factory=list)
    error_messages: List[str] = field(default_factory=list)
    empty_output_cells: List[int] = field(default_factory=list)
    stdout: str = ""
    stderr: str = ""

    def to_dict(self) -> dict:
        return {
            "passed": self.passed,
            "exit_code": self.exit_code,
            "error_cells": self.error_cells,
            "error_messages": self.error_messages[:5],  # cap report size
            "empty_output_cells": self.empty_output_cells,
        }


def execute_notebook(
    notebook_path: str,
    expected_nonempty_cell_indices: Optional[List[int]] = None,
    timeout_s: int = 120,
    log_file: Optional[Path] = None,
) -> ExecutionResult:
    """Run nbconvert on a copy. Never mutates the artifact being inspected."""
    src = Path(notebook_path)
    if not src.exists():
        return ExecutionResult(passed=False, exit_code=-1, stderr=f"not found: {src}")

    work = Path(tempfile.mkdtemp(prefix="varys_exec_"))
    try:
        copy = work / src.name
        shutil.copy2(src, copy)

        cmd = [
            "jupyter", "nbconvert",
            "--to", "notebook",
            "--execute",
            "--inplace",
            f"--ExecutePreprocessor.timeout={timeout_s}",
            "--ExecutePreprocessor.allow_errors=True",
            str(copy),
        ]
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout_s + 30)

        if log_file is not None:
            try:
                log_file.parent.mkdir(parents=True, exist_ok=True)
                log_file.write_text(
                    f"$ {' '.join(cmd)}\n--- stdout ---\n{proc.stdout}\n--- stderr ---\n{proc.stderr}\n"
                )
            except Exception:  # noqa: BLE001
                pass

        if proc.returncode != 0:
            return ExecutionResult(
                passed=False,
                exit_code=proc.returncode,
                stdout=proc.stdout,
                stderr=proc.stderr,
            )

        # Inspect the executed notebook for `ename` (=exception) and empty outputs.
        nb = nbformat.read(str(copy), as_version=4)
        error_cells: List[int] = []
        error_messages: List[str] = []
        empty: List[int] = []
        for i, cell in enumerate(nb.cells):
            if cell.cell_type != "code":
                continue
            outs = cell.get("outputs", []) or []
            for o in outs:
                if o.get("output_type") == "error" or "ename" in o:
                    error_cells.append(i)
                    error_messages.append(f"cell {i}: {o.get('ename', '')}: {o.get('evalue', '')}")
                    break
            if expected_nonempty_cell_indices and i in expected_nonempty_cell_indices:
                if not outs:
                    empty.append(i)

        passed = not error_cells and not empty
        return ExecutionResult(
            passed=passed,
            exit_code=0,
            error_cells=error_cells,
            error_messages=error_messages,
            empty_output_cells=empty,
            stdout=proc.stdout,
            stderr=proc.stderr,
        )
    except subprocess.TimeoutExpired as e:
        return ExecutionResult(passed=False, exit_code=-1, stderr=f"timeout: {e}")
    except Exception as e:  # noqa: BLE001
        return ExecutionResult(passed=False, exit_code=-1, stderr=f"crashed: {e}")
    finally:
        shutil.rmtree(work, ignore_errors=True)

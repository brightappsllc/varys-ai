"""JupyterLab subprocess lifecycle manager.

Spawns a fresh `jupyter lab` per test with a fixed token, an isolated temp
working directory, and a randomly selected available port. Tear-down is
unconditional.
"""

from __future__ import annotations

import os
import shutil
import socket
import subprocess
import tempfile
import time
from pathlib import Path
from typing import Optional
from urllib.parse import urlencode

import requests


FIXED_TOKEN = "varys-test-token"
READY_TIMEOUT_S = 30.0
POLL_INTERVAL_S = 0.5


def _pick_free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("", 0))
        return s.getsockname()[1]


class JupyterServer:
    """Manages the lifecycle of a JupyterLab subprocess for one test."""

    url: str
    token: str
    notebook_path: str

    def __init__(self, log_dir: Optional[Path] = None) -> None:
        self.token = FIXED_TOKEN
        self.url = ""
        self.notebook_path = ""
        self._port: int = 0
        self._proc: Optional[subprocess.Popen] = None
        self._workdir: Optional[Path] = None
        self._log_dir = log_dir or Path(tempfile.gettempdir()) / "varys_tests_logs"
        self._log_dir.mkdir(parents=True, exist_ok=True)
        self._log_file: Optional[Path] = None

    # ------------------------------------------------------------------
    # lifecycle
    # ------------------------------------------------------------------
    def start(self, fixture: str) -> None:
        """Spawn JupyterLab and copy `fixture` into a fresh temp workdir.

        `fixture` may be either:
          • an absolute path to a .ipynb file (preferred — used by the
            scenario loader, which resolves notebooks relative to the YAML)
          • a bare filename (legacy) — searched under
            varys_tests/curriculum/scenarios/<stem>/<filename>
        """
        self._workdir = Path(tempfile.mkdtemp(prefix="varys_test_"))
        src = self._resolve_fixture(fixture)
        dst = self._workdir / src.name
        shutil.copy2(src, dst)
        self.notebook_path = str(dst)

        self._port = _pick_free_port()
        self.url = f"http://localhost:{self._port}"

        ts = time.strftime("%Y%m%d-%H%M%S")
        self._log_file = self._log_dir / f"jupyter-{ts}-{self._port}.log"

        cmd = [
            "jupyter", "lab",
            "--no-browser",
            "--ServerApp.ip=127.0.0.1",
            f"--ServerApp.port={self._port}",
            f"--ServerApp.token={self.token}",
            "--ServerApp.password=",
            f"--ServerApp.root_dir={self._workdir}",
            "--ServerApp.open_browser=False",
            "--ServerApp.allow_origin=*",
            "--ServerApp.disable_check_xsrf=True",
            "--LabApp.expose_app_in_browser=True",
        ]

        env = os.environ.copy()
        # Force Varys into a deterministic state if needed (no-op if not set elsewhere)
        env.setdefault("PYTHONUNBUFFERED", "1")

        log_fh = open(self._log_file, "w")
        self._proc = subprocess.Popen(
            cmd,
            stdout=log_fh,
            stderr=subprocess.STDOUT,
            cwd=str(self._workdir),
            env=env,
        )

        self._wait_until_ready()

    def stop(self) -> None:
        if self._proc is not None:
            try:
                self._proc.terminate()
                try:
                    self._proc.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    self._proc.kill()
                    self._proc.wait(timeout=5)
            finally:
                self._proc = None
        if self._workdir is not None and self._workdir.exists():
            shutil.rmtree(self._workdir, ignore_errors=True)
            self._workdir = None

    # ------------------------------------------------------------------
    # workdir reset (for runner reuse between tasks)
    # ------------------------------------------------------------------
    def reset_workdir(self, fixture: str) -> None:
        """Replace the notebook in the workdir with a clean fixture copy.

        Faster than restart(): no subprocess churn. Use between curriculum tasks.
        """
        if self._workdir is None:
            raise RuntimeError("server not started")
        # Remove all .ipynb files (in case Varys wrote sibling files)
        for p in self._workdir.glob("*.ipynb"):
            try:
                p.unlink()
            except OSError:
                pass
        # Also clear .ipynb_checkpoints
        ck = self._workdir / ".ipynb_checkpoints"
        if ck.exists():
            shutil.rmtree(ck, ignore_errors=True)

        src = self._resolve_fixture(fixture)
        dst = self._workdir / src.name
        # Use shutil.copy (not copy2) so the new file gets a fresh mtime —
        # otherwise JupyterLab's file watcher won't fire and the open
        # notebook tab won't notice the disk change.
        shutil.copy(src, dst)
        # Belt-and-suspenders: explicitly touch to current time.
        dst.touch()
        self.notebook_path = str(dst)

    def _resolve_fixture(self, fixture: str) -> Path:
        """Accept absolute path OR bare filename and return an existing Path.

        Bare filenames are searched under scenarios/<stem>/<filename> first
        (new layout) then scenarios/<filename>'s parent for the legacy flat
        layout. Raises FileNotFoundError on miss.
        """
        p = Path(fixture)
        if p.is_absolute():
            if not p.exists():
                raise FileNotFoundError(f"fixture not found: {p}")
            return p
        scenarios_dir = (
            Path(__file__).resolve().parent.parent / "curriculum" / "scenarios"
        )
        # New layout: scenarios/<stem>/<filename>
        candidate = scenarios_dir / p.stem / p.name
        if candidate.exists():
            return candidate
        # Last-ditch: recursive search.
        for hit in scenarios_dir.rglob(p.name):
            return hit
        raise FileNotFoundError(
            f"fixture {fixture!r} not found under {scenarios_dir}"
        )

    # ------------------------------------------------------------------
    # urls
    # ------------------------------------------------------------------
    def get_notebook_url(self) -> str:
        if not self.url or not self.notebook_path or self._workdir is None:
            raise RuntimeError("server not started")
        rel = Path(self.notebook_path).name
        qs = urlencode({"token": self.token})
        return f"{self.url}/lab/tree/{rel}?{qs}"

    # ------------------------------------------------------------------
    # internals
    # ------------------------------------------------------------------
    def _wait_until_ready(self) -> None:
        deadline = time.time() + READY_TIMEOUT_S
        status_url = f"{self.url}/api/status?token={self.token}"
        last_err: Optional[Exception] = None
        while time.time() < deadline:
            if self._proc and self._proc.poll() is not None:
                raise RuntimeError(
                    f"jupyter lab exited prematurely (code={self._proc.returncode}); "
                    f"see {self._log_file}"
                )
            try:
                r = requests.get(status_url, timeout=2)
                if r.status_code == 200:
                    return
            except Exception as e:  # noqa: BLE001
                last_err = e
            time.sleep(POLL_INTERVAL_S)
        raise TimeoutError(
            f"jupyter lab did not become ready within {READY_TIMEOUT_S}s "
            f"(last error: {last_err}); see {self._log_file}"
        )

"""Pytest fixtures for the Varys stress-test framework.

Scope choices:
- `jupyter_server`: session — one JupyterLab process for the whole curriculum.
  The CurriculumRunner resets the workdir between tasks rather than restarting
  the server (per spec, server restart per task is too slow).
- `playwright_session`: session — one browser instance for the whole run.
"""

from __future__ import annotations

import os
from pathlib import Path

import pytest

from varys_tests.harness.jupyter_server import JupyterServer
from varys_tests.harness.varys_driver import PlaywrightSession


@pytest.fixture(scope="session")
def jupyter_server():
    server = JupyterServer()
    # Start with the simple fixture; runner resets per task.
    # Bare filename — JupyterServer._resolve_fixture searches under
    # scenarios/<stem>/ so this picks up scenarios/simple_rename/simple_rename.ipynb.
    server.start("simple_rename.ipynb")
    yield server
    server.stop()


@pytest.fixture(scope="session")
def playwright_session():
    headless = os.environ.get("VARYS_TEST_HEADLESS", "1") != "0"
    sess = PlaywrightSession(headless=headless)
    sess.start()
    yield sess
    sess.stop()

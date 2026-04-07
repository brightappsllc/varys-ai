"""Playwright-based driver for the Varys chat sidebar.

All Playwright mechanics are encapsulated here. Tests and curriculum code
should never import `playwright` directly.

NOTE on selectors: this is the v1.0 scaffold. The selectors below assume the
`data-testid` attributes added to `SidebarWidget.tsx` (varys-chat-input,
varys-send-button, varys-stop-button, varys-assistant-message). They will need
verification against the live DOM in a follow-up pass — Playwright trace
output and screenshots are written to `varys_tests/results/playwright/` to
make that verification possible.
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from pathlib import Path
from typing import Literal, Optional

from playwright.sync_api import Page, TimeoutError as PWTimeout, sync_playwright


# ----------------------------------------------------------------------
# selectors (single source of truth — change here when DOM changes)
# ----------------------------------------------------------------------
SEL_SIDEBAR_TAB = '[data-id="varys-sidebar"]'
SEL_CHAT_INPUT = '[data-testid="varys-chat-input"]'
SEL_SEND_BTN = '[data-testid="varys-send-button"]'
SEL_STOP_BTN = '[data-testid="varys-stop-button"]'
SEL_ASSISTANT_MSG = '[data-testid="varys-assistant-message"]'


@dataclass
class TaskResult:
    status: Literal["pass", "fail", "timeout"]
    varys_response: str
    notebook_path: str
    duration_s: float = 0.0


class VarysDriver:
    """Drives the Varys chat UI through Playwright."""

    def __init__(
        self,
        page: Page,
        notebook_url: str,
        notebook_path: str,
        artifacts_dir: Optional[Path] = None,
    ) -> None:
        self._page = page
        self._notebook_url = notebook_url
        self._notebook_path = notebook_path
        self._artifacts = artifacts_dir or Path(__file__).resolve().parent.parent / "results" / "playwright"
        self._artifacts.mkdir(parents=True, exist_ok=True)
        self._opened = False

    # ------------------------------------------------------------------
    # navigation
    # ------------------------------------------------------------------
    def open(self) -> None:
        """Navigate to the notebook and open the Varys sidebar."""
        self._page.goto(self._notebook_url, wait_until="domcontentloaded")
        # Wait for JupyterLab shell. The notebook tab takes a moment to mount.
        self._page.wait_for_selector(".jp-NotebookPanel", timeout=30_000)
        # Click the Varys sidebar tab to ensure it is visible.
        try:
            self._page.click(SEL_SIDEBAR_TAB, timeout=10_000)
        except PWTimeout:
            # Tab may already be active; tolerate.
            pass
        self._page.wait_for_selector(SEL_CHAT_INPUT, timeout=15_000)
        self._opened = True

    def reload_notebook(self, notebook_url: str, notebook_path: str) -> None:
        """Re-navigate after the runner reset the workdir for a new task."""
        self._notebook_url = notebook_url
        self._notebook_path = notebook_path
        self._opened = False
        self.open()

    # ------------------------------------------------------------------
    # task submission
    # ------------------------------------------------------------------
    def submit_task(self, prompt: str, timeout_s: int) -> TaskResult:
        if not self._opened:
            self.open()

        start = time.monotonic()

        # Clear and type the prompt. The chat input is contenteditable, so we
        # focus it and use keyboard.type rather than fill().
        input_locator = self._page.locator(SEL_CHAT_INPUT)
        input_locator.click()
        # Select-all + delete to clear contenteditable.
        self._page.keyboard.press("Control+A")
        self._page.keyboard.press("Delete")
        self._page.keyboard.type(prompt, delay=5)

        # Click send.
        try:
            self._page.click(SEL_SEND_BTN, timeout=5_000)
        except PWTimeout:
            return TaskResult(
                status="timeout",
                varys_response="<send button never appeared>",
                notebook_path=self._notebook_path,
                duration_s=time.monotonic() - start,
            )

        # Stage 1: wait for Stop button (confirms isLoading=true).
        try:
            self._page.wait_for_selector(SEL_STOP_BTN, timeout=10_000, state="visible")
        except PWTimeout:
            # Varys may have responded so fast the stop button never appeared.
            # That's not necessarily a failure — fall through to stage 2.
            pass

        # Stage 2: wait for Send button to reappear (isLoading=false).
        try:
            self._page.wait_for_selector(
                SEL_SEND_BTN, timeout=timeout_s * 1000, state="visible"
            )
        except PWTimeout:
            self._snapshot("timeout")
            return TaskResult(
                status="timeout",
                varys_response="<send button never reappeared>",
                notebook_path=self._notebook_path,
                duration_s=time.monotonic() - start,
            )

        # Save the notebook to disk so structural assertions see latest state.
        self._save_notebook()

        # Extract last assistant message text.
        response = self._extract_last_assistant_message()

        return TaskResult(
            status="pass",  # caller (assertion engine) decides final pass/fail
            varys_response=response,
            notebook_path=self._notebook_path,
            duration_s=time.monotonic() - start,
        )

    # ------------------------------------------------------------------
    # internals
    # ------------------------------------------------------------------
    def _save_notebook(self) -> None:
        """Trigger Ctrl+S so JupyterLab flushes the notebook to disk."""
        try:
            # Focus the notebook panel first
            self._page.locator(".jp-NotebookPanel").first.click(timeout=2_000)
            self._page.keyboard.press("Control+S")
            # Brief pause so the autosave commit reaches disk.
            self._page.wait_for_timeout(750)
        except PWTimeout:
            pass

    def _extract_last_assistant_message(self) -> str:
        bubbles = self._page.locator(SEL_ASSISTANT_MSG)
        try:
            count = bubbles.count()
        except Exception:  # noqa: BLE001
            return ""
        if count == 0:
            return ""
        try:
            return bubbles.nth(count - 1).inner_text(timeout=2_000)
        except Exception:  # noqa: BLE001
            return ""

    def _snapshot(self, label: str) -> None:
        ts = time.strftime("%Y%m%d-%H%M%S")
        try:
            self._page.screenshot(path=str(self._artifacts / f"{ts}-{label}.png"), full_page=True)
        except Exception:  # noqa: BLE001
            pass


# ----------------------------------------------------------------------
# context-manager helper used by conftest fixtures
# ----------------------------------------------------------------------
class PlaywrightSession:
    """Convenience wrapper that owns a Playwright instance + browser + page."""

    def __init__(self, headless: bool = True) -> None:
        self._headless = headless
        self._pw = None
        self._browser = None
        self._context = None
        self.page: Optional[Page] = None

    def start(self) -> Page:
        self._pw = sync_playwright().start()
        self._browser = self._pw.chromium.launch(headless=self._headless)
        self._context = self._browser.new_context(viewport={"width": 1400, "height": 900})
        self.page = self._context.new_page()
        return self.page

    def stop(self) -> None:
        try:
            if self._context:
                self._context.close()
            if self._browser:
                self._browser.close()
            if self._pw:
                self._pw.stop()
        finally:
            self._pw = None
            self._browser = None
            self._context = None
            self.page = None

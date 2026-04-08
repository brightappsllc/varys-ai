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

import json
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Literal, Optional

from playwright.sync_api import Page, TimeoutError as PWTimeout, sync_playwright


# ----------------------------------------------------------------------
# selectors (single source of truth — change here when DOM changes)
# ----------------------------------------------------------------------
# JupyterLab right sidebar tab. The tab bar lives in `.jp-SideBar.jp-mod-right`
# and each tab carries `data-id="<widget-id>"` matching the widget registered
# in src/index.ts (`sidebar.id = 'varys-sidebar'`).
SEL_SIDEBAR_TAB = '.jp-SideBar.jp-mod-right .lm-TabBar-tab[data-id="varys-sidebar"]'
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
        cell_mode: Optional[str] = None,        # "chat" | "agent" | None
        reasoning_mode: Optional[str] = None,   # "off" | "cot" | "sequential" | None
    ) -> None:
        self._page = page
        self._notebook_url = notebook_url
        self._notebook_path = notebook_path
        self._artifacts = artifacts_dir or Path(__file__).resolve().parent.parent / "results" / "playwright"
        self._artifacts.mkdir(parents=True, exist_ok=True)
        self._opened = False
        self._cell_mode = cell_mode
        self._reasoning_mode = reasoning_mode
        # Inject mode + reasoning into localStorage BEFORE navigation so the
        # SidebarWidget reads them on mount. add_init_script runs on every
        # new document, so this survives full reloads.
        if cell_mode or reasoning_mode:
            settings = {}
            if cell_mode:
                settings["ds-assistant-cell-mode"] = cell_mode
            if reasoning_mode:
                settings["ds-varys-reasoning-mode"] = reasoning_mode
            script = (
                "Object.entries(" + json.dumps(settings) + ")"
                ".forEach(([k, v]) => { try { localStorage.setItem(k, v); } catch (e) {} });"
            )
            try:
                self._page.add_init_script(script)
            except Exception:  # noqa: BLE001
                pass

    # ------------------------------------------------------------------
    # navigation
    # ------------------------------------------------------------------
    def open(self) -> None:
        """Navigate to the notebook and open the Varys sidebar."""
        print(f"[driver]   navigate → {self._notebook_url}", flush=True)
        self._page.goto(self._notebook_url, wait_until="domcontentloaded")
        # Verify settings actually landed in localStorage. If they didn't, the
        # init_script ran after the page already had stale values OR the keys
        # are wrong. Force-set them defensively, then reload once.
        if self._cell_mode or self._reasoning_mode:
            actual = self._page.evaluate(
                """() => ({
                    cell: localStorage.getItem('ds-assistant-cell-mode'),
                    reasoning: localStorage.getItem('ds-varys-reasoning-mode'),
                })"""
            )
            print(f"[driver]   localStorage after navigate: {actual}", flush=True)
            need_reload = False
            if self._cell_mode and actual.get("cell") != self._cell_mode:
                need_reload = True
            if self._reasoning_mode and actual.get("reasoning") != self._reasoning_mode:
                need_reload = True
            if need_reload:
                print("[driver]   forcing localStorage + reload", flush=True)
                self._page.evaluate(
                    """({cell, reasoning}) => {
                        if (cell) localStorage.setItem('ds-assistant-cell-mode', cell);
                        if (reasoning) localStorage.setItem('ds-varys-reasoning-mode', reasoning);
                    }""",
                    {"cell": self._cell_mode, "reasoning": self._reasoning_mode},
                )
                self._page.reload(wait_until="domcontentloaded")
                actual = self._page.evaluate(
                    """() => ({
                        cell: localStorage.getItem('ds-assistant-cell-mode'),
                        reasoning: localStorage.getItem('ds-varys-reasoning-mode'),
                    })"""
                )
                print(f"[driver]   localStorage after reload: {actual}", flush=True)
        # Wait for JupyterLab shell. The notebook tab takes a moment to mount.
        self._page.wait_for_selector(".jp-NotebookPanel", timeout=30_000)
        # Wait for the right sidebar tab bar to render the Varys tab.
        try:
            self._page.wait_for_selector(SEL_SIDEBAR_TAB, timeout=15_000, state="attached")
        except PWTimeout:
            self._snapshot("no-sidebar-tab")
            raise
        # Activate the tab. JupyterLab toggles on click, so we check
        # visibility after each attempt and re-click if needed (max 3 tries).
        input_loc = self._page.locator(SEL_CHAT_INPUT)
        for attempt in range(3):
            try:
                if input_loc.is_visible():
                    break
            except Exception:  # noqa: BLE001
                pass
            try:
                self._page.click(SEL_SIDEBAR_TAB, timeout=5_000)
            except PWTimeout:
                pass
            self._page.wait_for_timeout(800)
        # Final wait — if still not visible after 3 tries, fail loudly.
        self._page.wait_for_selector(SEL_CHAT_INPUT, timeout=10_000, state="visible")
        print("[driver]   sidebar open, chat input visible", flush=True)
        # Apply mode + reasoning via UI clicks. localStorage alone doesn't
        # work because the SidebarWidget reloads per-thread settings on mount,
        # which overwrites our values.
        self._apply_chat_settings()
        self._run_all_cells()
        self._opened = True

    # ------------------------------------------------------------------
    def _apply_chat_settings(self) -> None:
        """Set the cell mode and reasoning mode by interacting with the UI.

        - Cell mode: a real <select> with values "chat" / "agent" — use
          select_option which fires React's onChange.
        - Reasoning: a button + dropdown menu — click the chip, then click
          the option whose value matches.
        """
        if self._cell_mode:
            try:
                sel = self._page.locator('.ds-cell-mode-select').first
                sel.wait_for(state="visible", timeout=5_000)
                sel.select_option(value=self._cell_mode)
                print(f"[driver]   cell mode set → {self._cell_mode}", flush=True)
            except Exception as e:  # noqa: BLE001
                print(f"[driver]   ⚠ cell mode set failed: {e}", flush=True)

        if self._reasoning_mode:
            try:
                chip = self._page.locator('.ds-thinking-chip').first
                chip.wait_for(state="visible", timeout=5_000)
                chip.click()
                # Dropdown opens — find the option whose label matches.
                # The DOM uses ds-reasoning-item--{off|cot|seq}.
                mod_class = {
                    "off": "ds-reasoning-item--off",
                    "cot": "ds-reasoning-item--cot",
                    "sequential": "ds-reasoning-item--seq",
                }.get(self._reasoning_mode, "ds-reasoning-item--off")
                opt = self._page.locator(f".ds-reasoning-menu .{mod_class}").first
                opt.wait_for(state="visible", timeout=3_000)
                opt.click()
                print(f"[driver]   reasoning mode set → {self._reasoning_mode}", flush=True)
            except Exception as e:  # noqa: BLE001
                print(f"[driver]   ⚠ reasoning mode set failed: {e}", flush=True)

    # ------------------------------------------------------------------
    def _run_all_cells(self, max_wait_s: int = 60) -> None:
        """Trigger 'Run > Run All Cells' and wait for the kernel to finish.

        Completion detection: poll the cells until every code cell has an
        execution count (no `In [ ]:` prompts left) AND the kernel-busy
        indicator is idle. Tolerates syntax errors — they're part of some
        fixtures (e.g. simple_rename.ipynb) and the test wants Varys to fix
        them.
        """
        try:
            # Make sure focus is on the notebook, not the chat sidebar.
            try:
                self._page.locator('.jp-NotebookPanel .jp-Toolbar').first.click(timeout=2_000)
            except Exception:  # noqa: BLE001
                pass
            run_menu = self._page.locator('.lm-MenuBar-itemLabel', has_text='Run').first
            run_menu.wait_for(state="visible", timeout=5_000)
            run_menu.click()
            run_all = self._page.locator('.lm-Menu-itemLabel', has_text='Run All Cells').first
            run_all.wait_for(state="visible", timeout=5_000)
            run_all.click()
            print("[driver]   run all cells dispatched", flush=True)
        except PWTimeout:
            print("[driver]   ⚠ run all cells: menu not found, continuing", flush=True)
            self._snapshot("run-all-failed")
            return

        # Wait for completion. Two terminating conditions:
        #   (a) all cells executed (pending == 0)
        #   (b) no progress for 3s AND kernel is idle — handles fixtures
        #       with intentional syntax errors that halt run-all early.
        deadline = time.monotonic() + max_wait_s
        last_state = None
        idle_since: Optional[float] = None
        while time.monotonic() < deadline:
            try:
                state = self._page.evaluate(
                    """() => {
                        const prompts = Array.from(document.querySelectorAll(
                            '.jp-CodeCell .jp-InputPrompt'
                        ));
                        let pending = 0, running = 0;
                        for (const p of prompts) {
                            const t = (p.textContent || '').trim();
                            if (t.includes('[*]')) running++;
                            else if (t.includes('[ ]')) pending++;
                        }
                        // Kernel status — "Idle" or "Busy". Selector varies
                        // between JupyterLab versions.
                        const kStatus = document.querySelector(
                            '.jp-Notebook-ExecutionIndicator, [data-status]'
                        );
                        const kernelText = kStatus ? (kStatus.textContent || kStatus.getAttribute('data-status') || '').trim() : '';
                        return {
                            pending, running, total: prompts.length,
                            kernel: kernelText.toLowerCase(),
                        };
                    }"""
                )
            except Exception:  # noqa: BLE001
                state = {"pending": 0, "running": 0, "total": 0, "kernel": ""}

            if state != last_state:
                print(f"[driver]   run progress: {state}", flush=True)
                last_state = state
                idle_since = None  # progress reset

            # (a) Everything completed
            if state.get("total", 0) > 0 and state.get("pending", 1) == 0 and state.get("running", 0) == 0:
                print("[driver]   run all cells complete", flush=True)
                return

            # (b) No running cell + no progress for 3s → assume halted (e.g.
            # syntax error stopped the run mid-way). Accept and move on.
            if state.get("running", 0) == 0:
                if idle_since is None:
                    idle_since = time.monotonic()
                elif time.monotonic() - idle_since > 3.0:
                    print(f"[driver]   run all cells halted (pending={state.get('pending')}, likely error in earlier cell)", flush=True)
                    return
            self._page.wait_for_timeout(500)
        print(f"[driver]   ⚠ run all cells: timeout after {max_wait_s}s, continuing", flush=True)

    def reload_notebook(self, notebook_url: str, notebook_path: str) -> None:
        """Re-navigate after the runner reset the workdir for a new task."""
        self._notebook_url = notebook_url
        self._notebook_path = notebook_path
        self._opened = False
        self.open()

    def revert_notebook_in_place(self) -> None:
        """Reload the currently-open notebook from disk without a page reload.

        Strategy: the runner just overwrote the .ipynb file with a fresh
        fixture copy. JupyterLab's file watcher detects the external change
        and pops a `.jp-Dialog` asking the user how to resolve it. We click
        the "Revert" / "Reload" button on that dialog. If no dialog appears
        within a few seconds (e.g. file watcher missed the change), we fall
        back to the File menu, then to a full page reload as last resort.
        """
        # Step 1: wait for the auto-dialog. JupyterLab usually pops it within
        # 1-2s of the mtime change.
        try:
            dialog = self._page.locator('.jp-Dialog').first
            dialog.wait_for(state="visible", timeout=5_000)
            # Click "Reload from Disk" — JupyterLab's "File Changed on Disk"
            # dialog has buttons like "Reload" and "Overwrite". DO NOT click
            # anything matching "Revert", because "Revert" in JupyterLab
            # refers to "Revert to Checkpoint" (loads from .ipynb_checkpoints/),
            # which we deleted in reset_workdir → guaranteed failure.
            for label in ("Reload from Disk", "Reload", "Overwrite"):
                btn = dialog.locator('button', has_text=label).first
                try:
                    if btn.is_visible():
                        btn.click(timeout=2_000)
                        print(f"[driver]   notebook reverted via dialog ({label})", flush=True)
                        self._page.wait_for_timeout(500)
                        self._run_all_cells()
                        return
                except Exception:  # noqa: BLE001
                    continue
        except PWTimeout:
            pass

        # NOTE: do NOT fall back to File > "Revert Notebook to Checkpoint" —
        # that command only loads from .ipynb_checkpoints/, which we delete
        # in reset_workdir, so it always pops a "No checkpoints" dialog.
        # Step 2: full page reload (slow but always works).
        print("[driver]   ⚠ no auto-dialog, falling back to full reload", flush=True)
        self._opened = False
        self.open()

    # ------------------------------------------------------------------
    # task submission
    # ------------------------------------------------------------------
    def submit_task(self, prompt: str, timeout_s: int) -> TaskResult:
        if not self._opened:
            self.open()

        print(f"[driver]   submit (timeout={timeout_s}s): {prompt[:100]}", flush=True)
        start = time.monotonic()

        # The chat input is a contenteditable <div>, not a real <textarea>.
        # React state (`input`) is updated by an onInput handler reading
        # `el.innerText`. Playwright's keyboard.type() fires keydown/keypress
        # events but does NOT always trigger a synthetic React `input` event
        # against contenteditable in a way React picks up — leaving the Send
        # button un-rendered (`input.trim() === ''`).
        #
        # Inject text directly and dispatch a real `input` event so React's
        # listener fires. This is the approach Playwright recommends for
        # contenteditable when fill() is unavailable.
        input_locator = self._page.locator(SEL_CHAT_INPUT)
        input_locator.wait_for(state="visible", timeout=10_000)
        input_locator.click()
        # Focus + clear + execCommand insertText. execCommand simulates real
        # typing closely enough that React's onInput handler fires correctly,
        # which is required to update the `input` state and reveal the Send
        # button (`input.trim() ? <SendBtn/> : null`).
        # The contenteditable's React onInput handler isn't firing reliably
        # via dispatched events or execCommand — likely because React batches
        # event handlers in a way that ignores synthesized native events on
        # this particular element. Bypass the event system entirely: find
        # the React props on the DOM node, set innerText, then call onInput
        # directly with a fake event whose `target.innerText` matches.
        ok = self._page.evaluate(
            """({selector, text}) => {
                const el = document.querySelector(selector);
                if (!el) return {ok: false, reason: 'no-element'};
                el.focus();
                el.innerText = text;
                // Find React props key (__reactProps$xxxxx)
                const propsKey = Object.keys(el).find(k => k.startsWith('__reactProps$'));
                if (!propsKey) {
                    return {ok: false, reason: 'no-react-props', innerText: el.innerText};
                }
                const props = el[propsKey];
                if (typeof props.onInput !== 'function') {
                    return {ok: false, reason: 'no-onInput', innerText: el.innerText};
                }
                // React's onInput handler reads textareaRef.current.innerText,
                // not event.target — so we just need to call it. The event
                // arg is unused by the handler in SidebarWidget.tsx.
                try {
                    props.onInput({ target: el, currentTarget: el });
                } catch (e) {
                    return {ok: false, reason: 'onInput-threw: ' + e.message, innerText: el.innerText};
                }
                return {ok: true, innerText: el.innerText};
            }""",
            {"selector": SEL_CHAT_INPUT, "text": prompt},
        )
        print(f"[driver]   input injected: {ok}", flush=True)
        # Brief settle so React state update + re-render lands before we
        # look up the (possibly fresh) onKeyDown handler from the fiber.
        self._page.wait_for_timeout(300)

        # Skip the Send button entirely. handleKeyDown on the input triggers
        # `handleSend()` directly when Enter is pressed (without Shift) — see
        # SidebarWidget.tsx around line 6566. Call the handler via the React
        # fiber so we don't depend on synthetic event delivery.
        sent = self._page.evaluate(
            """({selector}) => {
                const el = document.querySelector(selector);
                if (!el) return {ok: false, reason: 'no-element'};
                const propsKey = Object.keys(el).find(k => k.startsWith('__reactProps$'));
                if (!propsKey) return {ok: false, reason: 'no-react-props'};
                const props = el[propsKey];
                if (typeof props.onKeyDown !== 'function') {
                    return {ok: false, reason: 'no-onKeyDown'};
                }
                try {
                    props.onKeyDown({
                        key: 'Enter',
                        shiftKey: false,
                        ctrlKey: false,
                        metaKey: false,
                        altKey: false,
                        target: el,
                        currentTarget: el,
                        preventDefault: () => {},
                        stopPropagation: () => {},
                        nativeEvent: { isComposing: false },
                    });
                } catch (e) {
                    return {ok: false, reason: 'onKeyDown-threw: ' + e.message};
                }
                return {ok: true};
            }""",
            {"selector": SEL_CHAT_INPUT},
        )
        print(f"[driver]   enter dispatched: {sent}", flush=True)
        if not sent.get("ok"):
            self._snapshot("send-failed")
            return TaskResult(
                status="timeout",
                varys_response=f"<send failed: {sent.get('reason')}>",
                notebook_path=self._notebook_path,
                duration_s=time.monotonic() - start,
            )

        # Stage 1: wait for Stop button (confirms isLoading=true → stream
        # started). If Varys fails before starting, we want to know.
        try:
            self._page.wait_for_selector(SEL_STOP_BTN, timeout=15_000, state="visible")
            print("[driver]   stream started (stop button visible)", flush=True)
        except PWTimeout:
            # The response may have been so fast the Stop button blinked past
            # us, or Varys errored before starting. Fall through to Stage 2 —
            # if isLoading was never true, the "hidden" wait below returns
            # immediately.
            print("[driver]   ⚠ stop button never appeared, continuing", flush=True)

        # Stage 2: wait for Stop button to disappear (isLoading → false).
        # We CANNOT wait for Send button to reappear because after sending,
        # the input is cleared and Send button is gone too:
        #   {isLoading ? <Stop/> : input.trim() ? <Send/> : null}
        try:
            self._page.wait_for_selector(
                SEL_STOP_BTN, timeout=timeout_s * 1000, state="hidden"
            )
            print(f"[driver]   response complete in {time.monotonic()-start:.1f}s", flush=True)
        except PWTimeout:
            print(f"[driver]   ✗ response timeout after {timeout_s}s", flush=True)
            self._snapshot("timeout")
            return TaskResult(
                status="timeout",
                varys_response="<send button never reappeared>",
                notebook_path=self._notebook_path,
                duration_s=time.monotonic() - start,
            )

        # Varys often presents code changes as diffs that require explicit
        # acceptance via the "✓ Accept" button (when requiresApproval=true).
        # Without this, the cell is never updated and the notebook on disk
        # stays unchanged. Click every pending Accept button.
        self._accept_all_pending_diffs()

        # Re-run all cells so the modified cell(s) actually execute against
        # the kernel. Mirrors a real user clicking Run after accepting an
        # AI-suggested change.
        self._run_all_cells()

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
    def set_limit_to_focal(self, on: bool) -> None:
        """Set the "Limit context to active cell" preference for the next
        chat request.

        The setting now lives in Settings → Workspace → Context. The chat
        input reads it fresh from localStorage at submit time, so we just
        write the key directly via JS — no UI navigation needed.
        """
        value = "1" if on else "0"
        try:
            self._page.evaluate(
                "(v) => { try { localStorage.setItem('ds-assistant-limit-to-focal', v); } catch (e) {} }",
                value,
            )
            print(f"[driver]   limit_to_focal → {'on' if on else 'off'} (localStorage)", flush=True)
        except Exception as e:  # noqa: BLE001
            print(f"[driver]   ⚠ set_limit_to_focal failed: {e}", flush=True)

    def run_all_cells(self, timeout_ms: int = 120_000) -> None:
        """Run every cell and BLOCK until the kernel reports idle and every
        code cell has a non-null execution_count.

        Critical: we must not return early. If we do, the first task will
        race in-flight cell executions which yank the active cell around
        and clobber our focus_cell() call.
        """
        result = self._page.evaluate(
            """async ({timeoutMs}) => {
                const sleep = (ms) => new Promise(r => setTimeout(r, ms));
                const app = window.jupyterapp
                          || (window.jupyterlab && window.jupyterlab.app);
                if (!app || !app.commands) return {ok: false, reason: 'no app.commands'};

                // Find the notebook panel.
                let panel = null;
                for (let i = 0; i < 100; i++) {
                    const cw = app.shell && app.shell.currentWidget;
                    if (cw && cw.content
                        && typeof cw.content.activeCellIndex === 'number') {
                        panel = cw; break;
                    }
                    await sleep(100);
                }
                if (!panel) return {ok: false, reason: 'no notebook panel'};

                try { if (panel.context && panel.context.ready) await panel.context.ready; } catch (e) {}
                try { if (panel.sessionContext && panel.sessionContext.ready) await panel.sessionContext.ready; } catch (e) {}

                // CRITICAL: activate the notebook so it becomes the
                // command-target. Without this, the Varys sidebar may be
                // currentWidget and notebook:run-all-cells silently no-ops.
                try { app.shell.activateById(panel.id); } catch (e) {}
                await sleep(150);

                try {
                    await app.commands.execute('notebook:run-all-cells');
                } catch (e) {
                    return {ok: false, reason: 'execute threw: ' + e.message};
                }

                // Wait for kernel idle AND every code cell to have an
                // execution_count (i.e., actually executed in this run).
                const deadline = Date.now() + timeoutMs;
                const nb = panel.content;
                while (Date.now() < deadline) {
                    await sleep(200);
                    const kernel = panel.sessionContext && panel.sessionContext.session
                                 && panel.sessionContext.session.kernel;
                    const status = kernel ? kernel.status : 'unknown';
                    let allDone = true;
                    let codeCells = 0;
                    let executed = 0;
                    for (const c of (nb.widgets || [])) {
                        const m = c.model;
                        if (m && m.type === 'code') {
                            codeCells++;
                            const ec = m.executionCount != null
                                     ? m.executionCount
                                     : (m.sharedModel && m.sharedModel.execution_count);
                            if (ec == null) { allDone = false; }
                            else { executed++; }
                        }
                    }
                    if (status === 'idle' && allDone && codeCells > 0) {
                        return {ok: true, status, codeCells, executed};
                    }
                }
                return {ok: false, reason: 'timeout waiting for idle/executed'};
            }""",
            {"timeoutMs": timeout_ms},
        )
        if not result or not result.get("ok"):
            print(f"[driver]   ⚠ run_all_cells failed: {result}", flush=True)
        else:
            print(
                f"[driver]   run_all_cells done "
                f"(executed {result.get('executed')}/{result.get('codeCells')} code cells)",
                flush=True,
            )

    def focus_cell(self, index: int) -> None:
        """Make cell N (0-indexed) the active JupyterLab cell.

        Strategy: drive JupyterLab's notebook model directly via
        page.evaluate. Clicking cell DOM is unreliable because clicking the
        editor enters edit mode and clicking the prompt gutter doesn't
        always change the active cell. Walking the Lumino widget tree to
        set `notebook.activeCellIndex` is the authoritative path.
        """
        # JupyterLab restores the saved active cell from notebook metadata
        # *after* the page loads, which races with us setting activeCellIndex.
        # Strategy: poll until the notebook widget is mounted with >= target+1
        # cells, set activeCellIndex, wait a beat, re-read, and retry if state
        # restoration overwrote us.
        result = self._page.evaluate(
            """async ({targetIdx}) => {
                const sleep = (ms) => new Promise(r => setTimeout(r, ms));

                const findPanel = () => {
                    const app = window.jupyterapp
                              || (window.jupyterlab && window.jupyterlab.app);
                    if (app && app.shell) {
                        try {
                            const it = app.shell.widgets('main');
                            let w = it.next();
                            while (w && !w.done) {
                                const cand = w.value;
                                if (cand && cand.content
                                    && typeof cand.content.activeCellIndex === 'number') {
                                    return cand;
                                }
                                w = it.next();
                            }
                        } catch (e) { /* ignore */ }
                        const cw = app.shell.currentWidget;
                        if (cw && cw.content
                            && typeof cw.content.activeCellIndex === 'number') {
                            return cw;
                        }
                    }
                    return null;
                };

                // Wait up to 10s for a notebook panel to appear.
                let panel = null;
                for (let i = 0; i < 100; i++) {
                    panel = findPanel();
                    if (panel) break;
                    await sleep(100);
                }
                if (!panel) return {ok: false, reason: 'no notebook panel'};

                // Await JupyterLab's own readiness signals so state restore
                // (which sets activeCellIndex from saved metadata) finishes
                // BEFORE we override it. Without this, our set races restore
                // on the first task and loses.
                try { if (panel.context && panel.context.ready) await panel.context.ready; } catch (e) {}
                try { if (panel.revealed) await panel.revealed; } catch (e) {}
                try { if (panel.sessionContext && panel.sessionContext.ready) await panel.sessionContext.ready; } catch (e) {}

                // Activate the notebook so it becomes the focused widget.
                // The Varys sidebar may currently be currentWidget; setting
                // activeCellIndex on a non-active notebook can be reverted
                // by JupyterLab's focus management on the next tick.
                const app2 = window.jupyterapp
                           || (window.jupyterlab && window.jupyterlab.app);
                try { if (app2 && app2.shell) app2.shell.activateById(panel.id); } catch (e) {}
                // Extra settle for the state-restore microtask queue.
                await sleep(300);

                const nb = panel.content;
                if (!nb.widgets || nb.widgets.length <= targetIdx) {
                    // Wait a bit more for cells to materialize.
                    for (let i = 0; i < 50; i++) {
                        if (nb.widgets && nb.widgets.length > targetIdx) break;
                        await sleep(100);
                    }
                }
                if (!nb.widgets || nb.widgets.length <= targetIdx) {
                    return {ok: false, reason: 'not enough cells',
                            have: (nb.widgets || []).length, want: targetIdx + 1};
                }

                const before = nb.activeCellIndex;

                // Set + verify with retries — state restore may overwrite us.
                let after = before;
                for (let i = 0; i < 10; i++) {
                    nb.activeCellIndex = targetIdx;
                    if (typeof nb.deselectAll === 'function') nb.deselectAll();
                    if (typeof nb.scrollToItem === 'function') {
                        try { nb.scrollToItem(targetIdx); } catch (e) { /* ignore */ }
                    }
                    await sleep(150);
                    after = nb.activeCellIndex;
                    if (after === targetIdx) break;
                }
                return {ok: after === targetIdx, before, after, target: targetIdx};
            }""",
            {"targetIdx": index},
        )
        if result.get("ok"):
            print(
                f"[driver]   focused cell #{index} (was #{result.get('before')}, now #{result.get('after')})",
                flush=True,
            )
            return

        print(f"[driver]   ⚠ focus_cell({index}) widget path failed: {result}", flush=True)

        # Fallback: click the cell at a position that selects without entering
        # edit mode. Click the very top of the cell (the gutter area).
        cells = self._page.locator('.jp-Notebook .jp-Cell')
        try:
            count = cells.count()
        except Exception:  # noqa: BLE001
            count = 0
        if 0 <= index < count:
            try:
                cells.nth(index).click(position={"x": 5, "y": 5}, timeout=2_000)
                # Press Escape to ensure we're in command mode (not edit mode).
                self._page.keyboard.press("Escape")
                self._page.wait_for_timeout(150)
                print(f"[driver]   focused cell #{index} (DOM click fallback)", flush=True)
            except Exception as e:  # noqa: BLE001
                print(f"[driver]   ⚠ focus_cell({index}) DOM fallback failed: {e}", flush=True)

    def _accept_all_pending_diffs(self) -> None:
        """Click every visible '✓ Accept' button in the chat panel.

        Varys's DiffView renders an Accept button when requiresApproval=true.
        When requiresApproval=false (recent UX change), the change is
        pre-applied and only a Reject button is shown — nothing to do here.
        We loop because accepting one diff may reveal another.
        """
        accept_sel = ".ds-assistant-btn-accept"
        clicked_total = 0
        for _ in range(20):  # safety bound
            buttons = self._page.locator(accept_sel)
            try:
                count = buttons.count()
            except Exception:  # noqa: BLE001
                break
            if count == 0:
                break
            clicked = 0
            for i in range(count):
                try:
                    btn = buttons.nth(i)
                    if btn.is_visible():
                        btn.click(timeout=2_000)
                        clicked += 1
                        # Brief pause so React resolves the diff before next iter
                        self._page.wait_for_timeout(150)
                except Exception:  # noqa: BLE001
                    pass
            clicked_total += clicked
            if clicked == 0:
                break
        if clicked_total > 0:
            print(f"[driver]   accepted {clicked_total} pending diff(s)", flush=True)
            # Allow the apply pipeline to flush model changes to the notebook.
            self._page.wait_for_timeout(500)

    def _save_notebook(self) -> None:
        """Flush the in-memory notebook to disk.

        CRITICAL: JupyterLab's "Save Notebook" command saves the *active*
        widget. After typing in the chat sidebar, the active widget is the
        sidebar, NOT the notebook — so File > Save Notebook would save
        nothing. We must focus the notebook panel first.
        """
        # Wait briefly for any pending model updates from accept-diff to land.
        self._page.wait_for_timeout(400)

        # Step 1: focus the notebook panel by clicking its tab bar (the
        # notebook tab in the main dock area, not a cell — clicking a cell
        # would put it in edit mode and Ctrl+S would still go to the cell).
        try:
            tab = self._page.locator('.jp-NotebookPanel .jp-Toolbar').first
            tab.click(timeout=2_000)
        except Exception:  # noqa: BLE001
            try:
                self._page.locator(".jp-NotebookPanel").first.click(timeout=2_000)
            except Exception:  # noqa: BLE001
                pass

        # Step 2: Ctrl+S now goes to the focused notebook.
        try:
            self._page.keyboard.press("Control+S")
            self._page.wait_for_timeout(800)
            print("[driver]   notebook saved via Ctrl+S (focused)", flush=True)
            return
        except Exception as e:  # noqa: BLE001
            print(f"[driver]   ⚠ Ctrl+S failed: {e}", flush=True)

        # Step 3 fallback: File menu (works as long as the active widget IS
        # the notebook — which we just attempted to ensure above).
        try:
            file_menu = self._page.locator('.lm-MenuBar-itemLabel', has_text='File').first
            file_menu.wait_for(state="visible", timeout=3_000)
            file_menu.click()
            save = self._page.locator('.lm-Menu-itemLabel', has_text='Save Notebook').first
            save.wait_for(state="visible", timeout=3_000)
            save.click()
            self._page.wait_for_timeout(800)
            print("[driver]   notebook saved via File menu fallback", flush=True)
        except Exception as e:  # noqa: BLE001
            print(f"[driver]   ⚠ save failed entirely: {e}", flush=True)

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

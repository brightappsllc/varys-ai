"""Curriculum DAG + runner.

Routing rules (per spec):
- Starting nodes: all Tier 1 tasks run unconditionally.
- A task that fully passes enqueues its `on_pass` successors.
- A task that fails structural or execution OR fails the judge (intent/data_safe)
  enqueues its `on_fail` lateral edges.
- Judge `response_quality == "poor"` alone is logged as a warning, NOT a failure.
- Timeouts are infrastructure failures: they neither pass nor fail the curriculum.
- Tier gate: Tier 3 only enters the queue if at least one Tier 2 task passed.
  Tier 4 only if at least one Tier 3 task passed. Implemented as an explicit
  gate in the runner, not via on_pass edges.
"""

from __future__ import annotations

import json
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, List, Optional, Set

from varys_tests.curriculum.tasks import (
    ALL_TASKS,
    TIER_1,
    TIER_2,
    TIER_3,
    TIER_4,
    Task,
    task_by_id,
)
from varys_tests.harness.executor import execute_notebook
from varys_tests.harness.judge import JudgeVerdict, judge_task, make_diff
from varys_tests.harness.jupyter_server import JupyterServer
from varys_tests.harness.notebook_state import StructuralResult, run_assertions
from varys_tests.harness.varys_driver import TaskResult, VarysDriver


# ----------------------------------------------------------------------
# per-task report
# ----------------------------------------------------------------------
@dataclass
class TaskReport:
    task_id: str
    tier: int
    status: str  # "pass" | "fail" | "timeout" | "skipped"
    structural: Optional[dict] = None
    execution: Optional[dict] = None
    judge: Optional[dict] = None
    varys_response: str = ""
    notebook_diff: str = ""
    duration_s: float = 0.0
    warnings: List[str] = field(default_factory=list)
    notes: str = ""

    def to_dict(self) -> dict:
        return {
            "task_id": self.task_id,
            "tier": self.tier,
            "status": self.status,
            "structural": self.structural,
            "execution": self.execution,
            "judge": self.judge,
            "varys_response": self.varys_response[:4000],
            "notebook_diff": self.notebook_diff[:16000],
            "duration_s": round(self.duration_s, 2),
            "warnings": self.warnings,
            "notes": self.notes,
        }


@dataclass
class CurriculumReport:
    started_at: str
    finished_at: str = ""
    tasks: List[TaskReport] = field(default_factory=list)
    infrastructure_failures: int = 0

    @property
    def tier1_pass_rate(self) -> float:
        return self._tier_pass_rate(1)

    @property
    def tier2_pass_rate(self) -> float:
        return self._tier_pass_rate(2)

    @property
    def tier3_pass_rate(self) -> float:
        return self._tier_pass_rate(3)

    @property
    def tier4_pass_rate(self) -> float:
        return self._tier_pass_rate(4)

    def _tier_pass_rate(self, tier: int) -> float:
        scored = [t for t in self.tasks if t.tier == tier and t.status in ("pass", "fail")]
        if not scored:
            return 0.0
        passed = sum(1 for t in scored if t.status == "pass")
        return passed / len(scored)

    def to_dict(self) -> dict:
        return {
            "started_at": self.started_at,
            "finished_at": self.finished_at,
            "infrastructure_failures": self.infrastructure_failures,
            "tier_pass_rates": {
                "tier1": self.tier1_pass_rate,
                "tier2": self.tier2_pass_rate,
                "tier3": self.tier3_pass_rate,
                "tier4": self.tier4_pass_rate,
            },
            "tasks": [t.to_dict() for t in self.tasks],
        }


# ----------------------------------------------------------------------
# runner
# ----------------------------------------------------------------------
class CurriculumRunner:
    def __init__(
        self,
        server: JupyterServer,
        driver_factory,  # callable: (notebook_url, notebook_path) -> VarysDriver
        results_dir: Optional[Path] = None,
    ) -> None:
        self._server = server
        self._driver_factory = driver_factory
        self._results_dir = results_dir or (
            Path(__file__).resolve().parent.parent / "results"
        )
        self._results_dir.mkdir(parents=True, exist_ok=True)
        # Track the currently-open fixture so we only do full page navigation
        # when the fixture changes between tasks. Same-fixture tasks reuse the
        # open notebook tab and just revert in place.
        self._current_fixture: Optional[str] = None
        self._driver: Optional[VarysDriver] = None
        # Stable report path — overwritten after each task so partial / aborted
        # runs still leave a debuggable artifact at a known location.
        self._report_path: Optional[Path] = None
        self._live_report: Optional[CurriculumReport] = None
        # One-shot setup actions to apply right after the first notebook open.
        self._pending_setup: Optional[dict] = None
        self._pending_limit_to_focal: bool = False

    # ------------------------------------------------------------------
    def run_scenario(
        self,
        tasks: List[Task],
        scenario_name: str = "scenario",
        setup: Optional[dict] = None,
        limit_to_focal: bool = False,
    ) -> CurriculumReport:
        """Run an ordered, chained list of tasks (scenario mode).

        Unlike `run()`, no tier gates apply — every task is attempted in
        sequence and each one builds on the previous task's notebook state.

        `setup` is an optional dict applied once, right after the notebook
        is first opened (before the first task's snapshot/focus/submit):
            {"run_all": True, "focus_cell": 2}
        """
        self._pending_setup = setup or None
        self._pending_limit_to_focal = limit_to_focal
        report = CurriculumReport(started_at=time.strftime("%Y-%m-%dT%H:%M:%S"))
        self._live_report = report
        ts = time.strftime("%Y%m%d-%H%M%S")
        self._report_path = self._results_dir / f"{ts}-{scenario_name}.json"
        for task in tasks:
            tr = self._run_one(task)
            report.tasks.append(tr)
            self._flush_report()
        report.finished_at = time.strftime("%Y-%m-%dT%H:%M:%S")
        self._flush_report()
        return report

    # ------------------------------------------------------------------
    def run(self) -> CurriculumReport:
        report = CurriculumReport(started_at=time.strftime("%Y-%m-%dT%H:%M:%S"))
        self._live_report = report
        ts = time.strftime("%Y%m%d-%H%M%S")
        self._report_path = self._results_dir / f"{ts}.json"
        passed_tiers: Set[int] = set()

        # Tier 1 — unconditional
        self._run_tier(TIER_1, report, passed_tiers)

        # Tier 2 — unconditional (per spec, only Tier 3/4 are gated)
        self._run_tier(TIER_2, report, passed_tiers)

        # Tier 3 — gated on at least one Tier 2 pass
        if 2 in passed_tiers:
            self._run_tier(TIER_3, report, passed_tiers)
        else:
            self._mark_skipped(TIER_3, report, "tier 2 gate not met")

        # Tier 4 — gated on at least one Tier 3 pass
        if 3 in passed_tiers:
            self._run_tier(TIER_4, report, passed_tiers)
        else:
            self._mark_skipped(TIER_4, report, "tier 3 gate not met")

        report.finished_at = time.strftime("%Y-%m-%dT%H:%M:%S")
        self._write_report(report)
        return report

    # ------------------------------------------------------------------
    def _run_tier(
        self,
        tier_tasks: List[Task],
        report: CurriculumReport,
        passed_tiers: Set[int],
    ) -> None:
        # Each tier is run as a queue: starting nodes are all tasks in the tier;
        # on_fail edges add lateral tasks within the same tier.
        queue: List[str] = [t.id for t in tier_tasks]
        seen: Set[str] = set()
        any_pass = False

        while queue:
            tid = queue.pop(0)
            if tid in seen:
                continue
            seen.add(tid)
            try:
                task = task_by_id(tid)
            except KeyError:
                continue

            tr = self._run_one(task)
            report.tasks.append(tr)
            self._flush_report()

            if tr.status == "timeout":
                report.infrastructure_failures += 1
                continue
            if tr.status == "pass":
                any_pass = True
                # `on_pass` may cross-tier; the tier gate handles ordering, so
                # we ignore cross-tier on_pass here. (Future: dispatch to a
                # global queue if needed.)
                for nxt in task.on_pass:
                    try:
                        if task_by_id(nxt).tier == task.tier:
                            queue.append(nxt)
                    except KeyError:
                        pass
            else:  # "fail"
                for nxt in task.on_fail:
                    try:
                        if task_by_id(nxt).tier == task.tier:
                            queue.append(nxt)
                    except KeyError:
                        pass

        if any_pass:
            passed_tiers.add(tier_tasks[0].tier)

    # ------------------------------------------------------------------
    def _run_one(self, task: Task) -> TaskReport:
        print(f"\n[curriculum] ▶ {task.id} (tier {task.tier}) — {task.prompt[:80]}", flush=True)
        tr = TaskReport(task_id=task.id, tier=task.tier, status="fail")

        same_fixture = (self._driver is not None and self._current_fixture == task.fixture)

        if not same_fixture:
            # First task on this fixture: place a fresh copy of the fixture
            # in the workdir and open it in a new browser tab.
            try:
                self._server.reset_workdir(task.fixture)
                print(f"[curriculum]   workdir reset → {task.fixture}", flush=True)
            except Exception as e:  # noqa: BLE001
                print(f"[curriculum]   ✗ workdir reset failed: {e}", flush=True)
                tr.status = "timeout"
                tr.notes = f"workdir reset failed: {e}"
                return tr
            url = self._server.get_notebook_url()
            nb_path = self._server.notebook_path
            print(
                f"[curriculum]   opening notebook (fixture change: {self._current_fixture} → {task.fixture})",
                flush=True,
            )
            driver = self._driver_factory(url, nb_path)
            self._driver = driver
            self._current_fixture = task.fixture

            # One-shot scenario setup (run_all, initial focus_cell) — applied
            # only on the *first* open of this scenario, before the first task
            # snapshots / focuses / submits.
            if self._pending_setup:
                setup = self._pending_setup
                self._pending_setup = None
                # Force the driver to open the page NOW so JupyterLab is
                # loaded before we try to dispatch app.commands. The driver's
                # own open() already runs all cells, so we don't need to
                # repeat that here — only honour focus_cell.
                try:
                    driver.open()
                except Exception as e:  # noqa: BLE001
                    print(f"[curriculum]   ⚠ driver.open() in setup failed: {e}", flush=True)
                # ALWAYS enforce the desired state of the "Focus on active
                # cell" pill — both ON and OFF. localStorage persists the
                # toggle across runs, so a previous scenario that turned it
                # ON would otherwise leak into a scenario that wants it OFF.
                desired = bool(self._pending_limit_to_focal)
                print(
                    f"[curriculum]   setup: enforcing limit_to_focal={desired}",
                    flush=True,
                )
                try:
                    driver.set_limit_to_focal(desired)
                except Exception as e:  # noqa: BLE001
                    print(f"[curriculum]   ⚠ set_limit_to_focal failed: {e}", flush=True)
                fc = setup.get("focus_cell")
                if fc is not None:
                    # YAML uses 1-indexed cell numbers to match the Varys UI
                    # badges (`#1`, `#2`, ...). JupyterLab's activeCellIndex
                    # is 0-indexed, so subtract 1.
                    print(f"[curriculum]   setup: focusing cell #{fc}", flush=True)
                    try:
                        driver.focus_cell(int(fc) - 1)
                    except Exception as e:  # noqa: BLE001
                        print(f"[curriculum]   ⚠ setup focus_cell failed: {e}", flush=True)
        else:
            # Chained mode: this task builds on the previous task's notebook
            # state. Do NOT reset workdir, do NOT revert. Just submit.
            print("[curriculum]   chained run (same fixture, keeping state)", flush=True)
            driver = self._driver
            nb_path = self._server.notebook_path

        # Snapshot the notebook *as it currently sits on disk* so the diff
        # captures only what THIS task changed, not what previous tasks did.
        before_path = self._snapshot_current(nb_path)

        # Focus the target cell if the task specifies one — mirrors how a
        # real user clicks the cell they want edited before asking Varys.
        if task.target_cell is not None:
            # YAML target_cell is 1-indexed (matches Varys UI badges).
            try:
                driver.focus_cell(task.target_cell - 1)
            except Exception as e:  # noqa: BLE001
                print(f"[curriculum]   ⚠ focus_cell({task.target_cell}) failed: {e}", flush=True)

        # Submit
        try:
            result: TaskResult = driver.submit_task(task.prompt, timeout_s=task.timeout_s)
        except Exception as e:  # noqa: BLE001
            tr.status = "timeout"
            tr.notes = f"driver crashed: {e}"
            return tr

        tr.varys_response = result.varys_response
        tr.duration_s = result.duration_s

        if result.status == "timeout":
            tr.status = "timeout"
            tr.notes = "driver reported timeout"
            return tr

        # Run all three assertion layers — none short-circuits the others.
        struct_res: StructuralResult = run_assertions(nb_path, task.structural_assertions)
        tr.structural = struct_res.to_dict()

        exec_passed = True
        if task.run_execution_assert:
            exec_res = execute_notebook(nb_path, timeout_s=task.timeout_s)
            tr.execution = exec_res.to_dict()
            exec_passed = exec_res.passed

        diff = make_diff(before_path, nb_path) if before_path else ""
        tr.notebook_diff = diff

        judge_passed = True
        if task.run_judge_assert:
            verdict: JudgeVerdict = judge_task(task.prompt, result.varys_response, diff)
            tr.judge = verdict.to_dict()
            judge_passed = verdict.passed
            if verdict.response_quality == "poor" and verdict.passed:
                tr.warnings.append("judge: response_quality=poor (logged only)")

        if struct_res.passed and exec_passed and judge_passed:
            tr.status = "pass"
        else:
            tr.status = "fail"

        sym = {"pass": "✓", "fail": "✗", "timeout": "⏱"}.get(tr.status, "?")
        print(
            f"[curriculum]   {sym} {task.id} → {tr.status} "
            f"(struct={struct_res.passed}, exec={exec_passed}, judge={judge_passed}, "
            f"{tr.duration_s:.1f}s)",
            flush=True,
        )
        return tr

    # ------------------------------------------------------------------
    def _snapshot_before(self, fixture: str) -> str:
        """Return path to the pristine fixture (used for diffs)."""
        fixtures_dir = Path(__file__).resolve().parent / "fixtures"
        p = fixtures_dir / fixture
        return str(p) if p.exists() else ""

    def _snapshot_current(self, nb_path: str) -> str:
        """Copy the current on-disk notebook to a temp file so we can diff
        against it after this task modifies the live notebook.
        """
        import shutil
        import tempfile
        try:
            tmp = tempfile.NamedTemporaryFile(
                prefix="varys_before_", suffix=".ipynb", delete=False
            )
            tmp.close()
            shutil.copy(nb_path, tmp.name)
            return tmp.name
        except Exception:  # noqa: BLE001
            return ""

    def _mark_skipped(self, tier_tasks: List[Task], report: CurriculumReport, reason: str) -> None:
        for t in tier_tasks:
            report.tasks.append(TaskReport(
                task_id=t.id, tier=t.tier, status="skipped", notes=reason,
            ))

    def _write_report(self, report: CurriculumReport) -> None:
        # Final write — same path as incremental flushes so users always
        # find the latest run at one stable location (plus the timestamp).
        self._flush_report()

    def _flush_report(self) -> None:
        if self._live_report is None or self._report_path is None:
            return
        try:
            with open(self._report_path, "w") as f:
                json.dump(self._live_report.to_dict(), f, indent=2)
        except Exception as e:  # noqa: BLE001
            print(f"[curriculum]   ⚠ report flush failed: {e}", flush=True)

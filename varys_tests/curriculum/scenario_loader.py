"""Scenario loader: parse YAML scenario files into Task objects.

A scenario bundles a source notebook with an ordered list of tasks. Tasks
are CHAINED — each task starts from the state left by the previous one,
mirroring the runner's same-fixture behavior.

Schema (see scenarios/rename_basics.yaml for an example):

    name: rename_basics
    description: short free text
    notebook: simple_rename.ipynb     # path relative to fixtures/
    tasks:
      - id: rename_var
        tier: 1
        prompt: |
          Rename `df_north` to `df_region_north` ...
        timeout_s: 180
        assertions:
          structural:
            - cell_count_between: [4, 8]
            - symbol_present: df_region_north
            - symbol_absent: df_north
            - cell_defining_symbol_nonempty: df_region_north
            - markdown_header_present: "Section 1"
            - symbols_in_order: [Section 1, Summary]
          execution: false           # bool — run nbconvert?
          judge: true                # bool — run LLM judge?

Each entry under `structural` is a single-key mapping where the key names
the assertion factory in notebook_state.py and the value is its argument(s).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, List, Optional

import yaml

from varys_tests.curriculum.tasks import Task
from varys_tests.harness.notebook_state import (
    cell_count_between,
    cell_defining_symbol_nonempty,
    markdown_header_present,
    symbol_absent,
    symbol_present,
    symbols_in_order,
)


SCENARIOS_DIR = Path(__file__).resolve().parent / "scenarios"


# ----------------------------------------------------------------------
# assertion factory dispatch
# ----------------------------------------------------------------------
def _build_structural_assertion(spec: Any):
    """Build a single structural assertion callable from a YAML entry.

    Each YAML entry is a single-key mapping like `{symbol_present: df_north}`
    or `{cell_count_between: [4, 8]}`.
    """
    if not isinstance(spec, dict) or len(spec) != 1:
        raise ValueError(f"structural assertion must be a single-key mapping: {spec!r}")
    name, arg = next(iter(spec.items()))
    if name == "cell_count_between":
        if not isinstance(arg, (list, tuple)) or len(arg) != 2:
            raise ValueError(f"cell_count_between requires [min, max], got {arg!r}")
        return cell_count_between(int(arg[0]), int(arg[1]))
    if name == "symbol_present":
        return symbol_present(str(arg))
    if name == "symbol_absent":
        return symbol_absent(str(arg))
    if name == "cell_defining_symbol_nonempty":
        return cell_defining_symbol_nonempty(str(arg))
    if name == "markdown_header_present":
        return markdown_header_present(str(arg))
    if name == "symbols_in_order":
        if not isinstance(arg, (list, tuple)):
            raise ValueError(f"symbols_in_order requires a list, got {arg!r}")
        return symbols_in_order([str(s) for s in arg])
    raise ValueError(f"unknown structural assertion: {name!r}")


# ----------------------------------------------------------------------
# scenario dataclass
# ----------------------------------------------------------------------
@dataclass
class Scenario:
    name: str
    notebook: str
    tasks: List[Task]
    description: str = ""
    cell_mode: Optional[str] = None      # "chat" | "agent" | None
    reasoning: Optional[str] = None      # "off" | "cot" | "sequential" | None
    setup: Optional[dict] = None         # {"run_all": bool, "focus_cell": int}

    @property
    def id(self) -> str:
        return self.name


# ----------------------------------------------------------------------
# loader
# ----------------------------------------------------------------------
def load_scenario(path: Path) -> Scenario:
    with open(path, "r", encoding="utf-8") as f:
        raw = yaml.safe_load(f)

    if not isinstance(raw, dict):
        raise ValueError(f"scenario file must be a mapping at top level: {path}")

    name = str(raw.get("name") or path.stem)
    notebook = raw.get("notebook")
    if not notebook:
        raise ValueError(f"scenario {name}: 'notebook' field is required")
    description = str(raw.get("description") or "")

    # Handle YAML bool coercion: bare `off`/`on` parse as False/True.
    def _normalize(v):
        if isinstance(v, bool):
            return "off" if v is False else "on"
        return str(v).lower() if v is not None else None

    cell_mode = _normalize(raw.get("mode") or raw.get("cell_mode"))
    if cell_mode is not None and cell_mode not in ("chat", "agent"):
        raise ValueError(f"scenario {name}: mode must be 'chat' or 'agent', got {cell_mode!r}")

    reasoning = _normalize(raw.get("reasoning"))
    if reasoning is not None and reasoning not in ("off", "cot", "sequential"):
        raise ValueError(
            f"scenario {name}: reasoning must be 'off', 'cot', or 'sequential', got {reasoning!r}"
        )

    raw_tasks = raw.get("tasks") or []
    if not isinstance(raw_tasks, list) or not raw_tasks:
        raise ValueError(f"scenario {name}: 'tasks' must be a non-empty list")

    tasks: List[Task] = []
    for i, t in enumerate(raw_tasks):
        if not isinstance(t, dict):
            raise ValueError(f"scenario {name}: task #{i} must be a mapping")
        tid = str(t.get("id") or f"{name}_task_{i}")
        tier = int(t.get("tier", 1))
        prompt = t.get("prompt")
        if not prompt:
            raise ValueError(f"scenario {name}/{tid}: 'prompt' is required")
        timeout_s = int(t.get("timeout_s", 180))
        target_cell = t.get("target_cell")
        if target_cell is not None:
            target_cell = int(target_cell)

        assertions = t.get("assertions") or {}
        structural_specs = assertions.get("structural") or []
        structural = [_build_structural_assertion(s) for s in structural_specs]
        run_exec = bool(assertions.get("execution", False))
        run_judge = bool(assertions.get("judge", True))

        tasks.append(Task(
            id=tid,
            tier=tier,
            prompt=str(prompt).strip(),
            fixture=notebook,
            timeout_s=timeout_s,
            structural_assertions=structural,
            run_execution_assert=run_exec,
            run_judge_assert=run_judge,
            target_cell=target_cell,
        ))

    raw_setup = raw.get("setup")
    setup: Optional[dict] = None
    if raw_setup is not None:
        if not isinstance(raw_setup, dict):
            raise ValueError(f"scenario {name}: 'setup' must be a mapping")
        setup = {}
        if "run_all" in raw_setup:
            setup["run_all"] = bool(raw_setup["run_all"])
        if "focus_cell" in raw_setup and raw_setup["focus_cell"] is not None:
            setup["focus_cell"] = int(raw_setup["focus_cell"])

    return Scenario(
        name=name,
        notebook=notebook,
        tasks=tasks,
        description=description,
        cell_mode=cell_mode,
        reasoning=reasoning,
        setup=setup,
    )


def discover_scenarios() -> List[Path]:
    """Return all *.yaml files in the scenarios/ directory."""
    if not SCENARIOS_DIR.exists():
        return []
    return sorted(SCENARIOS_DIR.glob("*.yaml")) + sorted(SCENARIOS_DIR.glob("*.yml"))


def load_scenario_by_name(name: str) -> Optional[Scenario]:
    """Find a scenario by its name (without extension)."""
    for p in discover_scenarios():
        if p.stem == name:
            return load_scenario(p)
    return None

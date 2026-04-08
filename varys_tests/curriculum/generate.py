"""Scenario generator: emit a scenario YAML for a given notebook via Claude.

Usage:
    python -m varys_tests.curriculum.generate path/to/notebook.ipynb \\
        --name my_scenario \\
        [--num-tasks 5] \\
        [--output varys_tests/curriculum/scenarios/my_scenario.yaml]

If --output is omitted, writes to scenarios/<notebook_stem>/<name>.yaml.
The notebook is copied into the same folder so the scenario is self-contained.

Environment: requires the same Anthropic key resolution as the judge
(ANTHROPIC_JUDGE_API_KEY → ANTHROPIC_API_KEY → ~/.jupyter/varys.env).
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import sys
from pathlib import Path
from typing import Optional

try:
    from anthropic import Anthropic
except ImportError:  # pragma: no cover
    Anthropic = None  # type: ignore

from varys_tests.harness.judge import _resolve_api_key  # reuse the same chain


GENERATOR_MODEL = "claude-sonnet-4-6"  # bigger model for higher-quality scenarios

SYSTEM_PROMPT = """You are designing a stress-test scenario for an AI coding assistant called Varys.

You will be given the source of a Jupyter notebook. Your job is to propose an
ORDERED, CHAINED list of tasks that exercise Varys's ability to edit, refactor,
and restructure that notebook. Each task builds on the result of the previous
one — the notebook accumulates changes across the chain.

Tier guide (use a mix):
  Tier 1: single-cell atomic edits (rename a variable, fix one syntax error,
          add one markdown cell)
  Tier 2: multi-cell edits without restructuring (add prints, reorder cells,
          delete one specific cell)
  Tier 3: refactoring (extract a function, consolidate duplicates, replace a
          loop with vectorized code)
  Tier 4: compound (functionalize duplicates AND reorder AND fix references)

For each task return:
  - id: snake_case identifier
  - tier: 1..4
  - prompt: the literal text the user would send to Varys (1-3 sentences)
  - timeout_s: 180 (T1), 300 (T2), 600 (T3), 900 (T4)
  - structural_assertions: a list of single-key mappings using ONLY these
    factory names:
      cell_count_between: [min, max]
      symbol_present: <name>
      symbol_absent: <name>
      cell_defining_symbol_nonempty: <name>
      markdown_header_present: <text>
      symbols_in_order: [<sym1>, <sym2>, ...]
  - run_execution: bool (true if the notebook should still execute cleanly
    after this task — false for tasks where partial state is OK)
  - run_judge: bool (almost always true)

Return ONLY a single valid JSON object of this form, NO markdown, NO preamble:

{
  "tasks": [
    {
      "id": "...",
      "tier": 1,
      "prompt": "...",
      "timeout_s": 180,
      "structural_assertions": [
        {"cell_count_between": [4, 8]},
        {"symbol_present": "df_region_north"}
      ],
      "run_execution": false,
      "run_judge": true
    }
  ]
}

Be generous with structural assertions — 3-6 per task. Be precise about
symbol names (read them from the notebook). Be conservative with cell count
bounds — leave room for Varys to add/remove a cell or two.
"""


def _read_notebook_source(path: Path) -> str:
    """Return a compact text rendering of the notebook (cell by cell)."""
    nb = json.loads(path.read_text(encoding="utf-8"))
    out = []
    for i, c in enumerate(nb.get("cells", [])):
        src = c.get("source", "")
        if isinstance(src, list):
            src = "".join(src)
        out.append(f"### cell {i} ({c.get('cell_type', 'code')}) ###\n{src}\n")
    return "".join(out)


def _extract_json(text: str) -> Optional[dict]:
    text = text.strip()
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\s*", "", text)
        text = re.sub(r"\s*```\s*$", "", text)
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        m = re.search(r"\{.*\}", text, re.DOTALL)
        if m:
            try:
                return json.loads(m.group(0))
            except json.JSONDecodeError:
                return None
    return None


def _to_yaml(scenario_name: str, description: str, notebook: str, tasks: list) -> str:
    """Render the scenario as YAML by hand (no PyYAML dump — we want a
    consistent, readable format with literal-block prompts)."""
    lines = [
        f"name: {scenario_name}",
        f"description: |",
        f"  {description}",
        f"",
        f"notebook: {notebook}",
        f"",
        f"tasks:",
    ]
    for t in tasks:
        lines.append(f"  - id: {t['id']}")
        lines.append(f"    tier: {int(t.get('tier', 1))}")
        prompt = str(t.get("prompt", "")).strip().replace("\r", "")
        lines.append(f"    prompt: |")
        for ln in prompt.split("\n"):
            lines.append(f"      {ln}")
        lines.append(f"    timeout_s: {int(t.get('timeout_s', 180))}")
        lines.append(f"    assertions:")
        lines.append(f"      structural:")
        for a in t.get("structural_assertions", []) or []:
            if not isinstance(a, dict) or len(a) != 1:
                continue
            k, v = next(iter(a.items()))
            if isinstance(v, list):
                vstr = "[" + ", ".join(str(x) for x in v) + "]"
            elif isinstance(v, str) and (":" in v or "#" in v):
                vstr = json.dumps(v)
            else:
                vstr = str(v)
            lines.append(f"        - {k}: {vstr}")
        lines.append(f"      execution: {'true' if t.get('run_execution') else 'false'}")
        lines.append(f"      judge: {'true' if t.get('run_judge', True) else 'false'}")
        lines.append("")
    return "\n".join(lines) + "\n"


# ----------------------------------------------------------------------
def main() -> int:
    ap = argparse.ArgumentParser(description="Generate a Varys scenario YAML for a notebook")
    ap.add_argument("notebook", type=Path, help="Path to source .ipynb")
    ap.add_argument("--name", required=True, help="Scenario name (used as filename and id)")
    ap.add_argument("--num-tasks", type=int, default=6, help="Approximate number of tasks to request")
    ap.add_argument("--description", default="", help="Free-text scenario description")
    ap.add_argument("--output", type=Path, default=None, help="Output YAML path")
    args = ap.parse_args()

    if Anthropic is None:
        print("ERROR: anthropic SDK not installed", file=sys.stderr)
        return 1
    api_key = _resolve_api_key()
    if not api_key:
        print("ERROR: no Anthropic API key found", file=sys.stderr)
        return 1

    src = args.notebook.expanduser().resolve()
    if not src.exists():
        print(f"ERROR: notebook not found: {src}", file=sys.stderr)
        return 1

    notebook_text = _read_notebook_source(src)

    # New layout: each scenario folder is self-contained.
    #   scenarios/<notebook_stem>/<notebook>.ipynb
    #   scenarios/<notebook_stem>/<scenario_name>.yaml
    scenario_dir = Path(__file__).resolve().parent / "scenarios" / src.stem
    scenario_dir.mkdir(parents=True, exist_ok=True)
    fixture_dst = scenario_dir / src.name
    if str(src) != str(fixture_dst):
        shutil.copy(src, fixture_dst)
        print(f"[generate] copied fixture → {fixture_dst}")

    user_msg = (
        f"Notebook filename: {src.name}\n"
        f"Requested number of tasks (approximate): {args.num_tasks}\n\n"
        f"--- NOTEBOOK SOURCE ---\n{notebook_text}\n--- END ---"
    )

    print(f"[generate] calling {GENERATOR_MODEL} …")
    client = Anthropic(api_key=api_key)
    resp = client.messages.create(
        model=GENERATOR_MODEL,
        max_tokens=4096,
        system=SYSTEM_PROMPT,
        messages=[{"role": "user", "content": user_msg}],
    )

    raw = ""
    for block in resp.content:
        if getattr(block, "type", None) == "text":
            raw += block.text

    parsed = _extract_json(raw)
    if not parsed or "tasks" not in parsed:
        print("ERROR: model did not return valid JSON. Raw output:", file=sys.stderr)
        print(raw, file=sys.stderr)
        return 2

    tasks = parsed["tasks"]
    if not isinstance(tasks, list) or not tasks:
        print("ERROR: 'tasks' is empty or not a list", file=sys.stderr)
        return 2

    description = args.description or f"Auto-generated scenario for {src.name} ({len(tasks)} tasks)"
    yaml_text = _to_yaml(args.name, description, src.name, tasks)

    out = args.output or (scenario_dir / f"{args.name}.yaml")
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(yaml_text, encoding="utf-8")
    print(f"[generate] wrote scenario → {out}")
    print(f"[generate]   {len(tasks)} tasks across tiers {sorted(set(int(t.get('tier', 1)) for t in tasks))}")
    print(f"[generate] review the file, then run:")
    print(f"           VARYS_SCENARIO={args.name} pytest varys_tests/tests/test_scenarios.py -v -s")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

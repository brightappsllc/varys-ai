"""LLM-as-judge layer.

Direct Anthropic SDK call — independent of Varys's inference pipeline.
Uses ANTHROPIC_JUDGE_API_KEY if set, otherwise falls back to ANTHROPIC_API_KEY
with a warning.
"""

from __future__ import annotations

import difflib
import json
import os
import re
import sys
from dataclasses import dataclass, field
from typing import List, Optional

try:
    from anthropic import Anthropic
except ImportError:  # pragma: no cover
    Anthropic = None  # type: ignore


JUDGE_MODEL = "claude-haiku-4-5"

JUDGE_SYSTEM_PROMPT = """You are an automated grader for an AI coding assistant called Varys.

You will be given:
- a task prompt the user gave to Varys
- the raw text Varys returned in the chat
- a unified diff of the notebook BEFORE and AFTER Varys's action

Your job is to grade whether Varys did what the user asked, whether the
notebook is still in a runnable state, and whether any data was lost.

You MUST return ONLY a single valid JSON object with these exact fields:
{
    "intent_correct": true|false,
    "execution_correct": true|false,
    "data_safe": true|false,
    "response_quality": "good"|"partial"|"poor",
    "notes": "brief free-text rationale (max 2 sentences)"
}

No preamble. No markdown fences. No commentary outside the JSON.
"""


@dataclass
class JudgeVerdict:
    intent_correct: bool
    execution_correct: bool
    data_safe: bool
    response_quality: str  # "good" | "partial" | "poor"
    notes: str
    raw: str = ""
    error: Optional[str] = None

    @property
    def passed(self) -> bool:
        return self.intent_correct and self.data_safe

    def to_dict(self) -> dict:
        return {
            "intent_correct": self.intent_correct,
            "execution_correct": self.execution_correct,
            "data_safe": self.data_safe,
            "response_quality": self.response_quality,
            "notes": self.notes,
            "error": self.error,
        }


def make_diff(before_path: str, after_path: str) -> str:
    """Build a unified diff of cell sources before/after."""
    def _read_sources(p: str) -> List[str]:
        try:
            with open(p, "r", encoding="utf-8") as f:
                nb = json.load(f)
        except Exception:
            return []
        out = []
        for i, c in enumerate(nb.get("cells", [])):
            src = c.get("source", "")
            if isinstance(src, list):
                src = "".join(src)
            out.append(f"### cell {i} ({c.get('cell_type', 'code')}) ###\n{src}\n")
        return out

    before = _read_sources(before_path)
    after = _read_sources(after_path)
    diff = difflib.unified_diff(
        "".join(before).splitlines(keepends=True),
        "".join(after).splitlines(keepends=True),
        fromfile="before",
        tofile="after",
        n=3,
    )
    return "".join(diff)


def _extract_json(text: str) -> Optional[dict]:
    text = text.strip()
    # Handle accidental markdown fences
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\s*", "", text)
        text = re.sub(r"\s*```\s*$", "", text)
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        # Try to find a {...} block
        m = re.search(r"\{.*\}", text, re.DOTALL)
        if m:
            try:
                return json.loads(m.group(0))
            except json.JSONDecodeError:
                return None
    return None


def _resolve_api_key() -> Optional[str]:
    key = os.environ.get("ANTHROPIC_JUDGE_API_KEY")
    if key:
        return key
    fallback = os.environ.get("ANTHROPIC_API_KEY")
    if fallback:
        print(
            "[varys_tests/judge] WARNING: ANTHROPIC_JUDGE_API_KEY not set; "
            "falling back to ANTHROPIC_API_KEY (shares Varys inference quota).",
            file=sys.stderr,
        )
        return fallback
    return None


def judge_task(task_prompt: str, varys_response: str, notebook_diff: str) -> JudgeVerdict:
    if Anthropic is None:
        return JudgeVerdict(
            intent_correct=False, execution_correct=False, data_safe=False,
            response_quality="poor", notes="anthropic SDK not installed",
            error="anthropic SDK missing",
        )

    api_key = _resolve_api_key()
    if not api_key:
        return JudgeVerdict(
            intent_correct=False, execution_correct=False, data_safe=False,
            response_quality="poor", notes="no API key configured for judge",
            error="missing ANTHROPIC_JUDGE_API_KEY / ANTHROPIC_API_KEY",
        )

    client = Anthropic(api_key=api_key)

    user_payload = json.dumps(
        {
            "task_prompt": task_prompt,
            "varys_response": varys_response[:8000],  # cap to keep judge cheap
            "notebook_diff": notebook_diff[:16000],
        },
        indent=2,
    )

    try:
        resp = client.messages.create(
            model=JUDGE_MODEL,
            max_tokens=512,
            system=JUDGE_SYSTEM_PROMPT,
            messages=[{"role": "user", "content": user_payload}],
        )
    except Exception as e:  # noqa: BLE001
        return JudgeVerdict(
            intent_correct=False, execution_correct=False, data_safe=False,
            response_quality="poor", notes=f"judge API call failed: {e}",
            error=str(e),
        )

    raw_text = ""
    try:
        for block in resp.content:
            if getattr(block, "type", None) == "text":
                raw_text += block.text
    except Exception:  # noqa: BLE001
        raw_text = str(resp)

    parsed = _extract_json(raw_text)
    if not parsed:
        return JudgeVerdict(
            intent_correct=False, execution_correct=False, data_safe=False,
            response_quality="poor", notes="judge returned invalid JSON",
            raw=raw_text, error="invalid JSON",
        )

    return JudgeVerdict(
        intent_correct=bool(parsed.get("intent_correct", False)),
        execution_correct=bool(parsed.get("execution_correct", False)),
        data_safe=bool(parsed.get("data_safe", False)),
        response_quality=str(parsed.get("response_quality", "poor")),
        notes=str(parsed.get("notes", "")),
        raw=raw_text,
    )

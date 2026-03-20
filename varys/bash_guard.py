"""Bash command safety analysis for Varys agent sessions.

Two-pass static analysis:
  Pass 1 — regex pattern matching against DANGEROUS_PATTERNS.
  Pass 2 — interpreter detection (skipped for skill sessions).

Public API
----------
  analyze_command(cmd, context) -> BashRisk
  is_safe(cmd, context)        -> bool
  get_risk(cmd, context)       -> BashRisk   (alias for analyze_command)
  audit_log(risk, was_blocked, nb_base)  — write JSON record via debug_logger

Config (read from os.environ, loaded by app.py from varys.env)
------
  BASH_GUARD_ENABLED       default "true"   — master switch
  BASH_GUARD_BLOCK_ON_WARN default "false"  — promote WARN → BLOCK
"""
from __future__ import annotations

import logging
import os
import re
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Optional

log = logging.getLogger(__name__)


# ── Enums & dataclasses ────────────────────────────────────────────────────────

class RiskLevel(str, Enum):
    SAFE  = "SAFE"
    WARN  = "WARN"
    BLOCK = "BLOCK"


@dataclass
class BashContext:
    """Caller-supplied context that modifies analysis behaviour."""
    is_skill_session: bool = False   # True for /powerpoint, /docx, etc.


@dataclass
class BashRisk:
    command:         str
    risk_level:      RiskLevel
    reason:          str
    matched_pattern: str


class BlockedCommandError(RuntimeError):
    """Raised when a BLOCK-level command is intercepted before execution."""


# ── Pattern catalogue ──────────────────────────────────────────────────────────

# Each entry: pattern_string -> (RiskLevel, human-readable reason)
# Patterns are compiled once at module load.
_RAW_PATTERNS: list[tuple[str, RiskLevel, str]] = [
    # ── BLOCK ──────────────────────────────────────────────────────────────────
    # Recursive forced delete — catastrophic
    (r"\brm\s+(-\S*r\S*f|-\S*f\S*r)\b",
     RiskLevel.BLOCK, "recursive forced delete (rm -rf / rm -fr)"),

    # Raw disk write — overwrites block devices
    (r"\bdd\b",
     RiskLevel.BLOCK, "raw disk write (dd)"),

    # Filesystem format
    (r"\bmkfs\b",
     RiskLevel.BLOCK, "filesystem format (mkfs)"),

    # Secure overwrite of disk/file
    (r"\bshred\b",
     RiskLevel.BLOCK, "secure file shred (shred)"),

    # Redirect directly to filesystem root — e.g. `cmd > /`
    # Match `>` followed by optional whitespace then exactly `/` not followed by another path char
    (r">\s*/(?:[^/\w]|$)",
     RiskLevel.BLOCK, "redirect to filesystem root (> /)"),

    # Pipe to shell — classic code injection
    (r"\bcurl\b.+\|\s*(ba)?sh\b",
     RiskLevel.BLOCK, "curl piped to shell (curl | bash/sh)"),
    (r"\bwget\b.+\|\s*(ba)?sh\b",
     RiskLevel.BLOCK, "wget piped to shell (wget | sh)"),

    # Shell eval — can execute arbitrary dynamic code
    (r"\beval\b",
     RiskLevel.BLOCK, "shell eval — arbitrary dynamic execution"),

    # Fork bomb
    (r":\(\)\s*\{.*:\|:.*\}",
     RiskLevel.BLOCK, "fork bomb pattern"),

    # ── WARN ───────────────────────────────────────────────────────────────────
    # Single-file forced delete (non-recursive)
    (r"\brm\s+-f\b",
     RiskLevel.WARN, "forced single-file delete (rm -f)"),

    # In-place stream edit — overwrites original file
    (r"\bsed\s+(-\S*i|--in-place)\b",
     RiskLevel.WARN, "in-place file edit (sed -i)"),

    # Recursive permission change
    (r"\bchmod\s+-R\b",
     RiskLevel.WARN, "recursive permission change (chmod -R)"),

    # Recursive ownership change
    (r"\bchown\s+-R\b",
     RiskLevel.WARN, "recursive ownership change (chown -R)"),

    # find + exec rm combination
    (r"\bfind\b.+\-exec\b.+\brm\b",
     RiskLevel.WARN, "find with exec rm — potential mass delete"),

    # xargs rm
    (r"\bxargs\b.+\brm\b",
     RiskLevel.WARN, "xargs rm — potential mass delete"),

    # rsync with delete flag
    (r"\brsync\b.+--delete\b",
     RiskLevel.WARN, "rsync --delete — removes destination files not in source"),

    # git clean — removes untracked files
    (r"\bgit\s+clean\b",
     RiskLevel.WARN, "git clean — removes untracked files"),

    # git reset hard — destroys uncommitted changes
    (r"\bgit\s+reset\s+--hard\b",
     RiskLevel.WARN, "git reset --hard — discards uncommitted changes"),

    # truncate — zeros or resizes a file
    (r"\btruncate\b",
     RiskLevel.WARN, "truncate — resizes/zeros a file"),

    # tee without -a (overwrites instead of appending)
    (r"\btee\b(?!\s+-a)(?!\s+--append)",
     RiskLevel.WARN, "tee without -a — overwrites destination file"),

    # mv — could overwrite an existing file silently
    (r"\bmv\b",
     RiskLevel.WARN, "mv — may silently overwrite destination"),
]

# Compile once
_COMPILED: list[tuple[re.Pattern, RiskLevel, str]] = [
    (re.compile(raw, re.IGNORECASE | re.DOTALL), level, reason)
    for raw, level, reason in _RAW_PATTERNS
]

# Pass 2 — interpreter tokens that bypass static analysis
_INTERPRETER_RE = re.compile(
    r"\b(python3?|bash|sh|node)\b",
    re.IGNORECASE,
)
_INTERPRETER_REASON = "interpreter invocation — static analysis unavailable"


# ── Core analysis ──────────────────────────────────────────────────────────────

def analyze_command(cmd: str, context: BashContext | None = None) -> BashRisk:
    """Analyse *cmd* and return a BashRisk with the highest risk level found.

    BLOCK takes precedence over WARN.  The first matching pattern for the
    winning level is reported as matched_pattern / reason.
    """
    if context is None:
        context = BashContext()

    # Respect master switch
    if not _guard_enabled():
        return BashRisk(cmd, RiskLevel.SAFE, "bash guard disabled", "")

    block_hit: tuple[str, str] | None = None   # (reason, pattern_src)
    warn_hit:  tuple[str, str] | None = None

    # Pass 1 — pattern matching
    for compiled, level, reason in _COMPILED:
        m = compiled.search(cmd)
        if m:
            pat_src = compiled.pattern
            if level is RiskLevel.BLOCK and block_hit is None:
                block_hit = (reason, pat_src)
            elif level is RiskLevel.WARN and warn_hit is None:
                warn_hit = (reason, pat_src)

    # Pass 2 — interpreter detection (skipped for skill sessions)
    if not context.is_skill_session and warn_hit is None and block_hit is None:
        if _INTERPRETER_RE.search(cmd):
            warn_hit = (_INTERPRETER_REASON, _INTERPRETER_RE.pattern)

    # Determine effective risk, honouring BASH_GUARD_BLOCK_ON_WARN
    if block_hit:
        reason, pat = block_hit
        return BashRisk(cmd, RiskLevel.BLOCK, reason, pat)

    if warn_hit:
        reason, pat = warn_hit
        effective = RiskLevel.BLOCK if _block_on_warn() else RiskLevel.WARN
        return BashRisk(cmd, effective, reason, pat)

    return BashRisk(cmd, RiskLevel.SAFE, "", "")


def is_safe(cmd: str, context: BashContext | None = None) -> bool:
    """Return True only when analyze_command returns SAFE."""
    return analyze_command(cmd, context).risk_level is RiskLevel.SAFE


def get_risk(cmd: str, context: BashContext | None = None) -> BashRisk:
    """Alias for analyze_command — provided for symmetry with is_safe."""
    return analyze_command(cmd, context)


# ── Audit logging ──────────────────────────────────────────────────────────────

def audit_log(
    risk: BashRisk,
    was_blocked: bool,
    nb_base: Path | None,
) -> None:
    """Write a structured JSON record for non-SAFE results.

    No-op when nb_base is None (debug_logger silently skips).
    Only called for WARN and BLOCK — callers should not call this for SAFE.
    """
    try:
        from .debug_logger import log as _dlog
        _dlog(
            "bash_guard",
            "command_flagged",
            {
                "command":         risk.command[:500],
                "risk_level":      risk.risk_level.value,
                "reason":          risk.reason,
                "matched_pattern": risk.matched_pattern,
                "was_blocked":     was_blocked,
            },
            nb_base=nb_base,
        )
    except Exception as exc:
        log.warning("bash_guard: audit_log failed — %s", exc)


# ── Config helpers (private) ───────────────────────────────────────────────────

def _guard_enabled() -> bool:
    return os.environ.get("BASH_GUARD_ENABLED", "true").strip().lower() not in ("false", "0", "no")


def _block_on_warn() -> bool:
    return os.environ.get("BASH_GUARD_BLOCK_ON_WARN", "false").strip().lower() in ("true", "1", "yes")

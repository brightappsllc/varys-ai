"""Minimal .env file parser — replaces python-dotenv with stdlib only.

Handles the subset of .env syntax used by Varys:
  KEY=VALUE          # bare value
  KEY="VALUE"        # double-quoted
  KEY='VALUE'        # single-quoted
  # comment line     # ignored
  KEY=               # empty value → empty string

Does NOT handle multi-line values, escape sequences in quoted strings, or
shell variable expansion — these are not used in varys.env / local_varys.env.
"""
from __future__ import annotations

import os
from pathlib import Path
from typing import Dict


def parse_dotenv(path: "str | Path") -> Dict[str, str]:
    """Read *path* and return a dict of {KEY: VALUE}.

    Returns an empty dict when the file does not exist or cannot be read.
    Never raises.
    """
    result: Dict[str, str] = {}
    try:
        with open(path, encoding="utf-8") as fh:
            for raw_line in fh:
                line = raw_line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, _, raw_val = line.partition("=")
                key = key.strip()
                if not key:
                    continue
                val = raw_val.strip()
                # Strip matching outer quotes
                if len(val) >= 2 and val[0] == val[-1] and val[0] in ('"', "'"):
                    val = val[1:-1]
                result[key] = val
    except Exception:
        pass
    return result


def load_dotenv(path: "str | Path", override: bool = True) -> None:
    """Parse *path* and push keys into ``os.environ``.

    When *override* is False, existing env vars are kept unchanged.
    """
    for key, val in parse_dotenv(path).items():
        if override or key not in os.environ:
            os.environ[key] = val

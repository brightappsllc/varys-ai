"""%%ai — IPython cell magic for Varys.

Auto-registered into every notebook kernel by the JupyterLab extension.
Can also be loaded manually:

    %load_ext varys.magic

Usage
-----
Basic advisory response (markdown / text):

    %%ai
    Explain what this dataset column 'churn' means.

Pass a specific model for one request:

    %%ai --model claude-opus-4
    Redesign this feature-engineering pipeline.

Force a skill:

    %%ai --skill eda
    Analyse the distribution of all numeric columns.

Skip DataFrame context injection:

    %%ai --no-context
    What is the difference between RMSE and MAE?

List available skills:

    %ai_skills

The magic sends the prompt + live DataFrame schemas from the kernel namespace
to the backend endpoint POST /varys/magic, which loads skills, memory,
and calls the configured chat LLM.  The response is rendered as Markdown in
the cell output area — no cell insertion happens (this is intentional: the
output is captured in the notebook's output for reproducibility).
"""
from __future__ import annotations

import argparse
import http.cookiejar
import json
import os
import shlex
import urllib.error
import urllib.request
from typing import Any

try:
    import pandas as pd
    _PANDAS = True
except ImportError:
    _PANDAS = False

from IPython.core.magic import Magics, cell_magic, line_magic, magics_class
from IPython.display import HTML, Markdown, display

# ── Server helpers ────────────────────────────────────────────────────────────

def _server_url() -> str:
    """Best-effort detection of the running Jupyter server URL."""
    return os.environ.get("JUPYTER_SERVER_URL", "http://localhost:8888").rstrip("/")


def _token() -> str:
    return os.environ.get("JUPYTER_TOKEN", "")


# ── XSRF-aware HTTP session ───────────────────────────────────────────────────

class _JupyterSession:
    """Thin HTTP session that handles Jupyter's XSRF cookie automatically.

    Jupyter Server requires every POST to include the ``_xsrf`` token in the
    ``X-XSRFToken`` header AND as a cookie.  We satisfy this by:
      1. Making one GET request to a lightweight endpoint to acquire the cookie.
      2. Attaching both the cookie jar and the ``X-XSRFToken`` header to every
         subsequent POST, reusing the cached token for the lifetime of the magic
         session (i.e. until the kernel is restarted).
    """

    def __init__(self) -> None:
        self._jar: http.cookiejar.CookieJar = http.cookiejar.CookieJar()
        self._opener = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(self._jar)
        )
        self._xsrf: str | None = None

    def _base_headers(self) -> dict[str, str]:
        headers: dict[str, str] = {}
        tok = _token()
        if tok:
            headers["Authorization"] = f"token {tok}"
        return headers

    def _acquire_xsrf(self) -> str:
        """Fetch the XSRF cookie from the health endpoint (GET, no side-effects)."""
        if self._xsrf:
            return self._xsrf
        url = _server_url()
        req = urllib.request.Request(
            f"{url}/varys/health",
            headers=self._base_headers(),
        )
        try:
            self._opener.open(req, timeout=10)
        except Exception:
            pass  # even a failed GET may have set the cookie
        for cookie in self._jar:
            if cookie.name == "_xsrf":
                self._xsrf = cookie.value
                return self._xsrf
        return ""

    def get(self, path: str) -> dict[str, Any]:
        url = _server_url()
        req = urllib.request.Request(
            f"{url}{path}",
            headers=self._base_headers(),
        )
        with self._opener.open(req, timeout=10) as resp:
            return json.loads(resp.read().decode())

    def post(self, path: str, payload: dict[str, Any]) -> dict[str, Any]:
        url = _server_url()
        xsrf = self._acquire_xsrf()
        headers = {**self._base_headers(), "Content-Type": "application/json"}
        if xsrf:
            headers["X-XSRFToken"] = xsrf

        req = urllib.request.Request(
            f"{url}{path}",
            data=json.dumps(payload).encode(),
            headers=headers,
            method="POST",
        )
        try:
            with self._opener.open(req, timeout=120) as resp:
                return json.loads(resp.read().decode())
        except urllib.error.HTTPError as exc:
            body = exc.read().decode()
            raise RuntimeError(
                f"Varys backend returned {exc.code}: {body}"
            ) from exc
        except Exception as exc:
            raise RuntimeError(
                f"Could not reach Varys backend at {url}. "
                "Make sure JupyterLab is running with the extension installed."
            ) from exc


# Module-level session — one per kernel lifetime, XSRF token cached after
# the first request.
_session = _JupyterSession()


# ── DataFrame introspection ───────────────────────────────────────────────────

def _collect_dataframes(ns: dict[str, Any]) -> list[dict[str, Any]]:
    """Extract schema metadata from all pandas DataFrames in the kernel namespace.

    Unlike the frontend approach (kernel execution via requestExecute), here we
    have direct Python access to the live objects — so this is zero-latency.
    """
    if not _PANDAS:
        return []
    schemas: list[dict[str, Any]] = []
    for name, obj in ns.items():
        if name.startswith("_") or not isinstance(obj, pd.DataFrame):
            continue
        try:
            sample_rows = obj.head(3).to_dict("records")
            sample_rows = [
                {k: (str(v)[:40] if len(str(v)) > 40 else v) for k, v in row.items()}
                for row in sample_rows
            ]
            schemas.append({
                "name": name,
                "shape": list(obj.shape),
                "columns": list(obj.columns),
                "dtypes": {c: str(t) for c, t in obj.dtypes.items()},
                "sample": sample_rows,
                "memoryMb": round(obj.memory_usage(deep=True).sum() / 1e6, 2),
            })
        except Exception:
            pass
    return schemas


# ── HTTP call ─────────────────────────────────────────────────────────────────

def _call_backend(
    message: str,
    dataframes: list[dict[str, Any]],
    model_override: str | None,
    skill_override: str | None,
) -> dict[str, Any]:
    """POST to /varys/magic via the XSRF-aware session."""
    return _session.post("/varys/magic", {
        "message": message,
        "dataframes": dataframes,
        "model_override": model_override,
        "skill_override": skill_override,
    })


# ── Rendering ─────────────────────────────────────────────────────────────────

_HEADER_CSS = """
<style>
.ds-magic-header{
  display:flex;align-items:center;gap:6px;flex-wrap:wrap;
  font-size:11px;color:#7a849e;margin-bottom:6px;font-family:system-ui,sans-serif;
}
.ds-magic-badge{
  background:#1e2e4a;color:#7ab8f5;border-radius:10px;
  padding:1px 8px;font-size:10px;font-weight:600;white-space:nowrap;
}
.ds-magic-divider{
  border:none;border-top:1px solid #2d3550;margin:2px 0 10px;
}
</style>
"""


def _render(result: dict[str, Any], quiet: bool) -> None:
    """Display the magic response in the cell output."""
    text: str = result.get("text", "*(empty response)*")
    model: str = result.get("model_used", "")
    provider: str = result.get("provider_used", "")
    skills: list[str] = result.get("skills_used", [])

    if not quiet:
        badges = ""
        if provider:
            badges += f'<span class="ds-magic-badge">🤖 {provider}</span>'
        if model:
            badges += f'<span class="ds-magic-badge">{model}</span>'
        for s in skills:
            badges += f'<span class="ds-magic-badge">🧠 {s}</span>'

        display(HTML(
            f'{_HEADER_CSS}'
            f'<div class="ds-magic-header">🔬 Varys&nbsp;{badges}</div>'
            f'<hr class="ds-magic-divider">'
        ))

    display(Markdown(text))


# ── Argument parser ───────────────────────────────────────────────────────────

_PARSER = argparse.ArgumentParser(prog="%%ai", add_help=False, exit_on_error=False)
_PARSER.add_argument("--model",      "-m", default=None, metavar="NAME",
                     help="Override the chat model for this request.")
_PARSER.add_argument("--skill",      "-s", default=None, metavar="SKILL",
                     help="Force a specific skill by name.")
_PARSER.add_argument("--no-context", action="store_true",
                     help="Do not inject live DataFrame schemas.")
_PARSER.add_argument("--quiet",      "-q", action="store_true",
                     help="Suppress the Varys header badge.")


# ── Magic class ───────────────────────────────────────────────────────────────

@magics_class
class AIMagics(Magics):
    """Provides %%ai cell magic and %ai_skills line magic."""

    # ── Cell magic ────────────────────────────────────────────────────────────

    @cell_magic
    def ai(self, line: str, cell: str) -> None:
        """Send the cell content as a prompt to Varys.

        Options (put after %%ai on the same line):
          --model  / -m NAME    Override chat model for this call.
          --skill  / -s SKILL   Force a specific skill by name.
          --no-context          Skip live DataFrame injection.
          --quiet  / -q         Suppress the header badge row.

        Examples
        --------
        %%ai
        Explain what this function does and suggest improvements.

        %%ai --skill eda
        Describe the distribution of the 'price' column.

        %%ai --model claude-opus-4 --quiet
        Write a vectorised pandas one-liner to compute 7-day rolling mean.
        """
        try:
            args = _PARSER.parse_args(shlex.split(line) if line.strip() else [])
        except (argparse.ArgumentError, SystemExit):
            print(
                "%%ai: unrecognised option.\n"
                "Usage: %%ai [--model NAME] [--skill SKILL] [--no-context] [--quiet]\n"
                "       <your prompt on the following lines>"
            )
            return

        prompt = cell.strip()
        if not prompt:
            print("%%ai: empty prompt — nothing sent.")
            return

        dataframes = (
            [] if args.no_context
            else _collect_dataframes(self.shell.user_ns)  # type: ignore[attr-defined]
        )

        # Show a transient "thinking" indicator while waiting for the backend
        from IPython.display import display as _d, HTML as _H
        spinner_id = "ds-magic-spinner"
        _d(_H("<em style='color:#7a849e;font-size:12px'>🔬 Varys is thinking…</em>"),
           display_id=spinner_id)

        try:
            result = _call_backend(prompt, dataframes, args.model, args.skill)
        except RuntimeError as exc:
            _d(_H(""), display_id=spinner_id)
            display(HTML(f"<span style='color:#e05263'>⚠️ {exc}</span>"))
            return
        except Exception as exc:  # noqa: BLE001
            _d(_H(""), display_id=spinner_id)
            display(HTML(f"<span style='color:#e05263'>⚠️ Unexpected error: {exc}</span>"))
            return

        # Clear spinner
        _d(_H(""), display_id=spinner_id)
        _render(result, quiet=args.quiet)

    # ── Line magics ───────────────────────────────────────────────────────────

    @line_magic
    def ai_skills(self, _line: str) -> None:
        """List all skills available in this project.

        Usage:  %ai_skills
        """
        try:
            data = _session.get("/varys/skills")
        except Exception as exc:  # noqa: BLE001
            print(f"Could not reach Varys backend: {exc}")
            return

        skills: list[dict] = data.get("skills", [])
        if not skills:
            print("No skills found in .jupyter-assistant/skills/")
            return

        rows = ["| Skill | Tier | Mode |", "|---|---|---|"]
        for s in skills:
            name = s.get("name", "?")
            keywords = s.get("keywords", [])
            mode = s.get("cell_insertion_mode", "preview")
            tier = "2 (keyword)" if keywords else "1 (always)"
            rows.append(f"| `{name}` | {tier} | `{mode}` |")

        display(Markdown(
            "**🧠 Varys — Available Skills**\n\n" + "\n".join(rows)
        ))


# ── Extension entry points ────────────────────────────────────────────────────

def load_ipython_extension(ipython: Any) -> None:  # noqa: ANN401
    """Called by `%load_ext varys.magic`."""
    ipython.register_magics(AIMagics)


def unload_ipython_extension(_ipython: Any) -> None:  # noqa: ANN401
    pass

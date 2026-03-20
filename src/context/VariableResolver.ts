/**
 * VariableResolver — parses @variable_name references from chat messages,
 * evaluates them in the active kernel, and returns smart, token-budget-aware
 * summaries for injection into the LLM prompt.
 *
 * Supports:
 *   @df                plain variable
 *   @df.head(20)       method call on a variable
 *   @df[['a','b']]     column subset
 *   @model_accuracy    scalar / string
 *
 * Serialisation tiers for DataFrames:
 *   ≤ 20 rows  × ≤ 10 cols → full markdown table
 *   ≤ 10,000 rows           → stats + head(5) sample
 *   > 10,000 rows           → stats + random 10-row sample + note
 */

import { INotebookTracker } from '@jupyterlab/notebook';

// ── Constants ─────────────────────────────────────────────────────────────────

/** Regex that matches @varName or @varName.method() or @varName[...] */
const AT_REF_RE =
  /@([A-Za-z_]\w*(?:\.[A-Za-z_]\w*(?:\([\w\s,'".]*\))?|(?:\[[\w\s,'":\[\]]*\]))*)/g;

/** Maximum total characters sent to the LLM for all resolved variables */
const MAX_VAR_CONTEXT_CHARS = 4_000;

// ── Python introspection script ───────────────────────────────────────────────
// Injected into the kernel with a list of expressions to evaluate.
// Returns a JSON array of summaries, one per expression.
const INSPECT_PY = `
import json as _j
def _dsa_inspect(exprs):
    results = []
    for expr in exprs:
        try:
            val = eval(expr)
        except Exception as exc:
            results.append({"type": "error", "expr": expr, "error": str(exc)})
            continue
        t = type(val).__name__
        try:
            import pandas as _pd
            if isinstance(val, _pd.DataFrame):
                nr, nc = val.shape
                out = {
                    "type": "dataframe", "expr": expr,
                    "shape": [nr, nc],
                    "columns": list(val.columns),
                    "dtypes": {c: str(dt) for c, dt in val.dtypes.items()},
                    "memory_mb": round(val.memory_usage(deep=True).sum() / 1e6, 2),
                    "missing": {c: int(n) for c, n in val.isnull().sum().items() if n > 0},
                }
                try:
                    if nr <= 20 and nc <= 10:
                        out["full_table"] = val.to_markdown(index=False)
                    elif nr <= 10000:
                        out["stats"] = val.describe(include="all").round(4).to_markdown()
                        out["head"] = val.head(5).to_markdown(index=False)
                    else:
                        out["stats"] = val.describe(include="all").round(4).to_markdown()
                        out["sample"] = val.sample(min(10, nr), random_state=42).to_markdown(index=False)
                        out["note"] = f"Large dataset ({nr:,} rows) — summary only. Use @{expr}.head() or @{expr}[cols] for subsets."
                except Exception:
                    out["head_str"] = str(val.head(5))
                results.append(out)
                continue
            if isinstance(val, _pd.Series):
                results.append({
                    "type": "series", "expr": expr,
                    "name": str(val.name), "dtype": str(val.dtype),
                    "length": len(val),
                    "stats": val.describe().to_markdown() if hasattr(val.describe(), "to_markdown") else str(val.describe()),
                })
                continue
        except ImportError:
            pass
        try:
            import numpy as _np
            if isinstance(val, _np.ndarray):
                results.append({
                    "type": "ndarray", "expr": expr,
                    "shape": list(val.shape), "dtype": str(val.dtype),
                    "sample": val.flat[:20].tolist(),
                })
                continue
        except ImportError:
            pass
        if isinstance(val, (int, float, bool)):
            results.append({"type": t, "expr": expr, "value": val})
        elif isinstance(val, str):
            results.append({"type": "str", "expr": expr, "length": len(val),
                           "value": val if len(val) <= 300 else val[:300] + "..."})
        elif isinstance(val, (list, tuple)):
            results.append({"type": t, "expr": expr, "length": len(val),
                           "sample": list(val[:15])})
        elif isinstance(val, dict):
            keys = list(val.keys())
            results.append({"type": "dict", "expr": expr, "length": len(keys),
                           "keys": keys[:20],
                           "sample": {str(k): str(v)[:80] for k, v in list(val.items())[:5]}})
        else:
            results.append({"type": t, "expr": expr, "repr": repr(val)[:400]})
    print(_j.dumps(results))
_dsa_inspect(EXPRS_PLACEHOLDER)
`.trim();

// ── Interfaces ────────────────────────────────────────────────────────────────

export interface ResolvedVariable {
  /** Original expression without the @ prefix (e.g. "df" or "df.head(10)") */
  expr: string;
  /** Structured summary returned by the kernel introspection script */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  summary: Record<string, any>;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Extract all unique @variable_ref expressions from a message string. */
export function parseVariableRefs(message: string): string[] {
  const refs: string[] = [];
  AT_REF_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = AT_REF_RE.exec(message)) !== null) {
    const expr = m[1];
    if (!refs.includes(expr)) refs.push(expr);
  }
  return refs;
}

/**
 * Cap the total JSON size of resolved variables to MAX_VAR_CONTEXT_CHARS by
 * progressively stripping large fields (full_table → head → stats → sample)
 * until the budget is met.
 */
function applyTokenBudget(vars: ResolvedVariable[]): ResolvedVariable[] {
  const DROP_ORDER = ['full_table', 'stats', 'head', 'sample', 'head_str'];
  let total = JSON.stringify(vars).length;
  if (total <= MAX_VAR_CONTEXT_CHARS) return vars;

  // Deep-clone so we don't mutate the originals
  const trimmed = vars.map(v => ({ ...v, summary: { ...v.summary } }));

  for (const field of DROP_ORDER) {
    if (total <= MAX_VAR_CONTEXT_CHARS) break;
    for (const v of trimmed) {
      if (field in v.summary) {
        delete v.summary[field];
        total = JSON.stringify(trimmed).length;
        if (total <= MAX_VAR_CONTEXT_CHARS) break;
      }
    }
  }
  return trimmed;
}

// ── Main class ────────────────────────────────────────────────────────────────

export class VariableResolver {
  private _tracker: INotebookTracker;

  constructor(tracker: INotebookTracker) {
    this._tracker = tracker;
  }

  /**
   * Resolve all @variable_ref expressions in `message`.
   * Returns an array of { expr, summary } objects ready to be attached to
   * the TaskRequest.  Returns [] if no @refs found or no kernel is available.
   */
  async resolve(message: string): Promise<ResolvedVariable[]> {
    const refs = parseVariableRefs(message);
    if (refs.length === 0) return [];

    const kernel = this._tracker.currentWidget?.sessionContext?.session?.kernel;
    if (!kernel) return [];

    const code = INSPECT_PY.replace(
      'EXPRS_PLACEHOLDER',
      JSON.stringify(refs)
    );

    return new Promise(resolve => {
      const future = kernel.requestExecute({
        code,
        silent: true,
        store_history: false,
        allow_stdin: false,
        stop_on_error: false,
      });

      let stdout = '';
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      future.onIOPub = (msg: any) => {
        if (msg.header.msg_type === 'stream' && msg.content.name === 'stdout') {
          stdout += msg.content.text as string;
        }
      };

      future.done
        .then(() => {
          try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const parsed: any[] = JSON.parse(stdout.trim());
            const results: ResolvedVariable[] = parsed.map((summary, i) => ({
              expr: refs[i],
              summary,
            }));
            resolve(applyTokenBudget(results));
          } catch {
            resolve([]);
          }
        })
        .catch(() => resolve([]));
    });
  }
}

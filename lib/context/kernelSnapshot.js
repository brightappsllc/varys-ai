/**
 * kernelSnapshot — lightweight post-execution variable introspection.
 *
 * After a cell executes, extracts variable names assigned in the cell source,
 * runs a silent Python snippet to get type/shape/value metadata, and returns
 * a kernel_snapshot dict for the SummaryStore.
 */
// ── Reserved words (not variable names) ──────────────────────────────────────
const RESERVED = new Set([
    'if', 'else', 'elif', 'for', 'while', 'with', 'try', 'except', 'finally',
    'class', 'def', 'import', 'from', 'return', 'and', 'or', 'not', 'in', 'is',
    'lambda', 'True', 'False', 'None', 'pass', 'break', 'continue', 'raise',
    'yield', 'async', 'await', 'assert', 'del', 'global', 'nonlocal', 'print',
]);
// ── Variable name extraction ──────────────────────────────────────────────────
/**
 * Return the set of simple assignment targets found in cell source.
 * Matches `name =` at the start of any line (ignores augmented assignments,
 * attribute assignments, and subscript assignments).
 */
export function extractAssignedNames(source) {
    const names = new Set();
    const re = /^([A-Za-z_]\w*)\s*=/mg;
    let m;
    while ((m = re.exec(source)) !== null) {
        const name = m[1];
        if (!RESERVED.has(name))
            names.add(name);
    }
    return [...names];
}
// ── Python introspection snippet ──────────────────────────────────────────────
// Lightweight: only type + shape/value — no full table rendering.
// NAMES_PLACEHOLDER is replaced with a JSON array of variable name strings.
const SNAPSHOT_PY = `
import json as _j, math as _math
_snap = {}
def _col_profile(_s):
    """Return a profile dict for one pandas Series column."""
    _p = {'dtype': str(_s.dtype)}
    try:
        _p['n_unique'] = int(_s.nunique())
    except Exception:
        pass
    _nc = int(_s.isna().sum())
    if _nc:
        _p['n_null'] = _nc
    _k = _s.dtype.kind
    if _k in ('i', 'u', 'f'):
        try:
            _p['min']  = (None if _math.isnan(float(_s.min()))  else float(_s.min()))
            _p['max']  = (None if _math.isnan(float(_s.max()))  else float(_s.max()))
            _p['mean'] = (None if _math.isnan(float(_s.mean())) else round(float(_s.mean()), 4))
        except Exception:
            pass
    elif _k == 'M':
        try:
            _p['min'] = str(_s.min().isoformat())
            _p['max'] = str(_s.max().isoformat())
        except Exception:
            pass
    return _p
for _name in NAMES_PLACEHOLDER:
    try:
        _obj = eval(_name)
        _t   = type(_obj).__name__
        try:
            import pandas as _pd
            if isinstance(_obj, _pd.DataFrame):
                _cols = list(_obj.columns[:30])
                _snap[_name] = {
                    'type': 'dataframe',
                    'shape': list(_obj.shape),
                    'columns': {str(c): _col_profile(_obj[c]) for c in _cols},
                }
                continue
            if isinstance(_obj, _pd.Series):
                _snap[_name] = {'type': 'series', 'shape': [len(_obj)], 'dtype': str(_obj.dtype)}
                continue
        except ImportError:
            pass
        try:
            import numpy as _np
            if isinstance(_obj, _np.ndarray):
                _snap[_name] = {'type': 'ndarray', 'shape': list(_obj.shape), 'dtype': str(_obj.dtype)}
                continue
        except ImportError:
            pass
        if isinstance(_obj, (int, float, bool)):
            _snap[_name] = {'type': _t, 'value': _obj}
        elif isinstance(_obj, str):
            _snap[_name] = {'type': 'str', 'value': str(_obj)[:200]}
        elif isinstance(_obj, (list, tuple, dict)):
            _snap[_name] = {'type': _t, 'sample': str(_obj)[:200]}
        else:
            _snap[_name] = {'type': type(_obj).__qualname__}
    except Exception:
        pass
print(_j.dumps(_snap))
`.trim();
// ── Main export ───────────────────────────────────────────────────────────────
/**
 * Execute a silent introspection in the kernel for the given variable names.
 * Returns a kernel_snapshot dict suitable for passing to apiClient.cellExecuted.
 * Never throws — returns {} on any error.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function buildKernelSnapshot(
// eslint-disable-next-line @typescript-eslint/no-explicit-any
kernel, names) {
    if (!names.length)
        return {};
    const code = SNAPSHOT_PY.replace('NAMES_PLACEHOLDER', JSON.stringify(names));
    return new Promise(resolve => {
        let stdout = '';
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let future;
        try {
            future = kernel.requestExecute({
                code,
                silent: true,
                store_history: false,
                allow_stdin: false,
                stop_on_error: false,
            });
        }
        catch (_a) {
            resolve({});
            return;
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        future.onIOPub = (msg) => {
            if (msg.header.msg_type === 'stream' &&
                msg.content.name === 'stdout') {
                stdout += msg.content.text;
            }
        };
        future.done
            .then(() => {
            var _a;
            try {
                resolve((_a = JSON.parse(stdout.trim())) !== null && _a !== void 0 ? _a : {});
            }
            catch (_b) {
                resolve({});
            }
        })
            .catch(() => resolve({}));
    });
}

# Varys Evaluation Notebooks

This directory contains evaluation notebooks for Varys features.

## Naming Convention

Notebooks follow the `nb<N>_<feature_slug>.ipynb` convention:

| Notebook | Feature | Status |
|---|---|---|
| `nb1_*.ipynb` | (future work) | — |
| `nb2_*.ipynb` | (future work) | — |
| `nb3_*.ipynb` | (future work) | — |
| `nb4_agent_integration.ipynb` | Varys File Agent integration | Active |

## nb4 — Agent Integration

Tests the full Varys File Agent (`/file_agent`) integration including:
- `run()` / `run_read_only()` runner functions
- `AgentCallbacks` (4-field, no `on_done`)
- Two-message history protocol
- `files_read` correctness (disk vs. staging)
- Accept/Reject endpoints and audit log
- Zero-change cleanup
- Deferred content (size guard)
- Security (path traversal, working directory enforcement)

## Running

```bash
jupyter lab evaluation/nb4_agent_integration.ipynb
```

All tests assume `ANTHROPIC_API_KEY` and `ANTHROPIC_CHAT_MODEL` are set.
Mock-based unit tests do not require real API calls.

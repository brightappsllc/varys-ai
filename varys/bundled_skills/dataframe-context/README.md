# DataFrame Context Awareness Skill

## What this skill does

This is a **Tier 1 skill** (always active — no keywords required). It tells the DS
Assistant how to interpret the live DataFrame schemas that are automatically collected
from your kernel before every chat request.

## How it works

Before each message you send, DS Assistant executes a small, silent Python snippet in
your notebook's kernel:

```python
# Runs silently (silent=True, store_history=False)
# Inspects get_ipython().user_ns for any pd.DataFrame variables
# Returns: name, shape, columns, dtypes, 3-row sample, memory
```

The result is injected into the LLM prompt as a `## Live DataFrame Context` section.
This means the AI already knows your variable names, column names, types, and sample
values — without you having to type `df.head()` or describe the schema manually.

## Benefits

| Without this skill | With this skill |
|---|---|
| "What columns do you have?" | Writes correct code immediately |
| Guesses column names | Uses exact names from the schema |
| Wrong dtype for operations | Knows float64 vs object vs datetime64 |
| Can't see filtered / new DFs | Sees ALL current kernel variables |
| Stale after cell modifications | Re-inspects after each cell execution |

## Caching

The schema is cached by the highest execution count in the notebook. It is only
re-fetched when you execute a cell — so rapid messages don't incur extra kernel
round-trips.

## Privacy note

Only schema metadata is sent to the LLM (column names, dtypes, 3 sample rows — at
most 8 fields per row, truncated to 40 characters). No bulk data is transmitted.

## Disabling

To turn off schema detection, disable this skill in the **Skills** tab of the DS
Assistant settings panel, or set `DS_DATAFRAME_DETECTION=false` in your `.env`.

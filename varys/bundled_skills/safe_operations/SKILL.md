---
name: safe-operations
---

# Safe Operations Skill

## Auto-execute these operations (autoExecute: true):
- pd.read_csv, pd.read_excel, pd.read_json (read operations)
- df.head(), df.tail(), df.describe(), df.info() (display operations)
- print(), display(), repr()
- Plotting: matplotlib/seaborn/plotly without file save
- df.shape, df.dtypes, df.columns (property access)
- df.value_counts(), df.nunique(), df.isnull() (aggregations)

## Require approval (autoExecute: false, requiresApproval: true):
- to_csv, to_excel, to_json, to_parquet (write operations)
- df.drop(inplace=True), df.fillna(inplace=True) (in-place mutations)
- model.fit(), model.train() (training operations)
- requests.post, requests.put (API write calls)
- os.remove, shutil.rmtree (file deletion)
- subprocess calls

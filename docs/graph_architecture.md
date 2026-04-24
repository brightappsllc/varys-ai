# Notebook Dependency Graph — Architecture

This document explains in detail how Varys builds, annotates, and renders the notebook dependency graph.

---

## Overview

The graph is a **directed acyclic graph (DAG)** where:
- Each **node** represents a non-empty code cell
- Each **edge** represents a data dependency between two cells (a symbol defined in one cell is used in another)

The pipeline has four stages:

```
Notebook cells (frontend)
        │  POST /varys/graph
        ▼
  GraphBuilder.build()          ← Python: nodes + edges
        │
  AnomalyDetector.run()         ← Python: annotate anomalies
        │  JSON response
        ▼
  computeLayoutSync()            ← TypeScript: dagre layout
        │
  GraphPanel / GraphNode / GraphEdge  ← React: SVG render
```

---

## Stage 1 — Node Creation (`builder.py`)

### What triggers a node

One node is created **per non-empty code cell**. Empty cells (whitespace only) are dropped both in the frontend payload and as a backend guard.

```python
sorted_cells = sorted(
    [c for c in cells if c.get("source", "").strip()],
    key=lambda c: c["index"],
)
```

### Symbol extraction

For each cell, Varys needs to know what symbols it **defines** and what it **loads** (consumes from other cells). Two data sources are used, depending on whether the cell has been executed:

| Data source | When used | How |
|---|---|---|
| `SummaryStore` (`data_source='store'`) | Cell has `execution_count > 0` | Reads `symbols_defined` and `symbols_consumed` captured at kernel execution time |
| `ASTParser` (`data_source='ast'`) | Cell is unexecuted | Static AST walk: assigns → `defines`, `ast.Name(ctx=Load)` → `consumed`, then `consumed -= defined` |

**Important known limitation:** For self-referential assignments like `df = df.dropna()`, the AST rule `consumed -= defined` removes `df` from `consumed` (because it is also assigned in the same statement). This means `loads=[]` for such cells. The redefine edge pass (Stage 1, Pass 2 below) exists specifically to compensate for this.

**Viz handle filtering:** The symbols `plt`, `sns`, `fig`, `ax`, `axes` are stripped from both `defines` and `loads` before any edge logic. These are matplotlib/seaborn state handles — not data artifacts — and would otherwise create spurious edges between nearly every plotting cell.

### Node label

A 4-priority cascade picks the display label:

| Priority | Condition | Label | Sublabel |
|---|---|---|---|
| 1 | First defined symbol with type info in store | Symbol name (`df`) | Type + shape (`DataFrame · 891 × 12`) |
| 2 | First defined symbol (no type info) | Symbol name | `""` |
| 3 | `plt.title()` / `fig.suptitle()` found in source | Plot title string | `"plot"` |
| 4 | Fallback | First 40 chars of source | `""` |

If the cell is unexecuted, `" · not executed"` is appended to the sublabel.

### Node role

After all edges are built, each node is assigned a **role** based on its relationship to the symbol history:

| Role | Condition | Color |
|---|---|---|
| `defines` | Introduces at least one symbol not seen in any preceding cell | Green |
| `redefines` | Assigns to a symbol already defined by an earlier cell | Amber |
| `consumes` | Loads symbols but defines nothing | Lavender |
| `empty` | No defines and no loads (e.g. a `print` with no assignments) | Gray |

---

## Stage 1 — Edge Creation (3 passes)

### Pass 1 — Dependency edges

```
for each node N:
  for each symbol S in N.loads:
    find the most-recent preceding cell D where S ∈ D.defines
    → create Edge(D → N, symbol=S, type='dependency')
```

**Trigger:** Cell N consumes a symbol that was defined by an earlier cell D.  
**Result:** Gray solid arrow from D to N.

Remaining unresolved loads (no definer found in the notebook) become `external_loads` — these are symbols coming from outside the notebook (e.g. a pre-loaded variable in the kernel).

### Pass 2 — Redefine edges

```
collect all cells that define the same symbol S → [C1, C2, ...] sorted by position

for each consecutive pair (Ci, Ci+1):
  if no edge already exists between them for S:
    → create Edge(Ci → Ci+1, symbol=S, type='redefines')
```

**Trigger:** The same symbol name appears in `defines` of two or more cells.  
**Purpose:** Fixes disconnected graphs caused by the `consumed -= defined` limitation. When `df = df.dropna()` has no loads recorded, this pass explicitly links the previous `df` definer (Cell 1) to the redefining cell (Cell 6).  
**Result:** Amber solid arrow.

### Pass 3 — Reimport edges

```
track the first cell that imports each module

for each cell N:
  for each module M in import statements of N's source:
    if M was already imported by an earlier cell C:
      → create Edge(C → N, symbol=M, type='reimport')
    else:
      record N as first importer of M
```

**Trigger:** A cell imports a module that was already imported earlier in the notebook.  
**Detection:** Regex `^(?:import (\w+)|from (\w+) import)` on cell source.  
**Result:** Red dashed arrow.

### Duplicate guard

All three passes share an `existing_keys` set of `(source_uuid, target_uuid, symbol)` tuples. An edge is only appended if its key is not already present, preventing duplicate edges between the same pair of cells for the same symbol.

---

## Stage 2 — Anomaly Detection (`anomaly.py`)

After the graph is built, `AnomalyDetector.run()` mutates `NodeData.anomalies` and `EdgeData.anomaly` in-place. Four anomaly classes are detected:

### SKIP_LINK (edge anomaly + node anomaly)
**Condition:** The source cell of an edge is not the most-recently-*executed* definer of the symbol.

Example: Cell 1 defines `df` (exec_count=5), Cell 3 also defines `df` (exec_count=2). Cell 5 loads `df`. The edge is Cell 3→Cell 5, but Cell 1 has the higher exec_count — so the edge is a SKIP_LINK. Cell 5 is consuming a stale version of `df`.

**Visual:** Orange arrow + orange badge on target node.

### DEAD_SYMBOL (node anomaly)
**Condition:** A cell defines a symbol that is never loaded by any later cell.

Example: Cell 4 computes `result = df.corr()` but nothing downstream reads `result`.

**Visual:** Gray badge on the defining node.

### OUT_OF_ORDER (edge anomaly + node anomaly)
**Condition:** Among adjacent executed cells (by notebook position), the earlier one has a *higher* execution count than the later one — meaning the notebook was run non-sequentially.

Example: Cell 2 (exec_count=10) appears before Cell 3 (exec_count=4) in the notebook — Cell 2 was re-run after Cell 3.

**Visual:** Red arrow + red badge on the earlier cell. All outgoing edges from the out-of-order cell are also marked.

### UNEXECUTED_IN_CHAIN (node anomaly)
**Condition:** An unexecuted cell sits between an executed cell that defines a symbol and a later executed cell that loads that same symbol.

Example: Cell 2 (executed, defines `X`) → Cell 3 (unexecuted, defines `X`) → Cell 4 (executed, loads `X`). Cell 4 is consuming Cell 2's `X`, silently skipping Cell 3's transformation.

**Visual:** Orange dashed border on the unexecuted cell.

---

## Stage 3 — Layout (`graphUtils.ts`)

Layout is computed using **dagre** (a directed-graph layout library).

```typescript
const g = new dagre.graphlib.Graph();
g.setGraph({ rankdir: 'TB', nodesep: 40, ranksep: 60, marginx: 20, marginy: 20 });

// Add nodes
for (const node of data.nodes)
  g.setNode(node.cellUuid, { width: 180, height: 64 });

// Add edges — use symbol as unique name so multiple edges
// between the same pair of nodes don't overwrite each other
for (const edge of data.edges)
  g.setEdge(edge.sourceUuid, edge.targetUuid, {}, edge.symbol);

dagre.layout(g);
```

After `dagre.layout(g)`, each node has an `(x, y)` center position and each edge has a `points[]` array of waypoints for curve drawing.

**Key settings:**
- `rankdir: 'TB'` — top-to-bottom flow (root cells at top, leaf cells at bottom)
- `nodesep: 40` — horizontal gap between sibling nodes
- `ranksep: 60` — vertical gap between ranks (generations)

The layout result (`LayoutResult`) contains:
- `nodes[]` — `{ cellUuid, x, y, width, height }`
- `edges[]` — `{ sourceUuid, targetUuid, symbol, points[] }`
- `graphWidth`, `graphHeight` — total canvas size

Layout runs asynchronously (via `requestAnimationFrame` so the loading spinner renders first).

---

## Stage 4 — Rendering (`GraphPanel`, `GraphNode`, `GraphEdge`)

### GraphNode

Each node is an SVG `<g>` element containing:
- A shadow `<rect>` (offset by 2px for depth)
- A main `<rect>` (fill = role color, stroke = role border color)
- A `<foreignObject>` containing an HTML div with two text lines:
  - **"Cell N"** — 1-indexed cell number (bold)
  - **label · sublabel** — symbol + type description (dimmed)
- An anomaly badge (colored circle, top-right) if anomalies exist

Border style overrides by priority:
1. Selected → blue ring
2. `UNEXECUTED_IN_CHAIN` → orange dashed border
3. Role color → green / amber / lavender / gray

### GraphEdge

Each edge is an SVG `<path>` drawn as a smooth quadratic Bézier curve through dagre's waypoints. The path ends with an arrowhead marker.

| Edge type | Color | Style |
|---|---|---|
| `dependency` | Gray | Solid |
| `redefines` | Amber `#d97706` | Solid, thicker |
| `reimport` | Red `#ef4444` | Dashed `6,4` |
| `SKIP_LINK` anomaly | Orange `#E8891A` | Solid, thicker |
| `OUT_OF_ORDER` anomaly | Red `#D94040` | Solid, thicker |

Edge labels (symbol name) are shown at the midpoint when zoom ≥ 0.7.

### Selection and highlighting

Clicking a node triggers a BFS over the edge adjacency map in both directions:
- **Upstream** nodes (ancestors) → light blue fill
- **Downstream** nodes (descendants) → light yellow fill
- **All other** nodes and edges → opacity 0.3 (dimmed)

Clicking the canvas background clears the selection.

---

## Data Flow Summary

```
┌─────────────────────────────────────────────────────┐
│  Frontend (useGraphData.ts)                          │
│  Reads notebook cells from JupyterLab widget        │
│  → POST /varys/graph  { notebookPath, cells[] }     │
└──────────────────────────┬──────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────┐
│  Backend (handlers/graph.py)                         │
│                                                      │
│  GraphBuilder.build(cells)                           │
│  ├─ For each cell: extract defines/loads             │
│  │    └─ SummaryStore (executed) or AST (unexecuted) │
│  ├─ Pass 1: dependency edges  (loads → defines)      │
│  ├─ Pass 2: redefines edges   (same symbol, 2 cells) │
│  ├─ Pass 3: reimport edges    (repeated imports)     │
│  └─ Node role: defines/redefines/consumes/empty      │
│                                                      │
│  AnomalyDetector.run(graph)                          │
│  └─ SKIP_LINK, DEAD_SYMBOL, OUT_OF_ORDER,            │
│     UNEXECUTED_IN_CHAIN                              │
│                                                      │
│  → JSON { nodes[], edges[] }                         │
└──────────────────────────┬──────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────┐
│  Frontend (graphUtils.ts)                            │
│  computeLayoutSync(data)                             │
│  ├─ Add all nodes to dagre                           │
│  ├─ Add all edges to dagre (keyed by symbol name)    │
│  ├─ dagre.layout() → x/y positions + waypoints      │
│  └─ → LayoutResult { nodes[], edges[], w, h }        │
└──────────────────────────┬──────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────┐
│  React render (GraphPanel.tsx)                       │
│  ├─ SVG canvas with pan & zoom                       │
│  ├─ GraphEdgeDefs — SVG arrowhead markers            │
│  ├─ GraphEdge × N — curved paths + labels            │
│  └─ GraphNode × N — colored rects + "Cell N" text    │
└─────────────────────────────────────────────────────┘
```

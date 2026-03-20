/**
 * diffUtils - LCS-based line-by-line diff computation.
 *
 * Produces a unified diff of two text strings at line granularity.
 * Kept dependency-free and small enough for typical notebook cell sizes.
 */

export type DiffLineType = 'equal' | 'insert' | 'delete';

export interface DiffLine {
  type: DiffLineType;
  text: string;
  /** 1-based line number in the original (for 'equal' / 'delete') */
  origLine?: number;
  /** 1-based line number in the modified (for 'equal' / 'insert') */
  newLine?: number;
}

/**
 * Compute a line-level diff between `original` and `modified`.
 * Returns a flat array of DiffLine items in document order.
 */
export function computeLineDiff(original: string, modified: string): DiffLine[] {
  const a = original === '' ? [] : original.split('\n');
  const b = modified === '' ? [] : modified.split('\n');
  const m = a.length;
  const n = b.length;

  // Build LCS table (O(m*n) — fine for cell-size content)
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }

  // Backtrack to produce diff sequence
  const result: DiffLine[] = [];
  let i = m, j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
      result.unshift({ type: 'equal', text: a[i - 1], origLine: i, newLine: j });
      i--; j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      result.unshift({ type: 'insert', text: b[j - 1], newLine: j });
      j--;
    } else {
      result.unshift({ type: 'delete', text: a[i - 1], origLine: i });
      i--;
    }
  }
  return result;
}

export interface DiffStats {
  insertions: number;
  deletions: number;
}

/** Count insertions and deletions in a diff. */
export function getDiffStats(lines: DiffLine[]): DiffStats {
  return lines.reduce(
    (acc, l) => {
      if (l.type === 'insert') acc.insertions++;
      else if (l.type === 'delete') acc.deletions++;
      return acc;
    },
    { insertions: 0, deletions: 0 }
  );
}

// ─────────────────────────────────────────────────────────────────
// Hunk splitting — groups consecutive change lines into hunks that
// can be independently accepted or rejected.
// ─────────────────────────────────────────────────────────────────

export interface DiffHunk {
  id: number;
  /** Inclusive start index in the flat DiffLine[] */
  startIdx: number;
  /** Exclusive end index in the flat DiffLine[] */
  endIdx: number;
  /** Original lines that will be restored on Reject */
  deletedLines: string[];
  /** New lines that will be kept on Accept */
  insertedLines: string[];
  /** Lines shown in the UI: context before + change block + context after */
  displayLines: DiffLine[];
}

/**
 * Split a flat diff into independently decidable hunks.
 * Each hunk covers one contiguous block of change lines.
 * `contextLines` equal lines on each side are included in `displayLines`
 * for readability but are NOT part of the hunk's range.
 */
export function splitIntoHunks(lines: DiffLine[], contextLines = 2): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  let hunkId = 0;
  let i = 0;

  while (i < lines.length) {
    if (lines[i].type === 'equal') { i++; continue; }

    // Collect the entire change block (delete/insert may be interleaved)
    const startIdx = i;
    while (i < lines.length && lines[i].type !== 'equal') i++;
    const endIdx = i;

    const deletedLines: string[] = [];
    const insertedLines: string[] = [];
    for (let j = startIdx; j < endIdx; j++) {
      if (lines[j].type === 'delete') deletedLines.push(lines[j].text);
      else if (lines[j].type === 'insert') insertedLines.push(lines[j].text);
    }

    // Build display lines with surrounding context
    const dispStart = Math.max(0, startIdx - contextLines);
    const dispEnd   = Math.min(lines.length, endIdx + contextLines);
    const displayLines = lines.slice(dispStart, dispEnd);

    hunks.push({ id: hunkId++, startIdx, endIdx, deletedLines, insertedLines, displayLines });
  }
  return hunks;
}

/**
 * Reconstruct the final cell content by applying per-hunk decisions.
 *  - 'accepted' (default for 'pending') → use the new (inserted) lines
 *  - 'rejected'                         → use the original (deleted) lines
 * Equal lines are always kept verbatim.
 */
export function reconstructFromHunks(
  lines: DiffLine[],
  hunks: DiffHunk[],
  decisions: Record<number, 'accepted' | 'rejected'>,
): string {
  // Build a lookup: line index → owning hunk
  const lineToHunk = new Map<number, DiffHunk>();
  for (const hunk of hunks) {
    for (let j = hunk.startIdx; j < hunk.endIdx; j++) lineToHunk.set(j, hunk);
  }

  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.type === 'equal') {
      out.push(line.text === '…' ? '' : line.text);
      i++;
      continue;
    }
    const hunk = lineToHunk.get(i)!;
    const decision = decisions[hunk.id] ?? 'accepted';
    if (decision === 'accepted') {
      out.push(...hunk.insertedLines);
    } else {
      out.push(...hunk.deletedLines);
    }
    i = hunk.endIdx; // skip past the whole hunk block
  }
  return out.join('\n');
}

/**
 * Trim equal lines around changes, keeping `contextLines` unchanged lines
 * before and after each hunk for readability.
 */
export function collapseContext(lines: DiffLine[], contextLines = 3): DiffLine[] {
  if (lines.length === 0) return lines;

  // Mark lines to keep
  const keep = new Array(lines.length).fill(false);

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].type !== 'equal') {
      const start = Math.max(0, i - contextLines);
      const end = Math.min(lines.length - 1, i + contextLines);
      for (let k = start; k <= end; k++) keep[k] = true;
    }
  }

  const result: DiffLine[] = [];
  let skipping = false;
  for (let i = 0; i < lines.length; i++) {
    if (keep[i]) {
      skipping = false;
      result.push(lines[i]);
    } else if (!skipping) {
      result.push({ type: 'equal', text: '…' });
      skipping = true;
    }
  }
  return result;
}

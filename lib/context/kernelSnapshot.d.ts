/**
 * kernelSnapshot — lightweight post-execution variable introspection.
 *
 * After a cell executes, extracts variable names assigned in the cell source,
 * runs a silent Python snippet to get type/shape/value metadata, and returns
 * a kernel_snapshot dict for the SummaryStore.
 */
/**
 * Return all variable names assigned in cell source, including tuple-unpacking.
 *
 * Handles:
 *   name = expr                       simple assignment
 *   a, b = expr                       flat tuple unpacking
 *   a, *b, c = expr                   starred unpacking
 *   (a, b) = expr  /  [a, b] = expr  parenthesised / bracketed unpacking
 *
 * Does NOT handle nested unpacking (a, (b, c) = ...) — uncommon in notebooks.
 * Augmented assignments (+=, -=, …), attribute assignments (obj.x = …), and
 * subscript assignments (d[k] = …) are intentionally ignored.
 */
export declare function extractAssignedNames(source: string): string[];
/**
 * Execute a silent introspection in the kernel for the given variable names.
 * Returns a kernel_snapshot dict suitable for passing to apiClient.cellExecuted.
 * Never throws — returns {} on any error.
 */
export declare function buildKernelSnapshot(kernel: any, names: string[]): Promise<Record<string, unknown>>;
//# sourceMappingURL=kernelSnapshot.d.ts.map
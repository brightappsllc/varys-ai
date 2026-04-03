/**
 * kernelSnapshot — lightweight post-execution variable introspection.
 *
 * After a cell executes, extracts variable names assigned in the cell source,
 * runs a silent Python snippet to get type/shape/value metadata, and returns
 * a kernel_snapshot dict for the SummaryStore.
 */
/**
 * Return the set of simple assignment targets found in cell source.
 * Matches `name =` at the start of any line (ignores augmented assignments,
 * attribute assignments, and subscript assignments).
 */
export declare function extractAssignedNames(source: string): string[];
/**
 * Execute a silent introspection in the kernel for the given variable names.
 * Returns a kernel_snapshot dict suitable for passing to apiClient.cellExecuted.
 * Never throws — returns {} on any error.
 */
export declare function buildKernelSnapshot(kernel: any, names: string[]): Promise<Record<string, unknown>>;
//# sourceMappingURL=kernelSnapshot.d.ts.map
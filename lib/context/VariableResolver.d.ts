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
export interface ResolvedVariable {
    /** Original expression without the @ prefix (e.g. "df" or "df.head(10)") */
    expr: string;
    /** Structured summary returned by the kernel introspection script */
    summary: Record<string, any>;
}
/** Extract all unique @variable_ref expressions from a message string. */
export declare function parseVariableRefs(message: string): string[];
export declare class VariableResolver {
    private _tracker;
    constructor(tracker: INotebookTracker);
    /**
     * Resolve all @variable_ref expressions in `message`.
     * Returns an array of { expr, summary } objects ready to be attached to
     * the TaskRequest.  Returns [] if no @refs found or no kernel is available.
     */
    resolve(message: string): Promise<ResolvedVariable[]>;
}
//# sourceMappingURL=VariableResolver.d.ts.map
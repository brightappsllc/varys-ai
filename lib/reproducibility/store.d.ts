/**
 * Module-level signal that bridges index.ts (cell execution listener)
 * and the ReproPanel React component.
 *
 * Usage:
 *   // emit (from index.ts after backend call)
 *   reproStore.emit(issues);
 *
 *   // subscribe (inside React component)
 *   useEffect(() => {
 *     reproStore.subscribe(setIssues);
 *     return () => reproStore.unsubscribe(setIssues);
 *   }, []);
 */
import { ReproIssue } from './types';
type Listener = (issues: ReproIssue[]) => void;
declare class ReproStore {
    private _listeners;
    private _issues;
    emit(issues: ReproIssue[]): void;
    get current(): ReproIssue[];
    subscribe(fn: Listener): void;
    unsubscribe(fn: Listener): void;
}
export declare const reproStore: ReproStore;
export {};
//# sourceMappingURL=store.d.ts.map
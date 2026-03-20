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

class ReproStore {
  private _listeners: Listener[] = [];
  private _issues: ReproIssue[]  = [];

  emit(issues: ReproIssue[]): void {
    this._issues = issues;
    this._listeners.forEach(fn => fn(issues));
  }

  get current(): ReproIssue[] {
    return this._issues;
  }

  subscribe(fn: Listener): void {
    this._listeners.push(fn);
  }

  unsubscribe(fn: Listener): void {
    this._listeners = this._listeners.filter(l => l !== fn);
  }
}

export const reproStore = new ReproStore();

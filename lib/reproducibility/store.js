class ReproStore {
    constructor() {
        this._listeners = [];
        this._issues = [];
    }
    emit(issues) {
        this._issues = issues;
        this._listeners.forEach(fn => fn(issues));
    }
    get current() {
        return this._issues;
    }
    subscribe(fn) {
        this._listeners.push(fn);
    }
    unsubscribe(fn) {
        this._listeners = this._listeners.filter(l => l !== fn);
    }
}
export const reproStore = new ReproStore();

import {AsyncLocalStorage} from 'node:async_hooks';

/** Own the lifetime of registered work, independently of caller await style.
 * Node still owns assertions, skip/todo, cancellation and final test outcomes. */
export function createNativeTestScope() {
    const storage = new AsyncLocalStorage();
    return {
        async run(callback) {
            const scope = { pending: [], closed: false };
            return storage.run(scope, async () => {
                try { return await callback(); }
                finally {
                    // Nested registration can add work while a batch completes.
                    while (scope.pending.length) await Promise.allSettled(scope.pending.splice(0));
                    scope.closed = true;
                }
            });
        },
        register(start) {
            const scope = storage.getStore();
            if (!scope || scope.closed) throw Error('GUI_NATIVE_LATE_REGISTRATION: register tests before their containing callback finishes');
            const result = start();
            scope.pending.push(Promise.resolve(result));
            return result;
        },
    };
}

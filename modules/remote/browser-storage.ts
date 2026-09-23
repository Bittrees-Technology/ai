import { BrowserOutboxError } from "./browser-outbox-state.js";
export type BrowserStorageIO<T> = {
  store(name: string): IDBObjectStore;
  request<R>(request: IDBRequest<R>, done: (value: R) => void): void;
  done(value: T): void;
};
/** Short IndexedDB transactions only: no crypto, network or awaited work inside
 * request callbacks. Publication returns only after transaction completion. */
export function browserStorageTransaction<T>(
  db: IDBDatabase,
  stores: string[],
  mode: IDBTransactionMode,
  check: () => void,
  work: (io: BrowserStorageIO<T>) => void,
): Promise<T> {
  return new Promise((resolve, reject) => {
    let tx: IDBTransaction,
      value: T,
      written = false,
      failure: Error | undefined;
    try {
      check();
      tx = db.transaction(stores, mode, { durability: "strict" });
    } catch (e) {
      reject(
        e instanceof BrowserOutboxError
          ? e
          : new BrowserOutboxError("STORAGE_UNAVAILABLE"),
      );
      return;
    }
    const fail = (e: unknown) => {
      failure =
        e instanceof BrowserOutboxError
          ? e
          : new BrowserOutboxError(
              e instanceof DOMException && e.name === "QuotaExceededError"
                ? "CAPACITY"
                : "STORAGE_UNAVAILABLE",
            );
      try {
        tx.abort();
      } catch {
        clearTimeout(timer);
        reject(failure);
      }
    };
    const run = (fn: () => void) => {
      try {
        check();
        fn();
        check();
      } catch (e) {
        fail(e);
      }
    };
    const timer = setTimeout(
      () => fail(new BrowserOutboxError("STORAGE_UNAVAILABLE")),
      15000,
    );
    tx.onabort = () => {
      clearTimeout(timer);
      reject(
        failure ??
          new BrowserOutboxError(
            tx.error?.name === "QuotaExceededError"
              ? "CAPACITY"
              : "STORAGE_UNAVAILABLE",
          ),
      );
    };
    tx.oncomplete = () => {
      clearTimeout(timer);
      try {
        check();
        if (!written) throw new BrowserOutboxError("STORAGE_UNAVAILABLE");
        resolve(value);
      } catch (e) {
        reject(e);
      }
    };
    run(() =>
      work({
        store: (name) => tx.objectStore(name),
        request: (request, done) => {
          request.onsuccess = () => run(() => done(request.result));
        },
        done: (result) => {
          value = result;
          written = true;
        },
      }),
    );
  });
}

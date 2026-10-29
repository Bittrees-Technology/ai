/** Pairing admission is a completed synchronous native verdict. TypeScript's
 * void callback type also accepts async functions; ignoring such a promise could
 * otherwise start key/source work before its admission check finishes.
 * This does not authorize anything: the callback must throw on unavailable proof.
 */
export function requireSynchronousPairingAdmission(check: () => void) {
  const result: unknown = check();
  if (result !== undefined) {
    // Observe a rejected accidental async verdict without accepting it or letting
    // it create an unhandled rejection after the pairing action has been denied.
    if (result instanceof Promise) void result.catch(() => {});
    throw Error("Completed synchronous native pairing admission required");
  }
}

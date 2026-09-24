import { z } from "zod";
import {
  remoteControlSchema,
  remoteReceiptSchema,
  parseRemoteControl,
} from "./status.js";

const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const revision = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER - 1);
const command = remoteControlSchema.refine(
  (c) =>
    Date.parse(c.expiresAt) > Date.parse(c.issuedAt) &&
    Date.parse(c.expiresAt) - Date.parse(c.issuedAt) <= 300000,
);
export const commandObservationSchema = z
  .strictObject({
    command,
    state: z.enum(["pending", "acknowledged", "cancelled", "expired"]),
    receipt: remoteReceiptSchema.nullable(),
  })
  .refine(
    (v) =>
      (v.state === "acknowledged") === (v.receipt !== null) &&
      (!v.receipt ||
        (v.receipt.id === v.command.id &&
          v.receipt.deviceId === v.command.deviceId &&
          Date.parse(v.receipt.completedAt) >= Date.parse(v.command.issuedAt) &&
          (v.receipt.outcome !== "applied" ||
            Date.parse(v.receipt.completedAt) <
              Date.parse(v.command.expiresAt)))),
  );
const entrySchema = z.strictObject({
  command,
  savedAt: positive,
  observation: z
    .strictObject({ at: positive, value: commandObservationSchema })
    .nullable(),
});
function sameIntent(a: z.infer<typeof command>, b: z.infer<typeof command>) {
  return (
    a.id === b.id &&
    a.deviceId === b.deviceId &&
    a.taskId === b.taskId &&
    a.command === b.command &&
    a.expectedRevision === b.expectedRevision
  );
}
export const commandHistorySchema = z
  .strictObject({
    version: z.literal(1),
    ownerId: z.uuid(),
    revision,
    entries: z.array(entrySchema).max(100),
  })
  .refine(
    (v) =>
      new Set(v.entries.map((e) => e.command.id)).size === v.entries.length &&
      v.entries.every(
        (e) =>
          !e.observation ||
          (sameIntent(e.command, e.observation.value.command) &&
            Date.parse(e.observation.value.command.expiresAt) <=
              Date.parse(e.command.expiresAt) &&
            e.observation.at >= e.savedAt),
      ),
  );
export type CommandHistory = z.infer<typeof commandHistorySchema>;
export const commandHistoryDatabaseName =
  "org.bittrees.ai.browser-command-history";
const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
const empty = (ownerId: string): CommandHistory => ({
  version: 1,
  ownerId,
  revision: 0,
  entries: [],
});
type Check = () => void;

/** Metadata journal only. It has no network transport, credentials, keys, task
 * content, import/resume or command execution path. The caller supplies current
 * authenticated owner scope and must fence presentation after asynchronous work. */
export class BrowserCommandHistory {
  constructor(private now = Date.now) {}
  private open(): Promise<IDBDatabase> {
    if (!globalThis.isSecureContext) return Promise.reject(Error("DENIED"));
    return new Promise((resolve, reject) => {
      let ended = false,
        request: IDBOpenDBRequest;
      const fail = () => {
        if (ended) return;
        ended = true;
        clearTimeout(timer);
        reject(Error("STORAGE_UNAVAILABLE"));
      };
      const timer = setTimeout(fail, 10000);
      try {
        request = indexedDB.open(commandHistoryDatabaseName, 1);
      } catch {
        fail();
        return;
      }
      request.onerror = request.onblocked = fail;
      request.onupgradeneeded = () => {
        if (ended) {
          request.transaction?.abort();
          return;
        }
        request.result.createObjectStore("owners", { keyPath: "ownerId" });
      };
      request.onsuccess = () => {
        if (ended) {
          request.result.close();
          return;
        }
        ended = true;
        clearTimeout(timer);
        request.result.onversionchange = () => request.result.close();
        resolve(request.result);
      };
    });
  }
  private async access(
    ownerId: string,
    check: Check,
    change?: (v: CommandHistory) => CommandHistory,
  ) {
    z.uuid().parse(ownerId);
    check();
    const db = await this.open();
    try {
      check();
      return await new Promise<CommandHistory>((resolve, reject) => {
        let value: CommandHistory, fault: unknown;
        const tx = db.transaction("owners", change ? "readwrite" : "readonly");
        const table = tx.objectStore("owners");
        const fail = (e: unknown) => {
          fault = e;
          try {
            tx.abort();
          } catch {}
        };
        const get = table.get(ownerId),
          count = table.count();
        count.onerror = get.onerror = () => fail(Error("STORAGE_UNAVAILABLE"));
        // Requests in one transaction run in order. The global document limit
        // and owner revision are checked inside the same write transaction.
        count.onsuccess = () => {
          try {
            check();
            value = commandHistorySchema.parse(get.result ?? empty(ownerId));
            if (value.ownerId !== ownerId) throw Error("DENIED");
            if (change) {
              const next = commandHistorySchema.parse(
                change(structuredClone(value)),
              );
              if (next.ownerId !== ownerId) throw Error("DENIED");
              if (
                new TextEncoder().encode(JSON.stringify(next)).length >
                  200000 ||
                (!get.result && count.result >= 100)
              )
                throw Error("CAPACITY");
              if (!same(next, value)) {
                check();
                table.put(next);
                value = next;
              }
            }
          } catch (e) {
            fail(e);
          }
        };
        tx.onabort = tx.onerror = () =>
          reject(fault ?? Error("STORAGE_UNAVAILABLE"));
        tx.oncomplete = () => {
          try {
            check();
            resolve(structuredClone(value));
          } catch (e) {
            reject(e);
          }
        };
      });
    } finally {
      db.close();
    }
  }
  read(ownerId: string, check: Check) {
    return this.access(ownerId, check);
  }
  /** Save the exact reviewed intent before its first possible network dispatch.
   * A row alone does not establish whether the server ever received it. */
  reserve(
    ownerId: string,
    expectedRevision: number,
    raw: unknown,
    check: Check,
  ) {
    revision.parse(expectedRevision);
    const intent = command.parse(raw);
    return this.access(ownerId, check, (current) => {
      if (current.revision !== expectedRevision) throw Error("CONFLICT");
      const prior = current.entries.find((e) => e.command.id === intent.id);
      if (prior) {
        if (!same(prior.command, intent)) throw Error("CONFLICT");
        return current;
      }
      if (current.entries.length >= 100) throw Error("CAPACITY");
      const time = positive.parse(this.now());
      parseRemoteControl(intent, time);
      return {
        ...current,
        revision: current.revision + 1,
        entries: [
          ...current.entries,
          { command: intent, savedAt: time, observation: null },
        ],
      };
    });
  }
  observe(
    ownerId: string,
    expectedRevision: number,
    id: string,
    raw: unknown,
    check: Check,
  ) {
    revision.parse(expectedRevision);
    z.uuid().parse(id);
    const observed = commandObservationSchema.parse(raw);
    return this.access(ownerId, check, (current) => {
      if (current.revision !== expectedRevision) throw Error("CONFLICT");
      const prior = current.entries.find((e) => e.command.id === id);
      if (
        !prior ||
        observed.command.id !== id ||
        !sameIntent(prior.command, observed.command) ||
        Date.parse(observed.command.expiresAt) >
          Date.parse(prior.command.expiresAt)
      )
        throw Error("CONFLICT");
      const old = prior.observation;
      const time = positive.parse(this.now());
      if (
        Date.parse(observed.command.issuedAt) > time + 30000 ||
        (observed.receipt &&
          Date.parse(observed.receipt.completedAt) > time + 30000) ||
        time < prior.savedAt ||
        (old &&
          (time < old.at ||
            (old.value.state !== "pending" && observed.state === "pending") ||
            (old.value.state === "acknowledged" && !same(old.value, observed))))
      )
        throw Error("CONFLICT");
      return {
        ...current,
        revision: current.revision + 1,
        entries: current.entries.map((e) =>
          e.command.id === id
            ? { ...e, observation: { at: time, value: observed } }
            : e,
        ),
      };
    });
  }
  /** Deletion advances a small owner revision tombstone so a late observation
   * cannot recreate deleted entries. Export is the same strict read projection. */
  clear(
    ownerId: string,
    expectedRevision: number,
    confirmed: true,
    check: Check,
  ) {
    revision.parse(expectedRevision);
    z.literal(true).parse(confirmed);
    return this.access(ownerId, check, (current) => {
      if (current.revision !== expectedRevision) throw Error("CONFLICT");
      return { ...current, revision: current.revision + 1, entries: [] };
    });
  }
}

import { z } from "zod";
import { privateBindingSchema } from "./private-peer-contracts.js";
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const browserLifecycleSlotSchema = z.strictObject({
  id: z.uuid(),
  keyEpoch: positive,
  binding: privateBindingSchema,
  createdAt: positive,
  state: z.enum(["preparing", "active", "retired", "deleted"]),
  publicKey: z
    .string()
    .length(87)
    .regex(/^[A-Za-z0-9_-]+$/)
    .nullable(),
});
export const browserLifecycleSchema = z
  .strictObject({
    scope: z.string().regex(/^[a-f0-9]{64}$/),
    revision: positive,
    ownerId: z.uuid(),
    deviceId: z.uuid(),
    locked: z.boolean(),
    slots: z.array(browserLifecycleSlotSchema).max(20),
  })
  .refine(
    (s) =>
      new Set(s.slots.map((x) => x.id)).size === s.slots.length &&
      s.slots.filter((x) => x.state === "active" || x.state === "preparing")
        .length <= 1 &&
      s.slots.every(
        (x) =>
          x.binding.ownerId === s.ownerId &&
          ((x.state !== "active" && x.state !== "preparing") ||
            x.binding.deviceId === s.deviceId) &&
          (x.state !== "active" || !!x.publicKey) &&
          ((x.state !== "deleted" && x.state !== "preparing") ||
            x.publicKey === null),
      ) &&
      (!s.locked ||
        s.slots.every((x) => x.state !== "active" && x.state !== "preparing")),
  );
export type BrowserLifecycleState = z.infer<typeof browserLifecycleSchema>;
export class BrowserKeyError extends Error {
  constructor(
    readonly code:
      | "DENIED"
      | "CONFLICT"
      | "MISSING"
      | "DELETED"
      | "CREATION_INCOMPLETE"
      | "STORAGE_UNAVAILABLE"
      | "CAPACITY"
      | "BUSY"
      | "SETUP_REQUIRED",
  ) {
    super(code);
  }
}
export const browserKeyDatabaseName = "org.bittrees.ai.browser-endpoint-keys";
export const browserKeyDatabaseVersion = 20;
export async function browserKeyScope(localOwner: string) {
  if (
    !z.string().min(1).max(256).safeParse(localOwner).success ||
    !globalThis.isSecureContext
  )
    throw new BrowserKeyError("DENIED");
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(
          JSON.stringify(["browser-endpoint-owner:v1", localOwner]),
        ),
      ),
    ),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
}
export function openBrowserKeyDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let ended = false;
    const fail = () => {
      if (!ended) {
        ended = true;
        clearTimeout(timer);
        reject(new BrowserKeyError("STORAGE_UNAVAILABLE"));
      }
    };
    const timer = setTimeout(fail, 10000);
    let r: IDBOpenDBRequest;
    try {
      r = indexedDB.open(browserKeyDatabaseName, browserKeyDatabaseVersion);
    } catch {
      fail();
      return;
    }
    r.onerror = fail;
    r.onblocked = fail;
    r.onupgradeneeded = (event) => {
      if (ended) {
        r.transaction?.abort();
        return;
      }
      if (event.oldVersion === 0) {
        const slots = r.result.createObjectStore("slots", {
          keyPath: ["scope", "keyId"],
        });
        slots.createIndex("scope", "scope");
      }
      if (event.oldVersion < 2)
        r.result.createObjectStore("lifecycle", { keyPath: "scope" });
      if (event.oldVersion < 3)
        r.result.createObjectStore("peers", { keyPath: "scope" });
      if (event.oldVersion < 4) {
        r.result.createObjectStore("meta", { keyPath: "scope" });
        const entries = r.result.createObjectStore("entries", {
          keyPath: "id",
        });
        entries.createIndex("scope", "scope");
        const channels = r.result.createObjectStore("channels", {
          keyPath: ["scope", "channel"],
        });
        channels.createIndex("scope", "scope");
        r.result.createObjectStore("private_migrations", { keyPath: "id" });
        const checks = r.result.createObjectStore("peer_checks", {
          keyPath: ["scope", "id"],
        });
        checks.createIndex("scope", "scope");
        checks.createIndex(
          "operation",
          ["scope", "role", "senderId", "operationId"],
          { unique: true },
        );
      }
      if (event.oldVersion < 5)
        r.result.createObjectStore("task_consents", { keyPath: "scope" });
      if (event.oldVersion < 6) {
        const preparations = r.result.createObjectStore("task_preparations", {
          keyPath: "id",
        });
        preparations.createIndex("scope", "scope");
      }
      if (event.oldVersion < 8)
        r.result.createObjectStore("conversation_consents", {
          keyPath: "scope",
        });
      if (event.oldVersion < 9) {
        const replay = r.result.createObjectStore("incoming_replay", {
          keyPath: ["scope", "operation"],
        });
        replay.createIndex("scope", "scope");
        for (const field of ["operation", "message", "sequence"])
          replay.createIndex(field, ["scope", field], { unique: true });
      }
      if (event.oldVersion < 19) {
        const decisions = r.result.createObjectStore(
          "autonote_approval_decisions",
          { keyPath: ["scope", "id"] },
        );
        decisions.createIndex("scope", "scope");
      }
      if (event.oldVersion < 18) {
        const inbox = r.result.createObjectStore("autonote_approval_inbox", {
          keyPath: ["scope", "id"],
        });
        inbox.createIndex("scope", "scope");
        inbox.createIndex("offer", ["scope", "offer"]);
        inbox.createIndex("part", ["scope", "offer", "index"], {
          unique: true,
        });
      }
      if (event.oldVersion < 17) {
        const delivery = r.result.createObjectStore("resume_delivery", {
          keyPath: ["scope", "id"],
        });
        delivery.createIndex("scope", "scope");
      }
      if (event.oldVersion < 16)
        r.result.createObjectStore("resume_consents", { keyPath: "scope" });
      if (event.oldVersion < 13) {
        const content = r.result.createObjectStore("conversation_content", {
          keyPath: ["scope", "id"],
        });
        content.createIndex("scope", "scope");
      }
    };
    // Version20 fences older writers before decision receipt replay records.
    // Version19 adds encrypted browser decision storage and fences previous writers.
    // Version18 adds an empty encrypted AutoNote approval inbox and fences previous writers.
    // Version16 adds separate resume consent and fences older replay writers.
    // Version14 fences older writers before outgoing recipient receipts are retained.
    // Existing encrypted content, keys, channels and replay rows are preserved.
    // Version12 fences older writers before generation-time replay provenance.
    // Version11 fences older writers before durable offer acknowledgements.
    // Version10 fences older writers before offer replay metadata enters grants.
    // Version9 fences older writers and adds a shared hash-only incoming ledger.
    // Existing historical records are not evidence of complete replay coverage.
    // Version8 fences older writers and adds empty, separate conversation consent.
    // Version7 fences older writers before retained transport observations are added.
    // Existing keys, consent, ciphertext and preparation records remain unchanged.
    r.onsuccess = () => {
      if (ended) {
        r.result.close();
        return;
      }
      ended = true;
      clearTimeout(timer);
      resolve(r.result);
    };
  });
}

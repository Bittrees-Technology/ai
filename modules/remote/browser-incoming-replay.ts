import { z } from "zod";
import { BrowserOutboxError } from "./browser-outbox-state.js";
import type { BrowserStorageIO } from "./browser-storage.js";
import {
  classifyPrivateReplay,
  privateReplayIdentitySchema,
  PrivateReplayError,
  type PrivateReplayIdentity,
} from "./private-replay.js";

export const browserIncomingReplayStore = "incoming_replay";
const hex = z.string().regex(/^[a-f0-9]{64}$/);
const outcomeSchema = z.discriminatedUnion("store", [
  z.strictObject({ store: z.literal("entries"), key: z.tuple([z.uuid()]) }),
  z.strictObject({
    store: z.literal("peer_checks"),
    key: z.tuple([hex, z.uuid()]),
  }),
  z.strictObject({
    store: z.literal("conversation_consents"),
    // Local consent row and authenticated offer-operation digest within it.
    key: z.tuple([hex, hex]),
  }),
]);
export const browserIncomingReplaySchema = z.strictObject({
  scope: hex,
  ...privateReplayIdentitySchema.shape,
  outcome: outcomeSchema,
});
type Outcome = z.infer<typeof outcomeSchema>;
type Row = z.infer<typeof browserIncomingReplaySchema>;

/** Hash-only replay metadata, not content or authority. The linked outcome stays
 * in its existing encrypted family store. Use browserPrivateIdentity.scope for
 * every receiver (not the distinct browserKeyScope used by device key records).
 * Caller authenticates and hashes BEFORE the write, then validates current
 * consent/keys and the retained outcome INSIDE this same write transaction.
 * No async work, second transaction, eviction or automatic replay reset here.
 */
export function consumeBrowserIncomingReplay<T>(
  io: BrowserStorageIO<T>,
  scope: string,
  identity: PrivateReplayIdentity,
  outcome: Outcome,
  retainedOutcome: boolean,
  done: (state: "new" | "duplicate") => void,
) {
  const candidate = browserIncomingReplaySchema.parse({
    scope,
    ...identity,
    outcome,
  });
  const store = io.store(browserIncomingReplayStore);
  if (store.transaction.mode !== "readwrite")
    throw new BrowserOutboxError("STORAGE_UNAVAILABLE");
  const matches = new Map<string, Row>();
  const fields = ["operation", "message", "sequence"] as const;
  const next = (index: number) => {
    if (index < fields.length) {
      const field = fields[index]!;
      io.request(store.index(field).get([scope, candidate[field]]), (raw) => {
        if (raw !== undefined) {
          const parsed = browserIncomingReplaySchema.safeParse(raw);
          if (
            !parsed.success ||
            parsed.data.scope !== scope ||
            parsed.data[field] !== candidate[field]
          )
            throw new BrowserOutboxError("STORAGE_UNAVAILABLE");
          matches.set(parsed.data.operation, parsed.data);
        }
        next(index + 1);
      });
      return;
    }
    let state: "new" | "duplicate";
    try {
      state = classifyPrivateReplay(
        identity,
        [...matches.values()].map(
          ({ scope: _scope, outcome: _outcome, ...id }) => id,
        ),
      );
    } catch (e) {
      throw new BrowserOutboxError(
        e instanceof PrivateReplayError ? e.code : "STORAGE_UNAVAILABLE",
      );
    }
    if (state === "duplicate") {
      const prior = [...matches.values()][0]!;
      if (
        !retainedOutcome ||
        JSON.stringify(prior.outcome) !== JSON.stringify(outcome)
      )
        throw new BrowserOutboxError("CONFLICT");
      done(state);
      return;
    }
    io.request(store.index("scope").count(scope), (count) => {
      if (count >= 4096) throw new BrowserOutboxError("CAPACITY");
      // Wait for the insert callback so the caller rechecks its guard after the
      // final replay mutation and before publishing or committing the outcome.
      io.request(store.add(candidate), () => done("new"));
    });
  };
  next(0);
}

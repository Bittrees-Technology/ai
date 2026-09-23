import { z } from "zod";
import { openBrowserKeyDatabase } from "./browser-key-state.js";
import {
  BrowserOutboxError,
  browserOutboxMetaSchema,
  browserOutboxEntrySchema,
  browserOutboxChannelSchema,
  browserPrivateDigest,
  browserPrivateIdentity,
  browserPrivateChannel,
} from "./browser-outbox-state.js";
import {
  browserStorageTransaction as tx,
  type BrowserStorageIO,
} from "./browser-storage.js";
const legacyName = "org.bittrees.ai.private-outbox",
  stores = ["meta", "entries", "channels"],
  journal = "private_migrations";
const globalId = "legacy-outbox-v1",
  prefix = globalId + ":";
const hex = z.string().regex(/^[a-f0-9]{64}$/);
const globalSchema = z.strictObject({
  id: z.literal(globalId),
  version: z.literal(1),
  complete: z.literal(true),
});
const ownerSchema = z
  .strictObject({
    id: z.string(),
    scope: hex,
    version: z.literal(1),
    state: z.enum(["copied", "cleaned"]),
    digest: hex,
    entries: z.number().int().min(0).max(256),
    channels: z.number().int().min(0).max(1024),
  })
  .refine((v) => v.id === prefix + v.scope);
type Snapshot = {
  meta: z.infer<typeof browserOutboxMetaSchema> | null;
  entries: z.infer<typeof browserOutboxEntrySchema>[];
  channels: z.infer<typeof browserOutboxChannelSchema>[];
};
const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
function snapshot(raw: Snapshot, scope: string) {
  const result = {
    meta: raw.meta === null ? null : browserOutboxMetaSchema.parse(raw.meta),
    entries: raw.entries.map((v) => browserOutboxEntrySchema.parse(v)),
    channels: raw.channels.map((v) => browserOutboxChannelSchema.parse(v)),
  };
  if (result.entries.length > 256 || result.channels.length > 1024)
    throw new BrowserOutboxError("CAPACITY");
  if (
    (result.meta && result.meta.scope !== scope) ||
    result.entries.some((v) => v.scope !== scope) ||
    result.channels.some((v) => v.scope !== scope) ||
    (!result.meta && (result.entries.length || result.channels.length))
  )
    throw new BrowserOutboxError("STORAGE_UNAVAILABLE");
  return result;
}
function readOwner<T>(
  io: BrowserStorageIO<T>,
  scope: string,
  done: (s: Snapshot) => void,
) {
  io.request(io.store("meta").get(scope), (meta) => {
    io.request(
      io.store("entries").index("scope").getAll(scope, 257),
      (entries) => {
        io.request(
          io.store("channels").index("scope").getAll(scope, 1025),
          (channels) =>
            done(snapshot({ meta: meta ?? null, entries, channels }, scope)),
        );
      },
    );
  });
}
function legacy(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let ended = false;
    const fail = () => {
      if (!ended) {
        ended = true;
        clearTimeout(timer);
        reject(new BrowserOutboxError("STORAGE_UNAVAILABLE"));
      }
    };
    const timer = setTimeout(fail, 10000);
    let r: IDBOpenDBRequest;
    try {
      r = indexedDB.open(legacyName, 2);
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
        r.result.createObjectStore("meta", { keyPath: "scope" });
        const e = r.result.createObjectStore("entries", { keyPath: "id" });
        e.createIndex("scope", "scope");
        const c = r.result.createObjectStore("channels", {
          keyPath: ["scope", "channel"],
        });
        c.createIndex("scope", "scope");
      }
      // Version2 only fences the v1 writer. Source records remain intact until a
      // verified common-store copy is committed; no cross-database atomicity claim.
    };
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
/** One common store for future check/task authority. A separate version2 legacy
 * fence prevents the old writer from racing the restartable copy/cleanup journal.
 * Key-only recovery opens the common database without needing this migration. */
export async function openBrowserPrivateDatabase(): Promise<IDBDatabase> {
  const db = await openBrowserKeyDatabase();
  let source: IDBDatabase | undefined,
    closed = false;
  const close = () => {
    closed = true;
    db.close();
    source?.close();
  };
  db.onversionchange = close;
  db.onclose = () => {
    closed = true;
  };
  const check = () => {
    if (closed) throw new BrowserOutboxError("STORAGE_UNAVAILABLE");
  };
  try {
    const complete = await tx(db, [journal], "readonly", check, (io) =>
      io.request(io.store(journal).get(globalId), (raw) => {
        if (raw !== undefined) globalSchema.parse(raw);
        io.done(raw !== undefined);
      }),
    );
    if (complete) return db;
    source = await legacy();
    check();
    source.onversionchange = close;
    source.onclose = () => {
      closed = true;
    };
    const owners = await tx<string[]>(
      source,
      stores,
      "readonly",
      check,
      (io) => {
        io.request(io.store("meta").getAll(undefined, 33), (rows) => {
          if (rows.length > 32) throw new BrowserOutboxError("CAPACITY");
          io.done(rows.map((v) => browserOutboxMetaSchema.parse(v).scope));
        });
      },
    );
    for (const scope of owners) {
      const saved = await tx<Snapshot>(
        source,
        stores,
        "readonly",
        check,
        (io) => readOwner(io, scope, (v) => io.done(v)),
      );
      if (!saved.meta) continue; // Another migrator already verified and cleaned it.
      // Validate owner association and sequence continuity outside write transactions.
      for (const entry of saved.entries) {
        const identity = await browserPrivateIdentity(entry.context.binding);
        if (identity.scope !== scope)
          throw new BrowserOutboxError("STORAGE_UNAVAILABLE");
        const channel = await browserPrivateChannel(identity, entry.context);
        const counter = saved.channels.find((v) => v.channel === channel);
        if (!counter || counter.next <= entry.header.sequence)
          throw new BrowserOutboxError("STORAGE_UNAVAILABLE");
      }
      const digest = await browserPrivateDigest(saved);
      check();
      await tx(db, [...stores, journal], "readwrite", check, (io) => {
        io.request(io.store(journal).get(globalId), (finished) => {
          if (finished !== undefined) {
            globalSchema.parse(finished);
            io.done(undefined);
            return;
          }
          io.request(io.store(journal).get(prefix + scope), (prior) => {
            if (prior !== undefined) {
              const marker = ownerSchema.parse(prior);
              if (marker.digest !== digest)
                throw new BrowserOutboxError("CONFLICT");
              readOwner(io, scope, (current) => {
                if (!same(saved, current))
                  throw new BrowserOutboxError("CONFLICT");
                io.done(undefined);
              });
              return;
            }
            readOwner(io, scope, (current) => {
              if (
                current.meta ||
                current.entries.length ||
                current.channels.length
              )
                throw new BrowserOutboxError("CONFLICT");
              io.store("meta").add(saved.meta!);
              for (const e of saved.entries) io.store("entries").add(e);
              for (const c of saved.channels) io.store("channels").add(c);
              io.store(journal).add(
                ownerSchema.parse({
                  id: prefix + scope,
                  scope,
                  version: 1,
                  state: "copied",
                  digest,
                  entries: saved.entries.length,
                  channels: saved.channels.length,
                }),
              );
              io.done(undefined);
            });
          });
        });
      });
      // A readback catches copy/publication failures before touching the source.
      const copied = await tx(
        db,
        [...stores, journal],
        "readonly",
        check,
        (io) => {
          io.request(io.store(journal).get(globalId), (finished) => {
            if (finished !== undefined) {
              globalSchema.parse(finished);
              io.done(true);
              return;
            }
            readOwner(io, scope, (current) => {
              if (!same(saved, current))
                throw new BrowserOutboxError("CONFLICT");
              io.done(false);
            });
          });
        },
      );
      if (copied) break; // An earlier complete migration already cleaned the source.
      await tx(source, stores, "readwrite", check, (io) =>
        readOwner(io, scope, (current) => {
          if (current.meta === null) {
            io.done(undefined);
            return;
          }
          if (!same(saved, current)) throw new BrowserOutboxError("CONFLICT");
          for (const e of saved.entries) io.store("entries").delete(e.id);
          for (const c of saved.channels)
            io.store("channels").delete([scope, c.channel]);
          io.store("meta").delete(scope);
          io.done(undefined);
        }),
      );
      await tx(db, [journal], "readwrite", check, (io) =>
        io.request(io.store(journal).get(prefix + scope), (raw) => {
          const marker = ownerSchema.parse(raw);
          if (marker.digest !== digest)
            throw new BrowserOutboxError("CONFLICT");
          marker.state = "cleaned";
          io.store(journal).put(marker);
          io.done(undefined);
        }),
      );
    }
    await tx(source, stores, "readonly", check, (io) => {
      io.request(io.store("meta").count(), (m) =>
        io.request(io.store("entries").count(), (e) =>
          io.request(io.store("channels").count(), (c) => {
            if (m || e || c)
              throw new BrowserOutboxError("STORAGE_UNAVAILABLE");
            io.done(undefined);
          }),
        ),
      );
    });
    // A restart may find no legacy owner after source cleanup committed. Validate
    // every journaled destination digest, not just row counts, before unlocking.
    // Crypto stays outside IDB transactions; final publication rechecks each exact
    // snapshot so no change between hashing and the write can be accepted.
    const verified = await tx<
      | {
          marker: z.infer<typeof ownerSchema>;
          saved: Snapshot;
        }[]
      | null
    >(db, [...stores, journal], "readonly", check, (io) => {
      io.request(io.store(journal).get(globalId), (finished) => {
        if (finished !== undefined) {
          globalSchema.parse(finished);
          io.done(null);
          return;
        }
        io.request(io.store(journal).getAll(undefined, 34), (rows) => {
          if (rows.length > 32) throw new BrowserOutboxError("CAPACITY");
          const markers = rows.map((v) => ownerSchema.parse(v));
          const result: {
            marker: z.infer<typeof ownerSchema>;
            saved: Snapshot;
          }[] = [];
          const next = (i: number) => {
            if (i === markers.length) {
              io.done(result);
              return;
            }
            const marker = markers[i]!;
            readOwner(io, marker.scope, (saved) => {
              if (
                !saved.meta ||
                saved.entries.length !== marker.entries ||
                saved.channels.length !== marker.channels
              )
                throw new BrowserOutboxError("STORAGE_UNAVAILABLE");
              result.push({ marker, saved });
              next(i + 1);
            });
          };
          next(0);
        });
      });
    });
    if (verified !== null) {
      for (const { marker, saved } of verified) {
        if ((await browserPrivateDigest(saved)) !== marker.digest)
          throw new BrowserOutboxError("CONFLICT");
        check();
      }
      await tx(db, [...stores, journal], "readwrite", check, (io) => {
        io.request(io.store(journal).get(globalId), (raw) => {
          if (raw !== undefined) {
            globalSchema.parse(raw);
            io.done(undefined);
            return;
          }
          io.request(io.store(journal).getAll(undefined, 34), (rows) => {
            if (rows.length !== verified.length)
              throw new BrowserOutboxError("CONFLICT");
            const markers = rows.map((v) => ownerSchema.parse(v));
            const next = (i: number) => {
              if (i < verified.length) {
                const { marker, saved } = verified[i]!;
                if (
                  !same(
                    { ...markers[i], state: "cleaned" },
                    { ...marker, state: "cleaned" },
                  )
                )
                  throw new BrowserOutboxError("CONFLICT");
                readOwner(io, marker.scope, (current) => {
                  if (!same(saved, current))
                    throw new BrowserOutboxError("CONFLICT");
                  next(i + 1);
                });
                return;
              }
              io.request(io.store("meta").count(), (m) =>
                io.request(io.store("entries").count(), (e) =>
                  io.request(io.store("channels").count(), (c) => {
                    if (
                      m !== markers.length ||
                      e !== markers.reduce((n, v) => n + v.entries, 0) ||
                      c !== markers.reduce((n, v) => n + v.channels, 0)
                    )
                      throw new BrowserOutboxError("STORAGE_UNAVAILABLE");
                    for (const marker of markers)
                      io.store(journal).put({ ...marker, state: "cleaned" });
                    io.store(journal).add(
                      globalSchema.parse({
                        id: globalId,
                        version: 1,
                        complete: true,
                      }),
                    );
                    io.done(undefined);
                  }),
                ),
              );
            };
            next(0);
          });
        });
      });
    }
    check();
    source.close();
    source = undefined;
    return db;
  } catch (e) {
    close();
    throw e instanceof BrowserOutboxError
      ? e
      : new BrowserOutboxError("STORAGE_UNAVAILABLE");
  }
}

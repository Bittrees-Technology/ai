import Database from "better-sqlite3";
import { z } from "zod";
import type { Vault } from "../storage/vault.js";
import {
  initialPairingJournalApplicationId,
  prepareInitialPairingJournalPath,
} from "../workflows/chat-journal-path.js";
import {
  encryptedInitialPairingStore,
  initialPairingJournalSchema,
} from "./initial-pairing-store.js";

/** Inactive native-only assembly. The caller supplies an already unlocked Vault
 * and an operator-selected private path. No launcher, browser or MCP registration.
 * Reuses the owned-path guard's documented same-UID trust assumption. */
export function openNativeInitialPairingJournal(
  path: string,
  vault: Vault,
  identity: { principal: string; keyFingerprint: string },
) {
  z.strictObject({
    principal: z
      .string()
      .refine(
        (v) => v.startsWith("agent:") && z.uuid().safeParse(v.slice(6)).success,
      ),
    keyFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  }).parse(identity);
  const guard = prepareInitialPairingJournalPath(path);
  let db: Database.Database | undefined;
  try {
    db = new Database(path, { fileMustExist: true });
    guard.assertUnchanged();
    db.pragma("synchronous = FULL");
    if (guard.created) {
      // Commit the dedicated identity and schema before WAL. Never initialize,
      // repair or chmod a preexisting foreign/empty database.
      db.transaction(() => {
        db!.exec(initialPairingJournalSchema);
        db!.pragma(`application_id = ${initialPairingJournalApplicationId}`);
        db!.pragma("user_version = 1");
      }).immediate();
    }
    const schema = db
      .prepare(
        "SELECT type,name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'",
      )
      .all() as { type: string; name: string; sql: string }[];
    if (
      schema.length !== 1 ||
      schema[0]?.type !== "table" ||
      schema[0]?.name !== "native_initial_pairing_journal" ||
      schema[0]?.sql !==
        initialPairingJournalSchema.replace(" IF NOT EXISTS", "")
    )
      throw Error("Foreign native pairing journal schema");
    guard.assertUnchanged();
    const store = encryptedInitialPairingStore(db, vault, identity);
    const connection = db;
    return {
      store,
      close() {
        if (connection.open) connection.close();
      },
    };
  } catch (error) {
    db?.close();
    throw error;
  } finally {
    guard.close();
  }
}

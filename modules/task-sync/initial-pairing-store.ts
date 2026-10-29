import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import type { Vault } from "../storage/vault.js";
import type {
  InitialPairingStore,
  InitialPairingState,
} from "./initial-pairing.js";
// Inactive adapter draft. Caller supplies an owned SQLite connection and already
// explicitly unlocked native vault. No file/Keychain/network/key creation here.
export const initialPairingJournalSchema =
  "CREATE TABLE IF NOT EXISTS native_initial_pairing_journal (binding TEXT PRIMARY KEY, revision INTEGER NOT NULL CHECK(revision > 0), sealed BLOB NOT NULL CHECK(length(sealed) BETWEEN 28 AND 81920))";
export function encryptedInitialPairingStore(
  db: Database.Database,
  vault: Vault,
  identity: { principal: string; keyFingerprint: string },
): InitialPairingStore {
  if (
    !identity ||
    !/^agent:[a-f0-9-]{36}$/.test(identity.principal) ||
    !/^[a-f0-9]{64}$/.test(identity.keyFingerprint)
  )
    throw Error("Invalid pairing journal identity");
  const binding = createHash("sha256")
    .update(
      "native initial pairing journal v1\n" +
        identity.principal +
        "\n" +
        identity.keyFingerprint,
    )
    .digest("hex");
  const purpose = "native-initial-pairing-v1:" + binding;
  db.pragma("busy_timeout = 2000");
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = FULL");
  db.exec(initialPairingJournalSchema);
  let expected: number | null = null;
  function validate(value: unknown): InitialPairingState {
    const candidate = value as InitialPairingState;
    const raw = JSON.stringify(value);
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Buffer.byteLength(raw) > 65536 ||
      !["starting", "pending", "held", "paired"].includes(candidate.phase) ||
      candidate.request?.principal !== identity.principal ||
      candidate.request?.keyFingerprint !== identity.keyFingerprint
    )
      throw Error("Pairing journal state rejected");
    return JSON.parse(raw);
  }
  return {
    async load() {
      const row = db
        .prepare(
          "SELECT revision,sealed FROM native_initial_pairing_journal WHERE binding=?",
        )
        .get(binding) as { revision: number; sealed: Buffer } | undefined;
      if (!row) {
        expected = 0;
        return null;
      }
      if (
        !Number.isSafeInteger(row.revision) ||
        row.revision < 1 ||
        !Buffer.isBuffer(row.sealed) ||
        row.sealed.length > 81920
      )
        throw Error("Pairing journal corrupt");
      const value = validate(vault.open(row.sealed, purpose));
      expected = row.revision;
      return value;
    },
    async save(value) {
      if (expected === null)
        throw Error("Inspect pairing journal before saving");
      const state = validate(value),
        sealed = vault.seal(state, purpose),
        previous = expected,
        next = previous + 1;
      if (
        !Number.isSafeInteger(next) ||
        !Buffer.isBuffer(sealed) ||
        sealed.length < 28 ||
        sealed.length > 81920
      )
        throw Error("Pairing journal state rejected");
      db.transaction(() => {
        if (previous === 0) {
          const r = db
            .prepare(
              "INSERT INTO native_initial_pairing_journal(binding,revision,sealed) VALUES(?,?,?) ON CONFLICT(binding) DO NOTHING",
            )
            .run(binding, next, sealed);
          if (r.changes !== 1)
            throw Error("Pairing journal changed; reconcile before retry");
        } else {
          const r = db
            .prepare(
              "UPDATE native_initial_pairing_journal SET revision=?,sealed=? WHERE binding=? AND revision=?",
            )
            .run(next, sealed, binding, previous);
          if (r.changes !== 1)
            throw Error("Pairing journal changed; reconcile before retry");
        }
      }).immediate();
      expected = next;
    },
  };
}

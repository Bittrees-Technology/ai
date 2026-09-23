import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../../../modules/storage/store.js";
import { Vault } from "../../../modules/storage/vault.js";
import { PrivateKeyLifecycle } from "../../../modules/remote/private-key-lifecycle.js";
import { PrivatePeerChecks } from "../../../modules/remote/private-peer-checks.js";
import { PrivatePeerEnrollment } from "../../../modules/remote/private-peers.js";
import type { PrivateBinding } from "../../../modules/remote/private-peer-contracts.js";
import type { PrivateKeyEntries } from "../../../modules/remote/private-endpoint-keys.js";
class Slot {
  private bytes?: Uint8Array;
  async getSecret() {
    return this.bytes ? Uint8Array.from(this.bytes) : undefined;
  }
  async addSecretIfAbsent(bytes: Uint8Array) {
    if (this.bytes) return false;
    // Buffer.slice() shares memory; the actual provider wipes its owned buffers.
    this.bytes = Uint8Array.from(bytes);
    return true;
  }
  async deleteCredential() {
    const found = !!this.bytes;
    this.bytes?.fill(0);
    this.bytes = undefined;
    return found;
  }
}
/** Actual Mac lifecycle/peer modules with disposable encrypted SQLite and
 * simulated native slots. Never reads the user's Keychain or installed app. */
export async function retainedMac(browser: PrivateBinding, now: number) {
  const dir = mkdtempSync(join(tmpdir(), "bittrees-browser-peer-mac-")),
    vault = new Vault(randomBytes(32));
  const owner = { userId: randomUUID(), tenantId: "synthetic-browser-peer" };
  const store = new Store(join(dir, "tasks.db"), vault, () => now);
  const binding = { ...browser, deviceId: randomUUID() };
  const slots = new Map<string, PrivateKeyEntries>();
  const entries = (id: string) => {
    let value = slots.get(id);
    if (!value) {
      value = { key: new Slot(), attempt: new Slot(), deleted: new Slot() };
      slots.set(id, value);
    }
    return value;
  };
  const keys = new PrivateKeyLifecycle(
    store,
    vault,
    owner,
    () => binding,
    entries,
    () => true,
    () => now,
  );
  const peers = new PrivatePeerEnrollment(
    store,
    vault,
    owner,
    () => binding,
    () => now,
  );
  const activate = async () => {
    const slot = keys.begin({
      expectedRevision: keys.list().revision,
      confirmed: true,
    });
    return keys.provision({
      keyId: slot.keyId,
      expectedRevision: slot.revision,
      confirmed: true,
    });
  };
  try {
    await activate();
  } catch (e) {
    store.close();
    rmSync(dir, { recursive: true, force: true });
    throw e;
  }
  return {
    binding,
    keys,
    peers,
    checks: new PrivatePeerChecks(
      store,
      vault,
      owner,
      () => binding,
      keys,
      peers,
      () => now,
    ),
    activate,
    invitation: (recipientId = browser.deviceId) =>
      keys.invitation({ recipientId, confirmed: true }),
    close() {
      keys.invalidate();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

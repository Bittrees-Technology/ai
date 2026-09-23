import {
  PrivatePeerChecks,
  peerCheckSummary,
  PrivatePeerCheckError,
} from "../../modules/remote/private-peer-checks.js";
import { PrivatePeerEnrollment } from "../../modules/remote/private-peers.js";
import type { PrivateKeyLifecycle } from "../../modules/remote/private-key-lifecycle.js";
import type { PrivateBinding } from "../../modules/remote/private-peer-contracts.js";
import type { RemoteClient } from "../../modules/remote/client.js";
import type { Store, Owner } from "../../modules/storage/store.js";
import type { Vault } from "../../modules/storage/vault.js";
/** Parent owns key/peer/permission/deletion exclusion and identity invalidation. */
export class CompanionPeerChecks {
  constructor(
    private store: Store,
    private vault: Vault,
    private owner: Owner,
    private keys: (
      current?: () => PrivateBinding | null,
    ) => PrivateKeyLifecycle,
    private remote?: RemoteClient,
    private enabled = false,
    private now = Date.now,
  ) {
    this.owner = { ...owner };
  }
  private checks(current: () => PrivateBinding | null = () => null) {
    return new PrivatePeerChecks(
      this.store,
      this.vault,
      this.owner,
      current,
      this.keys(current),
      new PrivatePeerEnrollment(
        this.store,
        this.vault,
        this.owner,
        current,
        this.now,
      ),
      this.now,
    );
  }
  status() {
    return {
      available: true,
      enabled: this.enabled && !!this.remote,
      checks: this.checks().list().map(peerCheckSummary),
    };
  }
  private async live<T>(action: (checks: PrivatePeerChecks) => T | Promise<T>) {
    if (!this.enabled || !this.remote)
      throw new PrivatePeerCheckError("DENIED");
    return this.remote.withVerifiedDevice(async (scope) =>
      action(this.checks(scope.current)),
    );
  }
  begin(raw: unknown) {
    return this.live((c) => c.begin(raw));
  }
  respond(raw: unknown) {
    return this.live((c) => c.respond(raw));
  }
  complete(raw: unknown) {
    return this.live((c) => c.complete(raw));
  }
  resume(raw: unknown) {
    return this.live((c) => c.resume(raw));
  }
  envelope(raw: unknown) {
    return this.live((c) => c.delivery(raw));
  }
  stop(raw: unknown) {
    return this.checks().stop(raw);
  }
}

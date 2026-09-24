import { z } from "zod";
import { privateBindingSchema } from "./private-peer-contracts.js";
import {
  BrowserRelayPermissionsClient,
  PrivateRelayClient,
} from "./private-relay-client.js";
import type { PrivateRelayIdentity } from "./private-relay-contracts.js";
const scopeSchema = z
  .strictObject({
    ownerId: z.uuid(),
    scope: z.string().min(1).max(1024),
    binding: privateBindingSchema,
  })
  .refine((v) => v.ownerId === v.binding.ownerId);
type Scope = z.infer<typeof scopeSchema>;
/** Internal host bridge. The binding must come from an active verified device
 * scope, never from persisted metadata or a caller-supplied page selection. */
export class BrowserRelayTransport {
  private generation = 0;
  private busy = false;
  private permissions?: BrowserRelayPermissionsClient;
  private active?: PrivateRelayClient;
  constructor(
    private current: () => Scope | null,
    private transport: typeof fetch = (...args) => globalThis.fetch(...args),
    private now = Date.now,
    private monotonic = () => performance.now(),
  ) {}
  invalidate() {
    this.generation++;
    this.permissions?.invalidate();
    this.active?.invalidate();
  }
  async withClient<T>(
    action: (
      client: PrivateRelayClient,
      identity: PrivateRelayIdentity,
    ) => Promise<T>,
  ): Promise<T> {
    if (this.busy) throw Error("BUSY");
    this.busy = true;
    const generation = ++this.generation,
      wall = this.now(),
      mono = this.monotonic();
    let open = true;
    try {
      const initial = scopeSchema.parse(this.current()),
        snapshot = JSON.stringify(initial);
      const valid = () => {
        try {
          const current = scopeSchema.parse(this.current()),
            time = this.now(),
            elapsed = this.monotonic() - mono;
          return (
            open &&
            generation === this.generation &&
            JSON.stringify(current) === snapshot &&
            Number.isSafeInteger(wall) &&
            wall > 0 &&
            Number.isSafeInteger(time) &&
            time >= wall &&
            time < Math.min(wall + 30000, initial.binding.expiresAt) &&
            Number.isFinite(elapsed) &&
            elapsed >= 0 &&
            elapsed < 30000
          );
        } catch {
          return false;
        }
      };
      const check = () => {
        if (!valid()) throw Error("DENIED");
      };
      check();
      const permissions = (this.permissions = new BrowserRelayPermissionsClient(
        () =>
          valid() ? { ownerId: initial.ownerId, scope: initial.scope } : null,
        this.transport,
        this.now,
        this.monotonic,
      ));
      const grant = await permissions.inspectBrowser(initial.binding);
      check();
      if (!grant || grant.expiresAt <= this.now()) throw Error("DENIED");
      const identity: PrivateRelayIdentity = {
        version: 1,
        scope: "private:relay",
        ownerId: initial.ownerId,
        endpointId: initial.binding.deviceId,
        endpointKind: "browser",
        credentialEpoch: initial.binding.credentialEpoch,
        permissionId: grant.id,
        expiresAt: Math.min(grant.expiresAt, initial.binding.expiresAt),
      };
      const client = (this.active = new PrivateRelayClient(
        () =>
          valid() && identity.expiresAt > this.now()
            ? {
                kind: "browser",
                scope: initial.scope,
                identity: { ...identity },
              }
            : null,
        this.transport,
        this.now,
        this.monotonic,
      ));
      const value = await action(client, structuredClone(identity));
      check();
      if (identity.expiresAt <= this.now()) throw Error("DENIED");
      return value;
    } finally {
      open = false;
      this.permissions?.invalidate();
      this.active?.invalidate();
      this.permissions = undefined;
      this.active = undefined;
      this.busy = false;
    }
  }
}

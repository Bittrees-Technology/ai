import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  PrivateKeyLifecycle,
  PrivateKeyLifecycleError,
} from "../../modules/remote/private-key-lifecycle.js";
import type { PrivateKeyEntries } from "../../modules/remote/private-endpoint-keys.js";
import type { PrivateBinding } from "../../modules/remote/private-peer-contracts.js";
import type { RemoteClient } from "../../modules/remote/client.js";
import type { Store, Owner } from "../../modules/storage/store.js";
import type { Vault } from "../../modules/storage/vault.js";
const request = z.strictObject({
  action: z.enum([
    "create",
    "replace",
    "resume",
    "remove",
    "revoke",
    "cleanup",
  ]),
  expectedRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  keyId: z.uuid().optional(),
});
type Review = z.infer<typeof request> & {
  id: string;
  createdAt: number;
  expiresAt: number;
  binding: PrivateBinding | null;
};
/** Trusted local owner only. Review never creates keys; confirmation rechecks the
 * exact revision and verified registration. No content transport or peer grants.
 */
export class CompanionPrivateKeys {
  private review?: Review;
  private running = false;
  constructor(
    private store: Store,
    private vault: Vault,
    private owner: Owner,
    private entries: (id: string) => PrivateKeyEntries,
    private remote?: RemoteClient,
    private setupEnabled = false,
    private now = Date.now,
  ) {
    this.owner = { ...owner };
  }
  get busy() {
    return this.running;
  }
  private keys(current: () => PrivateBinding | null = () => null) {
    return new PrivateKeyLifecycle(
      this.store,
      this.vault,
      this.owner,
      current,
      this.entries,
      undefined,
      this.now,
    );
  }
  status() {
    return {
      available: true,
      canSetup: this.setupEnabled && !!this.remote,
      state: this.keys().list(),
    };
  }
  invalidate() {
    this.review = undefined;
    this.remote?.invalidatePrivateIdentity();
  }
  private async exclusive<T>(fn: () => Promise<T>) {
    if (this.running) throw new PrivateKeyLifecycleError("BUSY");
    this.running = true;
    try {
      return await fn();
    } finally {
      this.running = false;
    }
  }
  private validate(input: z.infer<typeof request>) {
    const state = this.keys().list();
    if (state.revision !== input.expectedRevision)
      throw new PrivateKeyLifecycleError("CONFLICT");
    const slot = state.slots.find((v) => v.id === input.keyId);
    const selected = state.slots.find(
      (v) => v.state === "active" || v.state === "preparing",
    );
    const requiresKey = ["resume", "remove", "revoke"].includes(input.action);
    if (requiresKey !== !!input.keyId)
      throw new PrivateKeyLifecycleError("DENIED");
    if (
      (input.action === "create" && selected) ||
      (input.action === "replace" && !selected) ||
      (input.action === "resume" && slot?.state !== "preparing") ||
      (input.action === "remove" && (!slot || slot.state === "deleted")) ||
      (input.action === "revoke" &&
        (!slot || !["preparing", "active"].includes(slot.state))) ||
      (input.action === "cleanup" && !state.pendingKeyDeletionCount)
    )
      throw new PrivateKeyLifecycleError("DENIED");
    if (
      ["create", "replace", "resume"].includes(input.action) &&
      state.needsFreshPairing
    )
      throw new PrivateKeyLifecycleError("REPAIR_REQUIRED");
  }
  async prepare(raw: unknown) {
    return this.exclusive(async () => {
      this.review = undefined;
      const parsed = request.safeParse(raw);
      if (!parsed.success) throw new PrivateKeyLifecycleError("DENIED");
      const input = parsed.data;
      this.validate(input);
      const save = (binding: PrivateBinding | null) => {
        this.validate(input);
        this.review = {
          ...input,
          id: randomUUID(),
          createdAt: this.now(),
          expiresAt: Math.min(
            this.now() + 300000,
            binding?.expiresAt ?? Infinity,
          ),
          binding,
        };
        return structuredClone(this.review);
      };
      if (["create", "replace", "resume"].includes(input.action)) {
        if (!this.setupEnabled || !this.remote)
          throw new PrivateKeyLifecycleError("DENIED");
        return this.remote
          .withVerifiedDevice(async (scope) => {
            const binding = scope.current();
            if (!binding) throw new PrivateKeyLifecycleError("DENIED");
            return save(binding);
          })
          .catch((error) => {
            this.review = undefined;
            throw error;
          });
      }
      return save(null);
    });
  }
  async confirm(raw: unknown) {
    return this.exclusive(async () => {
      const input = z
        .strictObject({
          reviewId: z.uuid(),
          confirmed: z.literal(true),
          acknowledged: z.literal(true),
        })
        .safeParse(raw);
      const review = this.review;
      this.review = undefined;
      if (
        !input.success ||
        !review ||
        input.data.reviewId !== review.id ||
        review.expiresAt <= this.now() ||
        review.createdAt > this.now()
      )
        throw new PrivateKeyLifecycleError("DENIED");
      this.validate(review);
      const local = this.keys();
      const target = {
        keyId: review.keyId,
        expectedRevision: review.expectedRevision,
        confirmed: true,
      };
      if (review.action === "remove") await local.remove(target);
      else if (review.action === "revoke") local.revoke(target);
      else if (review.action === "cleanup")
        await local.cleanupPending({
          expectedRevision: review.expectedRevision,
          confirmed: true,
        });
      else {
        if (!this.setupEnabled || !this.remote)
          throw new PrivateKeyLifecycleError("DENIED");
        await this.remote.withVerifiedDevice(async (scope) => {
          if (
            JSON.stringify(scope.current()) !==
              JSON.stringify(review.binding) ||
            review.expiresAt <= this.now()
          )
            throw new PrivateKeyLifecycleError("DENIED");
          this.validate(review);
          const keys = this.keys(scope.current);
          const reserved =
            review.action === "resume"
              ? { keyId: review.keyId!, revision: review.expectedRevision }
              : keys.begin({
                  expectedRevision: review.expectedRevision,
                  confirmed: true,
                });
          await keys.provision({
            keyId: reserved.keyId,
            expectedRevision: reserved.revision,
            confirmed: true,
          });
        });
      }
      return this.status();
    });
  }
  async clearAll() {
    return this.exclusive(async () => {
      this.invalidate();
      await this.keys().clearAll({ confirmed: true });
    });
  }
}

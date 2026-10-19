import type { EnrollmentClient } from "../../modules/task-sync/enrollment-client.js";
import {
  workflowProgressSchema,
  type WorkflowProgress,
} from "../../modules/research/workflow-progress.js";
import { readFile, writeFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { hostname } from "node:os";
import { Vault } from "../../modules/storage/vault.js";
import {
  loadStorageKey,
  macKeychainEntry,
} from "../../modules/storage/keychain.js";
import { z } from "zod";
export function localWorkflows(
  directory: string,
  vault: Vault,
  models: () => string[],
  templates: () =>
    | {
        id: string;
        revision: number;
        definition: { kind: string };
        state?: string;
        progress?: WorkflowProgress;
      }[]
    | Promise<
        {
          id: string;
          revision: number;
          definition: { kind: string };
          state?: string;
          progress?: WorkflowProgress;
        }[]
      > = () => [],
  enrollmentTransport?: Pick<EnrollmentClient, "execute">,
) {
  const deviceFile = join(directory, "workflow-device.enc");
  let coordinatorVault: Promise<Vault> | undefined;
  async function settings() {
    const existing = join(directory, "marketplace/connection.enc");
    if (
      await stat(existing).then(
        () => true,
        () => false,
      )
    ) {
      coordinatorVault ??= loadStorageKey(
        macKeychainEntry("marketplace-coordinator"),
        true,
      )
        .then((key) => new Vault(key))
        .catch((error) => {
          coordinatorVault = undefined;
          throw error;
        });
      const c = (await coordinatorVault).open<any>(
        await readFile(existing),
        "marketplace-connection",
      );
      return { controlToken: c.controlToken, existing: true };
    }
    try {
      return vault.open<any>(await readFile(deviceFile), "workflow-device");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
  }
  async function call(action: string, input: unknown, controlToken?: string) {
    const r = await fetch("https://ai.bittrees.org/api/workflows", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(controlToken ? { authorization: "Bearer " + controlToken } : {}),
      },
      body: JSON.stringify({ action, input }),
      signal: AbortSignal.timeout(15000),
      redirect: "error",
    });
    if (!r.ok) throw Error("WORKFLOW_UNAVAILABLE");
    return r.json();
  }
  let syncing: Promise<unknown> | undefined;
  let catalogue: { status: string; checkedAt?: string; lastSyncedAt?: string } =
    { status: "pending" };
  async function sync() {
    if (syncing) return syncing;
    syncing = (async () => {
      const s = await settings();
      if (!s) return { synced: false, reason: "NOT_CONNECTED" };
      const result = await call(
        "device",
        {
          action: "catalogue",
          observedAt: Date.now(),
          entries: (await templates()).map((t) => ({
            id: t.id,
            revision: t.revision,
            kind: t.definition.kind,
            ...(t.state ? { state: t.state } : {}),
            ...(t.progress
              ? { progress: workflowProgressSchema.parse(t.progress) }
              : {}),
          })),
        },
        s.controlToken,
      );
      catalogue = {
        ...catalogue,
        ...(result.synced ? { lastSyncedAt: new Date().toISOString() } : {}),
        status: result.synced ? "synced" : result.reason,
        checkedAt: new Date().toISOString(),
      };
      return result;
    })()
      .catch((error) => {
        catalogue = {
          ...catalogue,
          status: "unavailable",
          checkedAt: new Date().toISOString(),
        };
        throw error;
      })
      .finally(() => {
        syncing = undefined;
      });
    return syncing;
  }
  return {
    sync,
    async attestRuntime(
      purpose: "enroll" | "activate" | "decision",
      request: unknown,
      signature: string,
    ) {
      if (enrollmentTransport && purpose === "enroll")
        return enrollmentTransport.execute(
          { operation: "attest", request, signature },
          AbortSignal.timeout(15000),
        );
      const s = await settings();
      if (!s) throw Error("Connect this Mac first");
      return call(
        "runtime-attestation",
        { purpose, request, signature },
        s.controlToken,
      );
    },
    async status() {
      if (enrollmentTransport) {
        const result = await enrollmentTransport.execute(
          { operation: "heartbeat" },
          AbortSignal.timeout(15000),
        );
        return {
          ...z.record(z.string(), z.unknown()).parse(result),
          connected: true,
          catalogue,
          models: models(),
        };
      }
      const s = await settings();
      if (!s)
        return { connected: false, models: models(), deviceLabel: hostname() };
      const result = await call(
        "device",
        { action: "heartbeat" },
        s.controlToken,
      );
      return {
        connected: true,
        catalogue,
        ...result,
        models: models(),
        ...(s.pairCode
          ? { pairCode: s.pairCode, pairExpiresAt: s.expiresAt }
          : {}),
      };
    },
    async register(raw: unknown) {
      const v = z
        .strictObject({ model: z.string().min(1).max(120) })
        .parse(raw);
      const previous = await settings();
      if (previous) {
        const { grant } = await call(
          "device",
          { action: "status" },
          previous.controlToken,
        );
        if (grant.wallet_address || previous.existing)
          throw Error("WORKFLOW_ALREADY_CONNECTED");
        await call("device", { action: "revoke" }, previous.controlToken);
      }
      if (
        v.model !== "Rule-based supplier validation (no model)" &&
        !models().includes(v.model)
      )
        throw Error("MODEL_UNAVAILABLE");
      const result = await call("register-device", {
        deviceLabel: hostname().slice(0, 80),
        modelLabel: v.model,
      });
      await writeFile(deviceFile, vault.seal(result, "workflow-device"), {
        mode: 0o600,
      });
      return { pairCode: result.pairCode, expiresAt: result.expiresAt };
    },
    async control(raw: unknown) {
      const v = z
        .strictObject({ action: z.enum(["pause", "revoke"]) })
        .parse(raw);
      const s = await settings();
      if (!s) throw Error("WORKFLOW_UNAVAILABLE");
      return call("device", v, s.controlToken);
    },
  };
}

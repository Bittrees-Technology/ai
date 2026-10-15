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
) {
  const deviceFile = join(directory, "workflow-device.enc");
  async function settings() {
    const existing = join(directory, "marketplace/connection.enc");
    if (
      await stat(existing).then(
        () => true,
        () => false,
      )
    ) {
      const key = await loadStorageKey(
        macKeychainEntry("marketplace-coordinator"),
        true,
      );
      const c = new Vault(key).open<any>(
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
  return {
    async status() {
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

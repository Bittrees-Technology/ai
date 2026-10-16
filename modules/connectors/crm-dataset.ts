import { randomUUID } from "node:crypto";
import { AsyncEntry } from "@napi-rs/keyring";
import { z } from "zod";
import { ConnectorError, type ConnectorSecret } from "./crm.js";

const endpoint = "https://crm.bittrees.org/api/integrations/datasets/mcp";
const savedSchema = z.strictObject({
  owner: z.string(),
  token: z.string().regex(/^[a-f0-9]{64}$/),
  datasetId: z.uuid(),
  name: z.string().max(200),
});
const snapshotSchema = z
  .object({
    id: z.uuid(),
    name: z.string().max(200),
    version: z.number().int().positive(),
    revision: z.string().regex(/^[a-f0-9]{64}$/),
    entries: z
      .array(
        z
          .object({
            id: z.uuid(),
            kind: z.enum(["people", "organizations", "projects"]),
            name: z.string(),
          })
          .passthrough(),
      )
      .max(600),
    crm: z.array(z.unknown()).max(600),
    links: z.array(z.unknown()).max(600),
  })
  .passthrough();
export const datasetSaveSchema = z.strictObject({
  version: z.number().int().positive(),
  name: z.string().trim().min(1).max(200),
  entries: z.array(z.record(z.string(), z.unknown())).max(600),
});
export function datasetKeychainEntry(profile: string): ConnectorSecret {
  if (process.platform !== "darwin" || !/^[A-Za-z0-9_-]{1,80}$/.test(profile))
    throw new Error("Invalid dataset profile");
  return new AsyncEntry("org.bittrees.ai.connector.crm-dataset", profile);
}
/** A single dataset and fixed source URL; project authority is checked by CRM for every operation. */
export class CrmDatasetConnector {
  private busy = false;
  constructor(
    private owner: string,
    private secret: ConnectorSecret,
    private request: typeof fetch = fetch,
  ) {}
  private async exclusive<T>(fn: () => Promise<T>): Promise<T> {
    if (this.busy) throw new ConnectorError("CONNECTION_BUSY");
    this.busy = true;
    try {
      return await fn();
    } finally {
      this.busy = false;
    }
  }
  private async saved() {
    const bytes = await this.secret.getSecret();
    if (!bytes) throw new ConnectorError("CONNECTION_REQUIRED");
    const parsed = savedSchema.safeParse(
      JSON.parse(Buffer.from(bytes).toString()),
    );
    if (!parsed.success || parsed.data.owner !== this.owner)
      throw new ConnectorError("INVALID_CONNECTION");
    return parsed.data;
  }
  private async call(token: string, name: string, args: unknown) {
    const id = randomUUID();
    let response: Response;
    try {
      response = await this.request(endpoint, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(15000),
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "MCP-Protocol-Version": "2025-11-25",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id,
          method: "tools/call",
          params: { name, arguments: args },
        }),
      });
    } catch {
      throw new ConnectorError("SOURCE_UNAVAILABLE");
    }
    if (response.status === 401 || response.status === 403)
      throw new ConnectorError("SOURCE_DENIED");
    if (!response.ok || !response.body)
      throw new ConnectorError("SOURCE_UNAVAILABLE");
    const reader = response.body.getReader();
    let bytes = 0;
    const chunks: Uint8Array[] = [];
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        bytes += next.value.length;
        if (bytes > 4_000_000) {
          await reader.cancel();
          throw new Error("large");
        }
        chunks.push(next.value);
      }
    } catch {
      throw new ConnectorError("INVALID_SOURCE");
    }
    try {
      const rpc = JSON.parse(Buffer.concat(chunks).toString());
      if (
        rpc.id !== id ||
        rpc.jsonrpc !== "2.0" ||
        rpc.error ||
        rpc.result?.isError
      )
        throw new Error("source error");
      if (
        rpc.result?.content?.length !== 1 ||
        rpc.result.content[0].type !== "text"
      )
        throw new Error("invalid");
      return JSON.parse(rpc.result.content[0].text);
    } catch {
      throw new ConnectorError("SOURCE_CONFLICT");
    }
  }
  async project(name: string, args: unknown, expectedDatasetId: string) {
    if (
      ![
        "projects.list",
        "project.read",
        "tasks.create",
        "tasks.claim",
        "tasks.finish",
      ].includes(name)
    )
      throw new ConnectorError("SOURCE_DENIED");
    return this.exclusive(async () => {
      const saved = await this.saved();
      if (saved.datasetId !== expectedDatasetId)
        throw new ConnectorError("SOURCE_DENIED");
      return this.call(saved.token, name, args);
    });
  }
  async status() {
    try {
      const s = await this.saved();
      return { datasetId: s.datasetId, name: s.name };
    } catch (e) {
      if (e instanceof ConnectorError && e.code === "CONNECTION_REQUIRED")
        return null;
      throw e;
    }
  }
  async connect(raw: unknown) {
    return this.exclusive(async () => {
      const { token } = z
        .strictObject({ token: z.string().regex(/^[a-f0-9]{64}$/) })
        .parse(raw);
      const snapshot = snapshotSchema.parse(
        await this.call(token, "dataset.read", {}),
      );
      await this.secret.setSecret(
        Buffer.from(
          JSON.stringify({
            owner: this.owner,
            token,
            datasetId: snapshot.id,
            name: snapshot.name,
          }),
        ),
      );
      return { datasetId: snapshot.id, name: snapshot.name };
    });
  }
  async schema() {
    return this.exclusive(async () =>
      this.call((await this.saved()).token, "dataset.schema", {}),
    );
  }
  async read(raw: unknown = {}) {
    return this.exclusive(async () => {
      const args = z
        .strictObject({
          revision: z
            .string()
            .regex(/^[a-f0-9]{64}$/)
            .optional(),
        })
        .parse(raw);
      const s = await this.saved(),
        result = await this.call(s.token, "dataset.read", args);
      if (result.unchanged === true)
        return z
          .strictObject({
            unchanged: z.literal(true),
            revision: z.string().regex(/^[a-f0-9]{64}$/),
          })
          .parse(result);
      const snapshot = snapshotSchema.parse(result);
      if (snapshot.id !== s.datasetId)
        throw new ConnectorError("INVALID_SOURCE");
      return snapshot;
    });
  }
  async save(raw: unknown) {
    return this.exclusive(async () => {
      const args = datasetSaveSchema.parse(raw),
        s = await this.saved();
      // Never retry automatically: the caller retains the exact payload on uncertainty.
      const result = z
        .object({ id: z.uuid(), version: z.number().int().positive() })
        .parse(await this.call(s.token, "dataset.save", args));
      if (result.id !== s.datasetId) throw new ConnectorError("INVALID_SOURCE");
      return result;
    });
  }
  async append(raw: unknown, expectedDatasetId: string) {
    return this.exclusive(async () => {
      const args = z
        .strictObject({
          version: z.number().int().positive(),
          entries: z.array(z.record(z.string(), z.unknown())).min(1).max(20),
        })
        .parse(raw);
      const s = await this.saved();
      if (s.datasetId !== expectedDatasetId)
        throw new ConnectorError("INVALID_CONNECTION");
      const result = z
        .object({
          id: z.uuid(),
          version: z.number().int().positive(),
          added: z.number().int().nonnegative(),
        })
        .parse(await this.call(s.token, "dataset.append", args));
      if (result.id !== s.datasetId) throw new ConnectorError("INVALID_SOURCE");
      return result;
    });
  }
  async forget() {
    return this.exclusive(async () => {
      await this.secret.deleteCredential();
      return { removed: true };
    });
  }
}

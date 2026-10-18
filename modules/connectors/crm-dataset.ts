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
    entries: z.array(
      z
        .object({
          id: z.uuid(),
          kind: z.enum(["people", "organizations", "projects"]),
          name: z.string(),
        })
        .passthrough(),
    ),
    crm: z.array(z.unknown()),
    links: z.array(z.unknown()),
  })
  .passthrough();
export const datasetSaveSchema = z.strictObject({
  version: z.number().int().positive(),
  name: z.string().trim().min(1).max(200),
  entries: z.array(z.record(z.string(), z.unknown())),
});
export const datasetPatchSchema = z.strictObject({
  version: z.number().int().positive(),
  name: z.string().trim().min(1).max(200),
  changes: z.array(z.record(z.string(), z.unknown())),
  removeIds: z.array(z.uuid()).default([]),
  entryOrder: z.array(z.uuid()).optional(),
});
export function datasetKeychainEntry(profile: string): ConnectorSecret {
  if (process.platform !== "darwin" || !/^[A-Za-z0-9_-]{1,80}$/.test(profile))
    throw new Error("Invalid dataset profile");
  return new AsyncEntry("org.bittrees.ai.connector.crm-dataset", profile);
}
/** A single dataset and fixed source URL; project authority is checked by CRM for every operation. */
export class CrmDatasetConnector {
  private tail: Promise<void> = Promise.resolve();
  private pending = 0;
  private generation = 0;
  private cooldown = { read: 0, write: 0 };
  constructor(
    private owner: string,
    private secret: ConnectorSecret,
    private request: typeof fetch = fetch,
  ) {}
  private async exclusive<T>(fn: () => Promise<T>): Promise<T> {
    // Queue individual source requests, not whole model runs. A failed request
    // releases the queue; writes are never retried by this layer.
    if (this.pending >= 32) throw new ConnectorError("CONNECTION_BUSY");
    const generation = this.generation;
    this.pending++;
    const result = this.tail.then(async () => {
      if (generation !== this.generation)
        throw new ConnectorError("INVALID_CONNECTION");
      return fn();
    });
    this.tail = result.then(
      () => {},
      () => {},
    );
    try {
      return await result;
    } finally {
      this.pending--;
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
    const lane = [
      "dataset.schema",
      "dataset.read",
      "qualification.context",
      "projects.list",
      "project.read",
      "tasks.list",
    ].includes(name)
      ? "read"
      : "write";
    if (Date.now() < this.cooldown[lane])
      throw new ConnectorError("SOURCE_RATE_LIMITED");
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
    if (response.status === 429) {
      // CRM has separate read/write budgets. Do not hammer either exhausted
      // lane or retry an uncertain mutation automatically.
      const retry = response.headers.get("retry-after");
      const seconds = retry === null ? NaN : Number(retry);
      const delay =
        Number.isFinite(seconds) && seconds > 0
          ? Math.min(seconds, 600) * 1000
          : 600_000;
      this.cooldown[lane] = Date.now() + delay;
      throw new ConnectorError("SOURCE_RATE_LIMITED");
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
        "qualification.context",
        "qualification.sync",
        "qualification.enrich",
        "projects.list",
        "project.read",
        "tasks.create",
        "tasks.list",
        "tasks.update",
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
  private async loadSnapshot(
    token: string,
    args: { revision?: string } = {},
    expectedId?: string,
  ): Promise<any> {
    let result: any;
    try {
      result = await this.call(token, "dataset.read", {
        ...args,
        pageSize: 100,
      });
    } catch (e) {
      // Older CRM servers reject the new read arguments. Read-only fallback;
      // never fall back or retry a mutation.
      if (!(e instanceof ConnectorError) || e.code !== "SOURCE_CONFLICT")
        throw e;
      result = await this.call(token, "dataset.read", args);
    }
    if (result.unchanged === true)
      return z
        .strictObject({
          unchanged: z.literal(true),
          revision: z.string().regex(/^[a-f0-9]{64}$/),
        })
        .parse(result);
    const first = snapshotSchema.parse(result);
    if (expectedId && first.id !== expectedId)
      throw new ConnectorError("INVALID_SOURCE");
    if (!first.pagination) return first;
    const pageInfo = z.strictObject({
      offset: z.number().int().nonnegative(),
      totalEntries: z.number().int().nonnegative(),
      nextOffset: z.number().int().nonnegative().nullable(),
    });
    let info = pageInfo.parse(first.pagination);
    if (info.offset !== 0) throw new ConnectorError("INVALID_SOURCE");
    const total = info.totalEntries,
      entries = [...first.entries],
      crm = new Map((first.crm as any[]).map((r) => [r.id, r])),
      links = new Map((first.links as any[]).map((r) => [r.entryId, r]));
    const submissions = new Map<string, any>(
      ((first.submissions as any[]) || []).map((r) => [
        r.operationId,
        { ...r, mappings: [...r.mappings] },
      ]),
    );
    while (info.nextOffset !== null) {
      if (info.nextOffset !== entries.length)
        throw new ConnectorError("INVALID_SOURCE");
      const page = snapshotSchema.parse(
        await this.call(token, "dataset.read", {
          pageSize: 100,
          offset: info.nextOffset,
          pageRevision: first.revision,
        }),
      );
      const next = pageInfo.parse(page.pagination);
      if (
        page.id !== first.id ||
        page.version !== first.version ||
        page.revision !== first.revision ||
        next.offset !== info.nextOffset ||
        next.totalEntries !== total ||
        !page.entries.length
      )
        throw new ConnectorError("SOURCE_CONFLICT");
      entries.push(...page.entries);
      for (const r of page.crm as any[]) crm.set(r.id, r);
      for (const r of page.links as any[]) links.set(r.entryId, r);
      for (const r of (page.submissions as any[]) || []) {
        const prior = submissions.get(r.operationId);
        submissions.set(r.operationId, {
          ...r,
          mappings: [...(prior?.mappings || []), ...r.mappings],
        });
      }
      info = next;
    }
    if (
      entries.length !== total ||
      new Set(entries.map((e) => e.id)).size !== entries.length
    )
      throw new ConnectorError("INVALID_SOURCE");
    const merged: any = {
      ...first,
      entries,
      crm: [...crm.values()],
      links: [...links.values()],
      submissions: [...submissions.values()],
    };
    delete merged.pagination;
    return merged;
  }
  async connect(raw: unknown) {
    return this.exclusive(async () => {
      const { token } = z
        .strictObject({ token: z.string().regex(/^[a-f0-9]{64}$/) })
        .parse(raw);
      const snapshot = snapshotSchema.parse(await this.loadSnapshot(token));
      // Invalidate queued operations before changing the credential, even if
      // the credential store reports an uncertain failure.
      this.generation++;
      this.cooldown = { read: 0, write: 0 };
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
        result = await this.loadSnapshot(s.token, args, s.datasetId);
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
      let name = "dataset.save",
        payload: unknown = args;
      if (Buffer.byteLength(JSON.stringify(args)) > 1_800_000) {
        const current = await this.loadSnapshot(s.token, {}, s.datasetId);
        if (
          current.version === args.version + 1 &&
          current.name === args.name &&
          JSON.stringify(current.entries) === JSON.stringify(args.entries)
        )
          return { id: s.datasetId, version: current.version };
        if (current.version !== args.version)
          throw new ConnectorError("SOURCE_CONFLICT");
        const baseline = new Map(current.entries.map((e: any) => [e.id, e])),
          nextIds = new Set(args.entries.map((e) => e.id));
        payload = {
          version: args.version,
          name: args.name,
          entryOrder: args.entries.map((e) => e.id),
          changes: args.entries.filter(
            (e) => JSON.stringify(e) !== JSON.stringify(baseline.get(e.id)),
          ),
          removeIds: current.entries
            .filter((e: any) => !nextIds.has(e.id))
            .map((e: any) => e.id),
        };
        if (Buffer.byteLength(JSON.stringify(payload)) > 1_800_000)
          throw new ConnectorError("SOURCE_TOO_LARGE");
        name = "dataset.patch";
      }
      const result = z
        .object({ id: z.uuid(), version: z.number().int().positive() })
        .parse(await this.call(s.token, name, payload));
      if (result.id !== s.datasetId) throw new ConnectorError("INVALID_SOURCE");
      return result;
    });
  }
  async patch(raw: unknown) {
    return this.exclusive(async () => {
      const args = datasetPatchSchema.parse(raw),
        s = await this.saved();
      const result = z
        .object({ id: z.uuid(), version: z.number().int().positive() })
        .parse(await this.call(s.token, "dataset.patch", args));
      if (result.id !== s.datasetId) throw new ConnectorError("INVALID_SOURCE");
      return result;
    });
  }
  async append(raw: unknown, expectedDatasetId: string) {
    return this.exclusive(async () => {
      const args = z
        .strictObject({
          version: z.number().int().positive(),
          entries: z.array(z.record(z.string(), z.unknown())).min(1),
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
      this.generation++;
      this.cooldown = { read: 0, write: 0 };
      await this.secret.deleteCredential();
      return { removed: true };
    });
  }
}

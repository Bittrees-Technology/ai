import {
  PostgresRunStore,
  type RunStore,
  type RunStep as Step,
} from "./run-store.js";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Pool } from "pg";
const batch = z.strictObject({
  id: z.uuid(),
  crm: z.strictObject({
    candidates: z.array(z.record(z.string(), z.unknown())).min(1).max(20),
  }),
  mercado: z
    .array(z.strictObject({ product: z.record(z.string(), z.unknown()) }))
    .min(1)
    .max(20),
});
export type Connection = { ownerId: string; token: string; expiresAt: number };
export class MarketplaceCoordinator {
  private store: RunStore;
  constructor(
    pool: Pool | RunStore,
    private connections: Connection[],
    private request: typeof fetch = fetch,
  ) {
    this.store = "query" in pool ? new PostgresRunStore(pool) : pool;
  }
  private connection(owner: string) {
    const c = this.connections.find((c) => c.ownerId === owner);
    if (
      !c ||
      !Number.isFinite(c.expiresAt) ||
      c.expiresAt <= Date.now() ||
      !c.token ||
      c.token.length < 16
    )
      throw new Error("Workflow connection unavailable");
    return c;
  }
  async create(owner: string, raw: unknown) {
    this.connection(owner);
    const input = batch.parse(raw);
    if (JSON.stringify(input).length > 55000)
      throw new Error("Batch too large");
    const steps: Step[] = [
      {
        source: "crm",
        operationId: randomUUID(),
        payload: input.crm,
        state: "pending",
      },
      ...input.mercado.map((payload) => ({
        source: "mercado" as const,
        operationId: randomUUID(),
        payload,
        state: "pending",
      })),
    ];
    await this.store.create(owner, input.id, input, steps);
    return this.get(owner, input.id);
  }
  async get(owner: string, id: string) {
    z.uuid().parse(id);
    const row = await this.store.get(owner, id);
    return {
      ...row,
      steps: (row.steps as Step[]).map(({ payload, ...s }) => s),
    };
  }
  private async call(c: Connection, step: Step, action: "preview" | "status") {
    const response = await this.request(
      "https://mcp.bittrees.org/mcp?mode=selected&projects=crm,mercado",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${c.token}`,
          "content-type": "application/json",
          "mcp-protocol-version": "2025-06-18",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: step.operationId,
          method: "tools/call",
          params: {
            name: `source_${step.source}_${action}`,
            arguments: {
              operationId: step.operationId,
              ...(action === "preview" ? step.payload : {}),
            },
          },
        }),
        redirect: "error",
        signal: AbortSignal.timeout(25000),
      },
    );
    if (!response.ok) throw new Error("Connection or source unavailable");
    const value = (await response.json()) as any;
    if (
      value.error ||
      value.result?.isError ||
      !value.result?.structuredContent
    )
      throw new Error("Source response unconfirmed");
    return value.result.structuredContent as { state?: string };
  }
  async advance(owner: string, id: string) {
    const c = this.connection(owner);
    z.uuid().parse(id);
    const lease = randomUUID();
    const steps = await this.store.claim(owner, id, lease);
    if (!steps) throw Error("Run unavailable or already running");
    // One source per invocation bounds runtime and permits independent retries.
    const step = steps.find((s) => s.state !== "decided");
    try {
      if (step) {
        try {
          this.connection(owner);
          let receipt = await this.call(c, step, "status");
          if (receipt.state === "not_found")
            receipt = await this.call(c, step, "preview");
          if (
            !receipt.state ||
            !["awaiting_review", "decided"].includes(receipt.state)
          )
            throw new Error("Unknown source state");
          step.state = receipt.state;
          step.receipt = receipt;
        } catch {
          step.state = "uncertain";
        }
        steps.splice(steps.indexOf(step), 1);
        steps.push(step);
      }
      await this.store.save(id, lease, steps);
    } finally {
      await this.store.release(id, lease);
    }
    return this.get(owner, id);
  }
}

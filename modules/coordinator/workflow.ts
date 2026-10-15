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
type Step = {
  source: "crm" | "mercado";
  operationId: string;
  payload: Record<string, unknown>;
  state: string;
  receipt?: unknown;
};
export type Connection = { ownerId: string; token: string; expiresAt: number };
export class MarketplaceCoordinator {
  constructor(
    private pool: Pool,
    private connections: Connection[],
    private request: typeof fetch = fetch,
  ) {}
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
    await this.pool.query(
      "INSERT INTO marketplace_runs(id,owner_id,input,steps) VALUES($1,$2,$3,$4) ON CONFLICT(id) DO NOTHING",
      [input.id, owner, input, JSON.stringify(steps)],
    );
    const result = await this.pool.query(
      "SELECT input=$3::jsonb AS same FROM marketplace_runs WHERE id=$1 AND owner_id=$2",
      [input.id, owner, input],
    );
    if (!result.rows[0]?.same) throw new Error("Run ID conflict");
    return this.get(owner, input.id);
  }
  async get(owner: string, id: string) {
    z.uuid().parse(id);
    const row = (
      await this.pool.query(
        "SELECT id,steps,updated_at FROM marketplace_runs WHERE id=$1 AND owner_id=$2",
        [id, owner],
      )
    ).rows[0];
    if (!row) throw new Error("Run not found");
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
    const row = (
      await this.pool.query(
        "UPDATE marketplace_runs SET lease=$3,lease_until=now()+interval '90 seconds' WHERE id=$1 AND owner_id=$2 AND (lease_until IS NULL OR lease_until<now()) RETURNING steps",
        [id, owner, lease],
      )
    ).rows[0];
    if (!row) throw new Error("Run unavailable or already running");
    const steps = row.steps as Step[];
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
      await this.pool.query(
        "UPDATE marketplace_runs SET steps=$3,updated_at=now() WHERE id=$1 AND lease=$2",
        [id, lease, JSON.stringify(steps)],
      );
    } finally {
      await this.pool.query(
        "UPDATE marketplace_runs SET lease=NULL,lease_until=NULL WHERE id=$1 AND lease=$2",
        [id, lease],
      );
    }
    return this.get(owner, id);
  }
}

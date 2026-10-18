import { z } from "zod";
export const agentMessage = z.strictObject({
  version: z.literal(1),
  operationId: z.uuid(),
  coordinatorId: z.uuid(),
  agentProfileId: z.uuid(),
  workflow: z.string().min(1).max(128),
  instruction: z.string().min(1).max(6000),
});
/** Outbound inter-agent REST. Exact operator-pinned HTTPS origins only; bearer scoped by source authority. */
export class AgentRestClient {
  constructor(
    private origin: string,
    private token: () => Promise<string>,
    private authorize: () => Promise<boolean>,
    private request: typeof fetch = fetch,
  ) {
    const u = new URL(origin);
    if (
      u.protocol !== "https:" ||
      u.origin !== origin ||
      u.username ||
      u.password
    )
      throw Error("An exact HTTPS agent origin is required");
  }
  async submit(raw: unknown, signal: AbortSignal) {
    const message = agentMessage.parse(raw);
    if (!(await this.authorize()))
      throw Error("Current inter-agent authority required");
    const token = await this.token();
    if (!token || /[\r\n]/.test(token)) throw Error("Invalid agent credential");
    const response = await this.request(this.origin + "/v1/agent-tasks", {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.any([signal, AbortSignal.timeout(20000)]),
      headers: {
        authorization: "Bearer " + token,
        "content-type": "application/json",
        "idempotency-key": message.operationId,
      },
      body: JSON.stringify(message),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw Error(
        "Agent delivery unconfirmed; reconcile operation ID before retry",
      );
    }
    if (!response.body) throw Error("Missing agent receipt");
    const reader = response.body.getReader();
    let size = 0;
    const chunks: Uint8Array[] = [];
    try {
      while (true) {
        const r = await reader.read();
        if (r.done) break;
        size += r.value.length;
        if (size > 8192) throw Error("Agent receipt too large");
        chunks.push(r.value);
      }
    } finally {
      await reader.cancel();
    }
    const receipt = z
      .strictObject({
        operationId: z.literal(message.operationId),
        state: z.enum(["queued", "held", "completed"]),
        evidenceId: z.string().min(1).max(200).optional(),
      })
      .parse(JSON.parse(Buffer.concat(chunks).toString()));
    if (receipt.state === "completed" && !receipt.evidenceId)
      throw Error("Completion requires evidence");
    if (!(await this.authorize()))
      throw Error("Authority revoked; delivery requires reconciliation");
    return receipt;
  }
}

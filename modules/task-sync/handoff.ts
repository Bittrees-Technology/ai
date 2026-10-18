import { randomUUID } from "node:crypto";
import { z } from "zod";
import { canonical } from "../contracts/canonical-json.js";
import { digest } from "./proof-contract.js";
import {
  runtimeHandoffSchema,
  runtimeHandoffMessage,
  runtimeEnrollmentSchema,
  runtimeEnrollmentMessage,
  leaseActivationSchema,
  leaseActivationMessage,
} from "./runtime-contract.js";
type Candidate = z.infer<typeof runtimeHandoffSchema>;
type State = {
  candidate: Candidate;
  id: string;
  pollSecret: string;
  reviewUrl: string;
  expiresAt: string;
  status: "pending" | "approved" | "complete" | "expired" | "failed";
  result?: any;
  message?: string;
};
/** Outbound-only owner review. Polling secret and results stay in the encrypted local store. */
export class RuntimeHandoff {
  private running: Promise<void> | null = null;
  constructor(
    private read: () => State | null,
    private save: (state: State) => void,
    private device: () => {
      principal: string;
      publicKey: string;
      credentialId: string;
    },
    private sign: (message: string) => string,
    private attest: (
      purpose: "enroll" | "activate",
      request: unknown,
      signature: string,
    ) => Promise<unknown>,
    private request: typeof fetch = fetch,
    private now = () => Date.now(),
  ) {}
  status() {
    const s = this.read();
    return s
      ? {
          kind: s.candidate.kind,
          status: s.status,
          reviewUrl: s.reviewUrl,
          expiresAt: s.expiresAt,
          message: s.message,
        }
      : null;
  }
  result() {
    const s = this.read();
    return s?.status === "complete" ? s.result : null;
  }
  private async call(action: string, input: unknown) {
    const r = await this.request(
      "https://roles.bittrees.org/api/mcp/runtime/" + action,
      {
        method: "POST",
        redirect: "error",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(input),
        signal: AbortSignal.timeout(15000),
      },
    );
    if (!r.ok) throw Error("Roles review could not be confirmed");
    const reader = r.body?.getReader();
    if (!reader) throw Error("Missing Roles response");
    let size = 0;
    const chunks: Uint8Array[] = [];
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.length;
        if (size > 64000) throw Error("Roles response too large");
        chunks.push(part.value);
      }
    } finally {
      await reader.cancel();
    }
    return JSON.parse(Buffer.concat(chunks).toString());
  }
  async start(input: unknown) {
    const old = this.read();
    if (
      this.running ||
      (old &&
        ["pending", "approved"].includes(old.status) &&
        Date.parse(old.expiresAt) > this.now())
    )
      throw Error("An owner review is already pending");
    const d = this.device();
    const candidate = runtimeHandoffSchema.parse({
      ...z.record(z.string(), z.unknown()).parse(input),
      version: 1,
      audience: "https://mcp.bittrees.org",
      principal: d.principal,
      publicKey: d.publicKey,
      issuedAt: this.now(),
      nonce: randomUUID(),
    });
    const result = z
      .strictObject({
        id: z.uuid(),
        pollSecret: z.string().regex(/^[a-f0-9]{64}$/),
        reviewUrl: z.string().url(),
        expiresAt: z.iso.datetime(),
      })
      .parse(
        await this.call("start", {
          request: candidate,
          signature: this.sign(runtimeHandoffMessage(candidate)),
        }),
      );
    if (
      result.reviewUrl !==
        "https://roles.bittrees.org/profile?runtimeRequest=" + result.id ||
      Date.parse(result.expiresAt) <= this.now() ||
      Date.parse(result.expiresAt) > this.now() + 300000
    )
      throw Error("Invalid owner review destination or expiry");
    this.save({ ...result, candidate, status: "pending" });
    return this.status();
  }
  tick() {
    if (this.running) return this.running;
    const s = this.read();
    if (!s || !["pending", "approved"].includes(s.status))
      return Promise.resolve();
    if (Date.parse(s.expiresAt) <= this.now()) {
      this.save({ ...s, status: "expired" });
      return Promise.resolve();
    }
    this.running = this.poll(s)
      .catch(() => {
        this.save({
          ...s,
          message:
            "Owner review could not be confirmed. Retrying until the review expires.",
        });
      })
      .finally(() => {
        this.running = null;
      });
    return this.running;
  }
  private async poll(s: State) {
    const auth = { id: s.id, pollSecret: s.pollSecret };
    let r = await this.call("poll", auth);
    if (r.status === "pending") return;
    if (r.status === "approved") {
      const c = s.candidate;
      const request =
        c.kind === "enroll"
          ? runtimeEnrollmentSchema.parse(r.request)
          : leaseActivationSchema.parse(r.request);
      if (Math.abs(this.now() - request.issuedAt) > 15000)
        throw Error("Stale owner challenge");
      const fields =
        c.kind === "enroll"
          ? [
              "principal",
              "publicKey",
              "authorityId",
              "deviceId",
              "sourceWorkspace",
            ]
          : ["principal", "leaseId", "policyDigest", "runtimeBindingDigest"];
      for (const field of fields)
        if ((request as any)[field] !== (c as any)[field])
          throw Error("Owner challenge changed");
      if (
        c.kind === "activate" &&
        (request as any).credentialId !== this.device().credentialId
      )
        throw Error("Wrong runtime credential");
      const message =
          c.kind === "enroll"
            ? runtimeEnrollmentMessage(request)
            : leaseActivationMessage(request),
        signature = this.sign(message);
      const attestation = await this.attest(c.kind, request, signature);
      r = await this.call("complete", {
        ...auth,
        proof: { request, signature, attestation },
      });
    }
    if (r.status !== "complete")
      throw Error("Unexpected owner review response");
    if (s.candidate.kind === "enroll") {
      const result = r.result,
        d = this.device(),
        b = result?.binding;
      const expected = {
        version: 1,
        ownerProfileId: z.uuid().parse(b?.ownerProfileId),
        ownerWallet: s.candidate.ownerWallet,
        authorityId: s.candidate.authorityId,
        deviceId: s.candidate.deviceId,
        principal: d.principal,
        credentialId: d.credentialId,
        sourceWorkspace: s.candidate.sourceWorkspace,
        tenant: "roles:" + b.ownerProfileId,
        workspace: "crm:" + s.candidate.sourceWorkspace,
      };
      if (
        result.permissionsGranted !== false ||
        result.principal !== d.principal ||
        result.publicKey !== d.publicKey ||
        result.credentialId !== d.credentialId ||
        canonical(b) !== canonical(expected) ||
        result.runtimeBindingDigest !== digest(b)
      )
        throw Error("Enrollment result differs from reviewed device");
    }
    this.save({
      ...s,
      status: "complete",
      result: r.result,
      message: undefined,
    });
  }
  async close() {
    await this.running;
  }
}

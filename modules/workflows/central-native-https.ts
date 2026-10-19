import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { publicIPv4 } from "../research/public-pages.js";
import { CentralTransportPlan } from "./central-transport-plan.js";
/** Unregistered native-only fixed MCP transport. The trusted owner must reserve
 * every attempted call durably under its approved cost/count/deadline budget.
 * This does not grant authority; current Roles/source checks remain on MCP.
 */
export class CentralNativeHTTPS {
  private resolving = false;
  constructor(
    private plan: CentralTransportPlan,
    private reserve: (input: {
      epoch: string;
      requestId: string;
      operationId: string;
    }) => void,
    private token: () => string,
    private resolve: typeof lookup = lookup,
    private send: typeof request = request,
  ) {}
  dispatch = async (
    input: unknown,
    signal: AbortSignal,
  ): Promise<Uint8Array> => {
    signal.throwIfAborted();
    const plan = this.plan.prepare(input);
    if (plan.timeoutMs < 1) throw Error("Central native deadline expired");
    this.reserve({
      epoch: plan.epoch,
      requestId: plan.requestId,
      operationId: plan.operationId,
    });
    this.plan.assertCurrent();
    const bounded = AbortSignal.any([
      signal,
      AbortSignal.timeout(plan.timeoutMs),
    ]);
    const url = new URL(plan.url);
    // Pin a validated IPv4 answer; never resolve a second time inside the socket.
    // IPv6 is conservatively excluded until separately reviewed.
    if (this.resolving)
      throw Error("Prior central workflow DNS lookup still pending");
    this.resolving = true;
    const pending = Promise.resolve()
      .then(() => this.resolve(url.hostname, { all: true, family: 4 }))
      .finally(() => {
        this.resolving = false;
      });
    const addresses = await new Promise<Awaited<typeof pending>>(
      (resolve, reject) => {
        const abort = () =>
          reject(bounded.reason ?? Error("Central workflow DNS cancelled"));
        bounded.addEventListener("abort", abort, { once: true });
        if (bounded.aborted) abort();
        pending
          .then(resolve, reject)
          .finally(() => bounded.removeEventListener("abort", abort));
      },
    );
    bounded.throwIfAborted();
    this.plan.assertCurrent();
    if (
      !addresses.length ||
      addresses.some(
        (a) => !publicIPv4(a.address) || a.address.startsWith("192.88.99."),
      )
    )
      throw Error("Central workflow DNS address rejected");
    const address = addresses[0]!.address;
    this.plan.assertCurrent();
    const credential = this.token();
    if (!/^[\x21-\x7e]{16,4096}$/.test(credential))
      throw Error("Central MCP credential unavailable");
    const headers = {
      "Content-Type": "application/json",
      Accept: "application/json",
      "Accept-Encoding": "identity",
      "Content-Length": String(Buffer.byteLength(plan.body)),
      Authorization: "Bearer " + credential,
      "X-Bittrees-Agent-Proof": plan.proof,
    };
    return new Promise((resolve, reject) => {
      const req = this.send(
        url,
        {
          method: "POST",
          headers,
          signal: bounded,
          agent: false,
          family: 4,
          rejectUnauthorized: true,
          servername: url.hostname,
          lookup: ((_host: any, opts: any, cb: any) =>
            opts.all
              ? cb(null, [{ address, family: 4 }])
              : cb(null, address, 4)) as any,
        },
        (res) => {
          res.on("error", reject);
          res.on("aborted", () =>
            reject(Error("Central workflow response interrupted")),
          );
          if (
            res.statusCode !== 200 ||
            !/^application\/json(?:;|$)/i.test(
              String(res.headers["content-type"] || ""),
            ) ||
            (res.headers["content-encoding"] &&
              res.headers["content-encoding"] !== "identity")
          ) {
            res.destroy();
            reject(
              Error("Central workflow response status or encoding rejected"),
            );
            return;
          }
          let size = 0;
          const chunks: Buffer[] = [];
          res.on("data", (chunk) => {
            size += chunk.length;
            if (size > 64000) {
              res.destroy(Error("Central workflow response too large"));
              return;
            }
            chunks.push(Buffer.from(chunk));
          });
          res.on("end", () => {
            try {
              bounded.throwIfAborted();
              this.plan.assertCurrent();
              resolve(Buffer.concat(chunks));
            } catch (e) {
              reject(e);
            }
          });
        },
      );
      req.on("error", reject);
      req.end(plan.body);
    });
  };
}

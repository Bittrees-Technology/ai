import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { publicIPv4 } from "../research/public-pages.js";
import { z } from "zod";
import { requireSynchronousPairingAdmission } from "./initial-pairing-admission.js";
import {
  INITIAL_PAIRING_START,
  INITIAL_PAIRING_POLL,
  initialPairingPoll,
  verifyInitialPairingRequest,
  verifyInitialPairingPollRequest,
  type initialPairingRequest,
} from "./initial-pairing.js";
type Initial = z.infer<typeof initialPairingRequest>;
export interface InitialPairingHTTPSInput {
  url: string;
  method: "POST";
  body: unknown;
}
export function checkInitialPairingHTTPSInput(
  plan: InitialPairingHTTPSInput,
  context: { request: Initial; pairingId: string } | null,
  now = Date.now(),
) {
  z.strictObject({
    url: z.enum([INITIAL_PAIRING_START, INITIAL_PAIRING_POLL]),
    method: z.literal("POST"),
    body: z.unknown(),
  }).parse(plan);
  if (plan.url === INITIAL_PAIRING_START)
    verifyInitialPairingRequest(plan.body, now);
  else {
    if (!context) throw Error("Current initial pairing context required");
    verifyInitialPairingPollRequest(
      plan.body,
      context.request,
      context.pairingId,
      now,
    );
  }
  const body = JSON.stringify(plan.body);
  if (Buffer.byteLength(body) > 16000)
    throw Error("Initial pairing body too large");
  return body;
}
/** Unregistered native-side adapter. No network activity on construction.
 * Admission must enforce reviewed source pairing purpose, cost and exact native consent before every request. No bearer, cookie or generic source credential is accepted.
 * Never instantiate in the model core or use this as a general proxy.
 */
export class InitialPairingHTTPS {
  private resolving = false;
  constructor(
    private admit: () => void,
    private context: () => { request: Initial; pairingId: string } | null,
    private resolve: typeof lookup = lookup,
    private send: typeof request = request,
  ) {}
  dispatch = async (
    plan: InitialPairingHTTPSInput,
    signal: AbortSignal,
  ): Promise<unknown> => {
    const body = checkInitialPairingHTTPSInput(plan, this.context());
    requireSynchronousPairingAdmission(() => this.admit());
    signal.throwIfAborted();
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(15000)]);
    const url = new URL(plan.url);
    // Pin a validated IPv4 answer; never resolve a second time inside the socket.
    // IPv6 is conservatively excluded until separately reviewed.
    if (this.resolving)
      throw Error("Prior enrollment DNS lookup still pending");
    this.resolving = true;
    const pending = Promise.resolve()
      .then(() => this.resolve(url.hostname, { all: true, family: 4 }))
      .finally(() => {
        this.resolving = false;
      });
    const addresses = await new Promise<Awaited<typeof pending>>(
      (resolve, reject) => {
        const abort = () =>
          reject(bounded.reason ?? Error("Enrollment DNS cancelled"));
        bounded.addEventListener("abort", abort, { once: true });
        if (bounded.aborted) abort();
        pending
          .then(resolve, reject)
          .finally(() => bounded.removeEventListener("abort", abort));
      },
    );
    bounded.throwIfAborted();
    requireSynchronousPairingAdmission(() => this.admit());
    if (
      !addresses.length ||
      addresses.some(
        (a) => !publicIPv4(a.address) || a.address.startsWith("192.88.99."),
      )
    )
      throw Error("Enrollment DNS address rejected");
    const address = addresses[0]!.address;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
      "Accept-Encoding": "identity",
      "Content-Length": String(Buffer.byteLength(body)),
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
            reject(Error("Enrollment response interrupted")),
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
            reject(Error("Enrollment response status or encoding rejected"));
            return;
          }
          let size = 0;
          const chunks: Buffer[] = [];
          res.on("data", (chunk) => {
            size += chunk.length;
            if (size > 16384) {
              res.destroy(Error("Enrollment response too large"));
              return;
            }
            chunks.push(Buffer.from(chunk));
          });
          res.on("end", () => {
            try {
              bounded.throwIfAborted();
              requireSynchronousPairingAdmission(() => this.admit());
              resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
            } catch (e) {
              reject(e);
            }
          });
        },
      );
      req.on("error", reject);
      req.end(body);
    });
  };
}

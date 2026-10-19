import { createServer, type Server } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { EnrollmentConsent } from "./enrollment-consent.js";
const action = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("propose") }),
  z.strictObject({
    action: z.literal("approve"),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
  }),
  z.strictObject({ action: z.literal("revoke") }),
]);
/** Inactive native-only control port. Its capability must never be forwarded to
 * the model/core. This port cannot execute enrollment or supply identity/keys.
 * Native UI must display the exact proposal before sending its digest approval.
 */
export class EnrollmentControl {
  private server: Server;
  private endpoint?: string;
  private closed = false;
  private listening = false;
  constructor(
    nativeToken: string,
    coreToken: string,
    private readonly consent: EnrollmentConsent,
  ) {
    if (
      !/^[a-f0-9]{64}$/.test(nativeToken) ||
      !/^[a-f0-9]{64}$/.test(coreToken) ||
      nativeToken === coreToken
    )
      throw Error("Separate native and core capabilities required");
    const expected = Buffer.from("Bearer " + nativeToken);
    this.server = createServer(async (req, res) => {
      const send = (status: number, value: unknown) => {
        if (res.destroyed || res.headersSent) return;
        res.writeHead(status, {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
          Connection: "close",
        });
        res.end(JSON.stringify(value));
      };
      const deadline = setTimeout(() => req.destroy(), 5000);
      try {
        const auth = Buffer.from(
          typeof req.headers.authorization === "string"
            ? req.headers.authorization
            : "",
        );
        if (
          this.closed ||
          !this.endpoint ||
          req.socket.remoteAddress !== "127.0.0.1" ||
          req.headers.host !== new URL(this.endpoint).host ||
          req.method !== "POST" ||
          req.url !== "/enrollment-control" ||
          req.headers.origin ||
          req.headers.cookie ||
          auth.length !== expected.length ||
          !timingSafeEqual(auth, expected)
        ) {
          send(403, { error: "Native enrollment control unavailable" });
          return;
        }
        if (
          req.headers["content-type"] !== "application/json" ||
          req.headers["content-encoding"]
        ) {
          send(400, { error: "Invalid native request" });
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 2048) {
            send(413, { error: "Request too large" });
            return;
          }
          chunks.push(Buffer.from(chunk));
        }
        if (this.closed || req.aborted || res.destroyed)
          throw Error("Control closed");
        const input = action.parse(
          JSON.parse(
            new TextDecoder("utf-8", { fatal: true }).decode(
              Buffer.concat(chunks),
            ),
          ),
        );
        if (input.action === "propose") send(200, consent.propose());
        else if (input.action === "approve") {
          consent.approve(input.digest);
          send(200, { approved: true });
        } else {
          consent.revoke();
          send(200, { revoked: true });
        }
      } catch {
        send(400, { error: "Native enrollment control unavailable" });
      } finally {
        clearTimeout(deadline);
      }
    });
    this.server.requestTimeout = 6000;
    this.server.headersTimeout = 5000;
    this.server.maxHeadersCount = 20;
    this.server.maxConnections = 2;
  }
  async listen() {
    if (this.closed || this.listening) throw Error("Control unavailable");
    this.listening = true;
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", () => {
        this.server.removeListener("error", reject);
        resolve();
      });
    });
    if (this.closed) {
      this.server.close();
      throw Error("Control closed");
    }
    const a = this.server.address();
    if (!a || typeof a === "string") throw Error("Control address missing");
    this.endpoint = `http://127.0.0.1:${a.port}/enrollment-control`;
    return this.endpoint;
  }
  async close() {
    this.consent.revoke();
    this.closed = true;
    this.endpoint = undefined;
    await new Promise<void>((resolve, reject) => {
      this.server.close((e) => {
        if (e && (e as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING")
          reject(e);
        else resolve();
      });
      this.server.closeAllConnections();
    });
  }
}

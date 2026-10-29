import { createServer, type Server } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";

export interface InitialPairingNativeActions {
  prepare(): unknown;
  approve(confirmation: { reviewId: string; digest: string }): Promise<unknown>;
  poll(): Promise<unknown>;
  close(): Promise<void>;
}
const inputSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("prepare") }),
  z.strictObject({
    action: z.literal("approve"),
    reviewId: z.uuid(),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
  }),
  z.strictObject({ action: z.literal("poll") }),
  z.strictObject({ action: z.literal("cancel") }),
]);

/** Inactive native IPC, not registered by any launcher/HTTP/model/MCP surface.
 * The dedicated random capability must stay with the trusted native owner.
 * Actions must be NativeInitialPairingReviewActions with independently admitted
 * source/key/cost context; this channel supplies no identity, key or permission.
 */
export class InitialPairingNativeControl {
  private readonly server: Server;
  private endpoint: string | undefined;
  private listening = false;
  private closed = false;
  private revoked = false;
  private busy = false;
  private closing: Promise<void> | undefined;
  constructor(
    nativeToken: string,
    coreToken: string,
    private readonly actions: InitialPairingNativeActions,
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
        const body = JSON.stringify(value);
        if (typeof body !== "string" || Buffer.byteLength(body) > 16384)
          throw Error("Native pairing response unavailable");
        res.writeHead(status, {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
          Connection: "close",
        });
        res.end(body);
      };
      const deadline = setTimeout(() => req.destroy(), 5000);
      let started = false;
      let occupies = false;
      let disconnected = false;
      const disconnect = () => {
        if (res.writableFinished) return;
        disconnected = true;
        this.revoked = true;
        void Promise.resolve()
          .then(() => actions.close())
          .catch(() => {});
      };
      try {
        const auth = Buffer.from(
          typeof req.headers.authorization === "string"
            ? req.headers.authorization
            : "",
        );
        const counts = new Map<string, number>();
        for (let i = 0; i < req.rawHeaders.length; i += 2) {
          const key = req.rawHeaders[i]!.toLowerCase();
          counts.set(key, (counts.get(key) ?? 0) + 1);
        }
        if (
          this.closed ||
          this.revoked ||
          !this.endpoint ||
          req.rawHeaders.length >= 40 ||
          req.socket.remoteAddress !== "127.0.0.1" ||
          req.headers.host !== new URL(this.endpoint).host ||
          counts.get("host") !== 1 ||
          counts.get("authorization") !== 1 ||
          req.method !== "POST" ||
          req.url !== "/initial-pairing-control" ||
          counts.has("origin") ||
          counts.has("cookie") ||
          auth.length !== expected.length ||
          !timingSafeEqual(auth, expected)
        ) {
          send(403, { error: "Native pairing control unavailable" });
          return;
        }
        if (
          req.headers["content-type"] !== "application/json" ||
          counts.get("content-type") !== 1 ||
          counts.has("content-encoding")
        ) {
          send(400, { error: "Invalid native pairing request" });
          return;
        }
        let size = 0;
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 2048) {
            send(413, { error: "Native pairing request too large" });
            return;
          }
          chunks.push(Buffer.from(chunk));
        }
        clearTimeout(deadline);
        if (req.rawTrailers.length) throw Error("Native trailers unavailable");
        const input = inputSchema.parse(
          JSON.parse(
            new TextDecoder("utf-8", { fatal: true }).decode(
              Buffer.concat(chunks),
            ),
          ),
        );
        if (this.closed || this.revoked || req.aborted || res.destroyed)
          throw Error("Native pairing control closed");
        if (this.busy && input.action !== "cancel") {
          send(409, { error: "Native pairing control busy" });
          return;
        }
        // Only an authenticated, schema-valid native request can cancel work
        // on disconnect. Invalid/browser requests never reach the actions.
        res.once("close", disconnect);
        started = true;
        if (input.action === "cancel") {
          this.revoked = true;
          await actions.close();
          send(200, { cancelled: true });
        } else {
          this.busy = occupies = true;
          const result =
            input.action === "prepare"
              ? actions.prepare()
              : input.action === "approve"
                ? await actions.approve({
                    reviewId: input.reviewId,
                    digest: input.digest,
                  })
                : await actions.poll();
          if (this.closed || this.revoked || disconnected || res.destroyed)
            throw Error("Native pairing control cancelled");
          send(200, result);
        }
      } catch {
        if (started) {
          this.revoked = true;
          try {
            await actions.close();
          } catch {
            /* No retry or substitute authority on failed cancellation. */
          }
        }
        send(400, { error: "Native pairing control unavailable" });
      } finally {
        clearTimeout(deadline);
        if (occupies) this.busy = false;
        if (res.writableFinished || !started)
          res.removeListener("close", disconnect);
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
    const address = this.server.address();
    if (!address || typeof address === "string")
      throw Error("Control address unavailable");
    this.endpoint = `http://127.0.0.1:${address.port}/initial-pairing-control`;
    return this.endpoint;
  }
  close() {
    if (this.closing) return this.closing;
    this.closed = this.revoked = true;
    this.endpoint = undefined;
    this.closing = (async () => {
      try {
        await this.actions.close();
      } finally {
        await new Promise<void>((resolve, reject) => {
          this.server.close((error) => {
            if (
              error &&
              (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING"
            )
              reject(error);
            else resolve();
          });
          this.server.closeAllConnections();
        });
      }
    })();
    return this.closing;
  }
}

import { createServer, type Server } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { centralNativeInputSchema } from "./central-transport-plan.js";
import type { CentralNativeHTTPS } from "./central-native-https.js";
/** Inactive native-side IPC interface. No review/session creation endpoint.
 * Only the trusted native owner supplies the reviewed/budgeted transport and random token.
 * Calling listen is explicit; there is no permission or scope mutation endpoint.
 */
export class CentralNativeBroker {
  private server: Server;
  private endpoint?: string;
  private closed = false;
  private listening = false;
  private closing?: Promise<void>;
  private active = new Set<AbortController>();
  private busy = false;
  constructor(
    token: string,
    current: () => Pick<CentralNativeHTTPS, "dispatch"> | null,
  ) {
    if (!/^[a-f0-9]{64}$/.test(token))
      throw Error("Invalid central workflow broker capability");
    const expected = Buffer.from("Bearer " + token);
    this.server = createServer(async (req, res) => {
      const controller = new AbortController();
      this.active.add(controller);
      const deadline = setTimeout(
        () => controller.abort(Error("Broker deadline")),
        21000,
      );
      res.on("close", () => {
        if (!res.writableEnded) controller.abort(Error("Caller disconnected"));
      });
      const fail = (status: number) => {
        if (!res.headersSent && !res.destroyed) {
          res.writeHead(status, {
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
            Connection: "close",
          });
          res.end('{"error":"Central workflow request unavailable"}');
        }
      };
      try {
        const auth = Buffer.from(
          typeof req.headers.authorization === "string"
            ? req.headers.authorization
            : "",
        );
        if (
          this.closed ||
          req.socket.remoteAddress !== "127.0.0.1" ||
          !this.endpoint ||
          req.headers.host !== new URL(this.endpoint).host ||
          req.method !== "POST" ||
          req.url !== "/central-workflow" ||
          req.headers.origin ||
          req.headers.cookie ||
          auth.length !== expected.length ||
          !timingSafeEqual(auth, expected)
        ) {
          fail(403);
          return;
        }
        if (
          req.headers["content-type"] !== "application/json" ||
          req.headers["content-encoding"]
        ) {
          fail(400);
          return;
        }
        const session = current();
        if (!session || this.busy) {
          fail(403);
          return;
        }
        let size = 0;
        const chunks: Buffer[] = [];
        const abort = () => req.destroy();
        controller.signal.addEventListener("abort", abort, { once: true });
        try {
          for await (const chunk of req) {
            size += chunk.length;
            if (size > 70000) {
              fail(413);
              return;
            }
            chunks.push(Buffer.from(chunk));
          }
        } finally {
          controller.signal.removeEventListener("abort", abort);
        }
        controller.signal.throwIfAborted();
        const value = centralNativeInputSchema.parse(
          JSON.parse(
            new TextDecoder("utf-8", { fatal: true }).decode(
              Buffer.concat(chunks),
            ),
          ),
        );
        if (current() !== session) {
          fail(403);
          return;
        }
        if (this.busy) {
          fail(409);
          return;
        }
        this.busy = true;
        let result: Uint8Array;
        try {
          result = await session.dispatch(value, controller.signal);
        } finally {
          this.busy = false;
        }
        controller.signal.throwIfAborted();
        if (current() !== session) {
          fail(403);
          return;
        }
        const body = Buffer.from(result);
        if (Buffer.byteLength(body) > 64000)
          throw Error("Broker response too large");
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        });
        res.end(body);
      } catch {
        fail(400);
      } finally {
        clearTimeout(deadline);
        this.active.delete(controller);
      }
    });
    this.server.requestTimeout = 22000;
    this.server.headersTimeout = 5000;
    this.server.maxHeadersCount = 20;
    this.server.maxConnections = 4;
  }
  async listen() {
    if (this.closed) throw Error("Central workflow broker closed");
    if (this.listening)
      throw Error("Central workflow broker already listening");
    this.listening = true;
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", () => {
        this.server.removeListener("error", reject);
        resolve();
      });
    });
    if (this.closed) {
      this.server.closeAllConnections();
      this.server.close();
      throw Error("Central workflow broker closed during startup");
    }
    const address = this.server.address();
    if (!address || typeof address === "string")
      throw Error("Missing broker address");
    this.endpoint = `http://127.0.0.1:${address.port}/central-workflow`;
    return this.endpoint;
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.endpoint = undefined;
    for (const controller of this.active)
      controller.abort(Error("Central workflow broker closed"));
    this.closing = new Promise<void>((resolve, reject) => {
      this.server.close((e) => {
        if (e && (e as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING")
          reject(e);
        else resolve();
      });
      this.server.closeAllConnections();
    });
    return this.closing;
  }
}

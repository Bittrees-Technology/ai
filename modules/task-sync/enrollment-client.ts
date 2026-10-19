import { request } from "node:http";
import { enrollmentOperation } from "./enrollment-transport-plan.js";
/** Core-side typed loopback client. Native startup must supply the capability;
 * no environment discovery, remote fetch fallback, enrollment or startup registration.
 */
export class EnrollmentClient {
  private readonly url: URL;
  constructor(
    endpoint: string,
    private readonly token: string,
  ) {
    this.url = new URL(endpoint);
    if (
      this.url.protocol !== "http:" ||
      this.url.hostname !== "127.0.0.1" ||
      !this.url.port ||
      this.url.pathname !== "/enrollment" ||
      this.url.username ||
      this.url.password ||
      this.url.search ||
      this.url.hash ||
      this.url.href !== endpoint ||
      !/^[a-f0-9]{64}$/.test(token)
    )
      throw Error("Invalid native enrollment capability");
  }
  async execute(raw: unknown, signal: AbortSignal): Promise<unknown> {
    signal.throwIfAborted();
    const body = JSON.stringify(enrollmentOperation.parse(raw));
    if (Buffer.byteLength(body) > 16000)
      throw Error("Enrollment request too large");
    const controller = new AbortController();
    const combined = AbortSignal.any([signal, controller.signal]);
    const timer = setTimeout(
      () => controller.abort(Error("Enrollment IPC deadline")),
      16000,
    );
    try {
      return await new Promise((resolve, reject) => {
        const req = request(
          this.url,
          {
            method: "POST",
            agent: false,
            signal: combined,
            headers: {
              "Content-Type": "application/json",
              "Content-Length": Buffer.byteLength(body),
              Authorization: "Bearer " + this.token,
              Connection: "close",
            },
          },
          (res) => {
            if (
              res.statusCode !== 200 ||
              res.headers["content-type"] !== "application/json" ||
              res.headers["content-encoding"]
            ) {
              res.destroy();
              reject(Error("Native enrollment unavailable"));
              return;
            }
            let size = 0;
            const chunks: Buffer[] = [];
            res.on("data", (chunk) => {
              size += chunk.length;
              if (size > 64000) {
                res.destroy();
                reject(Error("Enrollment response too large"));
              } else chunks.push(Buffer.from(chunk));
            });
            res.on("aborted", () =>
              reject(Error("Enrollment response interrupted")),
            );
            res.on("error", () =>
              reject(Error("Enrollment response unavailable")),
            );
            res.on("end", () => {
              try {
                combined.throwIfAborted();
                resolve(
                  JSON.parse(
                    new TextDecoder("utf-8", { fatal: true }).decode(
                      Buffer.concat(chunks),
                    ),
                  ),
                );
              } catch {
                reject(Error("Enrollment response invalid or cancelled"));
              }
            });
          },
        );
        req.on("error", () =>
          reject(Error("Native enrollment unavailable or cancelled")),
        );
        req.end(body);
      });
    } finally {
      clearTimeout(timer);
    }
  }
}

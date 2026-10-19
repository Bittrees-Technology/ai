import { request } from "node:http";
import { centralNativeInputSchema } from "./central-transport-plan.js";
/** Core-side typed loopback client. Native startup must supply the capability;
 * no environment discovery, remote fetch fallback, central workflow or startup registration.
 */
export class CentralNativeClient {
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
      this.url.pathname !== "/central-workflow" ||
      this.url.username ||
      this.url.password ||
      this.url.search ||
      this.url.hash ||
      this.url.href !== endpoint ||
      !/^[a-f0-9]{64}$/.test(token)
    )
      throw Error("Invalid native central workflow capability");
  }
  request: typeof fetch = async (input, options) => {
    if (
      String(input) !==
        "https://mcp.bittrees.org/mcp?mode=selected&projects=workflow" ||
      options?.method !== "POST" ||
      options.redirect !== "error" ||
      typeof options.body !== "string" ||
      !options.signal ||
      Buffer.byteLength(options.body) > 64000
    )
      throw Error("Unsupported central native request");
    const headers = new Headers(options.headers);
    if (
      [...headers.keys()].some(
        (key) =>
          !["authorization", "content-type", "x-bittrees-agent-proof"].includes(
            key,
          ),
      ) ||
      headers.get("content-type") !== "application/json"
    )
      throw Error("Unsupported central native headers");
    const proof = headers.get("x-bittrees-agent-proof");
    if (!proof || proof.length > 8000 || !/^[A-Za-z0-9_-]+$/.test(proof))
      throw Error("Missing central native proof");
    const raw = centralNativeInputSchema.parse({
      rpc: JSON.parse(options.body),
      proof: JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(
          Buffer.from(proof, "base64url"),
        ),
      ),
    });
    const bytes = await this.execute(raw, options.signal);
    return new Response(Buffer.from(bytes), {
      headers: { "content-type": "application/json" },
    });
  };
  async execute(raw: unknown, signal: AbortSignal): Promise<Uint8Array> {
    signal.throwIfAborted();
    const body = JSON.stringify(centralNativeInputSchema.parse(raw));
    if (Buffer.byteLength(body) > 70000)
      throw Error("Central workflow request too large");
    const controller = new AbortController();
    const combined = AbortSignal.any([signal, controller.signal]);
    const timer = setTimeout(
      () => controller.abort(Error("Central workflow IPC deadline")),
      21000,
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
              reject(Error("Native central workflow unavailable"));
              return;
            }
            let size = 0;
            const chunks: Buffer[] = [];
            res.on("data", (chunk) => {
              size += chunk.length;
              if (size > 64000) {
                res.destroy();
                reject(Error("Central workflow response too large"));
              } else chunks.push(Buffer.from(chunk));
            });
            res.on("aborted", () =>
              reject(Error("Central workflow response interrupted")),
            );
            res.on("error", () =>
              reject(Error("Central workflow response unavailable")),
            );
            res.on("end", () => {
              try {
                combined.throwIfAborted();
                const bytes = Buffer.concat(chunks);
                // Reject malformed UTF-8/JSON before forwarding the MCP envelope.
                JSON.parse(
                  new TextDecoder("utf-8", { fatal: true }).decode(bytes),
                );
                resolve(bytes);
              } catch {
                reject(Error("Central workflow response invalid or cancelled"));
              }
            });
          },
        );
        req.on("error", () =>
          reject(Error("Native central workflow unavailable or cancelled")),
        );
        req.end(body);
      });
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Fixed native execution capability only. Missing means no client or fallback here. */
export function nativeCentralClient(
  environment: NodeJS.ProcessEnv = process.env,
): CentralNativeClient | undefined {
  const endpoint = environment.BITTREES_CENTRAL_HELPER_URL,
    token = environment.BITTREES_CENTRAL_HELPER_TOKEN;
  if (!endpoint && !token) return undefined;
  if (!endpoint || !token) throw Error("Incomplete native central capability");
  return new CentralNativeClient(endpoint, token);
}

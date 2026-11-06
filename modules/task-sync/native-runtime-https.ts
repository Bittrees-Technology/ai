import { lookup } from "node:dns/promises";
import type { LookupAddress, LookupAllOptions } from "node:dns";
import { request } from "node:https";
import { publicIPv4 } from "../research/public-pages.js";

type Wire = {
  url: string;
  method: "GET" | "POST";
  body: string | null;
  proof: string | null;
};

function plan(input: Parameters<typeof fetch>[0], init?: RequestInit) {
  if (typeof input !== "string" || init?.redirect !== "error")
    throw Error("Unapproved task sync request");
  const url = new URL(input);
  if (url.href !== input || url.username || url.password || url.hash)
    throw Error("Noncanonical task sync URL");
  const source = input === "https://agent.bittrees.org/tasks.json";
  const connect = input === "https://mcp.bittrees.org/v1/task-sync/connect";
  const projects = url.searchParams.get("projects")?.split(",") ?? [];
  const rpc =
    url.origin === "https://mcp.bittrees.org" &&
    url.pathname === "/mcp" &&
    projects.length > 1 &&
    projects.length <= 101 &&
    projects[0] === "crm" &&
    new Set(projects).size === projects.length &&
    projects.every((project) => /^[a-z0-9-]{1,128}$/.test(project)) &&
    url.search ===
      "?" +
        new URLSearchParams({ mode: "selected", projects: projects.join(",") });
  const method = source ? "GET" : "POST";
  if (
    (!source && !connect && !rpc) ||
    init.method !== method ||
    (source ? init.body != null : typeof init.body !== "string") ||
    (typeof init.body === "string" && Buffer.byteLength(init.body) > 64000)
  )
    throw Error("Unapproved task sync request shape");
  const headers = new Headers(init.headers);
  const bearer = headers.get("authorization"),
    proof = headers.get("x-bittrees-agent-proof");
  if (
    [...headers.keys()].some(
      (key) =>
        ![
          "accept",
          "authorization",
          "content-type",
          "x-bittrees-agent-proof",
        ].includes(key),
    ) ||
    headers.get("accept") !== "application/json" ||
    headers.get("content-type") !== (source ? null : "application/json") ||
    (rpc
      ? !bearer || !/^Bearer [\x21-\x7e]{16,4096}$/.test(bearer)
      : bearer !== null) ||
    (proof !== null && (!rpc || !/^[A-Za-z0-9_-]{1,16384}$/.test(proof)))
  )
    throw Error("Unapproved task sync headers");
  const body = typeof init.body === "string" ? init.body : null;
  const wire: Wire = { url: input, method, body, proof };
  return {
    url,
    wire,
    bearer,
    limit: source ? 2_000_000 : connect ? 64000 : 256000,
  };
}

/** Native-only wire adapter. A trusted owner must provide current admission
 * for the exact request; this adapter never supplies authority or a bearer. */
export class TaskSyncNativeHTTPS {
  private resolving = false;
  constructor(
    private admit: (wire: Readonly<Wire>, signal: AbortSignal) => void,
    private resolve: (
      host: string,
      options: LookupAllOptions,
    ) => Promise<LookupAddress[]> = lookup,
    private send: typeof request = request,
  ) {}

  dispatch: typeof fetch = async (input, init) => {
    const { url, wire, bearer, limit } = plan(input, init);
    const timeout = AbortSignal.timeout(15000);
    const signal = init?.signal
      ? AbortSignal.any([init.signal, timeout])
      : timeout;
    const current = () => {
      signal.throwIfAborted();
      this.admit(Object.freeze(wire), signal);
      signal.throwIfAborted();
    };
    current();
    if (this.resolving) throw Error("Prior task sync DNS lookup still pending");
    this.resolving = true;
    const pending = Promise.resolve()
      .then(() => this.resolve(url.hostname, { all: true, family: 4 }))
      .finally(() => {
        this.resolving = false;
      });
    const answers = await new Promise<Awaited<typeof pending>>(
      (resolve, reject) => {
        const abort = () => reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
        pending
          .then(resolve, reject)
          .finally(() => signal.removeEventListener("abort", abort));
      },
    );
    current();
    if (
      !answers.length ||
      answers.some(
        ({ family, address }) =>
          family !== 4 ||
          !publicIPv4(address) ||
          address.startsWith("192.88.99."),
      )
    )
      throw Error("Task sync DNS address rejected");
    const address = answers[0]!.address;
    const headers = {
      Accept: "application/json",
      "Accept-Encoding": "identity",
      ...(wire.body === null
        ? {}
        : {
            "Content-Type": "application/json",
            "Content-Length": String(Buffer.byteLength(wire.body)),
          }),
      ...(bearer ? { Authorization: bearer } : {}),
      ...(wire.proof ? { "X-Bittrees-Agent-Proof": wire.proof } : {}),
    };
    return new Promise<Response>((resolve, reject) => {
      const req = this.send(
        url,
        {
          method: wire.method,
          headers,
          signal,
          agent: false,
          family: 4,
          rejectUnauthorized: true,
          servername: url.hostname,
          lookup: (_host, options, callback) =>
            options.all
              ? callback(null, [{ address, family: 4 }])
              : callback(null, address, 4),
        },
        (res) => {
          const status = res.statusCode ?? 0;
          res.on("error", reject);
          res.on("aborted", () =>
            reject(Error("Task sync response interrupted")),
          );
          if (
            status < 200 ||
            status > 599 ||
            (status >= 300 && status < 400) ||
            [204, 205].includes(status) ||
            !/^application\/json(?:;|$)/i.test(
              String(res.headers["content-type"] ?? ""),
            ) ||
            (res.headers["content-encoding"] &&
              res.headers["content-encoding"] !== "identity")
          ) {
            res.destroy();
            reject(Error("Task sync response status or encoding rejected"));
            return;
          }
          const chunks: Buffer[] = [];
          let size = 0;
          res.on("data", (chunk) => {
            size += chunk.length;
            if (size > limit)
              res.destroy(Error("Task sync response too large"));
            else chunks.push(Buffer.from(chunk));
          });
          res.on("end", () => {
            try {
              current();
              resolve(
                new Response(Buffer.concat(chunks), {
                  status,
                  headers: { "Content-Type": "application/json" },
                }),
              );
            } catch (error) {
              reject(error);
            }
          });
        },
      );
      req.on("error", reject);
      req.end(wire.body ?? undefined);
    });
  };
}

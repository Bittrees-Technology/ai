import { test as base } from "@playwright/test";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { createServer, request as httpsRequest } from "node:https";
import { createServer as createProxyServer } from "node:http";
import { connect, type Socket } from "node:net";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRemoteApp } from "../../../modules/remote/http.js";

async function startIdentityServer() {
  const origin = "https://ai.bittrees.org",
    schema = "browser_identity_" + randomUUID().replaceAll("-", "");
  let admin: Pool,
    pool: Pool,
    server: ReturnType<typeof createServer>,
    proxy: ReturnType<typeof createProxyServer>,
    folder: string,
    cert: Buffer,
    holdPath = "",
    dropPath = "",
    loseResponsePath = "",
    rejectPath = "",
    rejectSkip = 0,
    offline = false,
    heldIdentity = false,
    releaseIdentity: (() => void) | undefined;
  const sockets = new Set<Socket>();
  const events: string[] = [];

  function releaseHeld() {
    const resume = releaseIdentity;
    releaseIdentity = undefined;
    heldIdentity = false;
    resume?.();
  }
  async function close() {
    releaseHeld();
    for (const socket of sockets) socket.destroy();
    if (proxy) await new Promise<void>((r) => proxy.close(() => r()));
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    }
    await pool?.end();
    if (admin) {
      await admin.query("DROP SCHEMA IF EXISTS " + schema + " CASCADE");
      await admin.end();
    }
    if (folder) await rm(folder, { recursive: true, force: true });
  }
  try {
    const connectionString = process.env.BROWSER_TEST_DATABASE_URL;
    if (!connectionString)
      throw Error("Disposable browser test PostgreSQL is required");
    admin = new Pool({ connectionString });
    await admin.query("CREATE SCHEMA " + schema);
    pool = new Pool({ connectionString, options: "-c search_path=" + schema });
    for (const file of [
      "001-status",
      "002-pairing",
      "003-sessions",
      "004-controls",
      "005-control-scope",
      "006-maintenance",
      "007-templates",
      "008-browser-devices",
      "009-private-relay-access",
      "010-private-relay-messages",
      "011-mcp-delegation",
      "012-retention-90-days",
      "013-history-retention-indexes",
    ])
      await pool.query(
        await readFile(
          new URL(
            `../../../modules/remote/migrations/${file}.sql`,
            import.meta.url,
          ),
          "utf8",
        ),
      );
    folder = await mkdtemp(join(tmpdir(), "bittrees-browser-identity-tls-"));
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-days",
        "1",
        "-subj",
        "/CN=ai.bittrees.org",
        "-addext",
        "subjectAltName=DNS:ai.bittrees.org,DNS:localhost",
        "-keyout",
        join(folder, "key.pem"),
        "-out",
        join(folder, "cert.pem"),
      ],
      { stdio: "ignore" },
    );
    cert = await readFile(join(folder, "cert.pem"));
    let privateRelayEnabled = false, mcpClientCredentialHash: string | undefined;
    const newApp = () =>
      createRemoteApp(pool, {
        origin,
        chainId: 1,
        sessionMs: 3600000,
        deviceMs: 7200000,
        retentionMs: 86400000,
        requestsPerMinute: 1000,
        mcpClientCredentialHash,
        ...(privateRelayEnabled
          ? {
              privateRelayPolicy: {
                version: 1,
                origin,
                chainId: 1,
                receivedContent: "until-deleted",
                unreceivedContent: { mode: "until-deleted" },
                operationalMetadataMs: 604800000,
                maxMessagesPerOwner: 100,
                maxBytesPerOwner: 1048576,
              },
            }
          : {}),
        assets: fileURLToPath(
          new URL("../../../dist/remote-web/", import.meta.url),
        ),
      });
    let app = newApp();
    server = createServer(
      { key: await readFile(join(folder, "key.pem")), cert },
      async (req, res) => {
        const url = new URL(req.url!, origin);
        if (req.headers.host !== "ai.bittrees.org") {
          res.writeHead(403).end();
          return;
        }
        if (
          url.pathname.startsWith("/browser/") ||
          url.pathname.startsWith("/device/")
        ) {
          events.push(url.pathname);
          if (offline) {
            res
              .writeHead(503, { "content-type": "application/json" })
              .end('{"error":"UNAVAILABLE"}');
            return;
          }
          if (rejectPath === url.pathname && rejectSkip-- <= 0) {
            rejectPath = "";
            res
              .writeHead(503, { "content-type": "application/json" })
              .end('{"error":"UNAVAILABLE"}');
            return;
          }
          if (loseResponsePath === url.pathname) {
            loseResponsePath = "";
            const end = res.end.bind(res);
            // Preserve the committed operation but replace its reply. A complete
            // error response avoids Chromium's transparent connection-level retry.
            res.end = (() => {
              res.statusCode = 503;
              res.removeHeader("content-length");
              res.removeHeader("etag");
              res.setHeader("content-type", "application/json");
              return end('{"error":"UNAVAILABLE"}');
            }) as typeof res.end;
          }
          if (dropPath === url.pathname) {
            dropPath = "";
            res.end = (() => {
              res.destroy();
              return res;
            }) as typeof res.end;
          }
          if (holdPath === url.pathname) {
            holdPath = "";
            const end = res.end.bind(res);
            res.end = ((...args: Parameters<typeof end>) => {
              heldIdentity = true;
              releaseIdentity = () => {
                end(...args);
              };
              return res;
            }) as typeof res.end;
          }
          res.on("finish", () => {
            if (res.statusCode >= 400)
              console.error("Browser identity fixture rejection", {
                path: url.pathname,
                status: res.statusCode,
                origin: req.headers.origin,
                fetchSite: req.headers["sec-fetch-site"],
                cookieNames: (req.headers.cookie ?? "")
                  .split(";")
                  .map((part) => part.trim().split("=")[0]),
              });
          });
          app(req, res);
          return;
        }
        // Exercise the actual shipped status page and CSP in auth acceptance.
        if (
          [
            "/remote-panel",
            "/app.js",
            "/favicon.svg",
            "/controller.js",
            "/style.css",
            "/settings.json",
          ].includes(url.pathname) ||
          url.pathname.startsWith("/assets/remote-")
        ) {
          if (url.pathname === "/remote-panel") req.url = "/";
          app(req, res);
          return;
        }
        // Assets also travel over real HTTPS; only the local built fixture is read.
        try {
          const asset = await fetch(
            "http://127.0.0.1:44137" + url.pathname + url.search,
          );
          res.writeHead(asset.status, {
            "content-type": asset.headers.get("content-type") ?? "text/plain",
            "cache-control": "no-store",
          });
          res.end(Buffer.from(await asset.arrayBuffer()));
        } catch {
          res.writeHead(502).end();
        }
      },
    );
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    // A closed CONNECT tunnel preserves the browser's actual network/cookie stack.
    // No DNS lookup or connection to the named public site is ever performed.
    proxy = createProxyServer((_req, res) => {
      res.writeHead(403).end();
    });
    proxy.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    proxy.on("connect", (req, client, head) => {
      if (req.url !== "ai.bittrees.org:443") {
        client.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
        return;
      }
      const upstream = connect(
        (server.address() as { port: number }).port,
        "127.0.0.1",
        () => {
          client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
          if (head.length) upstream.write(head);
          client.pipe(upstream);
          upstream.pipe(client);
        },
      );
      sockets.add(upstream);
      upstream.on("close", () => {
        sockets.delete(upstream);
        client.destroy();
      });
      client.on("close", () => upstream.destroy());
      upstream.on("error", () => client.destroy());
      client.on("error", () => upstream.destroy());
    });
    await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", r));
    // Native test traffic uses actual TLS and the disposable certificate. Exact
    // origin/path mapping never performs DNS or contacts the public website.
    const nativeTransport: typeof fetch = async (raw, init) => {
      const url = new URL(String(raw));
      if (url.origin !== origin || !url.pathname.startsWith("/device/"))
        throw Error("Unexpected native test destination");
      return new Promise<Response>((resolve, reject) => {
        const request = httpsRequest(
          {
            host: "127.0.0.1",
            port: (server.address() as { port: number }).port,
            servername: "ai.bittrees.org",
            ca: cert,
            path: url.pathname + url.search,
            method: init?.method ?? "GET",
            headers: {
              ...Object.fromEntries(new Headers(init?.headers).entries()),
              Host: "ai.bittrees.org",
            },
            signal: init?.signal ?? undefined,
          },
          (response) => {
            const chunks: Buffer[] = [];
            response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
            response.on("error", reject);
            response.on("end", () => {
              const headers = new Headers();
              for (const [key, value] of Object.entries(response.headers))
                if (value !== undefined)
                  headers.set(
                    key,
                    Array.isArray(value) ? value.join(", ") : value,
                  );
              const status = response.statusCode!;
              const result = new Response(
                [204, 205, 304].includes(status) ? null : Buffer.concat(chunks),
                { status, headers },
              );
              Object.defineProperty(result, "url", { value: String(raw) });
              resolve(result);
            });
          },
        );
        request.on("error", reject);
        request.setTimeout(10000, () =>
          request.destroy(Error("Native test request timed out")),
        );
        request.end(init?.body);
      });
    };
    return {
      nativeTransport,
      pool,
      proxyUrl: `http://127.0.0.1:${(proxy.address() as { port: number }).port}`,
      events,
      reset() {
        releaseHeld();
        // Each test gets an independent in-memory per-IP request budget. The
        // real limiter still applies within that test, including all its tabs.
        // Retained server authority remains in the same disposable PostgreSQL.
        privateRelayEnabled = false;
        mcpClientCredentialHash = undefined;
        app = newApp();
        holdPath = "";
        dropPath = "";
        loseResponsePath = "";
        rejectPath = "";
        rejectSkip = 0;
        heldIdentity = false;
        releaseIdentity = undefined;
        offline = false;
        events.length = 0;
      },
      enableMcp(hash: string) { mcpClientCredentialHash = hash; app = newApp(); },
      enablePrivateRelay() {
        privateRelayEnabled = true;
        app = newApp();
      },
      hold(path = "/browser/registration/identity") {
        holdPath = path;
        heldIdentity = false;
      },
      held: () => heldIdentity,
      release() {
        releaseIdentity?.();
        releaseIdentity = undefined;
      },
      offline(value: boolean) {
        offline = value;
      },
      drop(path: string) {
        dropPath = path;
      },
      loseResponse(path: string) {
        loseResponsePath = path;
      },
      reject(path: string, skip = 0) {
        rejectPath = path;
        rejectSkip = skip;
      },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
export const test = base.extend<
  {},
  { identityServer: Awaited<ReturnType<typeof startIdentityServer>> }
>({
  identityServer: [
    async ({}, use) => {
      const server = await startIdentityServer();
      try {
        await use(server);
      } finally {
        await server.close();
      }
    },
    { scope: "worker" },
  ],
  context: async ({ browser, identityServer }, use) => {
    identityServer.reset();
    const context = await browser.newContext({
      proxy: { server: identityServer.proxyUrl },
      ignoreHTTPSErrors: true,
    });
    try {
      await use(context);
    } finally {
      await context.close();
    }
  },
});

import { test as base } from "@playwright/test";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { createServer } from "node:https";
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
    offline = false,
    heldIdentity = false,
    releaseIdentity: (() => void) | undefined;
  const sockets = new Set<Socket>();
  const events: string[] = [];

  async function close() {
    releaseIdentity?.();
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
    const app = createRemoteApp(pool, {
      origin,
      chainId: 1,
      sessionMs: 3600000,
      deviceMs: 7200000,
      retentionMs: 86400000,
      requestsPerMinute: 1000,
      assets: fileURLToPath(
        new URL("../../../dist/remote-web/", import.meta.url),
      ),
    });
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
    return {
      pool,
      proxyUrl: `http://127.0.0.1:${(proxy.address() as { port: number }).port}`,
      events,
      reset() {
        releaseIdentity?.();
        holdPath = "";
        dropPath = "";
        heldIdentity = false;
        releaseIdentity = undefined;
        offline = false;
        events.length = 0;
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

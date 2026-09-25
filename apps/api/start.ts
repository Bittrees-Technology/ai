import { open } from "node:fs/promises";
import { Pool } from "pg";
import { createRemoteServer, remoteServerConfigSchema } from "./server.js";

// No default host, database, certificates or automatic migration/cleanup.
async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== "--config" || !args[1])
    throw Error("configuration required");
  const file = await open(args[1], "r");
  let raw: unknown;
  try {
    const data = Buffer.alloc(16385);
    const { bytesRead } = await file.read(data, 0, data.length, 0);
    if (bytesRead > 16384) throw Error("configuration too large");
    raw = JSON.parse(data.subarray(0, bytesRead).toString("utf8"));
  } finally {
    await file.close();
  }
  const config = remoteServerConfigSchema.parse(raw);
  const connectionString = process.env.REMOTE_DATABASE_URL;
  if (!connectionString) throw Error("database required");
  const pool = new Pool({
    connectionString,
    max: 5,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
    statement_timeout: 10000,
    application_name: "bittrees-remote-api",
  });
  let service: Awaited<ReturnType<typeof createRemoteServer>> | undefined;
  try {
    service = await createRemoteServer(pool, config);
    const ready = await pool.query(
      "SELECT to_regclass('remote_mcp_history_expiry') IS NOT NULL AS ready",
    );
    if (ready.rows[0]?.ready !== true)
      throw Error("remote migrations required");
    const { server } = service;
    let stopping = false;
    const shutdown = () => {
      if (stopping) return;
      stopping = true;
      process.off("SIGINT", shutdown);
      process.off("SIGTERM", shutdown);
      const deadline = setTimeout(() => {
        server.closeAllConnections();
        process.exit(1);
      }, 10000);
      deadline.unref();
      server.close(() => {
        void pool.end().then(
          () => {
            clearTimeout(deadline);
          },
          () => {
            process.exitCode = 1;
            clearTimeout(deadline);
          },
        );
      });
      server.closeIdleConnections();
    };
    pool.on("error", () => {
      process.exitCode = 1;
      console.error("Remote database unavailable; stopping service.");
      shutdown();
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(config.listenPort, config.listenHost, () => {
        server.off("error", reject);
        resolve();
      });
    });
    server.on("error", () => {
      process.exitCode = 1;
      console.error("Remote listener failed; stopping service.");
      shutdown();
    });
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
    console.log(
      "Remote HTTPS service ready. Optional relay/MCP access follows the supplied configuration and user grants.",
    );
  } catch {
    service?.server.closeAllConnections();
    if (service?.server.listening) service.server.close();
    await pool.end();
    throw Error("startup failed");
  }
}
main().catch(() => {
  console.error(
    "Remote startup failed. Check explicit configuration, built assets, TLS files and database access. No configuration values are logged.",
  );
  process.exitCode = 1;
});

import { researchBatches } from "../modules/coordinator/research.js";
import { checkWorkflowAuthority } from "../modules/coordinator/authority-client.js";
import { LocalAuthority } from "../modules/coordinator/local-authority.js";
import { setTimeout as delay } from "node:timers/promises";
import Database from "better-sqlite3";
import { readFile, mkdir, stat, chmod } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  loadStorageKey,
  macKeychainEntry,
} from "../modules/storage/keychain.js";
import { Vault } from "../modules/storage/vault.js";
import { LocalRunStore } from "../modules/coordinator/local-store.js";
import { MarketplaceCoordinator } from "../modules/coordinator/workflow.js";
import { syncLocalStatus } from "../modules/coordinator/status-sync.js";
process.umask(0o077);
const dir = join(
  homedir(),
  "Library",
  "Application Support",
  "Bittrees AI",
  "marketplace",
);
await mkdir(dir, { recursive: true, mode: 0o700 });
const file = join(dir, "runs.sqlite");
const key = await loadStorageKey(
  macKeychainEntry("marketplace-coordinator"),
  await stat(file).then(
    () => true,
    () => false,
  ),
);
const vault = new Vault(key);
const settings = vault.open<{
  ownerId: string;
  mcpToken: string;
  syncToken: string;
  expiresAt: number | null;
  managed?: boolean;
  automatic?: boolean;
  controlToken?: string;
}>(await readFile(join(dir, "connection.enc")), "marketplace-connection");
const db = new Database(file);
await chmod(file, 0o600);
try {
  const store = new LocalRunStore(db, vault);
  const authority = new LocalAuthority(db);
  const [command, path] = process.argv.slice(2);
  if (command === "revoke-cloud" || command === "cloud-status") {
    if (!settings.controlToken)
      throw Error("Cloud control credential unavailable");
    const response = await fetch(
      "https://ai.bittrees.org/api/workflow-authority",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${settings.controlToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          action: command === "revoke-cloud" ? "revoke" : "status",
        }),
        redirect: "error",
        signal: AbortSignal.timeout(10000),
      },
    );
    if (!response.ok)
      throw Error("Cloud control failed; do not assume revocation succeeded");
    console.log(JSON.stringify(await response.json()));
  } else if (
    command === "grant" ||
    command === "revoke" ||
    command === "grants"
  ) {
    if (command === "grant") {
      if (!["until-revoked", "automatic-until-revoked"].includes(path || ""))
        throw Error("Choose a grant mode");
      console.log(
        JSON.stringify({
          grantId: authority.grant(
            settings.ownerId,
            "until-revoked",
            path === "automatic-until-revoked",
          ),
        }),
      );
    } else if (command === "revoke") {
      if (!path) throw Error("Grant ID required");
      authority.revoke(settings.ownerId, path);
      console.log("Grant revoked (if present).");
    } else console.log(JSON.stringify(authority.list(settings.ownerId)));
  } else {
    const grantId = process.env.MARKETPLACE_GRANT_ID;
    if (!grantId)
      throw Error(
        "MARKETPLACE_GRANT_ID is required; create an explicit local grant first",
      );
    const authorize = (owner: string, action: string) =>
      authority.check(owner, grantId, action);
    const coordinator = new MarketplaceCoordinator(
      store,
      [
        {
          ownerId: settings.ownerId,
          token: settings.mcpToken,
          expiresAt: settings.expiresAt,
          managed: settings.managed,
          automatic: settings.automatic,
        },
      ],
      fetch,
      authorize,
    );
    db.exec(
      "CREATE TABLE IF NOT EXISTS marketplace_schedule(owner TEXT PRIMARY KEY,last_research INTEGER NOT NULL)",
    );
    do {
      if (settings.controlToken) {
        const heartbeat = await fetch("https://ai.bittrees.org/api/workflows", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: "Bearer " + settings.controlToken,
          },
          body: JSON.stringify({
            action: "device",
            input: { action: "heartbeat" },
          }),
          signal: AbortSignal.timeout(15000),
          redirect: "error",
        });
        if (!heartbeat.ok) throw Error("Workflow device unavailable");
        const { grant } = await heartbeat.json();
        if (
          grant.revoked_at ||
          grant.paused_at ||
          (grant.require_wallet && !grant.signed_at) ||
          (grant.approval_expires_at &&
            new Date(grant.approval_expires_at).getTime() <= Date.now())
        ) {
          console.log(
            JSON.stringify({
              workflowPaused: true,
              walletApprovalRequired: !grant.signed_at,
            }),
          );
          break;
        }
      }
      authorize(settings.ownerId, "sync");
      if (
        command === "research" ||
        command === "watch" ||
        command === "cycle"
      ) {
        const last =
          (
            db
              .prepare(
                "SELECT last_research FROM marketplace_schedule WHERE owner=?",
              )
              .get(settings.ownerId) as { last_research: number } | undefined
          )?.last_research || 0;
        const due =
          command === "research" || Date.now() - last >= 6 * 60 * 60 * 1000;
        const openRuns = (
          await Promise.all(
            store
              .ids(settings.ownerId)
              .map((id) => coordinator.get(settings.ownerId, id)),
          )
        ).filter((run) =>
          run.steps.some((step) => step.state !== "decided"),
        ).length;
        // Reserve room for both research batches inside the source's ten-preview limit.
        if (due && openRuns > 8)
          console.log(
            JSON.stringify({
              researchDeferred:
                "Review backlog: resolve existing batches before researching more.",
            }),
          );
        if (due && openRuns <= 8) {
          const guard = async (host?: string) => {
            authorize(settings.ownerId, "create");
            if (settings.managed)
              await checkWorkflowAuthority(
                settings.mcpToken,
                "mcp",
                "sources:propose",
              );
            if (!host) return; // Cloud/local checks still run; domain permissions are checked per vendor and before batching.
            const r = await fetch(
              "https://mcp.bittrees.org/mcp?mode=selected&projects=crm,mercado",
              {
                method: "POST",
                headers: {
                  authorization: `Bearer ${settings.mcpToken}`,
                  "content-type": "application/json",
                  "mcp-protocol-version": "2025-06-18",
                },
                body: JSON.stringify({
                  jsonrpc: "2.0",
                  id: "brief",
                  method: "tools/call",
                  params: { name: "source_crm_brief", arguments: {} },
                }),
                redirect: "error",
                signal: AbortSignal.timeout(20000),
              },
            );
            const value = (await r.json()) as any;
            const brief = value.result?.structuredContent?.brief;
            if (
              !r.ok ||
              !brief?.allowTasks ||
              (host && !brief.sourceDomains?.includes(host))
            )
              throw Error("Research brief authority unavailable");
          };
          const runs = await researchBatches(
            db,
            settings.ownerId,
            async (input) => {
              try {
                return await coordinator.get(
                  settings.ownerId,
                  (input as { id: string }).id,
                );
              } catch (error) {
                if (
                  !(error instanceof Error) ||
                  error.message !== "Run not found"
                )
                  throw error;
              }
              return coordinator.create(settings.ownerId, input);
            },
            guard,
          );
          db.prepare(
            "INSERT INTO marketplace_schedule VALUES(?,?) ON CONFLICT(owner) DO UPDATE SET last_research=excluded.last_research",
          ).run(settings.ownerId, Date.now());
          console.log(JSON.stringify({ researchRuns: runs }));
        }
      }
      if (command === "create" && path) {
        const input = JSON.parse(await readFile(path, "utf8"));
        console.log(
          JSON.stringify(await coordinator.create(settings.ownerId, input)),
        );
      } else if (
        command === "advance" ||
        command === "watch" ||
        command === "cycle"
      ) {
        for (const id of store.ids(settings.ownerId).slice(0, 5)) {
          const run = await coordinator.get(settings.ownerId, id);
          if (run.steps.some((s) => s.state !== "decided"))
            console.log(
              JSON.stringify(await coordinator.advance(settings.ownerId, id)),
            );
        }
      } else if (command !== "sync" && command !== "research")
        throw Error(
          "Use create <batch.json>, advance, watch, sync, grant until-revoked, grants, or revoke <id>",
        );
      authorize(settings.ownerId, "sync");
      await syncLocalStatus(
        store,
        settings.ownerId,
        settings.syncToken,
        fetch,
        () => authorize(settings.ownerId, "sync"),
      );
      if (command === "watch") await delay(60000);
    } while (command === "watch");
  }
} finally {
  db.close();
  key.fill(0);
}

import { cloudAuthority } from "../modules/coordinator/cloud-authority.js";
// Dedicated disposable database only. Requires sibling source checkouts for all three apps.
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { Pool } from "pg";
import { MarketplaceCoordinator } from "../modules/coordinator/workflow.js";
const url = process.env.COORDINATOR_TEST_DATABASE_URL;
if (!url || !/^postgres:\/\/[^/]*127\.0\.0\.1:\d+\/coordinator_e2e$/.test(url))
  throw Error("Dedicated local coordinator_e2e database required");
process.env.DATABASE_URL = url;
process.env.CRM_LEADS_ENABLED = "true";
const root = resolve("..");
const load = (file: string) => import(pathToFileURL(resolve(root, file)).href);
const crm = await load("workflow-crm/lib/leads.ts");
const crmDb = await load("workflow-crm/lib/db.ts");
const { coordinatorRequest, coordinatorGrant } = await load(
  "workflow-marcada/lib/coordinator.mjs",
);
const { SourceConnections } = await load(
  "workflow-mcp/src/service/source-connections.mjs",
);
const { createMcpHandler } = await load("workflow-mcp/src/service/http.mjs");
const pool = new Pool({ connectionString: url });
await pool.query(crmDb.schema);
await pool.query(
  await readFile(resolve(root, "workflow-marcada/schema.sql"), "utf8"),
);
await pool.query(
  await readFile(
    "modules/remote/migrations/marketplace-coordinator.sql",
    "utf8",
  ),
);
await pool.query(
  await readFile("modules/remote/migrations/workflow-authority.sql", "utf8"),
);
await pool.query(
  await readFile(
    "modules/remote/migrations/workflow-wallet-permissions.sql",
    "utf8",
  ),
);
const nativeFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  if (String(url) === "https://ai.bittrees.org/api/workflow-authority") {
    try {
      return new Response(
        JSON.stringify(
          await cloudAuthority(
            pool,
            new Headers(init?.headers).get("authorization")!.slice(7),
            JSON.parse(String(init?.body)),
          ),
        ),
      );
    } catch {
      return new Response("{}", { status: 403 });
    }
  }
  if (String(url) === "https://miners.de/cart.js")
    return Response.json({ currency: "EUR" });
  if (String(url).startsWith("https://miners.de/products/auto-test-"))
    return Response.json({
      title: "Antminer S21 200TH/s " + owner,
      description: String(url).includes("hold")
        ? "PRE-ORDER ships December 2026"
        : "200 TH/s SHA-256 miner, 3500W.",
      variants: [{ id: 1, available: true, price: 100000 }],
      images: ["https://cdn.shopify.com/s/files/test.jpg"],
    });
  return nativeFetch(url, init);
};
const owner = randomUUID(),
  workspace = randomUUID();
await pool.query("INSERT INTO users(id,name) VALUES($1,$2)", [
  owner,
  "Synthetic coordinator test",
]);
await pool.query("INSERT INTO workspaces(id,name) VALUES($1,$2)", [
  workspace,
  "Synthetic test",
]);
await pool.query("INSERT INTO members VALUES($1,$2,'owner',NULL)", [
  workspace,
  owner,
]);
const brief = await crm.createSearch(owner, {
  workspaceId: workspace,
  brief: {
    target: "Mining equipment vendors",
    sourceDomains: ["bittrees.org", "miners.de"],
    allowTasks: true,
  },
});
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const sourceToken = "d".repeat(64),
  mcpToken = "e".repeat(64);
const grant: any = {
  identity: `coordinator:${owner}`,
  tokenHash: hash(sourceToken),
  expiresAt: Date.now() + 3600000,
  collections: ["asic"],
};
const actor: any = {
  tenant: "test",
  subject: owner,
  tokenHash: hash(mcpToken),
  audience: "https://mcp.bittrees.org",
  expiresAt: Date.now() + 3600000,
  projectIds: ["crm", "mercado"],
  permissions: ["catalog:read", "sources:propose"],
};
const authorityId = randomUUID(),
  control = "f".repeat(64) + randomUUID().replaceAll("-", "");
const controlToken = createHash("sha256").update(control).digest("hex");
await pool.query(
  "INSERT INTO workflow_authorities(id,owner_id,control_hash) VALUES($1,$2,$3)",
  [authorityId, owner, hash(controlToken)],
);
for (const [token, audience, scopes] of [
  [mcpToken, "mcp", ["sources:propose"]],
  [sourceToken, "mercado", ["propose"]],
  [brief.token, "crm", ["propose"]],
] as const) {
  await pool.query(
    "INSERT INTO workflow_credentials(token_hash,authority_id,audience,scopes) VALUES($1,$2,$3,$4) ON CONFLICT(token_hash) DO UPDATE SET authority_id=excluded.authority_id",
    [hash(token), authorityId, audience, JSON.stringify(scopes)],
  );
}
actor.managed = true;
actor.expiresAt = null;
grant.managed = true;
grant.expiresAt = null;
await pool.query(
  "UPDATE lead_searches SET standing=true,authority_managed=true,expires_at=NULL WHERE id=$1",
  [brief.id],
);
const sql = async (strings: TemplateStringsArray, ...values: unknown[]) =>
  (
    await pool.query(
      strings.reduce((s, v, i) => s + (i ? "$" + i : "") + v, ""),
      values,
    )
  ).rows;
let loseReply = true;
const sourceServer = createServer(async (req, res) => {
  try {
    let raw = "";
    for await (const c of req) raw += c;
    const body = JSON.parse(raw),
      path = req.url!;
    let data;
    if (path.startsWith("/api/integrations/leads/")) {
      const token = req.headers.authorization!.slice(7);
      data = path.endsWith("/status")
        ? await crm.agentStatus(token, body)
        : path.endsWith("/execute")
          ? await crm.executeQualifiedLeads(token, body)
          : path.endsWith("/brief")
            ? await crm.agentBrief(token)
            : await crm.prepare(token, body);
    } else
      data = await coordinatorRequest(
        sql,
        coordinatorGrant(req.headers.authorization, [grant]),
        path.split("/").pop(),
        body,
      );
    if (path.endsWith("/prepare") && loseReply) {
      loseReply = false;
      req.socket.destroy();
      return;
    }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(data));
  } catch (e: any) {
    console.error("Test source failure:", e.message);
    res.statusCode = e.status || e.statusCode || 400;
    res.end(JSON.stringify({ error: e.message }));
  }
});
await new Promise<void>((r) => sourceServer.listen(0, "127.0.0.1", r));
const port = (sourceServer.address() as any).port;
const sourceFetch: typeof fetch = (input, init) =>
  fetch(`http://127.0.0.1:${port}${new URL(String(input)).pathname}`, init);
const sourceConnections = new SourceConnections(
  ["crm", "mercado"].map((source) => ({
    ...actor,
    actorTokenHash: actor.tokenHash,
    source,
    token: source === "crm" ? brief.token : sourceToken,
  })),
  sourceFetch,
);
const server = createServer(
  createMcpHandler({ credentials: [actor], sourceConnections }),
);
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const mcpPort = (server.address() as any).port;
const localFetch: typeof fetch = (input, init) => {
  const u = new URL(String(input));
  return fetch(`http://127.0.0.1:${mcpPort}${u.pathname}${u.search}`, init);
};
const connections = [
  { ownerId: owner, token: mcpToken, expiresAt: null, managed: true },
];
let ai = new MarketplaceCoordinator(pool, connections, localFetch);
const c = {
  name: "Synthetic hardware vendor",
  website: "https://bittrees.org",
  summary: "Test evidence",
  relevance: "Mining equipment",
  uncertainties: "Synthetic; not for publication",
  fit: "high",
  evidence: "primary",
  sources: [
    { url: "https://bittrees.org", retrievedAt: new Date().toISOString() },
  ],
};
const input = {
  id: randomUUID(),
  crm: {
    candidates: [
      c,
      {
        ...c,
        kind: "people",
        name: "Synthetic sales contact",
        organizationIndex: 0,
      },
      {
        ...c,
        kind: "tasks",
        name: "Verify shipping and terms",
        organizationIndex: 0,
        contactIndex: 1,
        category: "Vendor follow-up",
      },
    ],
  },
  mercado: [
    {
      product: {
        product_id: "asic",
        name: "Synthetic miner",
        description: "Test only",
        source_url: "https://bittrees.org",
        source_name: "Synthetic vendor",
        price: 100,
        currency: "USD",
      },
    },
  ],
};
try {
  await ai.create(owner, input);
  await ai.create(owner, input);
  await assert.rejects(ai.get(randomUUID(), input.id));
  await assert.rejects(ai.create(owner, { ...input, mercado: [] }));
  for (let i = 0; i < 5; i++) await ai.advance(owner, input.id);
  ai = new MarketplaceCoordinator(pool, connections, localFetch); // durable restart
  let run = await ai.get(owner, input.id);
  assert(
    run.steps.every((s: any) => s.state === "awaiting_review"),
    JSON.stringify(run),
  );
  const crmStep = run.steps.find((s: any) => s.source === "crm");
  const review = await crm.review(owner, (crmStep as any).receipt.reviewId);
  await assert.rejects(
    crm.approve(owner, {
      reviewId: review.id,
      digest: review.digest,
      accept: [2],
    }),
  );
  await crm.approve(owner, {
    reviewId: review.id,
    digest: review.digest,
    accept: [0, 1, 2],
  });
  await crm.approve(owner, {
    reviewId: review.id,
    digest: review.digest,
    accept: [0, 1, 2],
  });
  const records = (
    await pool.query("SELECT kind,data FROM records WHERE workspace_id=$1", [
      workspace,
    ])
  ).rows;
  assert.equal(records.length, 3);
  assert(records.find((r) => r.kind === "tasks").data.personId);
  // Exercise the same review status transition as Mercado's existing staff action.
  const product = run.steps.find((s: any) => s.source === "mercado")!;
  await pool.query(
    "UPDATE marcada.product_submissions SET status='reviewed' WHERE id=$1",
    [product.operationId],
  );
  for (let i = 0; i < 4; i++) await ai.advance(owner, input.id);
  run = await ai.get(owner, input.id);
  assert(run.steps.every((s: any) => s.state === "decided"));
  assert.equal(
    (
      await pool.query(
        "SELECT count(*) FROM marcada.product_submissions WHERE identity=$1",
        [grant.identity],
      )
    ).rows[0].count,
    "1",
  );
  await assert.rejects(
    coordinatorRequest(sql, { ...grant, bearer: sourceToken }, "execute", {
      operationId: product.operationId,
    }),
  );
  actor.permissions.push("sources:execute");
  grant.automaticPolicy = "mercado-qualified-v1";
  process.env.CRM_MARKETPLACE_EXECUTION_ASSIGNMENTS = JSON.stringify([
    brief.id,
  ]);
  for (const [token, scopes] of [
    [mcpToken, ["sources:propose", "sources:execute"]],
    [sourceToken, ["propose", "publish:qualified"]],
    [brief.token, ["propose", "import:qualified"]],
  ] as const)
    await pool.query(
      "UPDATE workflow_credentials SET scopes=$2 WHERE token_hash=$1",
      [hash(token), JSON.stringify(scopes)],
    );
  ai = new MarketplaceCoordinator(
    pool,
    connections.map((c) => ({ ...c, automatic: true })),
    localFetch,
  );
  const vendor = {
    ...c,
    kind: "organizations",
    name: "Miners.de",
    website: "https://miners.de",
    sources: [
      { url: "https://miners.de", retrievedAt: new Date().toISOString() },
    ],
  };
  const autoInput = {
    id: randomUUID(),
    crm: {
      candidates: [
        vendor,
        {
          ...vendor,
          kind: "tasks",
          name: "Miners.de: verify automatic test",
          organizationIndex: 0,
        },
      ],
    },
    mercado: ["good", "hold"].map((suffix) => ({
      product: {
        product_id: "asic",
        name: "Antminer S21 200TH/s " + owner,
        description: "Source verification required",
        source_url:
          "https://miners.de/products/auto-test-" + suffix + "-" + owner,
        source_name: "Miners.de",
        price: 1000,
        currency: "EUR",
      },
    })),
  };
  await ai.create(owner, autoInput);
  for (let i = 0; i < 6; i++) await ai.advance(owner, autoInput.id);
  const autoRun = await ai.get(owner, autoInput.id);
  assert(
    autoRun.steps.every((s) => s.state === "decided"),
    JSON.stringify(autoRun),
  );
  const autoItems = (
    await pool.query("SELECT * FROM marcada.items WHERE source_url LIKE $1", [
      "https://miners.de/products/auto-test-%" + owner,
    ])
  ).rows;
  assert.equal(autoItems.length, 1);
  assert.equal(autoItems[0].active, true);
  assert.equal(autoItems[0].hashrate, "200TH/S");
  assert.equal(
    autoRun.steps.filter(
      (s: any) => s.receipt?.decision === "changes_requested",
    ).length,
    1,
  );
  const repeatOperation = randomUUID();
  await crm.prepare(brief.token, {
    operationId: repeatOperation,
    candidates: autoInput.crm.candidates,
  });
  const replay = await crm.executeQualifiedLeads(brief.token, {
    operationId: repeatOperation,
  });
  assert.equal(replay.state, "decided");
  assert.equal(
    (
      await pool.query(
        "SELECT count(*) FROM records WHERE workspace_id=$1 AND data->>'website'='https://miners.de'",
        [workspace],
      )
    ).rows[0].count,
    "2",
  );
  for (const step of autoRun.steps)
    await sourceConnections.call(
      actor,
      ["crm", "mercado"],
      "source_" + step.source + "_execute",
      { operationId: step.operationId },
    );
  assert.equal(
    (
      await pool.query(
        "SELECT count(*) FROM marcada.items WHERE source_url LIKE $1",
        ["https://miners.de/products/auto-test-%" + owner],
      )
    ).rows[0].count,
    "1",
  );
  const second = await crm.prepare(brief.token, {
    operationId: randomUUID(),
    candidates: input.crm.candidates,
  });
  assert.equal(second.state, "awaiting_review");
  await pool.query(
    "UPDATE members SET role='viewer' WHERE workspace_id=$1 AND user_id=$2",
    [workspace, owner],
  );
  await assert.rejects(crm.agentBrief(brief.token));
  await pool.query(
    "UPDATE members SET role='owner' WHERE workspace_id=$1 AND user_id=$2",
    [workspace, owner],
  );
  await assert.rejects(
    cloudAuthority(pool, mcpToken, {
      action: "check",
      audience: "crm",
      scope: "propose",
    }),
  );
  await cloudAuthority(pool, controlToken, { action: "revoke" });
  await assert.rejects(crm.agentBrief(brief.token));
  await assert.rejects(
    coordinatorRequest(sql, { ...grant, bearer: sourceToken }, "status", {
      operationId: product.operationId,
    }),
  );
  await assert.rejects(
    sourceConnections.call(actor, ["crm", "mercado"], "source_crm_status", {
      operationId: crmStep!.operationId,
    }),
  );
  const denied = await localFetch(
    "https://mcp.bittrees.org/mcp?mode=selected&projects=crm,mercado",
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${mcpToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    },
  );
  assert.equal(denied.status, 403);
  await assert.rejects(ai.advance(owner, input.id));
  await assert.rejects(ai.create(owner, { ...input, id: randomUUID() }));
  actor.permissions = [];
  await assert.rejects(
    sourceConnections.call(actor, ["crm"], "source_crm_status", {
      operationId: crmStep!.operationId,
    }),
  );
  console.log(
    "PASS: AI → MCP HTTP → CRM + Mercado handlers → persisted proposals → source review outcomes; lost reply, restart, duplicate retries, linked task, tenant denial and revoked MCP permission.",
  );
} finally {
  await new Promise<void>((r) => server.close(() => r()));
  await new Promise<void>((r) => sourceServer.close(() => r()));
  globalThis.fetch = nativeFetch;
  await pool.end();
  await crmDb.pool().end();
}

import { expect } from "@playwright/test";
import { test } from "./support/browser-identity-server.js";
import { openRemotePanel, loginRemotePanel } from "./support/remote-panel.js";
import { RemoteDeviceStore } from "../../modules/remote/devices.js";
import { RemoteTemplateStore } from "../../modules/remote/templates.js";
import { RemoteMcpDelegationStore } from "../../modules/remote/mcp-delegations.js";
import { randomBytes, randomUUID, createHash } from "node:crypto";
const hash = (v: string) => createHash("sha256").update(v).digest("hex");
test("owner reviews one MCP template connection, clears stale review and revokes the grant", async ({ page, identityServer }, info) => {
  identityServer.enableMcp(hash(randomBytes(32).toString("base64url")));
  const wallet = await openRemotePanel(page);
  await loginRemotePanel(page);
  const ownerId = (await identityServer.pool.query("SELECT id FROM remote_accounts WHERE lower(address)=lower($1)", [wallet.address])).rows[0].id;
  const devices = new RemoteDeviceStore(identityServer.pool, 7200000);
  const verifier = randomBytes(32).toString("base64url");
  const pair = await devices.begin(createHash("sha256").update(verifier).digest("base64url"));
  await devices.approve(ownerId, pair.id, pair.approvalCode);
  const mac = await devices.redeem(pair.id, verifier, ownerId);
  const identity = await devices.authenticate(mac.credential);
  const permissionId = randomUUID(), templateId = randomUUID(), now = Date.now();
  await new RemoteTemplateStore(identityServer.pool, 86400000).publish(identity, {
    permissionId, templateId, templateRevision: 1, approvedAt: now, expiresAt: now + 600000,
    maxRuns: 2, credentialHash: hash(randomBytes(32).toString("base64url")), confirmed: true,
  });
  await page.getByRole("button", { name: "Load devices", exact: true }).click();
  await page.getByRole("button", { name: "View approved templates", exact: true }).click();
  const delegation = new RemoteMcpDelegationStore(identityServer.pool);
  const id = randomUUID(), approvalCode = randomBytes(32).toString("base64url");
  await delegation.begin("bittrees-mcp", { id, actor: { tenant: "test-workspace", subject: "operator", actorId: "a".repeat(64) },
    challenge: createHash("sha256").update(verifier).digest("base64url"), approvalHash: hash(approvalCode) });
  const panel = page.getByRole("region", { name: "MCP connections", exact: true });
  async function review() {
    await panel.getByLabel("Request ID from MCP").fill(id);
    await panel.getByLabel("Approval code from MCP").fill(approvalCode);
    await panel.getByRole("button", { name: "Review connection request", exact: true }).click();
    await expect(panel.getByRole("combobox", { name: "Approved template", exact: true })).toBeVisible();
  }
  await review();
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await expect(panel.getByRole("combobox", { name: "Approved template", exact: true })).toHaveCount(0);
  await review();
  await panel.getByLabel("Maximum requests (1–20)").fill("1");
  await panel.getByLabel("Connection duration in minutes").fill("5");
  for (const width of [1180, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `test-results/mcp-connections/${info.project.name}-${width}.png`, fullPage: true });
  }
  await panel.getByLabel("I checked the MCP identity, template, limit and expiry.").check();
  await panel.getByRole("button", { name: "Approve this connection", exact: true }).click();
  await expect(panel.getByRole("status")).toContainText(ownerId);
  await panel.getByRole("button", { name: "Refresh connections", exact: true }).click();
  await expect(panel.getByRole("heading", { name: "Approved connection", exact: true })).toBeVisible();
  await panel.getByLabel("Stop future requests. Already accepted work may still finish.").check();
  await panel.getByRole("button", { name: "Revoke connection", exact: true }).click();
  await expect(panel.getByRole("heading", { name: "Revoked connection", exact: true })).toBeVisible();
  expect((await delegation.list(ownerId)).items.find((g: any) => g.id === id)?.revoked).toBe(true);
});

import { autoNoteSource } from "./support/autonote-source.js";
import { PrivateAutoNoteApprovalConsent } from "../../modules/remote/private-autonote-approval-consent.js";
import { PrivateAutoNoteApprovalOutbox } from "../../modules/remote/private-autonote-approval-outbox.js";
import { PrivateAutoNoteDecisions } from "../../modules/remote/private-autonote-decisions.js";
import type { BrowserKeyHost } from "../../modules/remote/browser-key-host.js";
import { test, expect } from "@playwright/test";
import { test as identityTest } from "./support/browser-identity-server.js";
import { ready as relayReady } from "./support/relay-endpoints.js";
import { randomUUID, createHash } from "node:crypto";
import { paired } from "./support/retained-browser-task.js";
import { splitAutoNoteApproval } from "../../modules/remote/private-autonote-approval-content.js";
import {
  openPrivateEnvelope,
  sealPrivateEnvelope,
  privateEnvelopeSuite,
} from "../../modules/remote/private-envelope.js";
test("encrypted AutoNote notes retain partial progress, exact replay and complete review across reopen", async ({
  page,
}) => {
  const f = await paired(page);
  try {
    await f.proveBrowser();
    const now = f.f.now,
      meetingId = randomUUID(),
      proposal = {
        operationId: randomUUID(),
        meetingId,
        version: 1,
        projectionHash: "a".repeat(64),
        summary: [{ text: "Synthetic plan", evidence: ["s1"] }],
        actions: [],
      };
    const detail = {
      id: randomUUID(),
      digest: createHash("sha256")
        .update(JSON.stringify(proposal))
        .digest("hex"),
      expiresAt: new Date(now + 600000).toISOString(),
      meetingId,
      title: "Retained synthetic meeting",
      visibility: "workspace",
      proposal,
      notes: {
        summary: "Retained context",
        topics: [],
        decisions: [],
        actions: Array.from({ length: 10 }, (_, i) => ({
          id: String(i),
          text: "🌳".repeat(1900),
          evidence: ["s1"],
          owner: null,
          dueDate: null,
          status: "proposed",
        })),
        questions: [],
        recommendations: [],
      },
    };
    const offerId = randomUUID(),
      transfer = await splitAutoNoteApproval(
        detail,
        {
          offerId,
          permissionId: randomUUID(),
          sourceApprovalId: randomUUID(),
          grantId: randomUUID(),
          issuedAt: now,
          expiresAt: now + 240000,
        },
        () => now,
      );
    const key = await f.mac.keys.resolve(),
      peer = await f.mac.peers.resolve(f.f.binding.deviceId, f.local.keyEpoch);
    let sequence = 100;
    const envelopes: Awaited<ReturnType<typeof sealPrivateEnvelope>>[] = [];
    for (const packet of [transfer.manifest, ...transfer.chunks])
      envelopes.push(
        await sealPrivateEnvelope(
          {
            version: 1,
            suite: privateEnvelopeSuite,
            ownerId: f.f.binding.ownerId,
            senderId: f.mac.binding.deviceId,
            recipientId: f.f.binding.deviceId,
            senderKeyEpoch: key.proof.keyEpoch,
            recipientKeyEpoch: f.local.keyEpoch,
            messageId: randomUUID(),
            operationId: "id" in packet ? packet.id : packet.offerId,
            sequence: sequence++,
            issuedAt: now,
            expiresAt: now + 240000,
          },
          new TextEncoder().encode(JSON.stringify(packet)),
          { senderKey: key.pair, recipientPublicKey: peer.publicKey },
          () => now,
        ),
      );
    const receive = (envelope: (typeof envelopes)[number]) =>
      page.evaluate(
        (envelope) =>
          window.browserPeersTest.approvalReceive({
            envelope,
            confirmed: true,
          }),
        envelope,
      );
    const reveal = () =>
      page.evaluate(
        (offerId) =>
          window.browserPeersTest.approvalReveal({ offerId, confirmed: true }),
        offerId,
      );
    await expect(receive(envelopes[1]!)).rejects.toThrow();
    await receive(envelopes[0]!);
    await expect(reveal()).rejects.toThrow();
    await receive(envelopes[1]!);
    await page.evaluate(() => window.browserPeersTest.approvalReopen());
    expect(
      (await page.evaluate(() => window.browserPeersTest.approvalStatus()))[0],
    ).toMatchObject({ offerId, received: 2 });
    expect((await receive(envelopes[1]!)).duplicate).toBe(true);
    for (const envelope of envelopes.slice(2).reverse())
      await receive(envelope);
    expect((await reveal()).detail).toEqual(detail);
    const decisionReview = await page.evaluate(
      (offerId) =>
        window.browserPeersTest.approvalDecisionPrepare({
          offerId,
          decision: "approve",
          confirmed: true,
        }),
      offerId,
    );
    expect(decisionReview.detail).toEqual(detail);
    await page.evaluate(
      (reviewId) =>
        window.browserPeersTest.approvalDecisionConfirm({
          reviewId,
          confirmed: true,
          acknowledged: true,
        }),
      decisionReview.id,
    );
    const lost = await page.evaluate(
      (offerId) =>
        window.browserPeersTest.approvalDecisionDispatch(offerId, true),
      offerId,
    );
    expect(lost.lost).toBe(true);
    await page.evaluate(() => window.browserPeersTest.approvalReopen());
    expect(
      (
        await page.evaluate(
          (offerId) =>
            window.browserPeersTest.approvalDecisionStatus({ offerId }),
          offerId,
        )
      ).attempts,
    ).toBe(1);
    const delivered = await page.evaluate(
      (offerId) =>
        window.browserPeersTest.approvalDecisionDispatch(offerId, false),
      offerId,
    );
    expect(delivered.envelope).toEqual(lost.envelope);
    expect(delivered.result!.attempts).toBe(2);
    const outgoing = delivered.envelope as (typeof envelopes)[number];
    const opened = await openPrivateEnvelope(
      outgoing,
      outgoing.header,
      { recipientKey: key.pair, senderPublicKey: peer.publicKey },
      () => now,
    );
    expect(
      JSON.parse(new TextDecoder().decode(opened.plaintext)),
    ).toMatchObject({
      type: "autonote.approval.decision",
      decision: "approve",
      offerId,
      detailHash: transfer.manifest.detailHash,
    });
    const decisionId = JSON.parse(new TextDecoder().decode(opened.plaintext))
      .id as string;
    const resultEnvelope = async (saved: boolean) => {
      const messageId = randomUUID();
      return sealPrivateEnvelope(
        {
          ...envelopes[0]!.header,
          messageId,
          operationId: messageId,
          sequence: sequence++,
        },
        new TextEncoder().encode(
          JSON.stringify({
            version: 1,
            type: "autonote.approval.receipt",
            decisionId,
            offerId,
            detailHash: transfer.manifest.detailHash,
            status: saved ? "saved" : "uncertain",
            receipt: saved
              ? {
                  meetingId,
                  operationId: proposal.operationId,
                  version: proposal.version + 1,
                }
              : null,
          }),
        ),
        { senderKey: key.pair, recipientPublicKey: peer.publicKey },
        () => now,
      );
    };
    const receiveResult = (envelope: (typeof envelopes)[number]) =>
      page.evaluate(
        ({ offerId, envelope }) =>
          window.browserPeersTest.approvalResultReceive({
            offerId,
            envelope,
            confirmed: true,
          }),
        { offerId, envelope },
      );
    const uncertain = await resultEnvelope(false);
    expect((await receiveResult(uncertain)).result.status).toBe("uncertain");
    expect(
      (await receiveResult(await resultEnvelope(true))).result.status,
    ).toBe("saved");
    expect(await receiveResult(uncertain)).toMatchObject({
      duplicate: true,
      result: { status: "saved" },
    });
    opened.plaintext.fill(0);
    const exported = await page.evaluate(
      (offerId) =>
        window.browserPeersTest.approvalExport({ offerId, confirmed: true }),
      offerId,
    );
    expect(exported.envelopes.length).toBe(envelopes.length);
    expect(JSON.stringify(exported)).not.toContain(detail.title);
    await page.evaluate(
      (offerId) =>
        window.browserPeersTest.approvalRemove({ offerId, confirmed: true }),
      offerId,
    );
    await expect(reveal()).rejects.toThrow();
    await expect(receive(envelopes[0]!)).rejects.toThrow();
  } finally {
    f.mac.close();
  }
});

test("browser AutoNote panel reveals complete notes only on confirmation and clears on focus loss", async ({
  page,
}, info) => {
  const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    expiresAt = Date.now() + 300000;
  let reads = 0,
    receives = 0,
    retainedDecision = false,
    sentDecision = false,
    resultReceived = false;
  await page.route("**/approval-test/**", async (route) => {
    const action = new URL(route.request().url()).pathname.split("/").at(-1);
    if (action === "decisionHistory")
      return route.fulfill({
        json: retainedDecision
          ? [
              {
                offerId: id,
                decisionId: id,
                decision: "approve",
                attempts: sentDecision ? 1 : 0,
                transport: sentDecision ? { state: "stored" } : null,
                result: resultReceived
                  ? { status: "saved", receipt: { version: 2 } }
                  : null,
                stopped: false,
              },
            ]
          : [],
      });
    if (action === "confirmDecision") {
      expect(route.request().postDataJSON()).toEqual({
        reviewId: id,
        confirmed: true,
        acknowledged: true,
      });
      retainedDecision = true;
      return route.fulfill({ json: { state: "retained" } });
    }
    if (action === "sendDecision") {
      expect(retainedDecision).toBe(true);
      sentDecision = true;
      return route.fulfill({ json: { transport: { state: "stored" } } });
    }
    if (action === "receiveResult") {
      expect(route.request().postDataJSON().offerId).toBe(id);
      resultReceived = true;
      return route.fulfill({
        json: { received: { duplicate: false, result: { status: "saved" } } },
      });
    }
    if (action === "status")
      return route.fulfill({ json: [{ offerId: id, received: 2, expiresAt }] });
    if (action === "inspect")
      return route.fulfill({
        json: {
          item: {
            selection: {
              messageId: id,
              envelopeHash: "a".repeat(64),
              revision: 1,
              storedAt: Date.now(),
            },
            cursor: { messageId: id, storedAt: Date.now() },
            expiresAt,
          },
          nextCursor: null,
        },
      });
    if (action === "receive") {
      receives++;
      expect(route.request().postDataJSON().confirmed).toBe(true);
      return route.fulfill({
        json: { received: { received: 2, total: 2 }, nextCursor: null },
      });
    }
    if (action === "reveal" || action === "prepareDecision") {
      if (action === "reveal") reads++;
      expect(route.request().postDataJSON()).toEqual({
        offerId: id,
        confirmed: true,
        ...(action === "prepareDecision" ? { decision: "approve" } : {}),
      });
      return route.fulfill({
        json: {
          ...(action === "prepareDecision"
            ? { id, decision: "approve", expiresAt: Date.now() + 60000 }
            : {}),
          manifest: { expiresAt },
          detail: {
            title: "Synthetic project meeting",
            visibility: "workspace",
            notes: {
              summary: "Retained context and exact new notes.",
              topics: [],
              decisions: [],
              actions: [
                {
                  text: "Review <script> as literal meeting text",
                  evidence: ["s1"],
                  status: "proposed",
                  owner: "Alex",
                  dueDate: "2026-10-01",
                },
              ],
              questions: [],
              recommendations: [],
            },
          },
        },
      });
    }
    throw Error("Unexpected fixture action " + action);
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/?autonote-browser-review");
  const panel = page.getByRole("region", { name: "AutoNote browser review" });
  await panel
    .getByRole("button", { name: "Refresh encrypted AutoNote offers" })
    .click();
  await panel
    .getByRole("button", { name: "Review revealing complete notes" })
    .click();
  const confirm = panel.getByRole("button", {
    name: "Confirm AutoNote action",
  });
  await expect(confirm).toBeDisabled();
  expect(reads).toBe(0);
  await panel
    .getByLabel("I understand and want to perform this action.")
    .check();
  await confirm.click();
  await expect(
    panel.getByText("Retained context and exact new notes.", { exact: true }),
  ).toBeVisible();
  await expect(
    panel.getByText("Review <script> as literal meeting text", { exact: true }),
  ).toBeVisible();
  const { mkdir } = await import("node:fs/promises");
  await mkdir("test-results/autonote-approval", { recursive: true });
  await panel.screenshot({
    path: `test-results/autonote-approval/${info.project.name}-browser-notes-phone.png`,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth + 1,
    ),
  ).toBe(false);
  await page.setViewportSize({ width: 1280, height: 1000 });
  await panel.screenshot({
    path: `test-results/autonote-approval/${info.project.name}-browser-notes-desktop.png`,
  });
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await expect(
    panel.getByText("Retained context and exact new notes.", { exact: true }),
  ).toHaveCount(0);
  await panel
    .getByRole("button", { name: "Inspect next encrypted item" })
    .click();
  await expect(confirm).toBeDisabled();
  expect(receives).toBe(0);
  await panel
    .getByLabel("I understand and want to perform this action.")
    .check();
  await confirm.click();
  await expect(panel.getByRole("status")).toContainText(
    "2 of 2 parts retained",
  );
  await panel
    .getByRole("button", { name: "Review approving these notes", exact: true })
    .click();
  await expect(confirm).toBeDisabled();
  await expect(
    panel.getByText("Retained context and exact new notes.", { exact: true }),
  ).toBeVisible();
  expect(retainedDecision).toBe(false);
  await page.setViewportSize({ width: 390, height: 844 });
  await panel.screenshot({
    path: `test-results/autonote-approval/${info.project.name}-browser-decision-phone.png`,
  });
  await page.setViewportSize({ width: 1280, height: 1000 });
  await panel.screenshot({
    path: `test-results/autonote-approval/${info.project.name}-browser-decision-desktop.png`,
  });
  await panel
    .getByLabel("I understand and want to perform this action.")
    .check();
  await confirm.click();
  await expect(panel.getByRole("status")).toContainText(
    "Decision retained locally",
  );
  expect(sentDecision).toBe(false);
  await panel
    .getByRole("button", {
      name: "Review sending retained decision",
      exact: true,
    })
    .click();
  await expect(confirm).toBeDisabled();
  await panel
    .getByLabel("I understand and want to perform this action.")
    .check();
  await confirm.click();
  await expect(panel.getByRole("status")).toContainText(
    "Encrypted decision stored at relay",
  );
  expect(sentDecision).toBe(true);
  await panel
    .getByRole("button", {
      name: "Inspect next result for this decision",
      exact: true,
    })
    .click();
  await expect(confirm).toBeDisabled();
  await page.setViewportSize({ width: 390, height: 844 });
  await panel.screenshot({
    path: `test-results/autonote-approval/${info.project.name}-browser-result-phone.png`,
  });
  await page.setViewportSize({ width: 1280, height: 1000 });
  await panel.screenshot({
    path: `test-results/autonote-approval/${info.project.name}-browser-result-desktop.png`,
  });
  await panel
    .getByLabel("I understand and want to perform this action.")
    .check();
  await confirm.click();
  await expect(
    panel.getByText("Saved in AutoNote, meeting version 2.", { exact: false }),
  ).toBeVisible();

  expect(reads).toBe(1);
  expect(receives).toBe(1);
});

identityTest(
  "browser approval saves actual AutoNote notes once and returns the recovered receipt",
  async ({ page, identityServer }) => {
    identityServer.enablePrivateRelay();
    const f = await relayReady(
      page,
      identityServer.pool,
      identityServer.nativeTransport,
    );
    let source: Awaited<ReturnType<typeof autoNoteSource>> | undefined;
    try {
      source = await autoNoteSource(f.mac);
      const { operationId, meetingId, detail } = source;
      const browser = f.mac.peers
        .list()
        .peers.find((p) => p.peerId === f.registration.binding.deviceId)!;
      const consent = new PrivateAutoNoteApprovalConsent(
        f.mac.store,
        f.mac.vault,
        f.mac.owner,
        () => f.mac.binding,
        f.mac.keys,
        f.mac.peers,
        source.approval,
        source.adapter,
        f.mac.clock,
      );
      const review = await consent.prepare({
        operationId,
        expectedRevision: consent.list(operationId).revision,
        peerId: browser.peerId,
        peerKeyEpoch: browser.keyEpoch,
        expiresAt: Math.min(
          Date.now() + 240000,
          f.native.record().permission!.expiresAt,
        ),
      });
      const granted = await consent.approve({
        reviewId: review.id,
        expectedRevision: review.revision,
        confirmed: true,
        acknowledged: true,
      });
      const outbox = new PrivateAutoNoteApprovalOutbox(
        f.mac.store,
        f.mac.vault,
        f.mac.owner,
        consent,
        f.mac.clock,
      );
      const queued = await outbox.prepare({
        operationId,
        permissionId: granted.grant.id,
        clientRequestId: randomUUID(),
        expectedRevision: granted.revision,
        confirmed: true,
      });
      await outbox.encrypt(operationId, queued.id);
      const offerId = queued.id;
      const box = f.mac.store.autoNoteReview(f.mac.owner, operationId)
        .approvalOutboxes![0]!;
      const decisions = new PrivateAutoNoteDecisions(
        f.mac.store,
        f.mac.vault,
        f.mac.owner,
        consent,
        source.approval,
        f.mac.clock,
      );
      let after: { storedAt: number; messageId: string } | null = null;
      for (const [index, part] of box.parts.entries()) {
        const envelope = part.envelope!;
        const record = f.native.record();
        await f.native.relay.withTransport(
          { id: record.id, expectedRevision: record.revision },
          async (client) =>
            outbox.dispatch(
              operationId,
              offerId,
              index,
              async (envelope) =>
                (await client.submit({ version: 1, envelope })).receipt,
            ),
        );
        const inspected: Awaited<
          ReturnType<BrowserKeyHost["autoNoteApprovalAPI"]["inspect"]>
        > = await page.evaluate(
          (after) =>
            window.browserPeersTest.approvalHostInspect({
              after,
              confirmed: true,
            }),
          after,
        );
        expect(inspected.item!.selection.messageId).toBe(
          envelope.header.messageId,
        );
        const received = await page.evaluate(
          (raw) => window.browserPeersTest.approvalHostReceive(raw),
          { after, selection: inspected.item!.selection, confirmed: true },
        );
        expect(received.transport.receipt.state).toBe("received");
        after = inspected.item!.cursor;
      }
      const retained = await page.evaluate(() =>
        window.browserPeersTest.approvalHostStatus(),
      );
      expect(retained[0]).toMatchObject({
        offerId,
        received: box.parts.length,
      });
      const opened = await page.evaluate(
        (offerId) =>
          window.browserPeersTest.approvalHostReveal({
            offerId,
            confirmed: true,
          }),
        offerId,
      );
      expect(opened.detail).toEqual(detail);
      const decision = await page.evaluate(
        (offerId) =>
          window.browserPeersTest.approvalHostDecisionPrepare({
            offerId,
            decision: "approve",
            confirmed: true,
          }),
        offerId,
      );
      await page.evaluate(
        (reviewId) =>
          window.browserPeersTest.approvalHostDecisionConfirm({
            reviewId,
            confirmed: true,
            acknowledged: true,
          }),
        decision.id,
      );
      const delivered = await page.evaluate(
        (offerId) =>
          window.browserPeersTest.approvalHostDecisionSend({
            offerId,
            confirmed: true,
          }),
        offerId,
      );
      expect(delivered.transport!.state).toBe("stored");
      const native = f.native.record();
      const returned = await f.native.relay.withTransport(
        { id: native.id, expectedRevision: native.revision },
        async (client) => client.poll({ after: null, limit: 1 }),
      );
      const envelope = returned.items[0]!.envelope;
      expect(source.saves()).toBe(0);
      const accepted = await decisions.receive({
        operationId,
        permissionId: granted.grant.id,
        envelope,
        confirmed: true,
      });
      expect(accepted).toMatchObject({ duplicate: false, state: "accepted" });
      await f.native.relay.withTransport(
        { id: native.id, expectedRevision: native.revision },
        async (client) =>
          client.acknowledge({
            messageId: returned.items[0]!.receipt.messageId,
            envelopeHash: returned.items[0]!.receipt.envelopeHash,
            expectedRevision: returned.items[0]!.receipt.revision,
            confirmed: true,
          }),
      );
      const decisionId = decisions.status(operationId)[0]!.decisionId;
      const execute = { operationId, decisionId, confirmed: true };
      await expect(decisions.execute(execute)).rejects.toThrow();
      expect(source.saves()).toBe(1);
      expect(decisions.status(operationId)[0]!.state).toBe("uncertain");
      await source.ledger.reconcile(operationId);
      decisions.recordReconciled(operationId, decisionId);
      const saved = decisions.status(operationId)[0]!.result!;
      expect(saved.status).toBe("saved");
      expect(saved.receipt).toMatchObject({
        meetingId,
        operationId,
        version: 2,
      });
      const actualMeeting = await source.sourceMeeting();
      expect(actualMeeting.version).toBe(2);
      expect(actualMeeting.notes).toEqual(detail.notes);
      await expect(decisions.execute(execute)).rejects.toThrow();
      expect(source.saves()).toBe(1);
      await decisions.prepareResult(execute);
      const messageId =
        decisions.status(operationId)[0]!.resultDeliveries[0]!.messageId;
      await f.native.relay.withTransport(
        { id: native.id, expectedRevision: native.revision },
        async (client) =>
          decisions.sendResult(
            { ...execute, messageId },
            async (envelope, check) =>
              (await client.submit({ version: 1, envelope }, check)).receipt,
          ),
      );
      const next = await page.evaluate(
        (after) =>
          window.browserPeersTest.approvalHostInspect({
            after,
            confirmed: true,
          }),
        after,
      );
      const result = await page.evaluate(
        (raw) => window.browserPeersTest.approvalHostResultReceive(raw),
        { offerId, after, selection: next.item!.selection, confirmed: true },
      );
      expect(result.received.result.status).toBe("saved");
      expect(result.transport.receipt.state).toBe("received");
      expect(result.received.result.receipt).toEqual(saved.receipt);
      expect(source.saves()).toBe(1);
    } finally {
      try {
        await source?.close();
      } finally {
        f.mac.close();
      }
    }
  },
);

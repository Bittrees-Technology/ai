import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { localApi } from "../apps/companion/http.js";
import { LocalWorker } from "../apps/companion/worker.js";
import { macConversationReceiveFixture as fixture } from "./helpers/mac-conversation-receive.js";
const ackCount = (g: Awaited<ReturnType<typeof fixture>>) =>
  g.control.calls.filter((p) => p.endsWith("acknowledge")).length;

test("selected conversation pull commits before ack and recovers ack loss across reopen without duplicate Inbox content", async () => {
  for (const ackAfterSave of [false, true]) {
    const g = await fixture();
    try {
      const body = g.message(),
        wire = await g.envelope(body);
      await g.queueEnvelope(wire);
      const initial = g.messages().length;
      const inspected = await g.inspect();
      assert.equal(
        g.e.store.exportPrivateConversationContent(g.e.owner).length,
        0,
      );
      assert.equal(g.messages().length, initial);
      assert.equal(ackCount(g), 0);
      assert.doesNotMatch(
        JSON.stringify(inspected),
        /SYNTHETIC|ciphertext|publicKey|permissionId/,
      );
      const input = {
        ...g.query(),
        selection: inspected.item!.selection,
        target: { action: "receive", permissionId: g.permission.id },
      };
      g.control.beforeAck = () => {
        assert.equal(g.messages().length, initial + 1);
        assert.equal(
          g.e.store.exportPrivateConversationContent(g.e.owner)[0]!.value
            .content.id,
          body.id,
        );
      };
      g.control.loseAck = true;
      g.control.ackAfterSave = ackAfterSave;
      await assert.rejects(g.check(input));
      assert.equal(g.messages().length, initial + 1);
      const saved = g.messages().at(-1)!.id;
      g.reopen();
      g.control.loseAck = false;
      if (ackAfterSave) {
        assert.equal((await g.inspect()).item, null);
        await assert.rejects(g.check(input), /CONFLICT/);
      } else {
        const result = await g.check(input);
        assert.equal(result.received.duplicate, true);
        assert.equal(result.received.entry.localMessageId, saved);
        assert.equal(result.received.status, "accepted-locally");
        assert.equal(result.transport.transportOnly, true);
        assert.equal(result.transport.receipt.state, "received");
        assert.doesNotMatch(
          JSON.stringify(result),
          /SYNTHETIC|ciphertext|publicKey|credential/,
        );
      }
      assert.equal(g.messages().length, initial + 1);
      assert.equal(g.e.store.export(g.e.owner).length, 0);
      assert.deepEqual((await g.inspect()).item, null);
      assert.deepEqual(
        g.e.store.exportPrivateConversationContent(g.e.owner)[0]!.value
          .envelope,
        wire,
      );
    } finally {
      g.close();
    }
  }
});

test("exact selected item fences a changed queue and parent-pending replies retain the original envelope for later admission", async () => {
  const g = await fixture();
  try {
    const parent = g.message(),
      reply = g.message(parent.id),
      wire = await g.envelope(reply);
    await g.queueEnvelope(wire);
    const selected = await g.selected();
    await assert.rejects(
      g.check({
        ...selected,
        selection: { ...selected.selection, envelopeHash: "0".repeat(64) },
      }),
      /CONFLICT/,
    );
    await assert.rejects(g.check(selected), /PARENT_PENDING/);
    assert.equal(g.messages().length, 1);
    assert.equal(ackCount(g), 0);
    assert.equal(
      g.e.store.exportPrivateConversationContent(g.e.owner).length,
      0,
    );
    await g.queueEnvelope(await g.envelope(parent));
    await assert.rejects(g.check(selected), /CONFLICT/);
    const accepted = await g.check();
    await g.queueEnvelope(wire);
    const result = await g.check();
    assert.equal(result.received.duplicate, false);
    const saved = g
      .messages()
      .find((m) => m.id === result.received.entry.localMessageId)!;
    assert.equal(saved.input.replyToId, accepted.received.entry.localMessageId);
    assert.equal(g.messages().length, 3);
    assert.equal(ackCount(g), 2);
  } finally {
    g.close();
  }
});

test("selected recipient receipt reconciles the exact outgoing original before ack and survives lost ack with no new Inbox item", async () => {
  const g = await fixture();
  try {
    const prepared = await g.e.controls.prepareConversationContent({
      id: randomUUID(),
      permissionId: g.permission.id,
      expectedConsentRevision:
        g.e.controls.conversationPermissionStatus().revision,
      localMessageId: g.messages()[0]!.id,
      parentId: null,
      kind: "message",
      expiresAt: g.f.clock() + 60000,
      confirmed: true,
    });
    const sealed = await g.e.controls.conversationContentEnvelope({
      permissionId: g.permission.id,
      id: prepared.entry.id,
      expectedRevision: prepared.entry.revision,
      confirmed: true,
    });
    const entry = g.e.controls.conversationContentStatus().items[0]!;
    const receipt = await g.envelope({
      version: 1,
      type: "conversation.received",
      scope: g.scope,
      acceptedId: entry.id,
      acceptedType: "conversation.message",
      operationId: entry.id,
      acceptedAt: g.f.clock(),
    });
    await g.queueEnvelope(receipt);
    const input = await g.selected({
      action: "reconcile",
      permissionId: g.permission.id,
      id: entry.id,
      expectedRevision: entry.revision,
    });
    await assert.rejects(
      g.check({ ...input, target: { ...input.target, id: randomUUID() } }),
    );
    await assert.rejects(
      g.check({
        ...input,
        target: { action: "receive", permissionId: g.permission.id },
      }),
    );
    assert.equal(ackCount(g), 0);
    g.control.beforeAck = () =>
      assert.equal(
        g.e.controls.conversationContentStatus().items[0]!.recipientAccepted,
        true,
      );
    g.control.loseAck = true;
    await assert.rejects(g.check(input));
    g.reopen();
    g.control.loseAck = false;
    await assert.rejects(g.check(input), /CONFLICT/);
    const result = await g.check({
      ...input,
      target: {
        ...input.target,
        expectedRevision:
          g.e.controls.conversationContentStatus().items[0]!.revision,
      },
    });
    assert.equal(result.received.status, "recipient-storage-confirmed");
    assert.equal(result.received.duplicate, true);
    assert.equal(g.messages().length, 1);
    assert.deepEqual(
      g.e.store.exportPrivateConversationContent(g.e.owner)[0]!.value.envelope,
      sealed.envelope,
    );
    assert.deepEqual(
      g.e.store.exportPrivateConversationContent(g.e.owner)[0]!.value
        .receiptEnvelope,
      receipt,
    );
  } finally {
    g.close();
  }
});

test("conversation queue authority is independent of task permission and rejects disabled access, tampering and revoked consent", async () => {
  const g = await fixture();
  try {
    await g.queueEnvelope(await g.envelope(g.message()));
    const input = await g.selected(),
      calls = g.control.calls.length;
    await assert.rejects(
      g.e
        .build(true, true, g.e.owner, false)
        .receiveRelayedConversation(g.relay, input),
      /DENIED/,
    );
    await assert.rejects(
      g.e.controls.receiveRelayedConversation(g.build(false), input),
      /DENIED/,
    );
    assert.equal(g.control.calls.length, calls);
    await assert.rejects(
      g.check({ ...input, target: { ...input.target, current: g.e.grant } }),
    );
    await assert.rejects(
      g.check({
        ...input,
        connection: { ...input.connection, expectedRevision: 999 },
      }),
      /CONFLICT/,
    );
    await g.tamper();
    await assert.rejects(g.check(), /UNAVAILABLE/);
    assert.equal(ackCount(g), 0);
    await g.queueEnvelope(await g.envelope(g.message()));
    const result = await g.e
      .build(false)
      .receiveRelayedConversation(g.relay, await g.selected());
    assert.equal(result.received.status, "accepted-locally");
    await g.queueEnvelope(await g.envelope(g.message()));
    const selected = await g.selected(),
      status = g.e.controls.conversationPermissionStatus();
    const review = await g.e.controls.prepareConversationPermission({
      action: "revoke",
      permissionId: g.permission.id,
      expectedRevision: status.revision,
    });
    await g.e.controls.confirmConversationPermission({
      reviewId: review.id,
      confirmed: true,
      acknowledged: true,
    });
    await assert.rejects(g.check(selected), /DENIED/);
    assert.equal(ackCount(g), 1);
  } finally {
    g.close();
  }
});

test("conversation admission excludes concurrent mutation and fences cancellation or expiry during native key access", async () => {
  for (const reason of ["cancel", "expiry"]) {
    const g = await fixture();
    let release!: () => void;
    try {
      await g.queueEnvelope(await g.envelope(g.message()));
      const input = await g.selected();
      let entered!: () => void;
      const reached = new Promise<void>((r) => (entered = r)),
        held = new Promise<void>((r) => (release = r));
      [...g.e.slots.values()][0]!.key.beforeRead = async () => {
        entered();
        await held;
      };
      const pending = g.check(input),
        rejected = assert.rejects(pending);
      await Promise.race([
        reached,
        pending.then(() => {
          throw Error("Expected held native read");
        }),
      ]);
      assert.equal(g.e.controls.busy, true);
      assert.equal(g.relay.busy, true);
      await assert.rejects(g.e.controls.clearAll(), /BUSY/);
      await assert.rejects(g.check(input), /BUSY/);
      if (reason === "cancel") g.e.controls.invalidate();
      else g.f.advance(30001);
      release();
      await rejected;
      assert.equal(g.messages().length, 1);
      assert.equal(ackCount(g), 0);
    } finally {
      release?.();
      g.close();
    }
  }
});

test("relay answer consumes an actual worker question once while an ordinary reply cannot resume it", async () => {
  const g = await fixture(true);
  try {
    const profile = {
      id: "local",
      runtime: "ollama",
      model: "synthetic",
      contextTokens: 4096,
      maxOutputTokens: 512,
      temperature: 0.2,
    } as const;
    const task = g.e.store.create(
      g.e.owner,
      {
        conversationId: g.conversationId,
        kind: "query",
        prompt: "Plan my trip",
        modelProfileId: "local",
        allowQuestions: true,
      },
      randomUUID(),
    );
    let generations = 0;
    const worker = new LocalWorker(
      g.e.store,
      g.e.owner,
      {
        pin: async () => ({ profile, digest: "c".repeat(64) }),
        generate: async (_model, prompt, _signal, format) => {
          generations++;
          if (format)
            return JSON.stringify(
              generations === 1
                ? { decision: "ask", question: "Where are you travelling?" }
                : { decision: "continue" },
            );
          assert.match(prompt, /Lisbon/);
          return "Synthetic Lisbon plan";
        },
      },
      () => profile,
    );
    await worker.runOnce();
    const wait = g.e.store.inputWaitHistory(g.e.owner, task.id)[0]!;
    const prepared = await g.e.controls.prepareConversationContent({
      id: randomUUID(),
      permissionId: g.permission.id,
      expectedConsentRevision:
        g.e.controls.conversationPermissionStatus().revision,
      localMessageId: wait.questionId,
      parentId: null,
      kind: "question",
      expiresAt: g.f.clock() + 60000,
      confirmed: true,
    });
    await g.e.controls.conversationContentEnvelope({
      permissionId: g.permission.id,
      id: prepared.entry.id,
      expectedRevision: prepared.entry.revision,
      confirmed: true,
    });
    await g.queueEnvelope(await g.envelope(g.message(prepared.entry.id)));
    await g.check();
    assert.equal(g.e.store.get(g.e.owner, task.id).status, "awaiting_input");
    const question = g.e.store
      .exportPrivateConversationContent(g.e.owner)
      .find((e) => e.value.content.id === prepared.entry.id)!.value.content;
    if (question.type !== "conversation.question")
      throw Error("Expected question");
    const answer = {
      version: 1,
      type: "conversation.answer",
      scope: g.scope,
      id: randomUUID(),
      taskId: task.id,
      questionId: prepared.entry.id,
      expectedRevision: question.taskRevision,
      content: "Lisbon",
      confirmed: true,
    };
    await g.queueEnvelope(await g.envelope(answer));
    const selected = await g.selected();
    g.control.loseAck = true;
    await assert.rejects(g.check(selected));
    g.control.loseAck = false;
    assert.equal(g.e.store.get(g.e.owner, task.id).status, "queued");
    assert.equal(generations, 1);
    assert.equal((await g.check(selected)).received.duplicate, true);
    assert.equal(
      g.e.store
        .inputWaitHistory(g.e.owner, task.id)
        .filter((w) => w.replyId !== null).length,
      1,
    );
    await worker.runOnce();
    assert.equal(generations, 3);
    assert.equal(g.e.store.get(g.e.owner, task.id).status, "completed");
  } finally {
    g.close();
  }
});

test("loopback conversation queue routes require local authentication and reject caller authority and wrong origins", async () => {
  const g = await fixture(),
    server = createServer(),
    token = randomBytes(32).toString("hex");
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  server.on(
    "request",
    localApi({
      store: g.e.store,
      owner: g.e.owner,
      privateKeys: g.e.controls,
      privateRelay: g.relay,
      token,
      port,
    }),
  );
  const call = (path: string, body: any, headers = {}) =>
    fetch(`http://127.0.0.1:${port}/v1/private-relay/${path}`, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + token,
        "Content-Type": "application/json",
        ...headers,
      },
      body: JSON.stringify(body),
    });
  try {
    await g.queueEnvelope(await g.envelope(g.message()));
    const input = await g.selected();
    assert.equal(
      (
        await call("inspect-conversation", g.query(), {
          Authorization: "Bearer wrong",
        })
      ).status,
      401,
    );
    assert.equal(
      (
        await call("check-conversation", input, {
          Origin: "https://untrusted.invalid",
        })
      ).status,
      403,
    );
    assert.equal(
      (await call("check-conversation", { ...input, current: g.e.grant }))
        .status,
      400,
    );
    const inspected = await call("inspect-conversation", g.query());
    assert.equal(inspected.status, 200);
    assert.equal(ackCount(g), 0);
    const response = await call("check-conversation", input);
    assert.equal(response.status, 200);
    assert.doesNotMatch(
      await response.text(),
      /SYNTHETIC|ciphertext|publicKey|credential/,
    );
    assert.equal(g.messages().length, 2);
    assert.equal(ackCount(g), 1);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    g.close();
  }
});

test("invalidating identity during a held poll prevents admission and leaves the selected queue item unacknowledged", async () => {
  const g = await fixture();
  try {
    await g.queueEnvelope(await g.envelope(g.message()));
    const selected = await g.selected();
    g.control.beforePoll = async () => g.e.controls.invalidate();
    await assert.rejects(g.check(selected), /DENIED/);
    assert.equal(g.messages().length, 1);
    assert.equal(ackCount(g), 0);
    assert.equal(
      g.e.store.exportPrivateConversationContent(g.e.owner).length,
      0,
    );
    g.control.beforePoll = undefined;
    assert.deepEqual((await g.inspect()).item!.selection, selected.selection);
    assert.equal((await g.check(selected)).received.duplicate, false);
  } finally {
    g.close();
  }
});

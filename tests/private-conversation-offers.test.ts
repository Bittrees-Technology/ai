import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { conversationFixture, owner } from "./helpers/conversation-fixture.js";
import { PrivateConversationOffers } from "../modules/remote/private-conversation-offers.js";
import { openPrivateEnvelope } from "../modules/remote/private-envelope.js";
import { conversationOfferSchema } from "../modules/remote/private-conversation-contracts.js";
import { Store } from "../modules/storage/store.js";
import { encryptedBackup, restoreBackup } from "../modules/storage/backup.js";
async function fixture() {
  const f = await conversationFixture(),
    approved = f.approve(await f.prepare()),
    offers = new PrivateConversationOffers(
      f.store,
      f.vault,
      owner,
      f.consent,
      f.clock,
    ),
    input = {
      clientRequestId: randomUUID(),
      permissionId: approved.grant.id,
      expectedConsentRevision: approved.revision,
      confirmed: true,
    };
  return { ...f, approved, offers, input };
}
const command = (e: { id: string; revision: number }) => ({
  id: e.id,
  expectedRevision: e.revision,
  confirmed: true,
});
test("conversation offers reserve once, authenticate exact scope and retain original ciphertext across retries", async () => {
  const f = await fixture();
  try {
    const reserved = await f.offers.prepare(f.input);
    assert.equal(reserved.value.state, "preparing");
    assert.equal(reserved.value.envelope, null);
    assert.ok(reserved.value.header.sequence > 1);
    assert.deepEqual(await f.offers.prepare(f.input), reserved);
    const ready = await f.offers.resume(command(reserved)),
      wire = await f.offers.delivery(command(ready));
    assert.deepEqual(await f.offers.resume(command(ready)), ready);
    assert.deepEqual(await f.offers.prepare(f.input), ready);
    const local = await f.keys.resolve(),
      opened = await openPrivateEnvelope(
        wire,
        wire.header,
        { recipientKey: f.sender, senderPublicKey: local.pair.publicKey },
        f.clock,
      );
    const offer = conversationOfferSchema.parse(
      JSON.parse(new TextDecoder().decode(opened.plaintext)),
    );
    opened.plaintext.fill(0);
    assert.deepEqual(offer.scope, {
      conversationRef: f.approved.grant.conversationRef,
      permissionId: f.approved.grant.id,
    });
    assert.deepEqual(offer.permissions, f.choices.permissions);
    assert.equal(offer.expiresAt, f.choices.expiresAt);
    assert.equal(
      JSON.stringify(offer).includes(f.choices.conversationId),
      false,
    );
    assert.equal(JSON.stringify(offer).includes(f.choices.inboxId), false);
    const restarted = new Store(f.path, f.vault, f.clock);
    try {
      const c = f.build(restarted),
        next = new PrivateConversationOffers(
          restarted,
          f.vault,
          owner,
          c.consent,
          f.clock,
        );
      assert.deepEqual(await next.delivery(command(ready)), wire);
      assert.equal(restarted.exportPrivateConversationOffers(owner).length, 1);
    } finally {
      restarted.close();
    }
    const raw = f.store.db
      .prepare("SELECT payload FROM private_conversation_offers")
      .get() as { payload: Buffer };
    assert.equal(
      raw.payload.includes(Buffer.from(f.approved.grant.conversationRef)),
      false,
    );
  } finally {
    f.close();
  }
});
test("conversation offer retries cannot change consent and concurrent encryption publishes one original envelope", async () => {
  const f = await fixture();
  try {
    const e = await f.offers.prepare(f.input);
    await assert.rejects(
      f.offers.prepare({
        ...f.input,
        expectedConsentRevision: f.input.expectedConsentRevision + 1,
      }),
      /CONFLICT/,
    );
    await assert.rejects(
      f.offers.prepare({
        ...f.input,
        clientRequestId: randomUUID(),
        expectedConsentRevision: f.input.expectedConsentRevision + 1,
      }),
      /CONFLICT/,
    );
    const concurrent = new PrivateConversationOffers(
      f.store,
      f.vault,
      owner,
      f.build().consent,
      f.clock,
    );
    const [a, b] = await Promise.all([
      f.offers.resume(command(e)),
      concurrent.resume(command(e)),
    ]);
    assert.deepEqual(a, b);
    assert.equal(f.store.exportPrivateConversationOffers(owner).length, 1);
  } finally {
    f.close();
  }
});
test("revocation, changed Inbox, expiry and missing identity deny prepared or ready offers", async () => {
  for (const mode of ["revoke", "inbox", "expiry", "identity"]) {
    const f = await fixture();
    try {
      const e = await f.offers.prepare(f.input),
        ready = await f.offers.resume(command(e));
      if (mode === "revoke")
        f.consent.revoke({
          permissionId: f.approved.grant.id,
          expectedRevision: f.approved.revision,
          confirmed: true,
        });
      if (mode === "inbox") f.store.createInbox(owner, f.inbox);
      if (mode === "expiry") f.time(ready.value.header.expiresAt);
      if (mode === "identity") f.setBinding(null);
      await assert.rejects(f.offers.delivery(command(ready)), /DENIED/);
      await assert.rejects(f.offers.resume(command(ready)), /DENIED/);
    } finally {
      f.close();
    }
  }
});
test("offline stop preserves history and prevents any later offer reveal", async () => {
  const f = await fixture();
  try {
    const e = await f.offers.prepare(f.input),
      ready = await f.offers.resume(command(e));
    f.setBinding(null);
    const stopped = f.offers.stop(command(ready));
    assert.equal(stopped.value.state, "stopped");
    assert.deepEqual(stopped.value.envelope, ready.value.envelope);
    assert.deepEqual(f.offers.stop(command(stopped)), stopped);
    f.setBinding(f.binding);
    await assert.rejects(f.offers.delivery(command(stopped)), /DENIED/);
    await assert.rejects(f.offers.prepare(f.input), /DENIED/);
  } finally {
    f.close();
  }
});
test("offer preparation cannot commit after native key lookup loses current identity", async () => {
  const f = await fixture();
  try {
    const slot = [...f.slots.values()][0]!;
    let entered!: () => void, release!: () => void;
    const enteredP = new Promise<void>((r) => (entered = r)),
      releaseP = new Promise<void>((r) => (release = r));
    slot.key.beforeRead = async () => {
      entered();
      await releaseP;
    };
    const pending = f.offers.prepare(f.input);
    await enteredP;
    f.setBinding(null);
    release();
    await assert.rejects(pending, /DENIED/);
    assert.deepEqual(f.store.exportPrivateConversationOffers(owner), []);
  } finally {
    f.close();
  }
});
test("offer backups lock retained ciphertext and deletion clears only the selected owner's records", async () => {
  const f = await fixture();
  try {
    const ready = await f.offers.resume(
        command(await f.offers.prepare(f.input)),
      ),
      backup = join(f.dir, "offers.aib"),
      path = join(f.dir, "restored.db");
    await encryptedBackup(f.store, f.vault, backup);
    await restoreBackup(backup, f.vault, path);
    const restored = new Store(path, f.vault, f.clock);
    try {
      const c = f.build(restored),
        offers = new PrivateConversationOffers(
          restored,
          f.vault,
          owner,
          c.consent,
          f.clock,
        ),
        saved = offers.get(ready.id);
      assert.equal(saved.locked, true);
      assert.deepEqual(saved.value.envelope, ready.value.envelope);
      await assert.rejects(offers.delivery(command(saved)), /DENIED/);
    } finally {
      restored.close();
    }
    const other = { ...owner, userId: "other" };
    f.store.deleteAll(other);
    assert.equal(f.store.exportPrivateConversationOffers(owner).length, 1);
    f.store.deleteAll(owner);
    assert.deepEqual(f.store.exportPrivateConversationOffers(owner), []);
  } finally {
    f.close();
  }
});
test("foreign and corrupted offer rows never return content or silently reset retained state", async () => {
  const f = await fixture();
  try {
    const e = await f.offers.prepare(f.input),
      foreign = new PrivateConversationOffers(
        f.store,
        f.vault,
        { ...owner, userId: "other" },
        f.consent,
        f.clock,
      );
    assert.throws(() => foreign.get(e.id), /DENIED/);
    f.store.db
      .prepare("UPDATE private_conversation_offers SET payload=? WHERE id=?")
      .run(Buffer.from("corrupt"), e.id);
    assert.throws(() => f.offers.get(e.id), /STORAGE_UNAVAILABLE/);
    assert.throws(
      () => f.store.exportPrivateConversationOffers(owner),
      /STORAGE_UNAVAILABLE/,
    );
    await assert.rejects(f.offers.resume(command(e)), /STORAGE_UNAVAILABLE/);
    assert.equal(
      (
        f.store.db
          .prepare("SELECT COUNT(*) n FROM private_conversation_offers")
          .get() as { n: number }
      ).n,
      1,
    );
  } finally {
    f.close();
  }
});

test("reviewed offer deadlines remain exact and reject expired or expanded opening windows", async () => {
  const f = await fixture();
  try {
    for (const expiresAt of [f.clock(), f.clock() + 300001, f.clock() - 1])
      await assert.rejects(
        f.offers.prepare({ ...f.input, expiresAt }),
        /DENIED/,
      );
    assert.deepEqual(
      f.store.db
        .prepare("SELECT count(*) AS count FROM private_conversation_offers")
        .get(),
      { count: 0 },
    );
    const expiresAt = f.clock() + 60000;
    const e = await f.offers.prepare({ ...f.input, expiresAt });
    assert.equal(e.value.header.expiresAt, expiresAt);
    await assert.rejects(
      f.offers.prepare({ ...f.input, expiresAt: expiresAt + 1 }),
      /CONFLICT/,
    );
    f.time(expiresAt);
    await assert.rejects(f.offers.resume(command(e)), /DENIED/);
  } finally {
    f.close();
  }
});

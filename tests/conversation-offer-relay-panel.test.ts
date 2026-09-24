import test from "node:test";
import assert from "node:assert/strict";
import { ConversationOfferPanelState } from "../apps/dashboard/conversation-offer-state.js";
import { macConversationRelayFixture } from "./helpers/mac-conversation-relay.js";
async function fixture() {
  const g = await macConversationRelayFixture();
  const control = { changeRecipient: false, changeReceipt: false };
  const calls: { path: string; body: any }[] = [];
  const panel = new ConversationOfferPanelState(
    async (path, _method, body) => {
      calls.push({ path, body });
      if (path === "/v1/private-relay") return g.relay.status();
      if (path.endsWith("/review")) {
        const review = await g.e.controls.prepareConversationOffer(
          body,
          g.relay,
        );
        if (control.changeRecipient && review.relayRecipient)
          review.relayRecipient.endpointId = review.binding.deviceId;
        return review;
      }
      if (path.endsWith("/confirm")) {
        const result = await g.e.controls.confirmConversationOffer(
          body,
          g.relay,
        );
        if (control.changeReceipt && "transport" in result)
          result.offer.relayObservation = null;
        return result;
      }
      return g.e.controls.conversationOfferStatus();
    },
    g.statusOffer().choices,
    () => {},
    g.f.clock,
    () => 0,
  );
  return { ...g, panel, panelControl: control, calls };
}
const mustNotDownload = () => {
  throw Error("upload cannot download");
};
test("offer upload panel requires a selected active connection and acknowledgement with no automatic retry", async () => {
  const g = await fixture();
  try {
    await g.panel.refresh();
    await g.panel.send(g.offer.offer.id, g.input().connection.id);
    assert.equal(g.panel.review, null);
    await g.panel.refreshConnections();
    assert.equal(g.panel.connections().length, 1);
    await g.panel.send(g.offer.offer.id, g.input().connection.id);
    assert.equal(
      (g.panel as ConversationOfferPanelState).review?.action,
      "send",
    );
    assert.deepEqual(g.calls.at(-1)?.body, g.input());
    await g.panel.confirm(false, () => true, mustNotDownload);
    assert.equal(g.outgoing.size, 0);
    await g.panel.confirm(true, () => true, mustNotDownload);
    assert.equal(g.outgoing.size, 1);
    assert.match(g.panel.notice, /must still review/);
    assert.equal(
      (g.panel as ConversationOfferPanelState).status?.offers[0]?.relayAttempts,
      1,
    );
    const count = g.calls.length;
    await g.panel.confirm(true, () => true, mustNotDownload);
    assert.equal(g.calls.length, count);
  } finally {
    g.panel.dispose();
    g.close();
  }
});
test("offer upload panel rejects changed recipient or inconsistent storage history", async () => {
  for (const mode of ["recipient", "receipt"] as const) {
    const g = await fixture();
    try {
      await g.panel.refresh();
      await g.panel.refreshConnections();
      g.panelControl.changeRecipient = mode === "recipient";
      g.panelControl.changeReceipt = mode === "receipt";
      await g.panel.send(g.offer.offer.id, g.input().connection.id);
      await g.panel.confirm(true, () => true, mustNotDownload);
      assert.ok(g.panel.error);
      assert.equal(g.panel.review, null);
      assert.equal(g.panel.status, null);
      assert.equal(g.outgoing.size, mode === "recipient" ? 0 : 1);
    } finally {
      g.panel.dispose();
      g.close();
    }
  }
});
test("uncertain offer upload clears the panel and explicit refresh preserves retry history", async () => {
  const g = await fixture();
  try {
    await g.panel.refresh();
    await g.panel.refreshConnections();
    await g.panel.send(g.offer.offer.id, g.input().connection.id);
    g.control.loseSubmit = true;
    await g.panel.confirm(true, () => true, mustNotDownload);
    assert.match(g.panel.error, /No automatic retry/);
    assert.equal(g.panel.status, null);
    assert.equal(g.outgoing.size, 1);
    await g.panel.refresh();
    assert.equal(
      (g.panel as ConversationOfferPanelState).status?.offers[0]?.relayAttempts,
      1,
    );
    assert.equal(
      (g.panel as ConversationOfferPanelState).status?.offers[0]
        ?.relayObservation,
      null,
    );
    await g.panel.refreshConnections();
    await g.panel.send(g.offer.offer.id, g.input().connection.id);
    g.panel.hide();
    await g.panel.confirm(true, () => true, mustNotDownload);
    assert.equal(g.statusOffer().relayAttempts, 1);
    assert.equal(g.panel.relayStatus, null);
  } finally {
    g.panel.dispose();
    g.close();
  }
});

import { randomUUID } from "node:crypto";
import { z } from "zod";
import { PrivateConversationConsent } from "../../modules/remote/private-conversation-consent.js";
import {
  PrivateConversationOffers,
  ConversationOfferError,
  exportPrivateConversationOffers,
} from "../../modules/remote/private-conversation-offers.js";
import { PrivatePeerEnrollment } from "../../modules/remote/private-peers.js";
import type { PrivateKeyLifecycle } from "../../modules/remote/private-key-lifecycle.js";
import type { PrivateBinding } from "../../modules/remote/private-peer-contracts.js";
import type { RemoteClient } from "../../modules/remote/client.js";
import type { Owner, Store } from "../../modules/storage/store.js";
import type { Vault } from "../../modules/storage/vault.js";
const revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const request = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("create"),
    permissionId: z.uuid(),
    expectedConsentRevision: revision,
  }),
  z.strictObject({
    action: z.literal("reveal"),
    id: z.uuid(),
    expectedRevision: revision,
  }),
  z.strictObject({
    action: z.literal("stop"),
    id: z.uuid(),
    expectedRevision: revision,
  }),
]);
type Entry = ReturnType<PrivateConversationOffers["get"]>;
type Grant = Entry["value"]["grant"];
type Review = {
  id: string;
  request: z.infer<typeof request>;
  grant: Grant;
  clientRequestId: string;
  createdAt: number;
  expiresAt: number;
  offerExpiresAt: number;
  monotonicAt: number;
  consentRevision: number;
};
const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
/** Local owner review/export only. Never uploads an offer or grants browser consent. */
export class CompanionConversationOffers {
  private review?: Review;
  private generation = 0;
  constructor(
    private store: Store,
    private vault: Vault,
    private owner: Owner,
    private keys: (
      current?: () => PrivateBinding | null,
    ) => PrivateKeyLifecycle,
    private remote?: RemoteClient,
    private enabled = false,
    private now = Date.now,
    private mono = () => performance.now(),
  ) {
    this.owner = { ...owner };
  }
  invalidate() {
    this.generation++;
    this.review = undefined;
  }
  private consent(current: () => PrivateBinding | null = () => null) {
    return new PrivateConversationConsent(
      this.store,
      this.vault,
      this.owner,
      current,
      this.keys(current),
      new PrivatePeerEnrollment(
        this.store,
        this.vault,
        this.owner,
        current,
        this.now,
      ),
      this.now,
      this.mono,
    );
  }
  private offers(consent = this.consent()) {
    return new PrivateConversationOffers(
      this.store,
      this.vault,
      this.owner,
      consent,
      this.now,
    );
  }
  private item(e: Entry) {
    return {
      id: e.id,
      revision: e.revision,
      permissionId: e.value.grant.id,
      choices: e.value.grant.choices,
      fingerprint: e.value.grant.peer.fingerprint,
      createdAt: e.value.header.issuedAt,
      expiresAt: e.value.header.expiresAt,
      state: e.locked
        ? "locked"
        : e.value.state === "stopped"
          ? "stopped"
          : e.value.header.expiresAt <= this.now()
            ? "expired"
            : e.value.state,
    };
  }
  status() {
    return {
      available: true,
      canSetup: this.enabled && !!this.remote,
      offers: exportPrivateConversationOffers(
        this.store,
        this.vault,
        this.owner,
      ).map((e) => this.item(e)),
    };
  }
  private live() {
    if (!this.enabled || !this.remote)
      throw new ConversationOfferError("DENIED");
    return this.remote;
  }
  private valid(r: Review, generation: number) {
    return (
      generation === this.generation &&
      this.now() >= r.createdAt &&
      this.now() < r.expiresAt &&
      this.mono() >= r.monotonicAt &&
      this.mono() - r.monotonicAt < r.expiresAt - r.createdAt
    );
  }
  async prepare(raw: unknown) {
    this.invalidate();
    const generation = this.generation,
      parsed = request.safeParse(raw);
    if (!parsed.success) throw new ConversationOfferError("DENIED");
    const input = parsed.data;
    const prior =
      input.action === "create" ? null : this.offers().get(input.id);
    if (input.action !== "create" && prior!.revision !== input.expectedRevision)
      throw new ConversationOfferError("CONFLICT");
    const save = (grant: Grant, consentRevision: number) => {
      if (generation !== this.generation)
        throw new ConversationOfferError("DENIED");
      const createdAt = this.now(),
        offerExpiresAt =
          prior?.value.header.expiresAt ??
          Math.min(createdAt + 300000, grant.choices.expiresAt);
      this.review = {
        id: randomUUID(),
        request: input,
        grant,
        clientRequestId: randomUUID(),
        createdAt,
        expiresAt:
          input.action === "stop"
            ? createdAt + 120000
            : Math.min(createdAt + 120000, offerExpiresAt),
        offerExpiresAt,
        monotonicAt: this.mono(),
        consentRevision,
      };
      return structuredClone({
        id: this.review.id,
        action: input.action,
        expiresAt: this.review.expiresAt,
        offerId: prior?.id ?? null,
        offerExpiresAt,
        permissionId: grant.id,
        choices: grant.choices,
        binding: grant.local.binding,
        fingerprint: grant.peer.fingerprint,
      });
    };
    if (input.action === "stop") return save(prior!.value.grant, 0);
    return this.live().withVerifiedDevice(async (scope) => {
      const current = () =>
          generation === this.generation ? scope.current() : null,
        consent = this.consent(current),
        state = consent.list(),
        permissionId =
          input.action === "create"
            ? input.permissionId
            : prior!.value.grant.id;
      if (
        input.action === "create" &&
        state.revision !== input.expectedConsentRevision
      )
        throw new ConversationOfferError("CONFLICT");
      const access = (await consent.resolve(permissionId)).offerAccess();
      if (
        !access ||
        (prior &&
          (prior.locked ||
            prior.value.state === "stopped" ||
            prior.value.header.expiresAt <= this.now() ||
            prior.value.header.issuedAt > this.now() ||
            !same(prior.value.grant, access.grant)))
      )
        throw new ConversationOfferError("DENIED");
      if (consent.list().revision !== state.revision)
        throw new ConversationOfferError("CONFLICT");
      return save(access.grant, state.revision);
    });
  }
  async confirm(raw: unknown) {
    const generation = this.generation,
      r = this.review;
    this.review = undefined;
    const parsed = z
      .strictObject({
        reviewId: z.uuid(),
        confirmed: z.literal(true),
        acknowledged: z.literal(true),
      })
      .safeParse(raw);
    if (
      !parsed.success ||
      !r ||
      parsed.data.reviewId !== r.id ||
      !this.valid(r, generation)
    )
      throw new ConversationOfferError("DENIED");
    const input = r.request;
    if (input.action === "stop") {
      const saved = this.store.db
        .transaction(() => {
          if (!this.valid(r, generation))
            throw new ConversationOfferError("DENIED");
          return this.offers().stop({
            id: input.id,
            expectedRevision: input.expectedRevision,
            confirmed: true,
          });
        })
        .immediate();
      return { offer: this.item(saved), envelope: null };
    }
    return this.live().withVerifiedDevice(async (scope) => {
      const current = () =>
          this.valid(r, generation) ? scope.current() : null,
        consent = this.consent(current);
      if (consent.list().revision !== r.consentRevision)
        throw new ConversationOfferError("CONFLICT");
      const access = (await consent.resolve(r.grant.id)).offerAccess();
      if (!access || !same(access.grant, r.grant) || !this.valid(r, generation))
        throw new ConversationOfferError("DENIED");
      const offers = this.offers(consent);
      let saved =
        input.action === "create"
          ? await offers.prepare({
              clientRequestId: r.clientRequestId,
              permissionId: r.grant.id,
              expectedConsentRevision: r.consentRevision,
              expiresAt: r.offerExpiresAt,
              confirmed: true,
            })
          : offers.get(input.id);
      if (
        input.action === "reveal" &&
        saved.revision !== input.expectedRevision
      )
        throw new ConversationOfferError("CONFLICT");
      saved = await offers.resume({
        id: saved.id,
        expectedRevision: saved.revision,
        confirmed: true,
      });
      const envelope = await offers.delivery({
        id: saved.id,
        expectedRevision: saved.revision,
        confirmed: true,
      });
      if (!this.valid(r, generation))
        throw new ConversationOfferError("DENIED");
      return { offer: this.item(saved), envelope };
    });
  }
}

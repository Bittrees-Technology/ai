import { z } from "zod";
import { createHash } from "node:crypto";
export const publicationContract = "news-reviewed-publication-v1" as const;
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const revision = z.number().int().min(0).max(2147483646);
const slug = z
  .string()
  .max(60)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const destination = z
  .string()
  .regex(/^https:\/\/news\.bittrees\.org\/[a-z0-9]+(?:-[a-z0-9]+)*$/)
  .max(86);
const itemShape = z
  .strictObject({
    id: z.string().regex(/^[a-f0-9]{64}$/),
    source_id: z.string().min(1).max(256),
    url: z.url().refine((v) => {
      const u = new URL(v);
      return u.protocol === "https:" && !u.username && !u.password;
    }),
    title: z.string().min(1).max(2000),
    topic: z.string().max(100),
    kind: z.string().max(100),
    published_at: z.iso.datetime(),
    tags: z.array(z.string().max(100)).max(50).optional(),
    authors: z.array(z.string().max(200)).max(20).optional(),
    publication: z.string().max(500).optional(),
    briefing_preview: z.string().max(16000).optional(),
    original_title: z.string().max(2000).optional(),
    observation_period: z.string().max(200).nullish(),
    released_at: z.iso.datetime().nullish(),
    retrieved_at: z.iso.datetime().nullish(),
    date_basis: z.string().max(100).optional(),
    translation_key: z.string().max(512).optional(),
    translation_status: z.string().max(100).optional(),
    translation: z
      .strictObject({
        language: z.string().max(30),
        title: z.string().max(2000).optional(),
        summary: z.string().max(16000).optional(),
        model: z.string().max(256),
      })
      .optional(),
    excerpt: z.string().max(32000),
    summary: z.string().max(16000).nullish(),
    summary_kind: z.string().max(100),
    user_edited: z.boolean().optional(),
  })
  .refine((i) =>
    i.user_edited === true
      ? i.summary_kind === "user_edited"
      : i.summary_kind !== "user_edited",
  );
const snapshotShape = z.strictObject({
  front: z.array(itemShape).min(1).max(100),
  feeds: z
    .array(
      z.strictObject({
        id: z.uuid(),
        name: z.string().max(100),
        slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
        items: z.array(itemShape).max(100),
      }),
    )
    .max(20),
  builtAt: z.iso.datetime().optional(),
  editedAt: z.iso.datetime().optional(),
});

export const newsPublicationReviewSchema = z
  .strictObject({
    contractVersion: z.literal(publicationContract),
    revision,
    publicationVersion: revision,
    reviewDigest: digest,
    url: destination,
    content: z.strictObject({
      name: z.string().min(1).max(100),
      slug,
      description: z.string().max(300),
      navigation: z
        .array(z.strictObject({ name: z.string().max(100), slug }))
        .max(20),
      snapshot: snapshotShape,
    }),
    eligibility: z.strictObject({
      eligible: z.boolean(),
      blockedItemIds: z.array(digest).max(2100),
    }),
    previousPublication: z.strictObject({
      published: z.boolean(),
      lastPublishedAt: z.iso.datetime().nullable(),
      snapshotDigest: digest.nullable(),
    }),
    observedAt: z.iso.datetime(),
  })
  .superRefine((v, ctx) => {
    const fail = () =>
      ctx.addIssue({
        code: "custom",
        message: "Inconsistent publication review",
      });
    if (
      v.url !== "https://news.bittrees.org/" + v.content.slug ||
      v.eligibility.eligible !== (v.eligibility.blockedItemIds.length === 0)
    )
      fail();
    const sections = [
      v.content.snapshot.front,
      ...v.content.snapshot.feeds.map((f) => f.items),
    ];
    for (const items of sections)
      if (new Set(items.map((i) => i.id)).size !== items.length) fail();
    const feedSlugs = v.content.snapshot.feeds.map((f) => f.slug),
      navSlugs = v.content.navigation.map((n) => n.slug);
    if (
      new Set(feedSlugs).size !== feedSlugs.length ||
      new Set(navSlugs).size !== navSlugs.length ||
      feedSlugs.some((s) => !navSlugs.includes(s))
    )
      fail();
    const allIds = new Set(sections.flat().map((i) => i.id));
    if (
      new Set(v.eligibility.blockedItemIds).size !==
        v.eligibility.blockedItemIds.length ||
      v.eligibility.blockedItemIds.some((i) => !allIds.has(i))
    )
      fail();
  });
export const newsPublicationReceiptSchema = z.strictObject({
  contractVersion: z.literal(publicationContract),
  operationId: z.uuid(),
  reviewDigest: digest,
  revision,
  publicationVersion: z.number().int().min(1).max(2147483647),
  url: destination,
  committedAt: z.iso.datetime(),
  status: z.literal("published"),
  historical: z.literal(true),
});
export const newsPublicationIdentitySchema = z.strictObject({
  accountId: z.uuid(),
  credentialId: z.uuid(),
});
export type NewsPublicationReview = z.infer<typeof newsPublicationReviewSchema>;
export type NewsPublicationReceipt = z.infer<
  typeof newsPublicationReceiptSchema
>;
export type NewsPublicationIdentity = z.infer<
  typeof newsPublicationIdentitySchema
>;
// Schema parsing fixes key order. The source observation timestamp is not content.
export function publicationFingerprint(value: NewsPublicationReview) {
  const { observedAt: _time, ...stable } =
    newsPublicationReviewSchema.parse(value);
  return createHash("sha256").update(JSON.stringify(stable)).digest("hex");
}
export function matchingPublicationReceipt(
  id: string,
  review: NewsPublicationReview,
  receipt: NewsPublicationReceipt,
) {
  return (
    receipt.operationId === id &&
    receipt.reviewDigest === review.reviewDigest &&
    receipt.revision === review.revision &&
    receipt.publicationVersion === review.publicationVersion + 1 &&
    receipt.url === review.url
  );
}

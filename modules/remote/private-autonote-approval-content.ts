import { z } from "zod";
import {
  autoNoteExactReviewSchema,
  type AutoNoteExactReview,
} from "../connectors/autonote-review-contracts.js";
import {
  approvalChunkByteLimit,
  approvalDetailByteLimit,
  autoNoteApprovalChunkSchema,
  autoNoteApprovalManifestSchema,
  type AutoNoteApprovalManifest,
  type AutoNoteApprovalChunk,
} from "./private-autonote-approval-contracts.js";
const encode = new TextEncoder();
const decode = new TextDecoder("utf-8", { fatal: true });
export class ApprovalContentError extends Error {
  readonly code = "APPROVAL_CONTENT_INVALID";
  constructor() {
    super("APPROVAL_CONTENT_INVALID");
  }
}
const digest = async (bytes: Uint8Array) =>
  Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes)),
    ),
  )
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("");
const encoded = (bytes: Uint8Array) => {
  let raw = "";
  for (let i = 0; i < bytes.length; i += 4096)
    raw += String.fromCharCode(...bytes.subarray(i, i + 4096));
  return btoa(raw).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
};
const decoded = (value: string) => {
  const bytes = Uint8Array.from(
    atob(value.replaceAll("-", "+").replaceAll("_", "/")),
    (c) => c.charCodeAt(0),
  );
  if (encoded(bytes) !== value) throw new ApprovalContentError();
  return bytes;
};
function current(manifest: AutoNoteApprovalManifest, now: number) {
  if (
    !Number.isSafeInteger(now) ||
    manifest.issuedAt > now + 30000 ||
    manifest.expiresAt <= now
  )
    throw new ApprovalContentError();
}
/** Internal plaintext preparation. The host must encrypt the manifest AND every
 * chunk to the explicitly authorized peer; no relay/network operation exists here. */
export async function splitAutoNoteApproval(
  rawDetail: unknown,
  rawScope: unknown,
  now = Date.now,
) {
  let bytes: Uint8Array | undefined;
  try {
    const detail = autoNoteExactReviewSchema.parse(rawDetail),
      scope = z
        .strictObject({
          offerId: z.uuid(),
          permissionId: z.uuid(),
          sourceApprovalId: z.uuid(),
          grantId: z.uuid(),
          issuedAt: z.number().int().positive(),
          expiresAt: z.number().int().positive(),
        })
        .parse(rawScope);
    bytes = encode.encode(JSON.stringify(detail));
    if (
      detail.meetingId !== detail.proposal.meetingId ||
      bytes.length > approvalDetailByteLimit ||
      scope.expiresAt > Date.parse(detail.expiresAt) ||
      (await digest(encode.encode(JSON.stringify(detail.proposal)))) !==
        detail.digest
    )
      throw new ApprovalContentError();
    const manifest = autoNoteApprovalManifestSchema.parse({
      version: 1,
      type: "autonote.approval.offer",
      ...scope,
      reviewId: detail.id,
      operationId: detail.proposal.operationId,
      meetingId: detail.meetingId,
      proposalDigest: detail.digest,
      detailHash: await digest(bytes),
      byteLength: bytes.length,
      chunkCount: Math.ceil(bytes.length / approvalChunkByteLimit),
    });
    current(manifest, now());
    const chunks: AutoNoteApprovalChunk[] = [];
    for (let index = 0; index < manifest.chunkCount; index++)
      chunks.push(
        autoNoteApprovalChunkSchema.parse({
          version: 1,
          type: "autonote.approval.chunk",
          id: crypto.randomUUID(),
          offerId: manifest.offerId,
          detailHash: manifest.detailHash,
          index,
          data: encoded(
            bytes.subarray(
              index * approvalChunkByteLimit,
              (index + 1) * approvalChunkByteLimit,
            ),
          ),
        }),
      );
    return { manifest, chunks };
  } catch {
    throw new ApprovalContentError();
  } finally {
    bytes?.fill(0);
  }
}
/** Complete-set validation only: host admission must already authenticate each
 * sender/recipient/epoch and atomically consume replay state. Partial notes never
 * become a review. A decision must bind both full-detail and proposal hashes. */
export async function assembleAutoNoteApproval(
  rawManifest: unknown,
  rawChunks: unknown,
  now = Date.now,
): Promise<AutoNoteExactReview> {
  let bytes: Uint8Array | undefined;
  try {
    const manifest = autoNoteApprovalManifestSchema.parse(rawManifest);
    current(manifest, now());
    if (!Array.isArray(rawChunks) || rawChunks.length !== manifest.chunkCount)
      throw new ApprovalContentError();
    bytes = new Uint8Array(manifest.byteLength);
    const seen = new Set<number>(),
      ids = new Set<string>();
    for (const raw of rawChunks) {
      const chunk = autoNoteApprovalChunkSchema.parse(raw);
      if (
        chunk.offerId !== manifest.offerId ||
        chunk.detailHash !== manifest.detailHash ||
        chunk.index >= manifest.chunkCount ||
        seen.has(chunk.index) ||
        ids.has(chunk.id)
      )
        throw new ApprovalContentError();
      seen.add(chunk.index);
      ids.add(chunk.id);
      const part = decoded(chunk.data),
        offset = chunk.index * approvalChunkByteLimit;
      try {
        if (
          part.length !==
          Math.min(approvalChunkByteLimit, manifest.byteLength - offset)
        )
          throw new ApprovalContentError();
        bytes.set(part, offset);
      } finally {
        part.fill(0);
      }
    }
    if ((await digest(bytes)) !== manifest.detailHash)
      throw new ApprovalContentError();
    const detail = autoNoteExactReviewSchema.parse(
      JSON.parse(decode.decode(bytes)),
    );
    if (
      detail.id !== manifest.reviewId ||
      detail.meetingId !== manifest.meetingId ||
      detail.proposal.meetingId !== manifest.meetingId ||
      detail.proposal.operationId !== manifest.operationId ||
      detail.digest !== manifest.proposalDigest ||
      manifest.expiresAt > Date.parse(detail.expiresAt) ||
      (await digest(encode.encode(JSON.stringify(detail.proposal)))) !==
        detail.digest ||
      encoded(encode.encode(JSON.stringify(detail))) !== encoded(bytes)
    )
      throw new ApprovalContentError();
    current(manifest, now());
    return detail;
  } catch {
    throw new ApprovalContentError();
  } finally {
    bytes?.fill(0);
  }
}

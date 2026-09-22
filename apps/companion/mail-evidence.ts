import { z } from "zod";
import { ConnectorError } from "../../modules/connectors/crm.js";
import { mailSections } from "../../modules/connectors/mail-drafts.js";
import {
  mailEvidenceRequest,
  mailEvidenceResponse,
  mailReviewSchema,
} from "../../modules/connectors/mail-evidence-contracts.js";
import type { MailTasks } from "../../modules/connectors/mail-tasks.js";
import { Store, StoreError, type Owner } from "../../modules/storage/store.js";

/** Fetch only a cited passage of the task's original authorized projection. No persisted raw source copy. */
export async function readMailEvidence(
  store: Store,
  owner: Owner,
  sources: Pick<MailTasks, "validate"> | undefined,
  id: string,
  raw: unknown,
) {
  const input = mailEvidenceRequest.parse(raw),
    task = store.get(owner, id);
  if (task.revision !== input.expectedRevision || task.status !== "completed")
    throw new StoreError("CONFLICT");
  const binding = store.sourceBinding(owner, id);
  const parsed = z
    .object({ kind: z.literal("unreviewed_draft"), mail: mailReviewSchema })
    .safeParse(task.result);
  const deny = (): never => {
    throw new ConnectorError("SOURCE_DENIED");
  };
  if (
    !sources ||
    !binding ||
    binding.authority.sourceApp !== "mail" ||
    !parsed.success
  )
    return deny();
  const mail = parsed.data.mail;
  const claims = [
    ...mail.summary,
    ...(mail.reply ? [mail.reply] : []),
    ...(mail.partSummaries?.flat() ?? []),
  ];
  const citations = claims.flatMap((c) => c.citations);
  if (!citations.some((c) => c.sectionId === input.sectionId)) return deny();
  const source = await sources.validate(binding),
    m = source.message;
  if (
    mail.messageId !== m.id ||
    mail.version !== m.sourceVersion ||
    mail.mode !== m.mode ||
    mail.projectionHash !== source.projectionHash ||
    mail.attachment?.id !==
      (m.mode === "attachment-text" ? m.attachment.id : undefined) ||
    citations.some(
      (c) =>
        c.messageId !== m.id ||
        c.version !== m.sourceVersion ||
        c.attachmentId !== mail.attachment?.id,
    )
  )
    return deny();
  let text: string | undefined;
  if (input.sectionId.startsWith("attachment-offset-")) {
    if (
      m.mode !== "attachment-text" ||
      !mail.partSummaries ||
      !mail.coverage ||
      mail.coverage.parts !== mail.partSummaries.length ||
      mail.coverage.sourceBytes !== m.attachment.bytes
    )
      return deny();
    const chars = Array.from(m.attachment.text);
    const offsets = mail.partSummaries.map((group) => {
      const ids = [
        ...new Set(
          group.flatMap((c) => c.citations.map((ref) => ref.sectionId)),
        ),
      ];
      if (ids.length !== 1 || !/^attachment-offset-(0|[1-9]\d*)$/.test(ids[0]!))
        return deny();
      return Number(ids[0]!.slice("attachment-offset-".length));
    });
    if (
      offsets[0] !== 0 ||
      offsets.some(
        (offset, i) =>
          !Number.isSafeInteger(offset) ||
          offset >= chars.length ||
          (i > 0 && offset <= offsets[i - 1]!),
      )
    )
      return deny();
    const index = offsets.findIndex(
      (offset) => "attachment-offset-" + offset === input.sectionId,
    );
    if (index < 0) return deny();
    text = chars
      .slice(offsets[index], offsets[index + 1] ?? chars.length)
      .join("");
  } else
    text = mailSections(source).find((s) => s.id === input.sectionId)?.text;
  if (text === undefined || text.length > 32000) return deny();
  // A deletion or model/task change during the asynchronous source read invalidates this preview.
  const current = store.get(owner, id);
  if (
    current.revision !== task.revision ||
    current.status !== "completed" ||
    JSON.stringify(store.sourceBinding(owner, id)) !== JSON.stringify(binding)
  )
    throw new StoreError("CONFLICT");
  return mailEvidenceResponse.parse({
    taskId: id,
    taskRevision: task.revision,
    sectionId: input.sectionId,
    text,
    mode: m.mode,
    incomplete:
      m.truncatedMetadata.length > 0 || (m.mode === "plain" && m.bodyTruncated),
  });
}

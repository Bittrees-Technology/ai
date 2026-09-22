import { createHash } from "node:crypto";
import { MailConnector } from "./mail.js";
import { ConnectorError } from "./crm.js";
import {
  sourceBindingSchema,
  type SourceBinding,
  type TaskInput,
} from "../contracts/index.js";
import { Store, type Owner } from "../storage/store.js";
const mailboxId = (mailbox: string) =>
  createHash("sha256")
    .update("mailbox:" + mailbox)
    .digest("hex");
/** A task binds one reviewed message version; caller data never selects source authority. */
export class MailTasks {
  constructor(
    private readonly connector: MailConnector,
    private readonly owner: Owner,
    private readonly deviceId: string,
  ) {}
  async create(
    store: Store,
    input: Omit<TaskInput, "sourceRefs" | "memoryIds">,
    content: "metadata" | "plain",
    key: string,
  ) {
    if (
      !["summarize", "draft"].includes(input.kind) ||
      (input.kind === "draft" && content !== "plain")
    )
      throw new ConnectorError("SOURCE_DENIED");
    const snapshot = await this.connector.read(content);
    if (
      input.kind === "draft" &&
      (snapshot.message.mode !== "plain" || !snapshot.message.bodyAvailable)
    )
      throw new ConnectorError("SOURCE_DENIED");
    const refs = [
      {
        app: "mail" as const,
        tenantId: mailboxId(snapshot.mailbox),
        resourceId: snapshot.message.id,
        revision: content + ":" + snapshot.message.sourceVersion,
      },
    ];
    const binding: SourceBinding = {
      authority: {
        userId: this.owner.userId,
        subjectId: snapshot.wallet,
        tenantId: refs[0]!.tenantId,
        deviceId: this.deviceId,
        sourceApp: "mail",
        grantId: snapshot.grantId,
        policyRevision: snapshot.policyRevision,
      },
      refs,
      expiresAt: snapshot.expiresAt,
      projectionHash: snapshot.projectionHash,
    };
    return store.create(
      this.owner,
      { ...input, sourceRefs: refs, memoryIds: [] },
      key,
      binding,
    );
  }
  async validate(raw: SourceBinding) {
    const parsed = sourceBindingSchema.safeParse(raw);
    if (!parsed.success) throw new ConnectorError("SOURCE_DENIED");
    const b = parsed.data;
    if (
      b.authority.sourceApp !== "mail" ||
      b.authority.userId !== this.owner.userId ||
      b.authority.deviceId !== this.deviceId ||
      b.refs.length !== 1 ||
      Date.parse(b.expiresAt) <= Date.now()
    )
      throw new ConnectorError("SOURCE_DENIED");
    const ref = b.refs[0]!,
      mode = ref.revision.split(":")[0];
    if (!["metadata", "plain"].includes(mode!))
      throw new ConnectorError("SOURCE_DENIED");
    const snapshot = await this.connector.read(mode as "metadata" | "plain");
    if (
      snapshot.wallet !== b.authority.subjectId ||
      mailboxId(snapshot.mailbox) !== b.authority.tenantId ||
      snapshot.grantId !== b.authority.grantId ||
      snapshot.policyRevision !== b.authority.policyRevision ||
      snapshot.expiresAt !== b.expiresAt ||
      snapshot.message.id !== ref.resourceId ||
      ref.revision !== mode + ":" + snapshot.message.sourceVersion ||
      snapshot.projectionHash !== b.projectionHash
    )
      throw new ConnectorError("SOURCE_DENIED");
    return snapshot;
  }
}

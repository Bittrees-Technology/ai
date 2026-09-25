import { ConnectorError } from "./crm.js";
import { AutoNoteConnector } from "./autonote.js";
import type { SourceBinding, TaskInput } from "../contracts/index.js";
import { Store, type Owner } from "../storage/store.js";
/** Server-side source adapter. Never accepts caller-selected subject, grant, revision or authority. */
export class AutoNoteTasks {
  constructor(
    private readonly connector: AutoNoteConnector,
    private readonly owner: Owner,
    private readonly deviceId: string,
  ) {}
  async choices() {
    const status = await this.connector.status();
    if (!status || status.state !== "stored")
      throw new ConnectorError("CONNECTION_REQUIRED");
    const snapshot = await this.connector.read(status.meetingId);
    if (
      snapshot.grantId !== status.grantId ||
      snapshot.subjectId !== status.subjectId ||
      snapshot.workspaceId !== status.workspaceId
    )
      throw new ConnectorError("INVALID_SOURCE");
    return [
      {
        id: snapshot.meeting.id,
        title: snapshot.meeting.title,
        version: snapshot.meeting.version,
      },
    ];
  }

  async create(
    store: Store,
    input: Omit<TaskInput, "sourceRefs" | "memoryIds">,
    meetingId: string,
    key: string,
    beforeCommit: () => void = () => {},
  ) {
    const status = await this.connector.status();
    if (!status || status.state !== "stored")
      throw new ConnectorError("CONNECTION_REQUIRED");
    const snapshot = await this.connector.read(meetingId);
    if (
      snapshot.grantId !== status.grantId ||
      snapshot.subjectId !== status.subjectId ||
      snapshot.workspaceId !== status.workspaceId
    )
      throw new ConnectorError("INVALID_SOURCE");
    const refs = [
      {
        app: "autonote" as const,
        tenantId: snapshot.workspaceId,
        resourceId: snapshot.meeting.id,
        revision: String(snapshot.meeting.version),
      },
    ];
    const binding: SourceBinding = {
      authority: {
        userId: this.owner.userId,
        subjectId: snapshot.subjectId,
        tenantId: snapshot.workspaceId,
        deviceId: this.deviceId,
        sourceApp: "autonote",
        grantId: snapshot.grantId,
        policyRevision: snapshot.policyRevision,
      },
      refs,
      expiresAt: status.expiresAt,
      projectionHash: snapshot.projectionHash,
    };
    beforeCommit();
    return store.create(
      this.owner,
      {
        ...input,
        sourceRefs: refs,
        memoryIds: input.memorySelection?.memories.map((item) => item.id) ?? [],
      },
      key,
      binding,
    );
  }
  captureReadBoundary() {
    return this.connector.captureReadBoundary();
  }
  async validate(binding: SourceBinding) {
    if (
      binding.authority.sourceApp !== "autonote" ||
      binding.refs.length !== 1 ||
      binding.refs.some(
        (r) =>
          r.app !== "autonote" || r.tenantId !== binding.authority.tenantId,
      ) ||
      binding.authority.userId !== this.owner.userId ||
      binding.authority.deviceId !== this.deviceId ||
      Date.parse(binding.expiresAt) <= Date.now()
    )
      throw new ConnectorError("SOURCE_DENIED");
    const status = await this.connector.status();
    if (
      !status ||
      status.state !== "stored" ||
      status.grantId !== binding.authority.grantId ||
      status.subjectId !== binding.authority.subjectId ||
      status.workspaceId !== binding.authority.tenantId ||
      status.policyRevision !== binding.authority.policyRevision
    )
      throw new ConnectorError("SOURCE_DENIED");
    const snapshot = await this.connector.read(binding.refs[0]!.resourceId);
    if (
      snapshot.grantId !== binding.authority.grantId ||
      snapshot.subjectId !== binding.authority.subjectId ||
      snapshot.workspaceId !== binding.authority.tenantId ||
      snapshot.projectionHash !== binding.projectionHash
    )
      throw new ConnectorError("SOURCE_DENIED");
    if (binding.refs[0]!.revision !== String(snapshot.meeting.version))
      throw new ConnectorError("SOURCE_DENIED");
    return snapshot;
  }
}

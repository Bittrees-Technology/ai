import { createHash } from "node:crypto";
import { CrmConnector, ConnectorError } from "./crm.js";
import type { SourceBinding, TaskInput } from "../contracts/index.js";
import { Store, type Owner } from "../storage/store.js";
const fingerprint = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
/** Server-side source adapter. Never accepts caller-selected subject, grant, revision or authority. */
export class CrmTasks {
  constructor(
    private readonly connector: CrmConnector,
    private readonly owner: Owner,
    private readonly deviceId: string,
  ) {}
  async choices() {
    const status = await this.connector.status();
    if (!status || status.state !== "stored")
      throw new ConnectorError("CONNECTION_REQUIRED");
    const snapshot = await this.connector.read(status.recordIds);
    if (
      snapshot.grantId !== status.grantId ||
      snapshot.subjectId !== status.subjectId ||
      snapshot.workspaceId !== status.workspaceId
    )
      throw new ConnectorError("INVALID_SOURCE");
    return snapshot.records.map(({ id, kind, data }) => ({
      id,
      kind,
      name: data.name,
    }));
  }
  async create(
    store: Store,
    input: Omit<TaskInput, "sourceRefs" | "memoryIds">,
    recordIds: string[],
    key: string,
    beforeCommit: () => void = () => {},
  ) {
    const status = await this.connector.status();
    if (!status || status.state !== "stored")
      throw new ConnectorError("CONNECTION_REQUIRED");
    const snapshot = await this.connector.read(recordIds);
    if (
      snapshot.grantId !== status.grantId ||
      snapshot.subjectId !== status.subjectId ||
      snapshot.workspaceId !== status.workspaceId
    )
      throw new ConnectorError("INVALID_SOURCE");
    const refs = snapshot.records.map((r) => ({
      app: "crm" as const,
      tenantId: snapshot.workspaceId,
      resourceId: r.id,
      revision: String(r.version),
    }));
    const binding: SourceBinding = {
      authority: {
        userId: this.owner.userId,
        subjectId: snapshot.subjectId,
        tenantId: snapshot.workspaceId,
        deviceId: this.deviceId,
        sourceApp: "crm",
        grantId: snapshot.grantId,
        policyRevision: snapshot.policyRevision,
      },
      refs,
      expiresAt: status.expiresAt,
      projectionHash: fingerprint(snapshot.records),
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
      binding.authority.sourceApp !== "crm" ||
      binding.refs.some(
        (r) => r.app !== "crm" || r.tenantId !== binding.authority.tenantId,
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
    const snapshot = await this.connector.read(
      binding.refs.map((r) => r.resourceId),
    );
    if (
      snapshot.grantId !== binding.authority.grantId ||
      snapshot.subjectId !== binding.authority.subjectId ||
      snapshot.workspaceId !== binding.authority.tenantId ||
      fingerprint(snapshot.records) !== binding.projectionHash
    )
      throw new ConnectorError("SOURCE_DENIED");
    if (
      snapshot.records.some(
        (r) =>
          binding.refs.find((ref) => ref.resourceId === r.id)?.revision !==
          String(r.version),
      )
    )
      throw new ConnectorError("SOURCE_DENIED");
    return snapshot;
  }
}

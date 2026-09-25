import {
  autoNoteApprovalOutboxesSchema,
  type AutoNoteApprovalOutbox,
} from "../remote/private-autonote-approval-outbox-contracts.js";
import {
  autoNotePeerApprovalGrantsSchema,
  type AutoNotePeerApprovalGrant,
} from "../remote/private-autonote-approval-consent-contracts.js";
import { exportPrivateResumeOffers } from "../remote/private-resume-offers.js";
import { exportPrivateResumeDelivery } from "../remote/private-resume-delivery.js";
import { exportPrivateResumeConsent } from "../remote/private-resume-consent.js";
import { RemoteResumes } from "./remote-resumes.js";
import { exportPrivateConversationContent } from "../remote/private-conversation-content.js";
import { exportPrivateIncomingReplay } from "../remote/private-incoming-replay.js";
import { exportPrivateConversationOffers } from "../remote/private-conversation-offers.js";
import { exportPrivateConversationConsent } from "../remote/private-conversation-consent.js";
import {
  queuePrivateRelayDeletion,
  exportPrivateRelayCredentials,
} from "../remote/private-relay-custody.js";
import { MailSends } from "./mail-sends.js";
import { NewsPublications } from "./news-publications.js";
import { TaskFeedback } from "./task-feedback.js";
import { dependencyFailureSchema } from "./dependency-failure.js";
import { exportPrivateTaskConsent } from "../remote/private-task-consent.js";
import { exportPrivatePeerChecks } from "../remote/private-peer-checks.js";
import {
  exportPrivateKeyLifecycle,
  queuePrivateKeyDeletion,
} from "../remote/private-key-lifecycle.js";
import { exportPrivateTaskResponses } from "../remote/private-task-responses.js";
import { exportPrivateTaskOutbox } from "../remote/private-task-outbox.js";
import { exportPrivateTaskReceipts } from "../remote/private-task-receipts.js";
import { exportPrivatePeers } from "../remote/private-peers.js";
import { databaseChangeToken } from "./change-token.js";
import { MemoryExtractions } from "./memory-extractions.js";
import { RemoteTemplates } from "./remote-templates.js";
import {
  templateSaveSchema,
  templateActionSchema,
  templateRunSchema,
  templateDefinitionSchema,
  type LocalTemplate,
} from "./templates.js";
import {
  autoNoteProposalSchema,
  autoNoteReconciledSchema,
  type AutoNoteProposal,
} from "../connectors/autonote-review-contracts.js";
import { z } from "zod";
import {
  remoteControlSchema,
  remoteReceiptSchema,
  parseRemoteControl,
} from "../remote/status.js";
import {
  crmProposalSchema,
  crmPreparedSchema,
  crmReceiptSchema,
  type CrmProposal,
  type CrmPrepared,
  type CrmReceipt,
} from "../connectors/crm-write-contracts.js";
import Database from "better-sqlite3";
import { randomUUID, createHash } from "node:crypto";
import { Vault } from "./vault.js";
import {
  requestSchema,
  sourceBindingSchema,
  type SourceBinding,
  commandSchema,
  modelProfileSchema,
  inboxSchema,
  inboxMessageSchema,
  type TaskInput,
  type TaskStatus,
} from "../contracts/index.js";
export class StoreError extends Error {
  constructor(
    public code:
      | "NOT_FOUND"
      | "CONFLICT"
      | "STALE_CLAIM"
      | "INVALID_INPUT"
      | "EXPIRED"
      | "CAPACITY",
  ) {
    super(code);
  }
}
export interface Owner {
  userId: string;
  tenantId: string;
}
interface Row {
  id: string;
  user_id: string;
  tenant_id: string;
  conversation_id: string;
  sequence: number;
  status: TaskStatus;
  revision: number;
  generation: number;
  lease_until: number | null;
  worker_id: string | null;
  deadline: number | null;
  next_attempt_at: number;
  created_at: number;
  updated_at: number;
  input: Buffer;
  result: Buffer | null;
  payload_hash: string;
  attempts: number;
}
export interface Task {
  id: string;
  conversationId: string;
  sequence: number;
  status: TaskStatus;
  revision: number;
  generation: number;
  createdAt: number;
  updatedAt: number;
  input: TaskInput;
  result: unknown;
}
export interface Publication {
  id: string;
  taskId: string;
  grantId: string;
  taskRevision: number;
  proposal: CrmProposal;
  state: "pending" | "prepared" | "uncertain" | "published" | "deleted";
  prepared: CrmPrepared | null;
  receipt: CrmReceipt | null;
  revision: number;
}
export interface AutoNoteReview {
  id: string;
  taskId: string;
  grantId: string;
  taskRevision: number;
  proposal: AutoNoteProposal;
  state: "local" | "uncertain" | "prepared" | "saved" | "deleted";
  response: z.infer<typeof autoNoteReconciledSchema> | null;
  approvalAttempt?: {
    approvalId: string;
    reviewedHash: string;
    requestedAt: string;
  };
  approvalDelegations?: AutoNotePeerApprovalGrant[];
  approvalOutboxes?: AutoNoteApprovalOutbox[];
  revision: number;
}
export interface Claim {
  task: Task;
  workerId: string;
  generation: number;
  leaseUntil: number;
}
const remoteControlIdentitySchema = z.strictObject({
  remoteOwnerId: z.uuid(),
  controlId: z.uuid(),
  deviceId: z.uuid(),
  epoch: z.number().int().positive().max(2147483647),
});
const remoteControlBindingSchema = remoteControlIdentitySchema.extend({
  expiresAt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});
const terminal = ["completed", "failed", "cancelled", "expired"];
export class Store {
  readonly db: Database.Database;
  readonly remoteTemplates: RemoteTemplates;
  readonly remoteResumes: RemoteResumes;
  readonly memoryExtractions: MemoryExtractions;
  readonly taskFeedback: TaskFeedback;
  readonly newsPublications: NewsPublications;
  readonly mailSends: MailSends;
  constructor(
    path: string,
    private vault: Vault,
    private now: () => number = Date.now,
  ) {
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = FULL");
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("busy_timeout = 5000");
    this.db.pragma("secure_delete = ON");
    const version = this.db.pragma("user_version", { simple: true }) as number;
    if (version > 38) {
      this.db.close();
      throw new Error("Unsupported database version");
    }
    try {
      this.db.transaction(() => {
        this.db.exec(`
CREATE TABLE IF NOT EXISTS conversations(id TEXT NOT NULL,user_id TEXT NOT NULL,tenant_id TEXT NOT NULL,next_sequence INTEGER NOT NULL DEFAULT 1,PRIMARY KEY(id,user_id,tenant_id));
CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,tenant_id TEXT NOT NULL,conversation_id TEXT NOT NULL,sequence INTEGER NOT NULL,status TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 1,generation INTEGER NOT NULL DEFAULT 0,lease_until INTEGER,worker_id TEXT,deadline INTEGER,next_attempt_at INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,input BLOB NOT NULL,result BLOB,payload_hash TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,UNIQUE(user_id,tenant_id,conversation_id,sequence));
CREATE INDEX IF NOT EXISTS tasks_owner ON tasks(user_id,tenant_id,created_at);
CREATE INDEX IF NOT EXISTS tasks_claim ON tasks(status,next_attempt_at,lease_until);
CREATE TABLE IF NOT EXISTS dependencies(task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,depends_on TEXT NOT NULL REFERENCES tasks(id),PRIMARY KEY(task_id,depends_on));
CREATE TABLE IF NOT EXISTS idempotency(user_id TEXT NOT NULL,tenant_id TEXT NOT NULL,key TEXT NOT NULL,hash TEXT NOT NULL,task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,PRIMARY KEY(user_id,tenant_id,key));
CREATE TABLE IF NOT EXISTS events(cursor INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,revision INTEGER NOT NULL,type TEXT NOT NULL,created_at INTEGER NOT NULL,UNIQUE(task_id,revision));
CREATE TABLE IF NOT EXISTS outbox(event_id TEXT PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE,acknowledged_at INTEGER);
CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,generation INTEGER NOT NULL,worker_id TEXT NOT NULL,started_at INTEGER NOT NULL,finished_at INTEGER,outcome TEXT,UNIQUE(task_id,generation));
`);
        this.db.exec(`
CREATE TABLE IF NOT EXISTS vault_meta(id INTEGER PRIMARY KEY CHECK(id=1), verifier BLOB NOT NULL);
CREATE TABLE IF NOT EXISTS inboxes(id TEXT NOT NULL,user_id TEXT NOT NULL,tenant_id TEXT NOT NULL,definition BLOB NOT NULL,PRIMARY KEY(id,user_id,tenant_id));
CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,tenant_id TEXT NOT NULL,inbox_id TEXT NOT NULL,conversation_id TEXT NOT NULL,sequence INTEGER NOT NULL,request_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,content BLOB NOT NULL,key TEXT NOT NULL,hash TEXT NOT NULL,created_at INTEGER NOT NULL,UNIQUE(user_id,tenant_id,key),FOREIGN KEY(inbox_id,user_id,tenant_id) REFERENCES inboxes(id,user_id,tenant_id) ON DELETE CASCADE);
CREATE INDEX IF NOT EXISTS messages_cursor ON messages(user_id,tenant_id,inbox_id,sequence);
CREATE TABLE IF NOT EXISTS receipts(message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,user_id TEXT NOT NULL,kind TEXT NOT NULL,recorded_at INTEGER NOT NULL,PRIMARY KEY(message_id,user_id,kind));
CREATE TABLE IF NOT EXISTS checkins(id TEXT PRIMARY KEY,message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,due_at INTEGER NOT NULL,closed_at INTEGER);
`);
        const verifier = this.db
          .prepare("SELECT verifier FROM vault_meta WHERE id=1")
          .get() as { verifier: Buffer } | undefined;
        if (verifier) {
          if (
            this.vault.open(verifier.verifier, "vault-verifier") !==
            "bittrees-ai"
          )
            throw new Error("Invalid storage key");
        } else {
          const previous = this.db
            .prepare("SELECT id,input FROM tasks LIMIT 1")
            .get() as { id: string; input: Buffer } | undefined;
          if (previous) this.vault.open(previous.input, "task:" + previous.id);
          this.db
            .prepare("INSERT INTO vault_meta VALUES(1,?)")
            .run(this.vault.seal("bittrees-ai", "vault-verifier"));
        }
        if (version < 3)
          this.db.exec("ALTER TABLE runs ADD COLUMN model_snapshot BLOB");
        this.db
          .exec(`CREATE TABLE IF NOT EXISTS model_profiles(id TEXT NOT NULL,user_id TEXT NOT NULL,tenant_id TEXT NOT NULL,payload BLOB NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(id,user_id,tenant_id));
CREATE TABLE IF NOT EXISTS model_defaults(user_id TEXT NOT NULL,tenant_id TEXT NOT NULL,profile_id TEXT NOT NULL,PRIMARY KEY(user_id,tenant_id),FOREIGN KEY(profile_id,user_id,tenant_id) REFERENCES model_profiles(id,user_id,tenant_id));`);
        this.db.exec(
          "CREATE TABLE IF NOT EXISTS task_sources(task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,payload BLOB NOT NULL)",
        );
        this.db.exec(
          "CREATE TABLE IF NOT EXISTS publication_intents(id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,payload BLOB NOT NULL,revision INTEGER NOT NULL DEFAULT 1)",
        );
        this.db.exec(
          "CREATE TABLE IF NOT EXISTS autonote_reviews(id TEXT PRIMARY KEY,task_id TEXT NOT NULL UNIQUE REFERENCES tasks(id) ON DELETE CASCADE,payload BLOB NOT NULL,revision INTEGER NOT NULL DEFAULT 1)",
        );
        this.db
          .exec(`CREATE TABLE IF NOT EXISTS remote_control_bindings(user_id TEXT NOT NULL,tenant_id TEXT NOT NULL,device_id TEXT NOT NULL,payload BLOB NOT NULL,PRIMARY KEY(user_id,tenant_id,device_id));
CREATE TABLE IF NOT EXISTS remote_control_receipts(user_id TEXT NOT NULL,tenant_id TEXT NOT NULL,id TEXT NOT NULL,payload BLOB NOT NULL,PRIMARY KEY(user_id,tenant_id,id));`);
        this.db.exec(
          `CREATE TABLE IF NOT EXISTS local_templates(id TEXT NOT NULL,user_id TEXT NOT NULL,tenant_id TEXT NOT NULL,revision INTEGER NOT NULL,payload BLOB,PRIMARY KEY(id,user_id,tenant_id));`,
        );
        this.db
          .exec(`CREATE TABLE IF NOT EXISTS remote_template_permissions(id TEXT NOT NULL,user_id TEXT NOT NULL,tenant_id TEXT NOT NULL,device_id TEXT NOT NULL,template_id TEXT NOT NULL,payload BLOB,PRIMARY KEY(id,user_id,tenant_id));
CREATE TABLE IF NOT EXISTS remote_template_runs(task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,permission_id TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS remote_template_receipts(user_id TEXT NOT NULL,tenant_id TEXT NOT NULL,id TEXT NOT NULL,payload BLOB NOT NULL,PRIMARY KEY(user_id,tenant_id,id));`);
        this.db.exec(
          "CREATE TABLE IF NOT EXISTS memory_extractions(task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,payload BLOB NOT NULL)",
        );
        this.db
          .exec(`CREATE TABLE IF NOT EXISTS message_positions(position INTEGER PRIMARY KEY AUTOINCREMENT,message_id TEXT NOT NULL UNIQUE REFERENCES messages(id) ON DELETE CASCADE);
INSERT INTO message_positions(message_id) SELECT m.id FROM messages m LEFT JOIN message_positions p ON p.message_id=m.id WHERE p.message_id IS NULL ORDER BY m.rowid;`);
        this.db.exec(
          "CREATE TABLE IF NOT EXISTS private_peer_states(user_id TEXT NOT NULL,tenant_id TEXT NOT NULL,revision INTEGER NOT NULL,anchor TEXT NOT NULL,locked INTEGER NOT NULL DEFAULT 0,payload BLOB,PRIMARY KEY(user_id,tenant_id))",
        );
        this.db.exec(
          "CREATE TABLE IF NOT EXISTS private_task_receipts(user_id TEXT NOT NULL,tenant_id TEXT NOT NULL,operation_hash TEXT NOT NULL,message_hash TEXT NOT NULL,sequence_hash TEXT NOT NULL,envelope_hash TEXT NOT NULL,payload BLOB NOT NULL,PRIMARY KEY(user_id,tenant_id,operation_hash),UNIQUE(user_id,tenant_id,message_hash),UNIQUE(user_id,tenant_id,sequence_hash))",
        );
        this.db.exec(
          "CREATE TABLE IF NOT EXISTS private_task_outbox(user_id TEXT NOT NULL,tenant_id TEXT NOT NULL,id TEXT NOT NULL,client_hash TEXT NOT NULL,operation_hash TEXT NOT NULL,revision INTEGER NOT NULL,locked INTEGER NOT NULL DEFAULT 0,payload BLOB NOT NULL,PRIMARY KEY(user_id,tenant_id,id),UNIQUE(user_id,tenant_id,client_hash),UNIQUE(user_id,tenant_id,operation_hash)); CREATE TABLE IF NOT EXISTS private_send_channels(user_id TEXT NOT NULL,tenant_id TEXT NOT NULL,channel_hash TEXT NOT NULL,next_sequence INTEGER NOT NULL,PRIMARY KEY(user_id,tenant_id,channel_hash))",
        );
        this.db.exec(
          "CREATE TABLE IF NOT EXISTS private_task_responses(user_id TEXT NOT NULL,tenant_id TEXT NOT NULL,id TEXT NOT NULL,operation_hash TEXT NOT NULL,kind TEXT NOT NULL,revision INTEGER NOT NULL,locked INTEGER NOT NULL DEFAULT 0,payload BLOB NOT NULL,PRIMARY KEY(user_id,tenant_id,id),UNIQUE(user_id,tenant_id,operation_hash,kind))",
        );
        this.db.exec(
          "CREATE TABLE IF NOT EXISTS private_key_lifecycle(user_id TEXT NOT NULL,tenant_id TEXT NOT NULL,revision INTEGER NOT NULL,anchor TEXT NOT NULL,locked INTEGER NOT NULL DEFAULT 0,payload BLOB,PRIMARY KEY(user_id,tenant_id))",
        );
        this.db.exec(
          "CREATE TABLE IF NOT EXISTS private_task_consents(user_id TEXT NOT NULL,tenant_id TEXT NOT NULL,revision INTEGER NOT NULL,locked INTEGER NOT NULL DEFAULT 0,payload BLOB,PRIMARY KEY(user_id,tenant_id))",
        );
        this.db.exec(
          "CREATE TABLE IF NOT EXISTS private_peer_checks(user_id TEXT NOT NULL,tenant_id TEXT NOT NULL,id TEXT NOT NULL,role TEXT NOT NULL,operation_hash TEXT NOT NULL,revision INTEGER NOT NULL,locked INTEGER NOT NULL DEFAULT 0,payload BLOB NOT NULL,PRIMARY KEY(user_id,tenant_id,id),UNIQUE(user_id,tenant_id,role,operation_hash))",
        );
        // Previously approved choices cannot become active merely because a new
        // possession check succeeds. Require a fresh permission review after upgrade.
        if (version < 19)
          this.db.exec(
            "UPDATE private_task_consents SET locked=1,revision=revision+1",
          );
        this.db.exec(
          "CREATE TABLE IF NOT EXISTS task_feedback(task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,revision INTEGER NOT NULL,payload BLOB NOT NULL)",
        );
        this.db.exec(
          "CREATE TABLE IF NOT EXISTS news_publications(user_id TEXT NOT NULL,tenant_id TEXT NOT NULL,id TEXT NOT NULL,payload BLOB NOT NULL,PRIMARY KEY(user_id,tenant_id,id))",
        );
        this.db.exec(
          "CREATE TABLE IF NOT EXISTS mail_sends(user_id TEXT NOT NULL,tenant_id TEXT NOT NULL,id TEXT NOT NULL,payload BLOB NOT NULL,PRIMARY KEY(user_id,tenant_id,id))",
        );
        this.db.exec(
          "CREATE TABLE IF NOT EXISTS private_relay_credentials(id TEXT NOT NULL,user_id TEXT NOT NULL,tenant_id TEXT NOT NULL,revision INTEGER NOT NULL,locked INTEGER NOT NULL DEFAULT 0,phase TEXT NOT NULL,grant_hash TEXT NOT NULL,payload BLOB,PRIMARY KEY(user_id,tenant_id,id),UNIQUE(user_id,tenant_id,grant_hash)); CREATE UNIQUE INDEX IF NOT EXISTS private_relay_one_active ON private_relay_credentials(user_id,tenant_id) WHERE locked=0 AND phase IN ('accepting','storing','active')",
        );
        this.db.exec(
          "CREATE TABLE IF NOT EXISTS private_response_delivery(user_id TEXT NOT NULL,tenant_id TEXT NOT NULL,response_id TEXT NOT NULL,payload BLOB NOT NULL,PRIMARY KEY(user_id,tenant_id,response_id),FOREIGN KEY(user_id,tenant_id,response_id) REFERENCES private_task_responses(user_id,tenant_id,id) ON DELETE CASCADE)",
        );
        this.db.exec(
          "CREATE TABLE IF NOT EXISTS task_input_waits(task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,question_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,worker_id TEXT NOT NULL,generation INTEGER NOT NULL,deadline INTEGER NOT NULL,reply_id TEXT UNIQUE REFERENCES messages(id),reply_revision INTEGER,CHECK((reply_id IS NULL)=(reply_revision IS NULL))); CREATE UNIQUE INDEX IF NOT EXISTS task_one_input_wait ON task_input_waits(task_id) WHERE reply_id IS NULL",
        );
        this.db.exec(
          "CREATE TABLE IF NOT EXISTS private_conversation_consents(user_id TEXT NOT NULL,tenant_id TEXT NOT NULL,revision INTEGER NOT NULL,locked INTEGER NOT NULL DEFAULT 0,payload BLOB,PRIMARY KEY(user_id,tenant_id))",
        );
        this.db.exec(
          "CREATE TABLE IF NOT EXISTS private_conversation_offers(user_id TEXT NOT NULL,tenant_id TEXT NOT NULL,id TEXT NOT NULL,client_hash TEXT NOT NULL,revision INTEGER NOT NULL,locked INTEGER NOT NULL DEFAULT 0,payload BLOB NOT NULL,PRIMARY KEY(user_id,tenant_id,id),UNIQUE(user_id,tenant_id,client_hash))",
        );
        this.db.exec(
          "CREATE TABLE IF NOT EXISTS private_incoming_replay(user_id TEXT NOT NULL,tenant_id TEXT NOT NULL,operation_hash TEXT NOT NULL,message_hash TEXT NOT NULL,sequence_hash TEXT NOT NULL,payload BLOB NOT NULL,PRIMARY KEY(user_id,tenant_id,operation_hash),UNIQUE(user_id,tenant_id,message_hash),UNIQUE(user_id,tenant_id,sequence_hash))",
        );
        this.db.exec(
          "CREATE TABLE IF NOT EXISTS private_conversation_content(user_id TEXT NOT NULL,tenant_id TEXT NOT NULL,id_hash TEXT NOT NULL,revision INTEGER NOT NULL,locked INTEGER NOT NULL DEFAULT 0,payload BLOB NOT NULL,PRIMARY KEY(user_id,tenant_id,id_hash))",
        );
        this.db
          .exec(`CREATE TABLE IF NOT EXISTS remote_resume_permissions(user_id TEXT NOT NULL,tenant_id TEXT NOT NULL,id TEXT NOT NULL,device_id TEXT NOT NULL,task_id TEXT NOT NULL,payload BLOB,PRIMARY KEY(user_id,tenant_id,id));
CREATE TABLE IF NOT EXISTS remote_resume_receipts(user_id TEXT NOT NULL,tenant_id TEXT NOT NULL,id TEXT NOT NULL,payload BLOB NOT NULL,PRIMARY KEY(user_id,tenant_id,id));`);
        this.db.exec(
          "CREATE TABLE IF NOT EXISTS private_resume_consents(user_id TEXT NOT NULL,tenant_id TEXT NOT NULL,revision INTEGER NOT NULL,locked INTEGER NOT NULL DEFAULT 0,payload BLOB,PRIMARY KEY(user_id,tenant_id))",
        );
        this.db.exec(
          "CREATE TABLE IF NOT EXISTS private_resume_delivery(user_id TEXT NOT NULL,tenant_id TEXT NOT NULL,id TEXT NOT NULL,locked INTEGER NOT NULL DEFAULT 0,payload BLOB NOT NULL,PRIMARY KEY(user_id,tenant_id,id))",
        );
        // Older writers must not bypass retained single-use resume authority.
        this.db.exec(
          "CREATE TABLE IF NOT EXISTS private_resume_offers(user_id TEXT NOT NULL,tenant_id TEXT NOT NULL,id TEXT NOT NULL,client_hash TEXT NOT NULL,revision INTEGER NOT NULL,locked INTEGER NOT NULL DEFAULT 0,payload BLOB NOT NULL,PRIMARY KEY(user_id,tenant_id,id),UNIQUE(user_id,tenant_id,client_hash))",
        );
        this.db.pragma("user_version = 38");
      })();
    } catch (error) {
      this.db.close();
      throw error;
    }
    this.remoteTemplates = new RemoteTemplates(this, vault, now);
    this.remoteResumes = new RemoteResumes(this, vault, now);
    this.memoryExtractions = new MemoryExtractions(this, vault);
    this.taskFeedback = new TaskFeedback(this, vault, now);
    this.newsPublications = new NewsPublications(this, vault, now);
    this.mailSends = new MailSends(this, vault, now);
  }
  private templatePurpose(owner: Owner, id: string) {
    return JSON.stringify(["local-template", owner.tenantId, owner.userId, id]);
  }
  template(owner: Owner, id: string): LocalTemplate {
    z.uuid().parse(id);
    const row = this.db
      .prepare(
        "SELECT revision,payload FROM local_templates WHERE id=? AND user_id=? AND tenant_id=?",
      )
      .get(id, owner.userId, owner.tenantId) as
      { revision: number; payload: Buffer | null } | undefined;
    if (!row?.payload) throw new StoreError("NOT_FOUND");
    return {
      id,
      revision: row.revision,
      definition: templateDefinitionSchema.parse(
        this.vault.open(row.payload, this.templatePurpose(owner, id)),
      ),
    };
  }
  templates(owner: Owner): LocalTemplate[] {
    return (
      this.db
        .prepare(
          "SELECT id FROM local_templates WHERE user_id=? AND tenant_id=? AND payload IS NOT NULL ORDER BY id",
        )
        .all(owner.userId, owner.tenantId) as { id: string }[]
    ).map((row) => this.template(owner, row.id));
  }
  saveTemplate(owner: Owner, raw: unknown) {
    const { id, expectedRevision, definition } = templateSaveSchema.parse(raw);
    return this.db
      .transaction(() => {
        this.profile(owner, definition.modelProfileId);
        const row = this.db
          .prepare(
            "SELECT revision,payload FROM local_templates WHERE id=? AND user_id=? AND tenant_id=?",
          )
          .get(id, owner.userId, owner.tenantId) as
          { revision: number; payload: Buffer | null } | undefined;
        if (row) {
          // Deleted IDs cannot be recycled into a different definition.
          if (!row.payload) throw new StoreError("CONFLICT");
          const current = this.template(owner, id);
          if (
            row.revision === expectedRevision + 1 &&
            this.vault.fingerprint(current.definition) ===
              this.vault.fingerprint(definition)
          )
            return current;
          if (row.revision !== expectedRevision)
            throw new StoreError("CONFLICT");
          this.remoteTemplates.revokeTemplate(owner, id);
          this.db
            .prepare(
              "UPDATE local_templates SET revision=revision+1,payload=? WHERE id=? AND user_id=? AND tenant_id=?",
            )
            .run(
              this.vault.seal(definition, this.templatePurpose(owner, id)),
              id,
              owner.userId,
              owner.tenantId,
            );
        } else {
          if (expectedRevision !== 0) throw new StoreError("CONFLICT");
          const count = this.db
            .prepare(
              "SELECT COUNT(*) AS count FROM local_templates WHERE user_id=? AND tenant_id=? AND payload IS NOT NULL",
            )
            .get(owner.userId, owner.tenantId) as { count: number };
          if (count.count >= 100) throw new StoreError("CAPACITY");
          this.db
            .prepare("INSERT INTO local_templates VALUES(?,?,?,1,?)")
            .run(
              id,
              owner.userId,
              owner.tenantId,
              this.vault.seal(definition, this.templatePurpose(owner, id)),
            );
        }
        return this.template(owner, id);
      })
      .immediate();
  }
  deleteTemplate(owner: Owner, id: string, raw: unknown) {
    const { expectedRevision } = templateActionSchema.parse(raw);
    return this.db
      .transaction(() => {
        const current = this.template(owner, id);
        if (current.revision !== expectedRevision)
          throw new StoreError("CONFLICT");
        this.remoteTemplates.revokeTemplate(owner, id);
        this.db
          .prepare(
            "UPDATE local_templates SET payload=NULL WHERE id=? AND user_id=? AND tenant_id=?",
          )
          .run(id, owner.userId, owner.tenantId);
      })
      .immediate();
  }
  runTemplate(owner: Owner, id: string, raw: unknown): Task {
    const { expectedRevision, invocationId } = templateRunSchema.parse(raw);
    return this.db
      .transaction(() => {
        const current = this.template(owner, id);
        if (current.revision !== expectedRevision)
          throw new StoreError("CONFLICT");
        this.profile(owner, current.definition.modelProfileId);
        const { kind, prompt, modelProfileId } = current.definition;
        return this.create(
          owner,
          {
            conversationId: invocationId,
            kind,
            prompt,
            modelProfileId,
            tags: [id, String(current.revision)],
          },
          `template-run:${invocationId}`,
        );
      })
      .immediate();
  }
  addProfile(owner: Owner, raw: unknown) {
    const profile = modelProfileSchema.parse(raw);
    if (profile.maxOutputTokens + 256 >= profile.contextTokens)
      throw new StoreError("INVALID_INPUT");
    const old = this.db
      .prepare(
        "SELECT id FROM model_profiles WHERE id=? AND user_id=? AND tenant_id=?",
      )
      .get(profile.id, owner.userId, owner.tenantId);
    if (old) throw new StoreError("CONFLICT");
    this.db
      .prepare("INSERT INTO model_profiles VALUES(?,?,?,?,?)")
      .run(
        profile.id,
        owner.userId,
        owner.tenantId,
        this.vault.seal(
          profile,
          "profile:" + owner.tenantId + ":" + owner.userId + ":" + profile.id,
        ),
        this.now(),
      );
    return profile;
  }
  profile(owner: Owner, id: string) {
    const row = this.db
      .prepare(
        "SELECT payload FROM model_profiles WHERE id=? AND user_id=? AND tenant_id=?",
      )
      .get(id, owner.userId, owner.tenantId) as { payload: Buffer } | undefined;
    if (!row) throw new StoreError("NOT_FOUND");
    return this.vault.open<ReturnType<typeof modelProfileSchema.parse>>(
      row.payload,
      "profile:" + owner.tenantId + ":" + owner.userId + ":" + id,
    );
  }
  profiles(owner: Owner) {
    return (
      this.db
        .prepare(
          "SELECT id FROM model_profiles WHERE user_id=? AND tenant_id=? ORDER BY created_at,id",
        )
        .all(owner.userId, owner.tenantId) as { id: string }[]
    ).map((p) => this.profile(owner, p.id));
  }
  setDefaultProfile(owner: Owner, id: string) {
    this.profile(owner, id);
    this.db
      .prepare(
        "INSERT INTO model_defaults VALUES(?,?,?) ON CONFLICT(user_id,tenant_id) DO UPDATE SET profile_id=excluded.profile_id",
      )
      .run(owner.userId, owner.tenantId, id);
  }
  defaultProfile(owner: Owner) {
    const row = this.db
      .prepare(
        "SELECT profile_id FROM model_defaults WHERE user_id=? AND tenant_id=?",
      )
      .get(owner.userId, owner.tenantId) as { profile_id: string } | undefined;
    return row ? this.profile(owner, row.profile_id) : null;
  }
  switchModel(
    owner: Owner,
    id: string,
    profileId: string,
    expectedRevision: number,
  ) {
    this.profile(owner, profileId);
    return this.db
      .transaction(() => {
        const row = this.row(owner, id);
        if (
          row.revision !== expectedRevision ||
          !["queued", "running", "paused"].includes(row.status)
        )
          throw new StoreError("CONFLICT");
        const input = { ...this.task(row).input, modelProfileId: profileId };
        this.db
          .prepare(
            "UPDATE runs SET finished_at=?,outcome='model_switched' WHERE task_id=? AND finished_at IS NULL",
          )
          .run(this.now(), id);
        this.db
          .prepare(
            "UPDATE tasks SET input=?,status=?,generation=generation+1,revision=revision+1,lease_until=NULL,worker_id=NULL,updated_at=? WHERE id=?",
          )
          .run(
            this.vault.seal(input, "task:" + id),
            row.status === "paused" ? "paused" : "queued",
            this.now(),
            id,
          );
        this.event(id, "model_switched");
        return this.get(owner, id);
      })
      .immediate();
  }
  private row(owner: Owner, id: string): Row {
    const row = this.db
      .prepare("SELECT * FROM tasks WHERE id=? AND user_id=? AND tenant_id=?")
      .get(id, owner.userId, owner.tenantId) as Row | undefined;
    if (!row) throw new StoreError("NOT_FOUND");
    return row;
  }
  private task(row: Row): Task {
    return {
      id: row.id,
      conversationId: row.conversation_id,
      sequence: row.sequence,
      status: row.status,
      revision: row.revision,
      generation: row.generation,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      input: this.vault.open(row.input, "task:" + row.id),
      result: row.result
        ? this.vault.open(row.result, "result:" + row.id)
        : null,
    };
  }
  get(owner: Owner, id: string): Task {
    return this.task(this.row(owner, id));
  }
  list(owner: Owner, limit = 50): Task[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM tasks WHERE user_id=? AND tenant_id=? ORDER BY created_at DESC,id LIMIT ?",
        )
        .all(
          owner.userId,
          owner.tenantId,
          Math.max(1, Math.min(limit, 100)),
        ) as Row[]
    ).map((r) => this.task(r));
  }
  private event(id: string, type: string) {
    const r = this.db
      .prepare("SELECT revision FROM tasks WHERE id=?")
      .get(id) as { revision: number };
    const eid = randomUUID();
    this.db
      .prepare(
        "INSERT INTO events(id,task_id,revision,type,created_at) VALUES(?,?,?,?,?)",
      )
      .run(eid, id, r.revision, type, this.now());
    this.db.prepare("INSERT INTO outbox(event_id) VALUES(?)").run(eid);
  }
  publication(owner: Owner, id: string): Publication {
    const row = this.db
      .prepare(
        "SELECT p.* FROM publication_intents p JOIN tasks t ON t.id=p.task_id WHERE p.id=? AND t.user_id=? AND t.tenant_id=?",
      )
      .get(id, owner.userId, owner.tenantId) as
      { payload: Buffer; revision: number } | undefined;
    if (!row) throw new StoreError("NOT_FOUND");
    return {
      ...this.vault.open<Omit<Publication, "revision">>(
        row.payload,
        "publication:" + id,
      ),
      revision: row.revision,
    };
  }
  publications(owner: Owner, taskId: string): Publication[] {
    this.row(owner, taskId);
    return (
      this.db
        .prepare(
          "SELECT id FROM publication_intents WHERE task_id=? ORDER BY rowid",
        )
        .all(taskId) as { id: string }[]
    ).map((row) => this.publication(owner, row.id));
  }
  reservePublication(owner: Owner, taskId: string, raw: unknown): Publication {
    const proposal = crmProposalSchema.parse(raw);
    return this.db
      .transaction(() => {
        const task = this.get(owner, taskId),
          binding = this.sourceBinding(owner, taskId);
        if (
          task.status !== "completed" ||
          !binding ||
          binding.authority.sourceApp !== "crm" ||
          binding.refs.some((r) => r.app !== "crm") ||
          proposal.projectionHash !== binding.projectionHash ||
          JSON.stringify(proposal.sources) !==
            JSON.stringify(
              binding.refs.map((r) => ({
                id: r.resourceId,
                version: Number(r.revision),
              })),
            )
        )
          throw new StoreError("INVALID_INPUT");
        const prior = this.db
          .prepare("SELECT id FROM publication_intents WHERE id=?")
          .get(proposal.operationId);
        if (prior) {
          const saved = this.publication(owner, proposal.operationId);
          if (
            saved.taskId !== taskId ||
            this.vault.fingerprint(saved.proposal) !==
              this.vault.fingerprint(proposal) ||
            saved.grantId !== binding.authority.grantId
          )
            throw new StoreError("CONFLICT");
          return saved;
        }
        if (
          (
            this.db
              .prepare(
                "SELECT count(*) AS n FROM publication_intents WHERE task_id=?",
              )
              .get(taskId) as { n: number }
          ).n >= 100
        )
          throw new StoreError("CAPACITY");
        const value: Omit<Publication, "revision"> = {
          id: proposal.operationId,
          taskId,
          grantId: binding.authority.grantId,
          taskRevision: task.revision,
          proposal,
          state: "pending",
          prepared: null,
          receipt: null,
        };
        this.db
          .prepare(
            "INSERT INTO publication_intents(id,task_id,payload) VALUES(?,?,?)",
          )
          .run(
            value.id,
            taskId,
            this.vault.seal(value, "publication:" + value.id),
          );
        return this.publication(owner, value.id);
      })
      .immediate();
  }
  settlePublication(
    owner: Owner,
    id: string,
    expectedRevision: number,
    update:
      { prepared: CrmPrepared } | { receipt: CrmReceipt } | { uncertain: true },
  ): Publication {
    return this.db
      .transaction(() => {
        const current = this.publication(owner, id);
        if (current.revision !== expectedRevision || current.receipt)
          throw new StoreError("CONFLICT");
        const { revision: _revision, ...value } = current;
        if ("prepared" in update) {
          const prepared = crmPreparedSchema.parse(update.prepared);
          if (
            current.prepared &&
            this.vault.fingerprint(prepared) !==
              this.vault.fingerprint(current.prepared)
          )
            throw new StoreError("CONFLICT");
          value.prepared = prepared;
          value.state = "prepared";
        } else if ("receipt" in update) {
          if (!current.prepared) throw new StoreError("INVALID_INPUT");
          value.receipt = crmReceiptSchema.parse(update.receipt);
          value.state = value.receipt.state;
        } else value.state = "uncertain";
        this.db
          .prepare(
            "UPDATE publication_intents SET payload=?,revision=revision+1 WHERE id=?",
          )
          .run(this.vault.seal(value, "publication:" + id), id);
        return this.publication(owner, id);
      })
      .immediate();
  }
  autoNoteReview(owner: Owner, id: string): AutoNoteReview {
    const row = this.db
      .prepare(
        "SELECT p.payload,p.revision FROM autonote_reviews p JOIN tasks t ON t.id=p.task_id WHERE p.id=? AND t.user_id=? AND t.tenant_id=?",
      )
      .get(id, owner.userId, owner.tenantId) as
      { payload: Buffer; revision: number } | undefined;
    if (!row) throw new StoreError("NOT_FOUND");
    return {
      ...this.vault.open<Omit<AutoNoteReview, "revision">>(
        row.payload,
        "autonote-review:" + id,
      ),
      revision: row.revision,
    };
  }
  autoNoteReviews(owner: Owner, taskId: string): AutoNoteReview[] {
    this.row(owner, taskId);
    return (
      this.db
        .prepare(
          "SELECT id FROM autonote_reviews WHERE task_id=? ORDER BY rowid",
        )
        .all(taskId) as { id: string }[]
    ).map((row) => this.autoNoteReview(owner, row.id));
  }
  reserveAutoNoteReview(
    owner: Owner,
    taskId: string,
    raw: unknown,
  ): AutoNoteReview {
    const proposal = autoNoteProposalSchema.parse(raw);
    if (Buffer.byteLength(JSON.stringify(proposal)) > 64000)
      throw new StoreError("CAPACITY");
    return this.db
      .transaction(() => {
        const task = this.get(owner, taskId),
          binding = this.sourceBinding(owner, taskId);
        if (
          task.status !== "completed" ||
          !binding ||
          binding.authority.sourceApp !== "autonote" ||
          binding.refs.length !== 1 ||
          binding.refs[0]!.app !== "autonote" ||
          binding.refs[0]!.resourceId !== proposal.meetingId ||
          binding.refs[0]!.revision !== String(proposal.version) ||
          binding.projectionHash !== proposal.projectionHash
        )
          throw new StoreError("INVALID_INPUT");
        if (
          this.db
            .prepare("SELECT id FROM autonote_reviews WHERE id=?")
            .get(proposal.operationId)
        ) {
          const old = this.autoNoteReview(owner, proposal.operationId);
          if (
            old.taskId !== taskId ||
            old.grantId !== binding.authority.grantId ||
            this.vault.fingerprint(old.proposal) !==
              this.vault.fingerprint(proposal)
          )
            throw new StoreError("CONFLICT");
          return old;
        }
        // A completed draft has one immutable submission identity, even if a client loses its key.
        if (
          this.db
            .prepare("SELECT id FROM autonote_reviews WHERE task_id=?")
            .get(taskId)
        )
          throw new StoreError("CONFLICT");
        const value: Omit<AutoNoteReview, "revision"> = {
          id: proposal.operationId,
          taskId,
          grantId: binding.authority.grantId,
          taskRevision: task.revision,
          proposal,
          state: "local",
          response: null,
        };
        this.db
          .prepare(
            "INSERT INTO autonote_reviews(id,task_id,payload) VALUES(?,?,?)",
          )
          .run(
            value.id,
            taskId,
            this.vault.seal(value, "autonote-review:" + value.id),
          );
        return this.autoNoteReview(owner, value.id);
      })
      .immediate();
  }
  setAutoNoteApprovalOutboxes(
    owner: Owner,
    id: string,
    expectedRevision: number,
    raw: unknown,
  ): AutoNoteReview {
    const boxes = autoNoteApprovalOutboxesSchema.parse(raw);
    if (Buffer.byteLength(JSON.stringify(boxes)) > 16_000_000)
      throw new StoreError("CAPACITY");
    return this.db
      .transaction(() => {
        const item = this.autoNoteReview(owner, id);
        if (
          item.revision !== expectedRevision ||
          boxes.some(
            (b) =>
              b.grant.operationId !== item.id ||
              b.grant.taskId !== item.taskId ||
              b.grant.grantId !== item.grantId,
          )
        )
          throw new StoreError("CONFLICT");
        const { revision: _revision, ...value } = item;
        value.approvalOutboxes = boxes;
        this.db
          .prepare(
            "UPDATE autonote_reviews SET payload=?,revision=revision+1 WHERE id=?",
          )
          .run(this.vault.seal(value, "autonote-review:" + id), id);
        return this.autoNoteReview(owner, id);
      })
      .immediate();
  }
  setAutoNoteApprovalDelegations(
    owner: Owner,
    id: string,
    expectedRevision: number,
    raw: unknown,
  ): AutoNoteReview {
    const grants = autoNotePeerApprovalGrantsSchema.parse(raw);
    return this.db
      .transaction(() => {
        const item = this.autoNoteReview(owner, id);
        if (
          item.revision !== expectedRevision ||
          !item.response ||
          grants.some(
            (g) =>
              g.operationId !== item.id ||
              g.taskId !== item.taskId ||
              g.taskRevision !== item.taskRevision ||
              g.grantId !== item.grantId ||
              g.reviewId !== item.response!.reviewId ||
              g.proposalDigest !== item.response!.digest ||
              g.expiresAt > Date.parse(item.response!.expiresAt),
          )
        )
          throw new StoreError("CONFLICT");
        const { revision: _revision, ...value } = item;
        value.approvalDelegations = grants;
        this.db
          .prepare(
            "UPDATE autonote_reviews SET payload=?,revision=revision+1 WHERE id=?",
          )
          .run(this.vault.seal(value, "autonote-review:" + id), id);
        return this.autoNoteReview(owner, id);
      })
      .immediate();
  }
  markAutoNoteApprovalAttempt(
    owner: Owner,
    id: string,
    expectedRevision: number,
    raw: unknown,
  ): AutoNoteReview {
    const attempt = z
      .strictObject({
        approvalId: z.uuid(),
        reviewedHash: z.string().regex(/^[a-f0-9]{64}$/),
        requestedAt: z.iso.datetime(),
      })
      .parse(raw);
    return this.db
      .transaction(() => {
        const current = this.autoNoteReview(owner, id);
        if (
          current.revision !== expectedRevision ||
          current.state !== "prepared" ||
          !current.response ||
          current.response.receipt ||
          Date.parse(current.response.expiresAt) <= Date.now()
        )
          throw new StoreError("CONFLICT");
        const { revision: _revision, ...value } = current;
        value.state = "uncertain";
        value.approvalAttempt = attempt;
        this.db
          .prepare(
            "UPDATE autonote_reviews SET payload=?,revision=revision+1 WHERE id=?",
          )
          .run(this.vault.seal(value, "autonote-review:" + id), id);
        return this.autoNoteReview(owner, id);
      })
      .immediate();
  }
  settleAutoNoteReview(
    owner: Owner,
    id: string,
    expectedRevision: number,
    update: { uncertain: true } | { response: unknown },
  ): AutoNoteReview {
    return this.db
      .transaction(() => {
        const current = this.autoNoteReview(owner, id);
        if (
          current.revision !== expectedRevision ||
          ["saved", "deleted"].includes(current.state)
        )
          throw new StoreError("CONFLICT");
        const { revision: _revision, ...value } = current;
        if ("uncertain" in update) value.state = "uncertain";
        else {
          const response = autoNoteReconciledSchema.parse(update.response);
          if (
            response.digest !==
              createHash("sha256")
                .update(JSON.stringify(value.proposal))
                .digest("hex") ||
            (response.receipt &&
              (response.receipt.meetingId !== value.proposal.meetingId ||
                response.receipt.operationId !== id ||
                response.receipt.version !== value.proposal.version + 1)) ||
            (value.response &&
              (value.response.reviewId !== response.reviewId ||
                value.response.digest !== response.digest ||
                value.response.expiresAt !== response.expiresAt))
          )
            throw new StoreError("CONFLICT");
          value.response = response;
          value.state = response.receipt
            ? "saved"
            : response.deleted
              ? "deleted"
              : "prepared";
        }
        this.db
          .prepare(
            "UPDATE autonote_reviews SET payload=?,revision=revision+1 WHERE id=?",
          )
          .run(this.vault.seal(value, "autonote-review:" + id), id);
        return this.autoNoteReview(owner, id);
      })
      .immediate();
  }
  sourceBinding(owner: Owner, id: string): SourceBinding | null {
    this.row(owner, id);
    const row = this.db
      .prepare("SELECT payload FROM task_sources WHERE task_id=?")
      .get(id) as { payload: Buffer } | undefined;
    return row
      ? sourceBindingSchema.parse(this.vault.open(row.payload, "source:" + id))
      : null;
  }
  /** The fourth argument is constructed only by a trusted source adapter, never HTTP input. */
  create(
    owner: Owner,
    raw: unknown,
    key: string,
    source?: SourceBinding,
  ): Task {
    const input = requestSchema.parse(raw);
    const binding = source ? sourceBindingSchema.parse(source) : undefined;
    if (
      binding
        ? binding.authority.userId !== owner.userId ||
          JSON.stringify(binding.refs) !== JSON.stringify(input.sourceRefs) ||
          input.memoryIds?.length ||
          Date.parse(binding.expiresAt) <= this.now()
        : input.sourceRefs.length
    )
      throw new StoreError("INVALID_INPUT");
    if (!/^[A-Za-z0-9:_-]{1,128}$/.test(key))
      throw new StoreError("INVALID_INPUT");
    return this.db
      .transaction(() => {
        const hash = this.vault.fingerprint(
          binding ? { input, binding } : input,
        );
        const previous = this.db
          .prepare(
            "SELECT hash,task_id FROM idempotency WHERE user_id=? AND tenant_id=? AND key=?",
          )
          .get(owner.userId, owner.tenantId, key) as
          { hash: string; task_id: string } | undefined;
        if (previous) {
          if (previous.hash !== hash) throw new StoreError("CONFLICT");
          return this.get(owner, previous.task_id);
        }
        const now = this.now(),
          deadline = input.deadline ? Date.parse(input.deadline) : null;
        if (deadline !== null && deadline <= now)
          throw new StoreError("EXPIRED");
        for (const dep of input.dependencies) this.row(owner, dep);
        this.db
          .prepare(
            "INSERT OR IGNORE INTO conversations(id,user_id,tenant_id) VALUES(?,?,?)",
          )
          .run(input.conversationId, owner.userId, owner.tenantId);
        const sequence = (
          this.db
            .prepare(
              "UPDATE conversations SET next_sequence=next_sequence+1 WHERE id=? AND user_id=? AND tenant_id=? RETURNING next_sequence-1 AS sequence",
            )
            .get(input.conversationId, owner.userId, owner.tenantId) as {
            sequence: number;
          }
        ).sequence;
        const id = randomUUID();
        this.db
          .prepare(
            "INSERT INTO tasks(id,user_id,tenant_id,conversation_id,sequence,status,deadline,created_at,updated_at,input,payload_hash) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
          )
          .run(
            id,
            owner.userId,
            owner.tenantId,
            input.conversationId,
            sequence,
            "queued",
            deadline,
            now,
            now,
            this.vault.seal(input, "task:" + id),
            hash,
          );
        if (binding)
          this.db
            .prepare("INSERT INTO task_sources VALUES(?,?)")
            .run(id, this.vault.seal(binding, "source:" + id));
        for (const dep of new Set(input.dependencies))
          this.db.prepare("INSERT INTO dependencies VALUES(?,?)").run(id, dep);
        this.db
          .prepare("INSERT INTO idempotency VALUES(?,?,?,?,?)")
          .run(owner.userId, owner.tenantId, key, hash, id);
        this.event(id, "created");
        return this.get(owner, id);
      })
      .immediate();
  }
  command(owner: Owner, id: string, raw: unknown): Task {
    const command = commandSchema.parse(raw);
    return this.db
      .transaction(() => {
        const r = this.row(owner, id);
        if (
          r.revision !== command.expectedRevision ||
          terminal.includes(r.status)
        )
          throw new StoreError("CONFLICT");
        if (command.command === "resume" && r.status !== "paused")
          throw new StoreError("CONFLICT");
        if (command.command === "pause" && r.status === "paused")
          throw new StoreError("CONFLICT");
        const status =
          command.command === "cancel"
            ? "cancelled"
            : command.command === "pause"
              ? "paused"
              : this.inputWaitHistory(owner, id).some((w) => w.replyId === null)
                ? "awaiting_input"
                : "queued";
        this.db
          .prepare(
            "UPDATE runs SET finished_at=?,outcome=? WHERE task_id=? AND finished_at IS NULL",
          )
          .run(this.now(), status, id);
        this.db
          .prepare(
            "UPDATE tasks SET status=?,revision=revision+1,generation=generation+1,lease_until=NULL,worker_id=NULL,updated_at=? WHERE id=?",
          )
          .run(status, this.now(), id);
        this.event(id, status);
        return this.get(owner, id);
      })
      .immediate();
  }
  /** A model question can use only the opted-in owner's personal Inbox. Creating
   * that Inbox and publishing the question share a transaction; an existing
   * incompatible definition is never overwritten. */
  waitForOwnerInput(
    owner: Owner,
    id: string,
    worker: string,
    generation: number,
    question: string,
  ) {
    return this.db
      .transaction(() => {
        const row = this.validClaim(owner, id, worker, generation);
        if (this.task(row).input.allowQuestions !== true)
          throw new StoreError("INVALID_INPUT");
        const inbox = this.inboxes(owner).find(
          (item) => item.id === "personal",
        );
        if (
          inbox &&
          (inbox.ownerType !== "user" ||
            inbox.ownerId !== owner.userId ||
            inbox.tenantId !== owner.tenantId ||
            inbox.teamId !== undefined ||
            inbox.memberUserIds.length !== 1 ||
            inbox.memberUserIds[0] !== owner.userId)
        )
          throw new StoreError("INVALID_INPUT");
        if (!inbox)
          this.createInbox(owner, {
            id: "personal",
            tenantId: owner.tenantId,
            ownerId: owner.userId,
            ownerType: "user",
            memberUserIds: [owner.userId],
          });
        return this.waitForInput(
          owner,
          id,
          worker,
          generation,
          {
            inboxId: "personal",
            question,
            replyDueAt: new Date(
              Math.min(this.now() + 86400000, row.deadline ?? Infinity),
            ).toISOString(),
          },
          `model-question:${id}:${generation}`,
        );
      })
      .immediate();
  }
  /** Trusted worker transition. The question is an ordinary encrypted inbox
   * message; only this atomic association can make its reply task input. */
  waitForInput(
    owner: Owner,
    id: string,
    worker: string,
    generation: number,
    raw: unknown,
    key: string,
  ) {
    const input = z
      .strictObject({
        inboxId: z.string().min(1).max(128),
        question: z.string().min(1).max(32000),
        replyDueAt: z.string().datetime(),
      })
      .parse(raw);
    return this.db
      .transaction(() => {
        const task = this.row(owner, id),
          now = this.now();
        const messageInput = inboxMessageSchema.parse({
          conversationId: task.conversation_id,
          recipientInboxId: input.inboxId,
          requestId: id,
          type: "clarification",
          content: input.question,
          replyExpected: true,
          replyDueAt: input.replyDueAt,
        });
        const prior = this.db
          .prepare(
            "SELECT m.id,m.hash,w.worker_id,w.generation FROM messages m LEFT JOIN task_input_waits w ON w.question_id=m.id WHERE m.user_id=? AND m.tenant_id=? AND m.key=?",
          )
          .get(owner.userId, owner.tenantId, key) as
          | { id: string; hash: string; worker_id: string; generation: number }
          | undefined;
        if (prior) {
          if (
            prior.hash !== this.vault.fingerprint(messageInput) ||
            prior.worker_id !== worker ||
            prior.generation !== generation
          )
            throw new StoreError("CONFLICT");
          return {
            task: this.get(owner, id),
            question: this.message(owner, prior.id),
            duplicate: true,
          };
        }
        this.validClaim(owner, id, worker, generation);
        const waits = this.inputWaitHistory(owner, id);
        if (waits.some((w) => w.replyId === null))
          throw new StoreError("CONFLICT");
        if (waits.length >= 8) throw new StoreError("CAPACITY");
        const due = Date.parse(input.replyDueAt);
        if (
          due <= now ||
          due > now + 7 * 86400000 ||
          (task.deadline !== null && due > task.deadline)
        )
          throw new StoreError("EXPIRED");
        if (
          this.inputReplyBytes(owner, id) + Buffer.byteLength(input.question) >
          128000
        )
          throw new StoreError("CAPACITY");
        const question = this.appendMessage(owner, messageInput, key);
        this.db
          .prepare(
            "INSERT INTO task_input_waits(task_id,question_id,worker_id,generation,deadline) VALUES(?,?,?,?,?)",
          )
          .run(id, question.id, worker, generation, due);
        this.db
          .prepare(
            "UPDATE tasks SET status='awaiting_input',revision=revision+1,generation=generation+1,lease_until=NULL,worker_id=NULL,updated_at=? WHERE id=?",
          )
          .run(now, id);
        this.db
          .prepare(
            "UPDATE runs SET finished_at=?,outcome='awaiting_input' WHERE task_id=? AND generation=?",
          )
          .run(now, id, generation);
        if (this.now() < now || this.now() >= due)
          throw new StoreError("EXPIRED");
        this.event(id, "awaiting_input");
        return { task: this.get(owner, id), question, duplicate: false };
      })
      .immediate();
  }
  inputWaitHistory(owner: Owner, id: string) {
    this.row(owner, id);
    return this.db
      .prepare(
        "SELECT w.question_id AS questionId,w.reply_id AS replyId,w.reply_revision AS replyRevision,w.deadline FROM task_input_waits w JOIN messages m ON m.id=w.question_id WHERE w.task_id=? ORDER BY m.sequence",
      )
      .all(id) as {
      questionId: string;
      replyId: string | null;
      replyRevision: number | null;
      deadline: number;
    }[];
  }
  private inputReplyBytes(owner: Owner, id: string) {
    return this.inputWaitHistory(owner, id).reduce(
      (sum, w) =>
        sum +
        Buffer.byteLength(this.message(owner, w.questionId).input.content) +
        (w.replyId
          ? Buffer.byteLength(this.message(owner, w.replyId).input.content)
          : 0),
      0,
    );
  }
  /** Direct owner control path: no new task is queued behind the task it unblocks.
   * Future transports must validate separate current conversation/reply authority
   * through the synchronous check inside the same transaction. */
  answerInput(
    owner: Owner,
    id: string,
    raw: unknown,
    key: string,
    check: () => void = () => {},
  ) {
    const input = z
      .strictObject({
        questionId: z.uuid(),
        expectedRevision: z
          .number()
          .int()
          .positive()
          .max(Number.MAX_SAFE_INTEGER),
        content: z.string().min(1).max(32000),
      })
      .parse(raw);
    return this.db
      .transaction(() => {
        check();
        const row = this.row(owner, id),
          wait = this.inputWaitHistory(owner, id).find(
            (w) => w.questionId === input.questionId,
          );
        if (!wait) throw new StoreError("NOT_FOUND");
        const question = this.message(owner, wait.questionId);
        const messageInput = inboxMessageSchema.parse({
          conversationId: row.conversation_id,
          recipientInboxId: question.input.recipientInboxId,
          requestId: id,
          replyToId: question.id,
          type: "reply",
          content: input.content,
        });
        if (
          question.input.requestId !== id ||
          question.input.conversationId !== row.conversation_id
        )
          throw new StoreError("CONFLICT");
        if (wait.replyId) {
          const prior = this.db
            .prepare("SELECT key,hash FROM messages WHERE id=?")
            .get(wait.replyId) as { key: string; hash: string };
          if (
            prior.key !== key ||
            prior.hash !== this.vault.fingerprint(messageInput) ||
            wait.replyRevision !== input.expectedRevision
          )
            throw new StoreError("CONFLICT");
          check();
          return {
            task: this.get(owner, id),
            reply: this.message(owner, wait.replyId),
            duplicate: true,
          };
        }
        if (
          row.revision !== input.expectedRevision ||
          !["awaiting_input", "paused"].includes(row.status)
        )
          throw new StoreError("CONFLICT");
        const now = this.now();
        if (
          now < question.createdAt ||
          now >= wait.deadline ||
          (row.deadline !== null && row.deadline <= now)
        )
          throw new StoreError("EXPIRED");
        if (
          this.inputReplyBytes(owner, id) + Buffer.byteLength(input.content) >
          128000
        )
          throw new StoreError("CAPACITY");
        const reply = this.appendMessage(owner, messageInput, key);
        this.db
          .prepare(
            "UPDATE task_input_waits SET reply_id=?,reply_revision=? WHERE task_id=? AND question_id=? AND reply_id IS NULL",
          )
          .run(reply.id, row.revision, id, question.id);
        this.db
          .prepare(
            "UPDATE tasks SET status=?,revision=revision+1,generation=generation+1,lease_until=NULL,worker_id=NULL,next_attempt_at=0,updated_at=? WHERE id=?",
          )
          .run(row.status === "paused" ? "paused" : "queued", now, id);
        if (
          this.now() < now ||
          this.now() >= wait.deadline ||
          (row.deadline !== null && this.now() >= row.deadline)
        )
          throw new StoreError("EXPIRED");
        this.event(id, "input_received");
        check();
        return { task: this.get(owner, id), reply, duplicate: false };
      })
      .immediate();
  }
  taskInputContext(
    owner: Owner,
    id: string,
    worker: string,
    generation: number,
  ) {
    const row = this.validClaim(owner, id, worker, generation);
    const waits = this.inputWaitHistory(owner, id);
    if (waits.some((w) => !w.replyId)) throw new StoreError("CONFLICT");
    return waits.map((w) => {
      const question = this.message(owner, w.questionId),
        reply = this.message(owner, w.replyId!);
      if (
        question.input.requestId !== id ||
        reply.input.requestId !== id ||
        question.input.conversationId !== row.conversation_id ||
        reply.input.conversationId !== row.conversation_id ||
        reply.input.replyToId !== question.id ||
        reply.input.recipientInboxId !== question.input.recipientInboxId ||
        reply.input.type !== "reply"
      )
        throw new StoreError("CONFLICT");
      return {
        questionId: question.id,
        replyId: reply.id,
        question: question.input.content,
        reply: reply.input.content,
      };
    });
  }
  exportInputWaits(owner: Owner) {
    return this.export(owner).flatMap((t) =>
      this.inputWaitHistory(owner, t.id).map((w) => ({ taskId: t.id, ...w })),
    );
  }

  /** Internal local-consent boundary. No HTTP route or implicit pairing grant. */
  allowRemoteControls(owner: Owner, raw: unknown) {
    const binding = remoteControlBindingSchema.parse(raw);
    if (binding.expiresAt <= this.now()) throw new StoreError("EXPIRED");
    this.db
      .prepare(
        "INSERT INTO remote_control_bindings VALUES(?,?,?,?) ON CONFLICT(user_id,tenant_id,device_id) DO UPDATE SET payload=excluded.payload",
      )
      .run(
        owner.userId,
        owner.tenantId,
        binding.deviceId,
        this.vault.seal(
          binding,
          this.remotePurpose(owner, "binding", binding.deviceId),
        ),
      );
  }
  remoteControlsAllowed(owner: Owner, rawIdentity: unknown) {
    const identity = remoteControlIdentitySchema.safeParse(rawIdentity);
    if (!identity.success) return false;
    const stored = this.db
      .prepare(
        "SELECT payload FROM remote_control_bindings WHERE user_id=? AND tenant_id=? AND device_id=?",
      )
      .get(owner.userId, owner.tenantId, identity.data.deviceId) as
      { payload: Buffer } | undefined;
    if (!stored) return false;
    const binding = remoteControlBindingSchema.safeParse(
      this.vault.open(
        stored.payload,
        this.remotePurpose(owner, "binding", identity.data.deviceId),
      ),
    );
    return (
      binding.success &&
      binding.data.expiresAt > this.now() &&
      binding.data.remoteOwnerId === identity.data.remoteOwnerId &&
      binding.data.epoch === identity.data.epoch &&
      binding.data.controlId === identity.data.controlId
    );
  }
  revokeRemoteControls(owner: Owner, deviceId: string) {
    z.uuid().parse(deviceId);
    this.db
      .prepare(
        "DELETE FROM remote_control_bindings WHERE user_id=? AND tenant_id=? AND device_id=?",
      )
      .run(owner.userId, owner.tenantId, deviceId);
  }
  private remotePurpose(owner: Owner, kind: string, id: string) {
    return JSON.stringify([
      "remote-control",
      owner.tenantId,
      owner.userId,
      kind,
      id,
    ]);
  }
  /** Delivery identity must come from the authenticated polling session, never the envelope. */
  executeRemoteControl(owner: Owner, rawIdentity: unknown, raw: unknown) {
    const identity = remoteControlIdentitySchema.parse(rawIdentity);
    const command = remoteControlSchema.parse(raw);
    if (identity.deviceId !== command.deviceId)
      throw new StoreError("INVALID_INPUT");
    return this.db
      .transaction(() => {
        const now = this.now();
        const stored = this.db
          .prepare(
            "SELECT payload FROM remote_control_bindings WHERE user_id=? AND tenant_id=? AND device_id=?",
          )
          .get(owner.userId, owner.tenantId, identity.deviceId) as
          { payload: Buffer } | undefined;
        const binding = stored
          ? remoteControlBindingSchema.parse(
              this.vault.open(
                stored.payload,
                this.remotePurpose(owner, "binding", identity.deviceId),
              ),
            )
          : null;
        if (
          !binding ||
          binding.remoteOwnerId !== identity.remoteOwnerId ||
          binding.epoch !== identity.epoch ||
          binding.controlId !== identity.controlId ||
          binding.expiresAt <= now
        )
          throw new StoreError("NOT_FOUND");
        const purpose = this.remotePurpose(owner, "receipt", command.id);
        const hash = this.vault.fingerprint({ identity, command });
        const previous = this.db
          .prepare(
            "SELECT payload FROM remote_control_receipts WHERE user_id=? AND tenant_id=? AND id=?",
          )
          .get(owner.userId, owner.tenantId, command.id) as
          { payload: Buffer } | undefined;
        if (previous) {
          const value = this.vault.open<{ hash: string; receipt: unknown }>(
            previous.payload,
            purpose,
          );
          if (value.hash !== hash) throw new StoreError("CONFLICT");
          return {
            receipt: remoteReceiptSchema.parse(value.receipt),
            duplicate: true,
          };
        }
        // Reject structurally invalid leases, even if their deadline has passed.
        const issued = Date.parse(command.issuedAt),
          expires = Date.parse(command.expiresAt);
        if (
          !Number.isFinite(now) ||
          issued > now ||
          expires <= issued ||
          expires - issued > 300000
        )
          throw new StoreError("INVALID_INPUT");
        let outcome: z.infer<typeof remoteReceiptSchema>["outcome"] = "expired";
        if (expires > now) {
          parseRemoteControl(command, now);
          try {
            this.command(owner, command.taskId, {
              command: command.command,
              expectedRevision: command.expectedRevision,
            });
            outcome = "applied";
          } catch (error) {
            if (!(error instanceof StoreError)) throw error;
            if (error.code === "NOT_FOUND") outcome = "denied";
            else if (error.code === "CONFLICT") outcome = "conflict";
            else throw error;
          }
        }
        const completed = this.now();
        // Throwing here rolls back both the nested task transition and the receipt.
        if (
          binding.expiresAt <= completed ||
          (outcome === "applied" && expires <= completed)
        )
          throw new StoreError("EXPIRED");
        const receipt = remoteReceiptSchema.parse({
          id: command.id,
          deviceId: command.deviceId,
          outcome,
          completedAt: new Date(completed).toISOString(),
        });
        this.db
          .prepare("INSERT INTO remote_control_receipts VALUES(?,?,?,?)")
          .run(
            owner.userId,
            owner.tenantId,
            command.id,
            this.vault.seal({ hash, command, identity, receipt }, purpose),
          );
        const committedAt = this.now();
        if (
          binding.expiresAt <= committedAt ||
          (outcome === "applied" && expires <= committedAt)
        )
          throw new StoreError("EXPIRED");
        return { receipt, duplicate: false };
      })
      .immediate();
  }
  exportRemoteControls(owner: Owner) {
    return (
      this.db
        .prepare(
          "SELECT id,payload FROM remote_control_receipts WHERE user_id=? AND tenant_id=? ORDER BY id",
        )
        .all(owner.userId, owner.tenantId) as { id: string; payload: Buffer }[]
    )
      .map((row) =>
        this.vault.open<{
          command: unknown;
          identity: unknown;
          receipt: unknown;
        }>(row.payload, this.remotePurpose(owner, "receipt", row.id)),
      )
      .map(({ command, identity, receipt }) => ({
        command,
        identity,
        receipt,
      }));
  }
  /** Runs only inside claim's write transaction. Bound transitions per worker tick;
   * later ticks settle deeper chains without recursively holding the write lock. */
  private failImpossibleDependencies(owner: Owner, now: number) {
    const candidates = this.db
      .prepare(
        `
      SELECT t.id FROM tasks t
      WHERE t.user_id=? AND t.tenant_id=?
        AND t.status NOT IN ('completed','failed','cancelled','expired')
        AND EXISTS (
          SELECT 1 FROM dependencies d JOIN tasks p ON p.id=d.depends_on
          WHERE d.task_id=t.id AND p.user_id=t.user_id AND p.tenant_id=t.tenant_id
            AND p.status IN ('failed','cancelled','expired')
        )
      ORDER BY t.created_at,t.id LIMIT 128
    `,
      )
      .all(owner.userId, owner.tenantId) as { id: string }[];
    for (const { id } of candidates) {
      const prerequisites = this.db
        .prepare(
          `
        SELECT p.id AS taskId,p.status FROM dependencies d JOIN tasks p ON p.id=d.depends_on
        WHERE d.task_id=? AND p.user_id=? AND p.tenant_id=?
          AND p.status IN ('failed','cancelled','expired') ORDER BY p.id LIMIT 33
      `,
        )
        .all(id, owner.userId, owner.tenantId);
      const result = dependencyFailureSchema.parse({
        kind: "dependency_failure",
        prerequisites,
      });
      this.db
        .prepare(
          `UPDATE tasks SET status='failed',revision=revision+1,generation=generation+1,
        result=?,lease_until=NULL,worker_id=NULL,updated_at=? WHERE id=?
      `,
        )
        .run(this.vault.seal(result, "result:" + id), now, id);
      this.db
        .prepare(
          "UPDATE runs SET finished_at=?,outcome='dependency_failed' WHERE task_id=? AND finished_at IS NULL",
        )
        .run(now, id);
      this.event(id, "dependency_failed");
    }
  }
  claim(
    owner: Owner,
    workerId: string,
    leaseMs = 30_000,
    admit = true,
    activeIds: string[] = [],
  ): Claim | null {
    if (
      !workerId ||
      leaseMs < 100 ||
      leaseMs > 300_000 ||
      activeIds.length > 4 ||
      activeIds.some((id) => typeof id !== "string")
    )
      throw new StoreError("INVALID_INPUT");
    return this.db
      .transaction(() => {
        const now = this.now();
        this.remoteTemplates.invalidateRuns(owner);
        const expired = this.db
          .prepare(
            "SELECT id FROM tasks WHERE user_id=? AND tenant_id=? AND (deadline<=? OR EXISTS(SELECT 1 FROM task_input_waits w WHERE w.task_id=tasks.id AND w.reply_id IS NULL AND w.deadline<=?)) AND status NOT IN ('completed','failed','cancelled','expired')",
          )
          .all(owner.userId, owner.tenantId, now, now) as { id: string }[];
        for (const { id } of expired) {
          this.db
            .prepare(
              "UPDATE tasks SET status='expired',revision=revision+1,generation=generation+1,lease_until=NULL,worker_id=NULL,updated_at=? WHERE id=?",
            )
            .run(now, id);
          this.db
            .prepare(
              "UPDATE runs SET finished_at=?,outcome='expired' WHERE task_id=? AND finished_at IS NULL",
            )
            .run(now, id);
          this.event(id, "expired");
        }
        this.failImpossibleDependencies(owner, now);
        if (!admit) return null;
        const r = this.db
          .prepare(
            `SELECT t.* FROM tasks t WHERE user_id=? AND tenant_id=? AND (status='queued' OR(status='running' AND lease_until<=?)) AND next_attempt_at<=?
AND NOT EXISTS(SELECT 1 FROM task_input_waits w WHERE w.task_id=t.id AND w.reply_id IS NULL)
AND t.id NOT IN (SELECT value FROM json_each(?))
AND NOT EXISTS(SELECT 1 FROM tasks earlier WHERE earlier.user_id=t.user_id AND earlier.tenant_id=t.tenant_id AND earlier.conversation_id=t.conversation_id AND earlier.sequence<t.sequence AND earlier.status NOT IN ('completed','failed','cancelled','expired'))
AND NOT EXISTS(SELECT 1 FROM dependencies d JOIN tasks p ON p.id=d.depends_on WHERE d.task_id=t.id AND p.status!='completed') ORDER BY created_at,id LIMIT 1`,
          )
          .get(
            owner.userId,
            owner.tenantId,
            now,
            now,
            JSON.stringify(activeIds),
          ) as Row | undefined;
        if (!r) return null;
        this.db
          .prepare(
            "UPDATE runs SET finished_at=?,outcome='lease_expired' WHERE task_id=? AND finished_at IS NULL",
          )
          .run(now, r.id);
        this.db
          .prepare(
            "UPDATE tasks SET status='running',revision=revision+1,generation=generation+1,lease_until=?,worker_id=?,updated_at=?,attempts=attempts+1 WHERE id=?",
          )
          .run(now + leaseMs, workerId, now, r.id);
        this.db
          .prepare(
            "INSERT INTO runs(id,task_id,generation,worker_id,started_at) VALUES(?,?,?,?,?)",
          )
          .run(randomUUID(), r.id, r.generation + 1, workerId, now);
        this.event(r.id, "claimed");
        return {
          task: this.get(owner, r.id),
          workerId,
          generation: r.generation + 1,
          leaseUntil: now + leaseMs,
        };
      })
      .immediate();
  }
  private validClaim(
    owner: Owner,
    id: string,
    worker: string,
    generation: number,
  ): Row {
    const r = this.row(owner, id);
    if (
      !this.remoteTemplates.runAllowed(owner, id) ||
      r.status !== "running" ||
      r.worker_id !== worker ||
      r.generation !== generation ||
      (r.lease_until ?? 0) <= this.now() ||
      (r.deadline !== null && r.deadline <= this.now())
    )
      throw new StoreError("STALE_CLAIM");
    return r;
  }
  heartbeat(
    owner: Owner,
    id: string,
    worker: string,
    generation: number,
    leaseMs = 30_000,
  ) {
    if (leaseMs < 100 || leaseMs > 300_000)
      throw new StoreError("INVALID_INPUT");
    return this.db
      .transaction(() => {
        this.validClaim(owner, id, worker, generation);
        this.db
          .prepare("UPDATE tasks SET lease_until=? WHERE id=?")
          .run(this.now() + leaseMs, id);
      })
      .immediate();
  }
  recordModel(
    owner: Owner,
    id: string,
    worker: string,
    generation: number,
    snapshot: unknown,
  ) {
    this.db
      .transaction(() => {
        this.validClaim(owner, id, worker, generation);
        const changed = this.db
          .prepare(
            "UPDATE runs SET model_snapshot=? WHERE task_id=? AND generation=? AND model_snapshot IS NULL",
          )
          .run(
            this.vault.seal(snapshot, "run:" + id + ":" + generation),
            id,
            generation,
          );
        if (changed.changes !== 1) throw new StoreError("CONFLICT");
      })
      .immediate();
  }
  runHistory(owner: Owner, id: string) {
    this.row(owner, id);
    return (
      this.db
        .prepare("SELECT * FROM runs WHERE task_id=? ORDER BY generation")
        .all(id) as {
        id: string;
        task_id: string;
        worker_id: string;
        generation: number;
        started_at: number;
        finished_at: number | null;
        outcome: string | null;
        model_snapshot: Buffer | null;
      }[]
    ).map(({ model_snapshot, ...row }) => ({
      ...row,
      model: model_snapshot
        ? this.vault.open(model_snapshot, "run:" + id + ":" + row.generation)
        : null,
    }));
  }
  complete(
    owner: Owner,
    id: string,
    worker: string,
    generation: number,
    result: unknown,
  ): Task {
    if (Buffer.byteLength(JSON.stringify(result) ?? "") > 256_000)
      throw new StoreError("INVALID_INPUT");
    return this.db
      .transaction(() => {
        this.validClaim(owner, id, worker, generation);
        this.memoryExtractions.context(owner, id);
        this.db
          .prepare(
            "UPDATE tasks SET status='completed',revision=revision+1,result=?,lease_until=NULL,worker_id=NULL,updated_at=? WHERE id=?",
          )
          .run(this.vault.seal(result, "result:" + id), this.now(), id);
        this.db
          .prepare(
            "UPDATE runs SET finished_at=?,outcome='completed' WHERE task_id=? AND generation=?",
          )
          .run(this.now(), id, generation);
        this.event(id, "completed");
        return this.get(owner, id);
      })
      .immediate();
  }
  fail(
    owner: Owner,
    id: string,
    worker: string,
    generation: number,
    transient: boolean,
    reason?: "invalid_model_output" | "runtime_limit" | "clarification_limit",
  ) {
    if (
      (reason !== undefined &&
        ![
          "invalid_model_output",
          "runtime_limit",
          "clarification_limit",
        ].includes(reason)) ||
      (reason !== undefined && transient)
    )
      throw new StoreError("INVALID_INPUT");
    return this.db
      .transaction(() => {
        const r = this.validClaim(owner, id, worker, generation);
        const retry = transient && r.attempts < 3;
        this.db
          .prepare(
            "UPDATE tasks SET status=?,revision=revision+1,lease_until=NULL,worker_id=NULL,next_attempt_at=?,updated_at=? WHERE id=?",
          )
          .run(
            retry ? "queued" : "failed",
            this.now() + 1000 * 2 ** r.attempts,
            this.now(),
            id,
          );
        this.db
          .prepare(
            "UPDATE runs SET finished_at=?,outcome=? WHERE task_id=? AND generation=?",
          )
          .run(
            this.now(),
            retry ? "retry" : (reason ?? "failed"),
            id,
            generation,
          );
        this.event(id, retry ? "retry_scheduled" : "failed");
        return this.get(owner, id);
      })
      .immediate();
  }
  events(owner: Owner, after = 0) {
    return this.db
      .prepare(
        "SELECT e.* FROM events e JOIN tasks t ON t.id=e.task_id WHERE t.user_id=? AND t.tenant_id=? AND e.cursor>? ORDER BY cursor LIMIT 100",
      )
      .all(owner.userId, owner.tenantId, after);
  }
  pending(owner: Owner) {
    return this.db
      .prepare(
        "SELECT e.* FROM events e JOIN tasks t ON t.id=e.task_id JOIN outbox o ON o.event_id=e.id WHERE t.user_id=? AND t.tenant_id=? AND o.acknowledged_at IS NULL ORDER BY e.cursor LIMIT 100",
      )
      .all(owner.userId, owner.tenantId);
  }
  acknowledge(owner: Owner, eventId: string) {
    this.db
      .prepare(
        "UPDATE outbox SET acknowledged_at=COALESCE(acknowledged_at,?) WHERE event_id=? AND event_id IN(SELECT e.id FROM events e JOIN tasks t ON t.id=e.task_id WHERE t.user_id=? AND t.tenant_id=?)",
      )
      .run(this.now(), eventId, owner.userId, owner.tenantId);
  }
  exportPrivateRelayCredentials(owner: Owner) {
    return exportPrivateRelayCredentials(this, this.vault, owner);
  }
  exportPrivateConversationContent(owner: Owner) {
    return exportPrivateConversationContent(this, this.vault, owner);
  }
  exportPrivateConversationOffers(owner: Owner) {
    return exportPrivateConversationOffers(this, this.vault, owner);
  }
  exportPrivateIncomingReplay(owner: Owner) {
    return exportPrivateIncomingReplay(this, this.vault, owner);
  }
  exportPrivateResumeOffers(owner: Owner) {
    return exportPrivateResumeOffers(this, this.vault, owner);
  }
  exportPrivateResumeDelivery(owner: Owner) {
    return exportPrivateResumeDelivery(this, this.vault, owner);
  }
  exportPrivateResumeConsent(owner: Owner) {
    return exportPrivateResumeConsent(this, this.vault, owner);
  }
  exportPrivateConversationConsent(owner: Owner) {
    return exportPrivateConversationConsent(this, this.vault, owner);
  }
  exportPrivateTaskConsent(owner: Owner) {
    return exportPrivateTaskConsent(this, this.vault, owner);
  }
  exportPrivatePeerChecks(owner: Owner) {
    return exportPrivatePeerChecks(this, this.vault, owner);
  }
  exportPrivateEndpointKeys(owner: Owner) {
    return exportPrivateKeyLifecycle(this, this.vault, owner);
  }
  exportPrivateTaskResponses(owner: Owner) {
    return exportPrivateTaskResponses(this, this.vault, owner);
  }
  exportPrivateTaskOutbox(owner: Owner) {
    return exportPrivateTaskOutbox(this, this.vault, owner);
  }
  exportPrivateTaskReceipts(owner: Owner) {
    return exportPrivateTaskReceipts(this, this.vault, owner);
  }
  exportPrivatePeerTrust(owner: Owner) {
    return exportPrivatePeers(this, this.vault, owner);
  }
  export(owner: Owner) {
    return (
      this.db
        .prepare(
          "SELECT * FROM tasks WHERE user_id=? AND tenant_id=? ORDER BY created_at,id",
        )
        .all(owner.userId, owner.tenantId) as Row[]
    ).map((r) => this.task(r));
  }
  createInbox(owner: Owner, raw: unknown) {
    const inbox = inboxSchema.parse(raw);
    // Personal-device pilot: agent/manager inboxes may represent only this user.
    if (
      inbox.tenantId !== owner.tenantId ||
      inbox.memberUserIds.some((id) => id !== owner.userId) ||
      (inbox.ownerType === "user" && inbox.ownerId !== owner.userId)
    )
      throw new StoreError("INVALID_INPUT");
    const purpose =
      "inbox:" + owner.tenantId + ":" + owner.userId + ":" + inbox.id;
    this.db
      .prepare(
        "INSERT INTO inboxes VALUES(?,?,?,?) ON CONFLICT(id,user_id,tenant_id) DO UPDATE SET definition=excluded.definition",
      )
      .run(
        inbox.id,
        owner.userId,
        owner.tenantId,
        this.vault.seal(inbox, purpose),
      );
    return inbox;
  }

  inboxes(owner: Owner) {
    return (
      this.db
        .prepare(
          "SELECT id,definition FROM inboxes WHERE user_id=? AND tenant_id=? ORDER BY id",
        )
        .all(owner.userId, owner.tenantId) as {
        id: string;
        definition: Buffer;
      }[]
    ).map((row) =>
      this.vault.open<ReturnType<typeof inboxSchema.parse>>(
        row.definition,
        "inbox:" + owner.tenantId + ":" + owner.userId + ":" + row.id,
      ),
    );
  }
  inboxConversations(owner: Owner, inboxId: string) {
    return this.inboxConversationPage(owner, inboxId).items;
  }
  inboxConversationPage(
    owner: Owner,
    inboxId: string,
    cursor?: string,
    preview: (message: ReturnType<Store["message"]>) => string = (message) =>
      message.input.content.slice(0, 100),
  ) {
    const purpose = JSON.stringify([
      "inbox-page",
      owner.tenantId,
      owner.userId,
      inboxId,
    ]);
    let boundary: { snapshot: number; before: number };
    if (cursor !== undefined) {
      try {
        if (!/^[A-Za-z0-9_-]{1,1024}$/.test(cursor)) throw Error();
        boundary = z
          .strictObject({
            snapshot: z
              .number()
              .int()
              .nonnegative()
              .max(Number.MAX_SAFE_INTEGER),
            before: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
          })
          .parse(this.vault.open(Buffer.from(cursor, "base64url"), purpose));
      } catch {
        throw new StoreError("INVALID_INPUT");
      }
    } else {
      const row = this.db
        .prepare(
          "SELECT COALESCE(MAX(position),0) AS position FROM message_positions",
        )
        .get() as { position: number };
      boundary = { snapshot: row.position, before: Number.MAX_SAFE_INTEGER };
    }
    const rows = this.db
      .prepare(
        `WITH latest AS (
      SELECT m.conversation_id, MAX(p.position) AS position FROM messages m JOIN message_positions p ON p.message_id=m.id
      WHERE m.user_id=? AND m.tenant_id=? AND m.inbox_id=? AND p.position<=? GROUP BY m.conversation_id
    ) SELECT latest.conversation_id,latest.position,m.id,m.created_at FROM latest JOIN message_positions p ON p.position=latest.position JOIN messages m ON m.id=p.message_id WHERE latest.position<? ORDER BY latest.position DESC LIMIT 101`,
      )
      .all(
        owner.userId,
        owner.tenantId,
        inboxId,
        boundary.snapshot,
        boundary.before,
      ) as {
      conversation_id: string;
      position: number;
      id: string;
      created_at: number;
    }[];
    const page = rows.slice(0, 100);
    return {
      items: page.map((row) => ({
        id: row.conversation_id,
        updatedAt: row.created_at,
        preview: preview(this.message(owner, row.id)),
      })),
      nextCursor:
        rows.length > 100
          ? this.vault
              .seal(
                { snapshot: boundary.snapshot, before: page.at(-1)!.position },
                purpose,
              )
              .toString("base64url")
          : null,
    };
  }
  appendMessage(owner: Owner, raw: unknown, key: string) {
    const input = inboxMessageSchema.parse(raw);
    if (!/^[A-Za-z0-9:_-]{1,128}$/.test(key))
      throw new StoreError("INVALID_INPUT");
    return this.db
      .transaction(() => {
        const hash = this.vault.fingerprint(input);
        const prior = this.db
          .prepare(
            "SELECT id,hash FROM messages WHERE user_id=? AND tenant_id=? AND key=?",
          )
          .get(owner.userId, owner.tenantId, key) as
          { id: string; hash: string } | undefined;
        if (prior) {
          if (prior.hash !== hash) throw new StoreError("CONFLICT");
          return this.message(owner, prior.id);
        }
        const inbox = this.db
          .prepare(
            "SELECT id FROM inboxes WHERE id=? AND user_id=? AND tenant_id=?",
          )
          .get(input.recipientInboxId, owner.userId, owner.tenantId);
        if (!inbox) throw new StoreError("NOT_FOUND");
        if (
          input.requestId &&
          this.row(owner, input.requestId).conversation_id !==
            input.conversationId
        )
          throw new StoreError("INVALID_INPUT");
        if (input.replyToId) {
          const parent = this.message(owner, input.replyToId);
          if (
            parent.input.conversationId !== input.conversationId ||
            parent.input.recipientInboxId !== input.recipientInboxId
          )
            throw new StoreError("INVALID_INPUT");
        }
        this.db
          .prepare(
            "INSERT OR IGNORE INTO conversations(id,user_id,tenant_id) VALUES(?,?,?)",
          )
          .run(input.conversationId, owner.userId, owner.tenantId);
        const sequence = (
          this.db
            .prepare(
              "UPDATE conversations SET next_sequence=next_sequence+1 WHERE id=? AND user_id=? AND tenant_id=? RETURNING next_sequence-1 AS sequence",
            )
            .get(input.conversationId, owner.userId, owner.tenantId) as {
            sequence: number;
          }
        ).sequence;
        const id = randomUUID();
        this.db
          .prepare("INSERT INTO messages VALUES(?,?,?,?,?,?,?,?,?,?,?)")
          .run(
            id,
            owner.userId,
            owner.tenantId,
            input.recipientInboxId,
            input.conversationId,
            sequence,
            input.requestId ?? null,
            this.vault.seal(input, "message:" + id),
            key,
            hash,
            this.now(),
          );
        this.db
          .prepare("INSERT INTO message_positions(message_id) VALUES(?)")
          .run(id);
        if (input.replyExpected && input.replyDueAt)
          this.db
            .prepare("INSERT INTO checkins VALUES(?,?,?,NULL)")
            .run(randomUUID(), id, Date.parse(input.replyDueAt));
        if (input.replyToId)
          this.db
            .prepare(
              "UPDATE checkins SET closed_at=COALESCE(closed_at,?) WHERE message_id=?",
            )
            .run(this.now(), input.replyToId);
        return this.message(owner, id);
      })
      .immediate();
  }
  message(owner: Owner, id: string) {
    const row = this.db
      .prepare(
        "SELECT id,content,sequence,created_at FROM messages WHERE id=? AND user_id=? AND tenant_id=?",
      )
      .get(id, owner.userId, owner.tenantId) as
      | { id: string; content: Buffer; sequence: number; created_at: number }
      | undefined;
    if (!row) throw new StoreError("NOT_FOUND");
    return {
      id: row.id,
      sequence: row.sequence,
      createdAt: row.created_at,
      receipts: this.db
        .prepare(
          "SELECT kind,recorded_at AS recordedAt FROM receipts WHERE message_id=? AND user_id=? ORDER BY recorded_at,kind",
        )
        .all(row.id, owner.userId) as { kind: string; recordedAt: number }[],
      input: this.vault.open<ReturnType<typeof inboxMessageSchema.parse>>(
        row.content,
        "message:" + id,
      ),
    };
  }
  messages(owner: Owner, inboxId: string, conversationId: string, after = 0) {
    return (
      this.db
        .prepare(
          "SELECT id FROM messages WHERE user_id=? AND tenant_id=? AND inbox_id=? AND conversation_id=? AND sequence>? ORDER BY sequence LIMIT 100",
        )
        .all(owner.userId, owner.tenantId, inboxId, conversationId, after) as {
        id: string;
      }[]
    ).map((r) => this.message(owner, r.id));
  }
  receipt(
    owner: Owner,
    id: string,
    kind: "delivered" | "read" | "acknowledged",
  ) {
    this.message(owner, id);
    this.db
      .prepare("INSERT OR IGNORE INTO receipts VALUES(?,?,?,?)")
      .run(id, owner.userId, kind, this.now());
  }
  checkins(owner: Owner) {
    return this.db
      .prepare(
        "SELECT c.id,c.message_id,c.due_at,c.closed_at,CASE WHEN c.closed_at IS NOT NULL THEN 'closed' WHEN c.due_at<=? THEN 'overdue' ELSE 'open' END AS status FROM checkins c JOIN messages m ON m.id=c.message_id WHERE m.user_id=? AND m.tenant_id=? ORDER BY (c.closed_at IS NOT NULL),c.due_at,c.id LIMIT 100",
      )
      .all(this.now(), owner.userId, owner.tenantId);
  }
  exportMessages(owner: Owner) {
    return (
      this.db
        .prepare(
          "SELECT id FROM messages WHERE user_id=? AND tenant_id=? ORDER BY created_at,id",
        )
        .all(owner.userId, owner.tenantId) as { id: string }[]
    ).map((r) => this.message(owner, r.id));
  }
  deleteAll(owner: Owner, beforeDelete?: () => void) {
    this.db
      .transaction(() => {
        // Trusted synchronous caller checks run under the deletion write lock.
        beforeDelete?.();
        queuePrivateKeyDeletion(this, this.vault, owner);
        queuePrivateRelayDeletion(this, owner);
        this.db
          .prepare(
            "UPDATE private_task_consents SET payload=NULL,locked=1,revision=revision+1 WHERE user_id=? AND tenant_id=?",
          )
          .run(owner.userId, owner.tenantId);
        this.db
          .prepare(
            "UPDATE private_conversation_consents SET payload=NULL,locked=1,revision=revision+1 WHERE user_id=? AND tenant_id=?",
          )
          .run(owner.userId, owner.tenantId);
        this.db
          .prepare(
            "UPDATE private_resume_consents SET payload=NULL,locked=1,revision=revision+1 WHERE user_id=? AND tenant_id=?",
          )
          .run(owner.userId, owner.tenantId);
        this.db
          .prepare(
            "UPDATE private_peer_states SET payload=NULL,locked=1,revision=revision+1 WHERE user_id=? AND tenant_id=?",
          )
          .run(owner.userId, owner.tenantId);
        for (const table of [
          "mail_sends",
          "news_publications",
          "private_peer_checks",
          "private_task_responses",
          "private_task_outbox",
          "private_conversation_offers",
          "private_conversation_content",
          "private_incoming_replay",
          "private_send_channels",
          "private_task_receipts",
          "remote_resume_receipts",
          "private_resume_delivery",
          "private_resume_offers",
          "remote_resume_permissions",
          "remote_template_receipts",
          "remote_template_permissions",
          "local_templates",
          "remote_control_receipts",
          "remote_control_bindings",
        ])
          this.db
            .prepare(`DELETE FROM ${table} WHERE user_id=? AND tenant_id=?`)
            .run(owner.userId, owner.tenantId);
        this.db
          .prepare("DELETE FROM model_defaults WHERE user_id=? AND tenant_id=?")
          .run(owner.userId, owner.tenantId);
        this.db
          .prepare("DELETE FROM model_profiles WHERE user_id=? AND tenant_id=?")
          .run(owner.userId, owner.tenantId);
        this.db
          .prepare(
            "DELETE FROM task_input_waits WHERE task_id IN (SELECT id FROM tasks WHERE user_id=? AND tenant_id=?)",
          )
          .run(owner.userId, owner.tenantId);
        this.db
          .prepare("DELETE FROM inboxes WHERE user_id=? AND tenant_id=?")
          .run(owner.userId, owner.tenantId);
        this.db
          .prepare(
            "DELETE FROM dependencies WHERE task_id IN(SELECT id FROM tasks WHERE user_id=? AND tenant_id=?)",
          )
          .run(owner.userId, owner.tenantId);
        this.db
          .prepare("DELETE FROM tasks WHERE user_id=? AND tenant_id=?")
          .run(owner.userId, owner.tenantId);
        this.db
          .prepare("DELETE FROM conversations WHERE user_id=? AND tenant_id=?")
          .run(owner.userId, owner.tenantId);
      })
      .immediate();
    this.db.pragma("wal_checkpoint(TRUNCATE)");
  }
  async backup(destination: string) {
    await this.db.backup(destination);
  }
  changeToken() {
    return databaseChangeToken(this.db);
  }
  close() {
    this.db.close();
  }
}

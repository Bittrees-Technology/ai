import {
  readFileSync,
  lstatSync,
  realpathSync,
  openSync,
  closeSync,
  statfsSync,
} from "node:fs";
import { join, isAbsolute } from "node:path";
import { createHash, createPublicKey, verify } from "node:crypto";
import Database from "better-sqlite3";
import { z } from "zod";
import {
  NativeRuntimeCostBudget,
  nativeRuntimeCostApproval,
} from "../../modules/task-sync/native-runtime-cost.js";
import { verifyCrmResultLease } from "../../modules/task-sync/crm-result-lease-contract.mjs";
import { checkAssignmentNativeAction } from "../../modules/task-sync/assignment-native-admission.js";
import { assignmentSchema } from "../../modules/task-sync/assignment-contract.js";
import { Vault } from "../../modules/storage/vault.js";
import {
  savedCentralState,
  existingCentralCredential,
  signExistingCentralAssignmentRequest,
} from "../../modules/workflows/central-saved-state.js";
import { existingEnrollmentCredential } from "../../modules/task-sync/enrollment-credential.js";
import { verifyActivationReceipt } from "../../modules/task-sync/activation.js";
import {
  activationReceiptSchema,
  runtimeAttestationSchema,
  runtimeAttestationMessage,
} from "../../modules/task-sync/runtime-contract.js";
import {
  assignmentServiceReview,
  launchAssignmentServiceBroker,
} from "../../modules/task-sync/assignment-service-native.js";
import {
  nativeAssignmentGateway,
  assignmentGatewayScope,
} from "../../modules/task-sync/assignment-gateway-native.js";
import { AssignmentAttestationHTTPS } from "../../modules/task-sync/assignment-https.js";
import {
  TaskSyncRunBudget,
  taskSyncBudgetReview,
} from "../../modules/task-sync/run-budget.js";
import { digest } from "../../modules/task-sync/proof-contract.js";
import {
  exactOutcomeValidatorPin,
  exactOutcomeCriteria,
  validateExactOutcome,
} from "../../modules/task-sync/assignment-exact-validator.js";
const hash = (v: string | Buffer) =>
  createHash("sha256").update(v).digest("hex");
const hex = z.string().regex(/^[a-f0-9]{64}$/),
  key = z.string().min(1).max(512);
export const assignmentLaunchConfiguration = z.strictObject({
  version: z.literal(1),
  confirmed: z.literal(true),
  sourceAccessApproved: z.literal(true),
  review: assignmentServiceReview,
  criteria: exactOutcomeCriteria,
  centralStateDigest: hex,
  gatewayCredentialDigest: hex,
  coordinatorCredentialDigest: hex,
  authorityId: z.uuid(),
  deviceId: z.uuid(),
  ownerWallet: z.string().regex(/^0x[a-f0-9]{40}$/),
  connectionId: z.uuid(),
  workflowPublicKey: key,
  rolesPublicKey: key,
  attestationPublicKey: key,
  activation: z.strictObject({
    receipt: activationReceiptSchema,
    signature: z.string().min(1).max(200),
  }),
  budget: taskSyncBudgetReview,
  evidenceDigest: hex,
});
const costEvidence = z
  .strictObject({
    version: z.literal(1),
    id: z.string().min(1).max(128),
    observedAt: z.int().positive(),
    validUntil: z.int().positive(),
    account: z.string().min(1).max(128),
    project: z.string().min(1).max(128),
    plan: z.string().min(1).max(128),
    services: z.tuple([
      z.literal("mcp.bittrees.org"),
      z.literal("roles.bittrees.org"),
      z.literal("workflow.bittrees.org"),
      z.literal("crm.bittrees.org"),
      z.literal("ai.bittrees.org"),
    ]),
    resourceClass: z.string().min(1).max(512),
    overageControls: z.string().min(1).max(512),
    costBasis: z.enum([
      "verified-included-usage",
      "explicit-one-time-approval",
    ]),
    maximumAdditionalMicroUSD: z.int().min(0).max(1000000),
    runtimeApproval: nativeRuntimeCostApproval.optional(),
    reference: z.string().min(1).max(1024),
  })
  .refine(
    (p) =>
      p.costBasis === "verified-included-usage"
        ? p.maximumAdditionalMicroUSD === 0 && p.runtimeApproval === undefined
        : p.runtimeApproval !== undefined &&
          p.maximumAdditionalMicroUSD === p.runtimeApproval.maximumMicroUSD,
    "Actual included coverage or exact explicit aggregate approval required",
  );
function protectedBytes(path: string, max = 128000) {
  const s = lstatSync(path);
  if (
    !s.isFile() ||
    s.isSymbolicLink() ||
    realpathSync(path) !== path ||
    s.size > max ||
    (s.mode & 0o077) !== 0 ||
    s.uid !== process.getuid?.()
  )
    throw Error("Protected native assignment file required");
  const bytes = readFileSync(path),
    after = lstatSync(path);
  if (
    after.ino !== s.ino ||
    after.dev !== s.dev ||
    after.mtimeMs !== s.mtimeMs ||
    after.ctimeMs !== s.ctimeMs ||
    bytes.length !== s.size
  )
    throw Error("Native assignment file changed during read");
  return bytes;
}
/** Real launcher assembly. No configuration means no vault read, sockets, budget
 * DB or model action. Files pin reviewed admission; Roles/source services still
 * decide each protected action. No enrollment, activation, key creation or
 * credential substitution path exists here. */
export async function launchAssignments(
  directory: string,
  unlock: (profile: string) => Promise<Vault>,
  now = Date.now,
  network: {
    resolve?: ConstructorParameters<typeof AssignmentAttestationHTTPS>[1];
    send?: ConstructorParameters<typeof AssignmentAttestationHTTPS>[2];
  } = {},
) {
  if (!isAbsolute(directory))
    throw Error("Absolute native assignment directory required");
  const path = join(directory, "native-assignments.json"),
    evidencePath = join(directory, "native-assignments-evidence.json");
  let bytes: Buffer;
  try {
    bytes = protectedBytes(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
  const config = assignmentLaunchConfiguration.parse(
      JSON.parse(bytes.toString("utf8")),
    ),
    pin = hash(bytes),
    proofBytes = protectedBytes(evidencePath),
    proof = costEvidence.parse(JSON.parse(proofBytes.toString("utf8")));
  const review = config.review,
    r = config.activation.receipt;
  const admitted = () => {
    const at = now();
    if (
      !Number.isSafeInteger(at) ||
      at < review.approvedAt ||
      at >= review.expiresAt ||
      review.expiresAt - review.approvedAt > 900000 ||
      config.budget.maxWorkAttempts !== review.assignments.length ||
      config.budget.issuedAt !== review.approvedAt ||
      config.budget.expiresAt !== review.expiresAt ||
      proof.observedAt > review.approvedAt ||
      proof.validUntil < review.expiresAt ||
      proof.validUntil - proof.observedAt > 3600000 ||
      (proof.runtimeApproval !== undefined &&
        (proof.runtimeApproval.approvedAt > review.approvedAt ||
          proof.runtimeApproval.expiresAt < review.expiresAt)) ||
      hash(proofBytes) !== config.evidenceDigest ||
      hash(protectedBytes(path)) !== pin ||
      hash(protectedBytes(evidencePath)) !== config.evidenceDigest ||
      !review.validator ||
      digest(review.validator) !==
        digest(exactOutcomeValidatorPin(config.criteria)) ||
      config.criteria.length !== review.assignments.length ||
      review.assignments.some(
        (a) =>
          !config.criteria.some(
            (c) =>
              c.assignmentDigest === digest(a) &&
              c.reviewedAt <= review.approvedAt,
          ),
      )
    )
      throw Error(
        "Current exact native source, validator and bounded cost admission required",
      );
  };
  admitted();
  const expected = {
    principal: r.principal,
    credentialId: r.credentialId,
    tenant: r.tenant,
    workspace: r.workspace,
    sourceWorkspace: r.sourceWorkspace,
    subject: r.principal,
    leaseId: r.leaseId,
    runtimeBindingDigest: r.runtimeBindingDigest,
    policyDigest: r.policyDigest,
    projectIds: ["crm", "workflow"],
  };
  const { identity } = verifyActivationReceipt(
    config.activation,
    expected,
    config.rolesPublicKey,
    now(),
  );
  if (review.expiresAt > identity.expiresAt)
    throw Error("Assignment review exceeds activated lease");
  const attester = createPublicKey(config.attestationPublicKey);
  if (attester.asymmetricKeyType !== "ed25519")
    throw Error("Assignment attester signer unavailable");
  const centralPath = join(directory, "central-workflows.db");
  const centralInfo = lstatSync(centralPath);
  if (
    !centralInfo.isFile() ||
    centralInfo.isSymbolicLink() ||
    realpathSync(centralPath) !== centralPath ||
    centralInfo.uid !== process.getuid?.()
  )
    throw Error("Existing canonical central state required");
  let preferred = false,
    controlPath = join(directory, "workflow-device.enc");
  try {
    const parent = lstatSync(join(directory, "marketplace"));
    if (!parent.isDirectory() || parent.isSymbolicLink())
      throw Error("Canonical coordinator directory required");
    lstatSync(join(directory, "marketplace/connection.enc"));
    preferred = true;
    controlPath = join(directory, "marketplace/connection.enc");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  const controlBytes = protectedBytes(controlPath, 65536),
    controlPin = hash(controlBytes);
  const vault = await unlock("personal");
  admitted();
  const costs = proof.runtimeApproval
    ? new NativeRuntimeCostBudget(
        directory,
        vault,
        proof.runtimeApproval,
        admitted,
        now,
      )
    : undefined;
  const state = () => {
    admitted();
    const snapshot = savedCentralState(centralPath, vault);
    if (
      hash(JSON.stringify(snapshot)) !== config.centralStateDigest ||
      snapshot.principal !== identity.principal ||
      snapshot.credentialId !== identity.credentialId ||
      snapshot.tenant !== identity.tenant ||
      snapshot.workspace !== identity.workspace ||
      snapshot.connectionId !== config.connectionId ||
      snapshot.profileId !== review.profileId ||
      snapshot.mcpCredentialDigest !== config.gatewayCredentialDigest ||
      review.assignments.some(
        (a) =>
          a.workflowId !== snapshot.workflowId ||
          a.principal !== snapshot.principal,
      )
    )
      throw Error(
        "Existing central assignment custody differs from approved scope",
      );
    return snapshot;
  };
  const snapshot = state();
  const coordinator = preferred
    ? await unlock("marketplace-coordinator")
    : undefined;
  const control = await existingEnrollmentCredential(
    directory,
    vault,
    coordinator,
  );
  if (hash(control) !== config.coordinatorCredentialDigest)
    throw Error(
      "Existing coordinator credential differs from approved custody",
    );
  const current = () => {
    state();
    if (hash(protectedBytes(controlPath, 65536)) !== controlPin)
      throw Error("Coordinator custody changed");
    return review;
  };
  current();
  const scope = assignmentGatewayScope(review, identity, config.connectionId);
  if (config.budget.scopeDigest !== scope)
    throw Error("Native assignment budget scope differs");
  const space = statfsSync(directory);
  if (Number(space.bavail) * Number(space.bsize) < 20 * 1024 ** 3)
    throw Error("Native assignment storage reserve unavailable");
  const budgetPath = join(directory, "native-assignment-budgets.db");
  try {
    const info = lstatSync(budgetPath);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      realpathSync(budgetPath) !== budgetPath ||
      info.size > 32 * 1024 ** 2 ||
      (info.mode & 0o077) !== 0 ||
      info.uid !== process.getuid?.()
    )
      throw Error("Native assignment budget storage held");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    const fd = openSync(budgetPath, "wx", 0o600);
    closeSync(fd);
  }
  const db = new Database(budgetPath);
  db.pragma("journal_mode=WAL");
  db.pragma("synchronous=FULL");
  db.exec(
    "CREATE TABLE IF NOT EXISTS budgets(epoch TEXT PRIMARY KEY,record BLOB NOT NULL);CREATE TABLE IF NOT EXISTS model_admissions(id TEXT PRIMARY KEY)",
  );
  try {
    const aad = "native-assignment-budget:" + review.epoch;
    const budget = new TaskSyncRunBudget(
      {
        read: () => {
          const row = db
            .prepare("SELECT record FROM budgets WHERE epoch=?")
            .get(review.epoch) as { record: Buffer } | undefined;
          return row ? vault.open(row.record, aad) : null;
        },
        write: (value) => {
          db.prepare(
            "INSERT INTO budgets VALUES(?,?) ON CONFLICT(epoch) DO UPDATE SET record=excluded.record",
          ).run(review.epoch, vault.seal(value, aad));
        },
        atomic: (work) => db.transaction(work).immediate(),
      },
      now,
    );
    budget.bind(config.budget);
    const decisions = new Map<
      string,
      { requestId: string; operationId: string }
    >();
    const stop = new AbortController(),
      pending = new Set<Promise<Response>>();
    const attestation = new AssignmentAttestationHTTPS(
      () => {
        current();
        budget.assertCurrent(scope);
      },
      network.resolve,
      network.send,
    );
    const attest = budget.fetch(
      (input, init) => {
        costs?.reserve("attestation");
        return attestation.dispatch(input, init);
      },
      () => {
        current();
        return scope;
      },
      () => "attestation",
    );
    const gateway = nativeAssignmentGateway({
      current,
      identity,
      connectionId: config.connectionId,
      publicKey: snapshot.publicKey,
      credential: () => {
        state();
        const token = existingCentralCredential(centralPath, vault);
        if (hash(token) !== config.gatewayCredentialDigest)
          throw Error("Gateway credential changed");
        return token;
      },
      budget,
      reserveCost: () => costs?.reserve("assignment"),
      now,
      admit: () => {
        current();
      },
      resolve: network.resolve,
      send: network.send,
      signAndAttest: async (challenge, signal) => {
        current();
        const signature = signExistingCentralAssignmentRequest(
          centralPath,
          vault,
          challenge.request,
          now(),
        );
        current();
        const reply = await attest("https://ai.bittrees.org/api/workflows", {
          method: "POST",
          redirect: "error",
          signal,
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            Authorization: "Bearer " + control,
          },
          body: JSON.stringify({
            action: "runtime-attestation",
            input: {
              purpose: "decision",
              request: challenge.request,
              signature,
            },
          }),
        });
        if (!reply.ok) {
          await reply.body?.cancel();
          throw Error("Current registered assignment attestation unavailable");
        }
        const packet = z
          .strictObject({
            request: runtimeAttestationSchema,
            signature: z.string().min(1).max(200),
          })
          .parse(await reply.json());
        current();
        const a = packet.request;
        if (
          a.authorityId !== config.authorityId ||
          a.deviceId !== config.deviceId ||
          a.ownerWallet !== config.ownerWallet ||
          a.principal !== identity.principal ||
          a.credentialId !== identity.credentialId ||
          a.sourceWorkspace !== identity.sourceWorkspace ||
          a.purpose !== "decision" ||
          a.requestDigest !== digest(challenge.request) ||
          a.issuedAt > now() + 1000 ||
          a.issuedAt < now() - 15000 ||
          a.expiresAt <= now() ||
          !verify(
            null,
            Buffer.from(runtimeAttestationMessage(a)),
            attester,
            Buffer.from(packet.signature, "base64"),
          )
        )
          throw Error("Registered assignment attestation binding rejected");
        decisions.set(challenge.request.parametersDigest, {
          requestId: challenge.request.requestId,
          operationId: challenge.request.operationId,
        });
        return { request: challenge.request, signature, attestation: packet };
      },
    });
    const tracked = (
      input: Parameters<typeof gateway.forward>[0],
      signal: AbortSignal,
    ) => {
      const work = gateway.forward(
        input,
        AbortSignal.any([signal, stop.signal]),
      );
      pending.add(work);
      void work.finally(() => pending.delete(work)).catch(() => {});
      return work;
    };
    const broker = await launchAssignmentServiceBroker({
      current,
      now,
      authorize: async (_review, binding, signal, phase) => {
        signal.throwIfAborted();
        current();
        checkAssignmentNativeAction(review, config.criteria, binding, now());
        const modelId = digest(binding.assignment);
        if (
          phase === "inference" &&
          db.prepare("SELECT id FROM model_admissions WHERE id=?").get(modelId)
        )
          throw Error(
            "Native model admission already reserved; no repeat after uncertainty",
          );
        if (phase === "inference" || phase === "validation") {
          // The current protected source read obtains fresh Roles and CRM checks
          // immediately before inference or independent result validation.
          const response = await tracked(
            { kind: "task", assignmentId: binding.assignment.assignmentId },
            signal,
          );
          if (!response.ok) {
            await response.body?.cancel();
            throw Error("Current source/Role admission unavailable");
          }
          const source = z
            .strictObject({
              assignment: assignmentSchema,
              instruction: z.string().min(1).max(8000),
            })
            .parse(await response.json());
          current();
          if (
            digest(source.assignment) !== digest(binding.assignment) ||
            digest(source.instruction) !== binding.inputDigest
          )
            throw Error("Protected source changed before local action");
        }
        let leaseDeadline: number | undefined;
        if (phase === "inference" || phase === "validation") {
          const claim = binding.claim,
            crmOperationId = binding.crmOperationId;
          if (!claim || !z.uuid().safeParse(crmOperationId).success)
            throw Error("Original model result operation required");
          const expected = config.criteria.find(
            (c) => c.assignmentDigest === digest(binding.assignment),
          )!;
          const response = await tracked(
            {
              kind: "lease",
              assignmentId: binding.assignment.assignmentId,
              runId: claim.runId,
              leaseId: claim.leaseId,
              crmOperationId: crmOperationId!,
              resultDigest: expected.resultDigest,
            },
            signal,
          );
          if (!response.ok) {
            await response.body?.cancel();
            throw Error("Current Workflows model lease unavailable");
          }
          const parameters = {
            tool: "workflow_crm_result_read",
            arguments: {
              connectionId: config.connectionId,
              assignmentDigest: digest(binding.assignment),
              runId: claim.runId,
              leaseId: claim.leaseId,
              crmOperationId,
            },
          };
          const decision = decisions.get(digest(parameters));
          if (!decision || decision.operationId !== crmOperationId)
            throw Error("Current native lease challenge receipt required");
          const proof = verifyCrmResultLease(
            await response.json(),
            {
              state: "running",
              assignmentDigest: digest(binding.assignment),
              connectionId: config.connectionId,
              runId: claim.runId,
              leaseId: claim.leaseId,
              crmOperationId,
              operation: "receipt",
              authorityOperationId: crmOperationId,
              resultDigest: expected.resultDigest,
              principal: identity.principal,
              credentialId: identity.credentialId,
              runtimeLeaseId: identity.leaseId,
              runtimeBindingDigest: identity.runtimeBindingDigest,
              tenant: identity.tenant,
              workspace: identity.workspace,
              authorityRequestId: decision.requestId,
            },
            config.workflowPublicKey,
            now(),
          );
          current();
          leaseDeadline = proof.expiresAt;
        }
        if (phase === "inference")
          db.transaction(() => {
            if (
              db
                .prepare(
                  "INSERT INTO model_admissions VALUES(?) ON CONFLICT DO NOTHING",
                )
                .run(modelId).changes !== 1
            )
              throw Error("Native inference admission already reserved");
            budget.beginWork(scope);
          }).immediate();
        return leaseDeadline;
      },
      validate: async (_review, input, signal) => {
        signal.throwIfAborted();
        current();
        return validateExactOutcome(
          input,
          config.criteria,
          review.approvedAt,
          review.expiresAt,
          now(),
        );
      },
      forward: tracked,
    });
    return {
      environment: broker.environment,
      close: async () => {
        stop.abort();
        try {
          await broker.close();
          await Promise.allSettled([...pending]);
        } finally {
          db.close();
        }
      },
    };
  } catch (e) {
    db.close();
    throw e;
  }
}

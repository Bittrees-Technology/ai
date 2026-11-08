import test from "node:test";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  realpathSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
  chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  randomBytes,
  randomUUID,
  generateKeyPairSync,
  createHash,
  sign,
  verify,
} from "node:crypto";
import Database from "better-sqlite3";
import { crmResultLeaseMessage } from "../modules/task-sync/crm-result-lease-contract.mjs";
import { canonical } from "../modules/contracts/canonical-json.js";
import { AssignmentAttestationHTTPS } from "../modules/task-sync/assignment-https.js";
import { checkAssignmentNativeAction } from "../modules/task-sync/assignment-native-admission.js";
import { Vault } from "../modules/storage/vault.js";
import {
  savedCentralState,
  signExistingCentralAssignmentRequest,
} from "../modules/workflows/central-saved-state.js";
import {
  runtimeAttestationMessage,
  activationReceiptMessage,
} from "../modules/task-sync/runtime-contract.js";
import { assignmentGatewayScope } from "../modules/task-sync/assignment-gateway-native.js";
import { nativeAssignmentServiceClient } from "../modules/task-sync/assignment-service-native.js";
import { digest } from "../modules/task-sync/proof-contract.js";
import { exactOutcomeValidatorPin } from "../modules/task-sync/assignment-exact-validator.js";
import { launchAssignments } from "../apps/companion/assignment-launch.js";
import { NativeRuntimeCostBudget } from "../modules/task-sync/native-runtime-cost.js";
const hash = (v: string | Buffer) =>
  createHash("sha256").update(v).digest("hex");
function fixture() {
  const directory = realpathSync(
      mkdtempSync(join(tmpdir(), "assignment-launch-")),
    ),
    vault = new Vault(randomBytes(32)),
    now = Date.now();
  const pair = generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  const roles = generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  const principal = "agent:" + randomUUID(),
    credentialId = hash(pair.publicKey),
    connectionId = randomUUID();
  const central = {
    confirmed: true,
    enabled: false,
    tenant: "t",
    workspace: "w",
    connectionId,
    workflowId: "checked-result",
    delegationId: randomUUID(),
    profileId: randomUUID(),
    mcpToken: randomBytes(32).toString("hex"),
  };
  const centralPath = join(directory, "central-workflows.db"),
    db = new Database(centralPath);
  db.exec("CREATE TABLE state(key TEXT PRIMARY KEY,value BLOB NOT NULL)");
  for (const [name, value] of [
    ["identity", { ...pair, principal, credentialId }],
    ["config", central],
  ] as const)
    db.prepare("INSERT INTO state VALUES(?,?)").run(
      name,
      vault.seal(value, "central-workflows:" + name),
    );
  db.close();
  const control = randomBytes(32).toString("hex");
  writeFileSync(
    join(directory, "workflow-device.enc"),
    vault.seal({ controlToken: control }, "workflow-device"),
    { mode: 0o600 },
  );
  const assignment = {
    assignmentId: randomUUID(),
    taskId: randomUUID(),
    taskRevision: 1,
    projectId: randomUUID(),
    workflowId: central.workflowId,
    workflowRevision: 1,
    principal,
  };
  const criteria = [
    {
      assignmentDigest: digest(assignment),
      inputDigest: digest("12 + 30"),
      resultDigest: digest({ summary: "42" }),
      evidenceReference: "isolated synthetic arithmetic source",
      reviewedAt: now - 1000,
    },
  ];
  const review = {
    version: 1 as const,
    epoch: randomUUID(),
    approvedAt: now - 100,
    expiresAt: now + 60000,
    profileId: central.profileId,
    modelDigest: "b".repeat(64),
    validator: exactOutcomeValidatorPin(criteria),
    completeTask: false,
    assignments: [assignment],
  };
  const receipt = {
    version: 1 as const,
    issuer: "https://roles.bittrees.org" as const,
    sourceWorkspace: randomUUID(),
    audience: "https://mcp.bittrees.org" as const,
    leaseId: randomUUID(),
    policyDigest: "c".repeat(64),
    principal,
    credentialId,
    runtimeBindingDigest: "d".repeat(64),
    tenant: central.tenant,
    workspace: central.workspace,
    activatedAt: new Date(now - 1000).toISOString(),
    expiresAt: new Date(now + 60000).toISOString(),
    renewable: false as const,
  };
  const identity = {
    principal,
    credentialId,
    tenant: receipt.tenant,
    workspace: receipt.workspace,
    sourceWorkspace: receipt.sourceWorkspace,
    subject: principal,
    leaseId: receipt.leaseId,
    runtimeBindingDigest: receipt.runtimeBindingDigest,
    activatedAt: now - 1000,
    expiresAt: now + 60000,
  };
  const evidence = {
    version: 1,
    id: "synthetic-zero-cost",
    observedAt: now - 1000,
    validUntil: now + 60000,
    account: "synthetic",
    project: "synthetic",
    plan: "test",
    services: [
      "mcp.bittrees.org",
      "roles.bittrees.org",
      "workflow.bittrees.org",
      "crm.bittrees.org",
      "ai.bittrees.org",
    ],
    resourceClass: "isolated tests; no network execution",
    overageControls: "no downstream calls permitted by fixture",
    costBasis: "verified-included-usage",
    maximumAdditionalMicroUSD: 0,
    reference: "synthetic fixture only",
  };
  const evidenceBytes = Buffer.from(JSON.stringify(evidence));
  writeFileSync(
    join(directory, "native-assignments-evidence.json"),
    evidenceBytes,
    { mode: 0o600 },
  );
  const config = {
    version: 1,
    confirmed: true,
    sourceAccessApproved: true,
    review,
    criteria,
    centralStateDigest: hash(
      JSON.stringify(savedCentralState(centralPath, vault)),
    ),
    gatewayCredentialDigest: hash(central.mcpToken),
    coordinatorCredentialDigest: hash(control),
    authorityId: randomUUID(),
    deviceId: randomUUID(),
    ownerWallet: "0x" + "1".repeat(40),
    connectionId,
    workflowPublicKey: roles.publicKey,
    rolesPublicKey: roles.publicKey,
    attestationPublicKey: roles.publicKey,
    activation: {
      receipt,
      signature: sign(
        null,
        Buffer.from(activationReceiptMessage(receipt)),
        roles.privateKey,
      ).toString("base64"),
    },
    budget: {
      version: 1,
      confirmed: true,
      runId: randomUUID(),
      scopeDigest: assignmentGatewayScope(review, identity, connectionId),
      issuedAt: review.approvedAt,
      expiresAt: review.expiresAt,
      maxWorkAttempts: 1,
      maxRequests: 12,
      maxRequestBytes: 100000,
      maxResponseBytes: 100000,
      requestsByKind: {
        source: 0,
        connect: 0,
        execute: 8,
        preview: 0,
        owner: 0,
        attestation: 4,
        status: 0,
      },
    },
    evidenceDigest: hash(evidenceBytes),
  };
  const save = () =>
    writeFileSync(
      join(directory, "native-assignments.json"),
      JSON.stringify(config),
      { mode: 0o600 },
    );
  save();
  let unlocks = 0,
    networkCalls = 0,
    leaseState = "running";
  const network = {
    resolve: async () => [{ address: "8.8.8.8", family: 4 }],
    send: ((url: URL, init: any, callback: any) => {
      networkCalls++;
      assert.equal(init.rejectUnauthorized, true);
      assert.equal(init.servername, url.hostname);
      const req = new EventEmitter() as any;
      req.end = (raw: string) =>
        queueMicrotask(() => {
          const body = JSON.parse(String(raw));
          let response: unknown,
            status = 200;
          if (url.hostname === "ai.bittrees.org") {
            assert.equal(body.action, "runtime-attestation");
            assert.equal(body.input.purpose, "decision");
            assert.ok(
              verify(
                null,
                Buffer.from(
                  "Bittrees MCP authority request v1\n" +
                    canonical(body.input.request),
                ),
                pair.publicKey,
                Buffer.from(body.input.signature, "base64"),
              ),
            );
            const request = {
              version: 1,
              issuer: "https://ai.bittrees.org",
              audience: "https://roles.bittrees.org",
              purpose: "decision",
              requestDigest: digest(body.input.request),
              authorityId: config.authorityId,
              deviceId: config.deviceId,
              ownerWallet: config.ownerWallet,
              principal,
              credentialId,
              sourceWorkspace: identity.sourceWorkspace,
              issuedAt: now,
              expiresAt: now + 15000,
              nonce: randomUUID(),
            };
            response = {
              request,
              signature: sign(
                null,
                Buffer.from(runtimeAttestationMessage(request)),
                roles.privateKey,
              ).toString("base64"),
            };
          } else {
            assert.equal(
              url.href,
              "https://mcp.bittrees.org/v1/crm-assignments",
            );
            assert.ok(body.kind === "task" || body.kind === "lease");
            if (!init.headers["X-Bittrees-Agent-Proof"]) {
              status = 428;
              const parameters =
                body.kind === "lease"
                  ? {
                      tool: "workflow_crm_result_read",
                      arguments: {
                        connectionId,
                        assignmentDigest: digest(assignment),
                        runId: body.runId,
                        leaseId: body.leaseId,
                        crmOperationId: body.crmOperationId,
                      },
                    }
                  : {
                      tool: "workflow_crm_task",
                      arguments: {
                        connectionId,
                        workflowId: assignment.workflowId,
                        assignmentDigest: digest(assignment),
                      },
                    };
              const request = {
                version: 1,
                source: "mcp.bittrees.org",
                audience:
                  "https://roles.bittrees.org/api/authority/mcp-decision",
                requestId: randomUUID(),
                operationId:
                  body.kind === "lease" ? body.crmOperationId : randomUUID(),
                parametersDigest: digest(parameters),
                issuedAt: now,
                principal,
                credentialId,
                delegationId: null,
                leaseId: identity.leaseId,
                runtimeBindingDigest: identity.runtimeBindingDigest,
                tenant: identity.tenant,
                workspace: identity.workspace,
                project: "workflow",
                resource: "workflow:" + assignment.workflowId,
                action:
                  body.kind === "lease"
                    ? "workflow:complete"
                    : "workflow:claim",
                stage: "execute",
              };
              response = {
                error: "Local device signature required",
                challenge: {
                  type: "roles-proof-required",
                  request,
                  parameters,
                },
              };
            } else {
              const proof = JSON.parse(
                Buffer.from(
                  init.headers["X-Bittrees-Agent-Proof"],
                  "base64url",
                ).toString(),
              );
              assert.ok(
                verify(
                  null,
                  Buffer.from(
                    "Bittrees MCP authority request v1\n" +
                      canonical(proof.request),
                  ),
                  pair.publicKey,
                  Buffer.from(proof.signature, "base64"),
                ),
              );
              assert.ok(
                verify(
                  null,
                  Buffer.from(
                    runtimeAttestationMessage(proof.attestation.request),
                  ),
                  roles.publicKey,
                  Buffer.from(proof.attestation.signature, "base64"),
                ),
              );
              if (body.kind === "lease") {
                const p = {
                  version: 1,
                  issuer: "https://workflow.bittrees.org",
                  audience: "https://crm.bittrees.org",
                  kind: "crm-result-lease",
                  state: leaseState,
                  assignmentDigest: digest(assignment),
                  connectionId,
                  runId: body.runId,
                  leaseId: body.leaseId,
                  crmOperationId: body.crmOperationId,
                  operation: "receipt",
                  authorityOperationId: body.crmOperationId,
                  resultDigest: body.resultDigest,
                  principal,
                  credentialId,
                  runtimeLeaseId: identity.leaseId,
                  runtimeBindingDigest: identity.runtimeBindingDigest,
                  tenant: identity.tenant,
                  workspace: identity.workspace,
                  authorityRequestId: proof.request.requestId,
                  issuedAt: now,
                  expiresAt: now + 4000,
                };
                response = {
                  proof: p,
                  signature: sign(
                    null,
                    Buffer.from(crmResultLeaseMessage(p)),
                    roles.privateKey,
                  ).toString("base64"),
                };
              } else response = { assignment, instruction: "12 + 30" };
            }
          }
          const res = Readable.from([JSON.stringify(response)]) as any;
          res.statusCode = status;
          res.headers = { "content-type": "application/json" };
          callback(res);
        });
      return req;
    }) as any,
  };
  return {
    directory,
    vault,
    now,
    config,
    assignment,
    identity,
    save,
    centralPath,
    pair,
    unlocks: () => unlocks,
    networkCalls: () => networkCalls,
    setLeaseState: (state: string) => (leaseState = state),
    launch: () =>
      launchAssignments(
        directory,
        async () => {
          unlocks++;
          return vault;
        },
        () => now,
        network,
      ),
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}
test("native paid admission shares helper reservations and survives assignment review replacement", async () => {
  const f = fixture();
  let service: Awaited<ReturnType<typeof f.launch>>;
  try {
    const runtimeApproval = {
      approvalId: randomUUID(),
      reference: "synthetic-only-no-runtime-approval",
      pricingReference: "synthetic-aggregate-downstream-ceilings",
      authorizedAt: f.config.review.approvedAt,
      authorizationExpiresAt: f.config.review.expiresAt,
      providers: ["neon", "vercel"],
      approvedAt: f.config.review.approvedAt,
      expiresAt: f.config.review.expiresAt,
      maximumMicroUSD: 600000,
      maximumAttempts: 20,
      ceilings: {
        enrollment: 100000,
        central: 100000,
        assignment: 100000,
        attestation: 100000,
      },
    };
    const proofPath = join(f.directory, "native-assignments-evidence.json");
    const proof = JSON.parse(readFileSync(proofPath, "utf8"));
    Object.assign(proof, {
      costBasis: "explicit-one-time-approval",
      maximumAdditionalMicroUSD: 600000,
      runtimeApproval,
    });
    const bytes = JSON.stringify(proof);
    writeFileSync(proofPath, bytes);
    f.config.evidenceDigest = hash(bytes);
    f.save();
    service = await f.launch();
    assert.ok(service);
    let client = nativeAssignmentServiceClient(service.environment)!;
    const input = {
      assignment: f.assignment,
      claim: {
        assignmentDigest: digest(f.assignment),
        runId: randomUUID(),
        leaseId: randomUUID(),
        expiresAt: f.now + 60000,
      },
      crmOperationId: randomUUID(),
      inputDigest: digest("12 + 30"),
      resultDigest: digest({ summary: "42" }),
      result: { summary: "42" },
    };
    const validate = () =>
      client.execute(
        { kind: "validate", epoch: f.config.review.epoch, input },
        AbortSignal.timeout(3000),
      );
    assert.equal((await (await validate()).json()).validation.accepted, true);
    assert.equal(f.networkCalls(), 6);
    await service.close();
    // Neither another helper nor a new request-budget epoch gets fresh funding.
    assert.throws(
      () =>
        new NativeRuntimeCostBudget(
          f.directory,
          f.vault,
          runtimeApproval,
          () => {},
          () => f.now,
        ).reserve("enrollment"),
      /spending budget exhausted/,
    );
    f.config.review.epoch = randomUUID();
    f.config.budget.runId = randomUUID();
    f.config.budget.scopeDigest = assignmentGatewayScope(
      f.config.review,
      f.identity,
      f.config.connectionId,
    );
    f.save();
    service = await f.launch();
    assert.ok(service);
    client = nativeAssignmentServiceClient(service.environment)!;
    await assert.rejects(validate());
    assert.equal(f.networkCalls(), 6);
  } finally {
    await service!?.close();
    f.cleanup();
  }
});

test("absent native setup cannot unlock, create storage or begin network work", async () => {
  const f = fixture();
  try {
    rmSync(join(f.directory, "native-assignments.json"));
    assert.equal(await f.launch(), null);
    assert.equal(f.unlocks(), 0);
    assert.equal(
      existsSync(join(f.directory, "native-assignment-budgets.db")),
      false,
    );
  } finally {
    f.cleanup();
  }
});
test("invalid scope, signer, acceptance or runtime cost evidence denies before vault read", async () => {
  for (const alter of [
    (f: ReturnType<typeof fixture>) => {
      f.config.review.expiresAt = f.now - 1;
    },
    (f: ReturnType<typeof fixture>) => {
      f.config.activation.signature = "forged";
    },
    (f: ReturnType<typeof fixture>) => {
      f.config.criteria[0]!.resultDigest = "f".repeat(64);
    },
    (f: ReturnType<typeof fixture>) => {
      f.config.evidenceDigest = "f".repeat(64);
    },
    (f: ReturnType<typeof fixture>) => {
      f.config.budget.maxWorkAttempts = 2;
    },
  ]) {
    const f = fixture();
    try {
      alter(f);
      f.save();
      await assert.rejects(f.launch());
      assert.equal(f.unlocks(), 0);
      assert.equal(
        existsSync(join(f.directory, "native-assignment-budgets.db")),
        false,
      );
    } finally {
      f.cleanup();
    }
  }
  const f = fixture();
  try {
    chmodSync(join(f.directory, "native-assignments.json"), 0o644);
    await assert.rejects(f.launch(), /Protected/);
    assert.equal(f.unlocks(), 0);
  } finally {
    f.cleanup();
  }
});
test("actual native bootstrap publishes only protected IPC and independently checks pinned outcome", async () => {
  const f = fixture();
  let service: Awaited<ReturnType<typeof f.launch>>;
  try {
    service = await f.launch();
    assert.ok(service);
    const client = nativeAssignmentServiceClient(service.environment)!;
    const review = await client.execute(
      { kind: "review" },
      AbortSignal.timeout(3000),
    );
    assert.deepEqual((await review.json()).review, f.config.review);
    const input = {
      assignment: f.assignment,
      claim: {
        assignmentDigest: digest(f.assignment),
        runId: randomUUID(),
        leaseId: randomUUID(),
        expiresAt: f.now + 60000,
      },
      crmOperationId: randomUUID(),
      inputDigest: digest("12 + 30"),
      resultDigest: digest({ summary: "42" }),
      result: { summary: "42" },
    };
    const checked = await client.execute(
      { kind: "validate", epoch: f.config.review.epoch, input },
      AbortSignal.timeout(3000),
    );
    assert.equal((await checked.json()).validation.accepted, true);
    assert.equal(f.networkCalls(), 6); // source and lease: challenge, existing-key attestation, protected reply
    await assert.rejects(
      client.execute(
        {
          kind: "validate",
          epoch: f.config.review.epoch,
          input: {
            ...input,
            result: { summary: "43" },
            resultDigest: digest({ summary: "43" }),
          },
        },
        AbortSignal.timeout(3000),
      ),
    );
    const raw = readFileSync(join(f.directory, "native-assignment-budgets.db"));
    assert.equal(
      raw.includes(Buffer.from(f.config.gatewayCredentialDigest)),
      false,
    );
    f.config.sourceAccessApproved = false as true;
    f.save();
    await assert.rejects(
      client.execute({ kind: "review" }, AbortSignal.timeout(3000)),
    );
  } finally {
    await service!?.close();
    f.cleanup();
  }
});
test("restarted native bootstrap preserves exhausted reservations and blocks before external dispatch", async () => {
  const f = fixture();
  let service = await f.launch();
  assert.ok(service);
  await service.close();
  try {
    const path = join(f.directory, "native-assignment-budgets.db"),
      db = new Database(path),
      aad = "native-assignment-budget:" + f.config.review.epoch;
    const row = db
      .prepare("SELECT record FROM budgets WHERE epoch=?")
      .get(f.config.review.epoch) as { record: Buffer };
    const state = f.vault.open<any>(row.record, aad);
    state.requests = state.review.maxRequests;
    state.byKind.execute = 8;
    state.byKind.attestation = 4;
    db.prepare("UPDATE budgets SET record=? WHERE epoch=?").run(
      f.vault.seal(state, aad),
      f.config.review.epoch,
    );
    db.close();
    service = await f.launch();
    assert.ok(service);
    const client = nativeAssignmentServiceClient(service.environment)!;
    await assert.rejects(
      client.execute(
        {
          kind: "assignment",
          epoch: f.config.review.epoch,
          input: { kind: "task", assignmentId: f.assignment.assignmentId },
        },
        AbortSignal.timeout(3000),
      ),
    );
    await service.close();
    service = null;
    const inspect = new Database(path, { readonly: true });
    const saved = f.vault.open<any>(
      (
        inspect
          .prepare("SELECT record FROM budgets WHERE epoch=?")
          .get(f.config.review.epoch) as { record: Buffer }
      ).record,
      aad,
    );
    inspect.close();
    assert.equal(saved.requests, 12);
    assert.equal(f.networkCalls(), 0);
    assert.match(saved.held, /budget exhausted/);
  } finally {
    await service?.close();
    f.cleanup();
  }
});
test("existing central signer returns only an exact workflow decision signature", () => {
  const f = fixture();
  try {
    const request = {
      version: 1,
      source: "mcp.bittrees.org",
      audience: "https://roles.bittrees.org/api/authority/mcp-decision",
      requestId: randomUUID(),
      operationId: randomUUID(),
      parametersDigest: "f".repeat(64),
      issuedAt: f.now,
      principal: f.identity.principal,
      credentialId: f.identity.credentialId,
      delegationId: null,
      leaseId: f.identity.leaseId,
      runtimeBindingDigest: f.identity.runtimeBindingDigest,
      tenant: f.identity.tenant,
      workspace: f.identity.workspace,
      project: "workflow",
      resource: "workflow:" + f.assignment.workflowId,
      action: "workflow:claim",
      stage: "execute",
    };
    const signature = signExistingCentralAssignmentRequest(
      f.centralPath,
      f.vault,
      request,
      f.now,
    );
    assert.ok(signature);
    assert.equal(typeof signature, "string");
    assert.ok(
      verify(
        null,
        Buffer.from("Bittrees MCP authority request v1\n" + canonical(request)),
        f.pair.publicKey,
        Buffer.from(signature, "base64"),
      ),
    );
    assert.throws(() =>
      signExistingCentralAssignmentRequest(
        f.centralPath,
        f.vault,
        { ...request, resource: "workflow:other" },
        f.now,
      ),
    );
    assert.throws(() =>
      signExistingCentralAssignmentRequest(
        f.centralPath,
        f.vault,
        { ...request, principal: "agent:" + randomUUID() },
        f.now,
      ),
    );
    assert.throws(() =>
      signExistingCentralAssignmentRequest(
        f.centralPath,
        f.vault,
        { ...request, issuedAt: f.now - 16000 },
        f.now,
      ),
    );
  } finally {
    f.cleanup();
  }
});

test("attestation transport admits only the fixed typed decision route and refuses private DNS", async () => {
  const f = fixture();
  let lookups = 0,
    sockets = 0;
  try {
    const adapter = new AssignmentAttestationHTTPS(
      () => {},
      async () => {
        lookups++;
        return [{ address: "127.0.0.1", family: 4 }];
      },
      (() => {
        sockets++;
        throw Error("No socket allowed");
      }) as any,
    );
    const request = {
      version: 1,
      source: "mcp.bittrees.org",
      audience: "https://roles.bittrees.org/api/authority/mcp-decision",
      requestId: randomUUID(),
      operationId: randomUUID(),
      parametersDigest: "f".repeat(64),
      issuedAt: f.now,
      principal: f.identity.principal,
      credentialId: f.identity.credentialId,
      delegationId: null,
      leaseId: f.identity.leaseId,
      runtimeBindingDigest: f.identity.runtimeBindingDigest,
      tenant: f.identity.tenant,
      workspace: f.identity.workspace,
      project: "workflow",
      resource: "workflow:" + f.assignment.workflowId,
      action: "workflow:claim",
      stage: "execute",
    };
    const body = {
      action: "runtime-attestation",
      input: { purpose: "decision", request, signature: "signature" },
    };
    const init = {
      method: "POST",
      redirect: "error" as const,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: "Bearer " + "a".repeat(64),
      },
      body: JSON.stringify(body),
    };
    const url = "https://ai.bittrees.org/api/workflows";
    for (const options of [
      { ...init, body: JSON.stringify({ ...body, action: "register-device" }) },
      {
        ...init,
        body: JSON.stringify({
          ...body,
          input: { ...body.input, purpose: "enroll" },
        }),
      },
      { ...init, headers: { ...init.headers, Cookie: "session" } },
      {
        ...init,
        headers: { ...init.headers, "x-bittrees-agent-proof": "abc" },
      },
      {
        ...init,
        body: JSON.stringify({
          ...body,
          input: { ...body.input, request: { ...request, resource: "*" } },
        }),
      },
    ])
      await assert.rejects(adapter.dispatch(url, options));
    await assert.rejects(
      adapter.dispatch("https://mcp.bittrees.org/v1/crm-assignments", init),
    );
    assert.equal(lookups, 0);
    await assert.rejects(adapter.dispatch(url, init), /DNS address/);
    assert.equal(lookups, 1);
    assert.equal(sockets, 0);
  } finally {
    f.cleanup();
  }
});

test("native action admission pins input, task, run, method and source status scope", () => {
  const f = fixture();
  try {
    const claim = {
      assignmentDigest: digest(f.assignment),
      runId: randomUUID(),
      leaseId: randomUUID(),
      expiresAt: f.now + 30000,
    };
    const infer = {
      assignment: f.assignment,
      claim,
      action: "infer" as const,
      inputDigest: digest("12 + 30"),
    };
    checkAssignmentNativeAction(
      f.config.review,
      f.config.criteria,
      infer,
      f.now,
    );
    assert.throws(() =>
      checkAssignmentNativeAction(
        f.config.review,
        f.config.criteria,
        { ...infer, inputDigest: digest("other input") },
        f.now,
      ),
    );
    assert.throws(() =>
      checkAssignmentNativeAction(
        f.config.review,
        f.config.criteria,
        { ...infer, claim: { ...claim, expiresAt: f.now - 1 } },
        f.now,
      ),
    );
    const read = {
      assignment: f.assignment,
      claim,
      action: "read" as const,
      request: {
        url:
          "https://crm.bittrees.org/api/automation/tasks/" +
          f.assignment.taskId,
        method: "GET",
        bodyDigest: digest(null),
        operationId: null,
      },
    };
    checkAssignmentNativeAction(
      f.config.review,
      f.config.criteria,
      read,
      f.now,
    );
    for (const request of [
      { ...read.request, url: "https://elsewhere.invalid" },
      { ...read.request, method: "POST" },
      { ...read.request, bodyDigest: digest({ extra: true }) },
    ])
      assert.throws(() =>
        checkAssignmentNativeAction(
          f.config.review,
          f.config.criteria,
          { ...read, request },
          f.now,
        ),
      );
    const id = randomUUID(),
      recovery = {
        assignment: f.assignment,
        claim: { ...claim, expiresAt: f.now - 1 },
        action: "read-completion" as const,
        request: {
          url:
            "https://workflow.bittrees.org/api/task-runs/" +
            claim.runId +
            "/completions/" +
            id,
          method: "GET",
          bodyDigest: digest(null),
          operationId: null,
        },
      };
    checkAssignmentNativeAction(
      f.config.review,
      f.config.criteria,
      recovery,
      f.now,
    );
    assert.throws(() =>
      checkAssignmentNativeAction(
        f.config.review,
        f.config.criteria,
        {
          ...recovery,
          request: {
            ...recovery.request,
            url:
              "https://workflow.bittrees.org/api/task-runs/" +
              randomUUID() +
              "/completions/" +
              id,
          },
        },
        f.now,
      ),
    );
    assert.throws(() =>
      checkAssignmentNativeAction(
        f.config.review,
        f.config.criteria,
        { ...recovery, action: "read-finalization" },
        f.now,
      ),
    );
  } finally {
    f.cleanup();
  }
});

test("model start obtains fresh source admission after pinning and never repeats across restart", async () => {
  const f = fixture();
  let service: Awaited<ReturnType<typeof f.launch>>;
  try {
    service = await f.launch();
    assert.ok(service);
    let client = nativeAssignmentServiceClient(service.environment)!;
    const binding = {
      assignment: f.assignment,
      claim: {
        assignmentDigest: digest(f.assignment),
        runId: randomUUID(),
        leaseId: randomUUID(),
        expiresAt: f.now + 60000,
      },
      action: "infer",
      crmOperationId: randomUUID(),
      inputDigest: digest("12 + 30"),
    };
    const call = () =>
      client.execute(
        { kind: "model-admit", epoch: f.config.review.epoch, binding },
        AbortSignal.timeout(3000),
      );
    assert.equal((await (await call()).json()).authorized, true);
    assert.equal(f.networkCalls(), 6);
    await assert.rejects(call());
    assert.equal(f.networkCalls(), 6);
    await service.close();
    service = await f.launch();
    assert.ok(service);
    client = nativeAssignmentServiceClient(service.environment)!;
    await assert.rejects(call());
    assert.equal(f.networkCalls(), 6);
    await service.close();
    f.config.review.epoch = randomUUID();
    f.config.budget.runId = randomUUID();
    f.config.budget.scopeDigest = assignmentGatewayScope(
      f.config.review,
      f.identity,
      f.config.connectionId,
    );
    f.save();
    service = await f.launch();
    assert.ok(service);
    client = nativeAssignmentServiceClient(service.environment)!;
    await assert.rejects(call());
    assert.equal(f.networkCalls(), 6);
  } finally {
    await service!?.close();
    f.cleanup();
  }
});

test("a signed terminal Workflows lease cannot admit another model turn", async () => {
  const f = fixture();
  let service: Awaited<ReturnType<typeof f.launch>>;
  try {
    f.setLeaseState("completed");
    service = await f.launch();
    assert.ok(service);
    const client = nativeAssignmentServiceClient(service.environment)!;
    await assert.rejects(
      client.execute(
        {
          kind: "model-admit",
          epoch: f.config.review.epoch,
          binding: {
            assignment: f.assignment,
            claim: {
              assignmentDigest: digest(f.assignment),
              runId: randomUUID(),
              leaseId: randomUUID(),
              expiresAt: f.now + 60000,
            },
            action: "infer",
            crmOperationId: randomUUID(),
            inputDigest: digest("12 + 30"),
          },
        },
        AbortSignal.timeout(3000),
      ),
    );
    const db = new Database(join(f.directory, "native-assignment-budgets.db"), {
      readonly: true,
    });
    assert.equal(
      (
        db.prepare("SELECT count(*) AS n FROM model_admissions").get() as {
          n: number;
        }
      ).n,
      0,
    );
    db.close();
    assert.equal(f.networkCalls(), 6);
  } finally {
    await service!?.close();
    f.cleanup();
  }
});

test("missing native custody files deny before unlocking any vault", async () => {
  for (const name of ["central-workflows.db", "workflow-device.enc"]) {
    const f = fixture();
    try {
      rmSync(join(f.directory, name));
      await assert.rejects(f.launch());
      assert.equal(f.unlocks(), 0);
    } finally {
      f.cleanup();
    }
  }
});

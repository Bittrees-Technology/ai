// Read-only prerequisite audit of an explicitly pinned private Mail checkout.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const source = resolve(process.env.MAIL_REPO || "");
const expected = process.env.MAIL_SOURCE_COMMIT;
const output = process.env.MAIL_READINESS_OUTPUT;
assert.ok(
  process.env.MAIL_REPO &&
    output &&
    expected &&
    /^[a-f0-9]{40}$/.test(expected),
  "MAIL_REPO, MAIL_SOURCE_COMMIT and MAIL_READINESS_OUTPUT are required",
);
const git = (...args: string[]) =>
  execFileSync("git", ["-C", source, ...args], { encoding: "utf8" }).trim();
assert.equal(git("rev-parse", "HEAD"), expected);
assert.equal(
  git("status", "--porcelain"),
  "",
  "Use a clean private source checkout",
);
const sha = (bytes: string | Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
const run = (binary: string, args: string[]) =>
  execFileSync(binary, args, {
    cwd: source,
    encoding: "utf8",
    timeout: 180_000,
    maxBuffer: 8 * 1024 ** 2,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
  });
const tests = [
  "tests/ai-mail-grants.test.mjs",
  "tests/ai-mail-consent.test.mjs",
  "tests/chat-mail-grants.test.mjs",
  "tests/connector.test.mjs",
];
const log = run(process.execPath, ["--test", "--test-reporter=tap", ...tests]);
const count = (key: string) =>
  Number(new RegExp(`^# ${key} (\\d+)$`, "m").exec(log)?.[1]);
assert.ok(count("tests") > 0);
assert.equal(count("pass"), count("tests"));
for (const key of ["fail", "cancelled", "skipped", "todo"])
  assert.equal(count(key), 0);
const temp = await mkdtemp(join(tmpdir(), "ai-mail-send-contract-"));
try {
  const { build } = createRequire(join(source, "package.json"))("esbuild");
  // Only the environment provider is substituted. Production parsers/routes remain unchanged.
  (globalThis as any).__mailSendReadinessEnv = {
    MAIL_EXTERNAL_ENABLED: "false",
  };
  await build({
    stdin: {
      contents:
        "export {chatMailOperation} from './lib/chat-mail-operation'; export {aiMailHttp} from './lib/ai-mail-http';",
      resolveDir: source,
    },
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: join(temp, "source.mjs"),
    plugins: [
      {
        name: "synthetic-env",
        setup(b: any) {
          b.onResolve({ filter: /^cloudflare:workers$/ }, () => ({
            path: "env",
            namespace: "fixture",
          }));
          b.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
            contents: "export const env=globalThis.__mailSendReadinessEnv",
          }));
        },
      },
    ],
  });
  const { chatMailOperation, aiMailHttp } = await import(
    pathToFileURL(join(temp, "source.mjs")).href
  );
  const plain = {
    to: "synthetic@bittrees.org",
    subject: "Synthetic",
    text: "Exact text",
    idempotencyKey: "synthetic-operation-01",
  };
  assert.deepEqual(chatMailOperation("send", plain).payload, plain);
  for (const extra of [
    { from: "other@bittrees.org" },
    { cc: ["copy@bittrees.org"] },
    { bcc: ["hidden@bittrees.org"] },
    { approved: true },
  ])
    assert.throws(() => chatMailOperation("send", { ...plain, ...extra }));
  assert.throws(() => chatMailOperation("send", { ...plain, to: [plain.to] }));
  for (const action of ["send", "send-review", "send-receipt"]) {
    const response = await aiMailHttp(
      new Request("https://mail.bittrees.org/api/integrations/ai/" + action, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(plain),
      }),
      action,
    );
    assert.equal(response.status, 404);
  }
  const python = JSON.parse(
    run(process.env.MAIL_PYTHON || "python3", [
      fileURLToPath(new URL("mail-send-readiness.py", import.meta.url)),
      source,
    ]),
  );
  assert.equal(python.status, "passed");
  assert.equal(python.realSmtpCalls, 0);
  assert.equal(git("status", "--porcelain"), "");
  assert.equal(git("rev-parse", "HEAD"), expected);
  const files = [
    "lib/ai-mail-grants.ts",
    "lib/ai-mail-http.ts",
    "lib/chat-mail-grants.ts",
    "lib/chat-mail-operation.ts",
    "lib/mail-job-authority.ts",
    "lib/mail-connector.ts",
    "ops/mail-connector.py",
    "ops/mail_managed.py",
    ...tests,
  ];
  const evidence = {
    verifiedAt: new Date().toISOString(),
    sourceCommit: expected,
    node: process.version,
    sourceHashes: Object.fromEntries(
      await Promise.all(
        files.map(async (f) => [f, sha(await readFile(join(source, f)))]),
      ),
    ),
    actualSourceTests: {
      tests: count("tests"),
      pass: count("pass"),
      fail: 0,
      skipped: 0,
      logSha256: sha(log),
      files: tests,
    },
    interceptedConnector: python,
    readyForAiSend: false,
    verifiedBoundaries: [
      "Selected AI grant scopes and queue validation reject send and unselected reads",
      "AI and Chat grants remain separate with session, assignment, MFA, expiry, revocation and freeze checks",
      "Actual AI HTTP exposes no send/review/receipt operation",
      "Chat parser rejects caller From, Cc/Bcc, multiple To and caller approval fields",
      "Source durable duplicate/uncertain outcomes checked with intercepted SMTP only",
    ],
    requiredWork: [
      "A separate AI send grant and exact-content approval, rechecked through queue dispatch",
      "Source support for the full reviewed From/To/Cc/Bcc/subject/body/attachment envelope",
      "Read-only operation receipt lookup, retaining accepted/uncertain states without resending",
      "Companion durable intent, exact review UI and reconciliation wired to that source contract",
      "Synthetic end-to-end change/revoke/freeze/duplicate/ambiguous-send acceptance before any live activation",
    ],
    limits: [
      "This is prerequisite evidence, not completed X2 sending or a live-user acceptance",
      "Private source checkout and disposable fixtures only; no Site changes, deployment, migration, personal key/data, message delivery or Acer operation",
      "Existing Mail source uses Acer for mailbox transport; Mac AI inference remains separate and Acer news model/runtime/jobs unchanged",
    ],
  };
  await writeFile(resolve(output!) + ".source-tests.tap", log);
  await writeFile(resolve(output!), JSON.stringify(evidence, null, 2) + "\n");
  console.log(
    `Mail source ${expected}: ${count("tests")} source tests and intercepted send checks passed. AI sending remains unavailable; five implementation requirements recorded.`,
  );
} finally {
  delete (globalThis as any).__mailSendReadinessEnv;
  await rm(temp, { recursive: true, force: true });
}

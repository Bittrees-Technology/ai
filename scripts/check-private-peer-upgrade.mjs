import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
const repo = process.cwd(),
  resources = process.env.BITTREES_OLD_APP_RESOURCES;
if (!resources)
  throw Error(
    "Set BITTREES_OLD_APP_RESOURCES to the reviewed PR104 app Resources directory; run npm run build first.",
  );
const olderInfo = JSON.parse(
  readFileSync(join(resources, "build-info.json"), "utf8"),
);
assert.equal(
  olderInfo.sourceCommit,
  "f79cff5944a49c45724026e806a0de819e912433",
);
assert.equal(olderInfo.sourceDirty, false);
execFileSync("/usr/bin/codesign", [
  "--verify",
  "--deep",
  "--strict",
  dirname(dirname(resources)),
]);
const { Store } = await import(
  pathToFileURL(join(repo, "dist/modules/storage/store.js"))
);
const { Vault } = await import(
  pathToFileURL(join(repo, "dist/modules/storage/vault.js"))
);
const dir = mkdtempSync(join(tmpdir(), "private-peer-compat-"));
const oldCode = `
import {pathToFileURL} from 'node:url'; import {join, dirname} from 'node:path';
const root=process.env.TEST_RESOURCES,dir=process.env.TEST_DIRECTORY;
const {Store}=await import(pathToFileURL(join(root,'engine/dist/modules/storage/store.js')));
const {Vault}=await import(pathToFileURL(join(root,'engine/dist/modules/storage/vault.js')));
const {encryptedBackup,restoreBackup}=await import(pathToFileURL(join(root,'engine/dist/modules/storage/backup.js')));
const vault=new Vault(Buffer.alloc(32,7)),owner={userId:'synthetic',tenantId:'personal'};
if(process.env.TEST_ACTION==='seed') {
 const store=new Store(join(dir,'tasks.db'),vault);
 const task=store.create(owner,{conversationId:'test',kind:'query',prompt:'synthetic-existing',modelProfileId:'p'},'seed');
 await encryptedBackup(store,vault,join(dir,'old.aib'));
 console.log(JSON.stringify({id:task.id,schema:store.db.pragma('user_version',{simple:true})})); store.close();
} else if(process.env.TEST_ACTION==='refuse') {
 try {const store=new Store(join(dir,'tasks.db'),vault);store.close();throw Error('old engine unexpectedly opened new schema');}
 catch(error) {if(error.message!=='Unsupported database version')throw error;console.log(JSON.stringify({newSchemaRejected:true}));}
} else {
 await restoreBackup(join(dir,'old.aib'),vault,join(dir,'rollback.db'));
 const store=new Store(join(dir,'rollback.db'),vault);
 console.log(JSON.stringify({schema:store.db.pragma('user_version',{simple:true}),prompt:store.export(owner)[0].input.prompt}));store.close();
}`;
function old(action) {
  return JSON.parse(
    execFileSync(
      join(resources, "node"),
      ["--input-type=module", "-e", oldCode],
      {
        encoding: "utf8",
        env: {
          PATH: process.env.PATH,
          TEST_RESOURCES: resources,
          TEST_DIRECTORY: dir,
          TEST_ACTION: action,
        },
      },
    ),
  );
}
try {
  const seed = old("seed");
  assert.equal(seed.schema, 12);
  const store = new Store(
    join(dir, "tasks.db"),
    new Vault(Buffer.alloc(32, 7)),
  );
  assert.equal(store.db.pragma("user_version", { simple: true }), 15);
  assert.equal(
    store.get({ userId: "synthetic", tenantId: "personal" }, seed.id).input
      .prompt,
    "synthetic-existing",
  );
  store.close();
  const rejection = old("refuse");
  assert.equal(rejection.newSchemaRejected, true);
  const rollback = old("rollback");
  assert.equal(rollback.schema, 12);
  assert.equal(rollback.prompt, "synthetic-existing");
  const receipt = {
    testedAt: new Date().toISOString(),
    olderSource: olderInfo.sourceCommit,
    olderBundleSignatureVerified: true,
    newSchema: 15,
    oldSchema: 12,
    storeSourceSha256: createHash("sha256")
      .update(readFileSync("modules/storage/store.ts"))
      .digest("hex"),
    upgradedTaskPreserved: true,
    oldEngineRefusedNewSchema: true,
    oldEngineRestoredOriginalBackupToSeparatePath: true,
    personalDataOrKeychainUsed: false,
    installedAppChanged: false,
    limits:
      "Synthetic data using previously reviewed extracted PR104 runtime; not a personal/native installation acceptance.",
  };
  if (process.env.BITTREES_COMPAT_RECEIPT)
    writeFileSync(
      process.env.BITTREES_COMPAT_RECEIPT,
      JSON.stringify(receipt, null, 2) + "\n",
      { flag: "wx" },
    );
  console.log(JSON.stringify(receipt));
} finally {
  rmSync(dir, { recursive: true, force: true });
}

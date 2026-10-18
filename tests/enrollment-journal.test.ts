import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { randomBytes, randomUUID } from "node:crypto";
import { EnrollmentJournal, type EnrollmentOperationBinding } from "../modules/task-sync/enrollment-journal.js";
import { Vault } from "../modules/storage/vault.js";
function fixture() {
  const dir = mkdtempSync(tmpdir()+"/enrollment-journal-");
  const vault = new Vault(randomBytes(32));
  let authorized = true;
  const open = () => new EnrollmentJournal(dir+"/journal.db", vault, () => { if (!authorized) throw Error("Revoked"); });
  const binding: EnrollmentOperationBinding = { operationId: randomUUID(), epoch: "review", kind: "start", requestDigest: "a".repeat(64) };
  return { open, binding, revoke: () => { authorized=false; }, cleanup: () => rmSync(dir,{recursive:true}) };
}
test("unknown mutation remains reserved after restart and cannot replay", () => {
  const f=fixture(); let j=f.open();
  try { j.reserve(f.binding); j.close(); j=f.open();
    assert.equal(j.inspect(f.binding)?.state,"reserved");
    assert.throws(()=>j.reserve(f.binding),/reconciliation/);
  } finally { j.close(); f.cleanup(); }
});
test("independent journal handles cannot duplicate operation reservations", () => {
  const f=fixture(), a=f.open(), b=f.open();
  try { a.reserve(f.binding); assert.throws(()=>b.reserve(f.binding)); }
  finally { a.close(); b.close(); f.cleanup(); }
});
test("confirmed receipt is immutable, bound and still requires current authority", () => {
  const f=fixture(), j=f.open();
  try {
    assert.throws(()=>j.confirm(f.binding,"b".repeat(64)));
    j.reserve(f.binding); j.confirm(f.binding,"b".repeat(64)); j.confirm(f.binding,"b".repeat(64));
    assert.equal(j.inspect(f.binding)?.state,"confirmed");
    assert.throws(()=>j.confirm(f.binding,"c".repeat(64)));
    assert.throws(()=>j.inspect({...f.binding,epoch:"changed"}));
    assert.throws(()=>j.reserve(f.binding));
    f.revoke(); assert.throws(()=>j.inspect(f.binding)); assert.throws(()=>j.confirm(f.binding,"b".repeat(64)));
  } finally { j.close(); f.cleanup(); }
});

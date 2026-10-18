import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { Vault } from "../storage/vault.js";
export const cloudModel = "xingchen-agi/xing4.0-29b-a4b:free";
export const keyInput = z.strictObject({
  apiKey: z.string().regex(/^sk-or-v1-[a-zA-Z0-9]{32,128}$/),
});
export class CloudConnection {
  private db: Database.Database;
  private active = new Set<AbortController>();
  constructor(
    path: string,
    private vault: Vault,
    private transport: (body: unknown, signal: AbortSignal) => Promise<any>,
  ) {
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS connection(id INTEGER PRIMARY KEY,value BLOB NOT NULL)",
    );
  }
  private read(): any {
    const r = this.db
      .prepare("SELECT value FROM connection WHERE id=1")
      .get() as { value: Buffer } | undefined;
    return r
      ? this.vault.open(r.value, "cloud-connection")
      : { enabled: false, revision: randomUUID() };
  }
  private save(value: unknown) {
    this.db
      .prepare("INSERT OR REPLACE INTO connection VALUES(1,?)")
      .run(this.vault.seal(value, "cloud-connection"));
  }
  status() {
    const c = this.read();
    return {
      enabled: c.enabled,
      hasKey: !!c.apiKey,
      model: cloudModel,
      provider: "phala",
      spendingLimitUSD: 0,
      revision: c.revision,
      lastCheck: c.lastCheck ?? null,
      reason: c.enabled
        ? "Free-only, zero-retention specialist drafts; each task requires export confirmation."
        : "Cloud execution disabled. Save a key, check eligibility, then enable explicitly.",
    };
  }
  install(raw: unknown) {
    const { apiKey } = keyInput.parse(raw);
    this.stop();
    this.save({ apiKey, enabled: false, revision: randomUUID() });
    return this.status();
  }
  stop() {
    for (const c of this.active) c.abort(Error("Cloud access revoked"));
  }
  disable() {
    this.stop();
    const c = this.read();
    this.save({ ...c, enabled: false, revision: randomUUID() });
    return this.status();
  }
  async check() {
    const c = this.read();
    if (!c.apiKey) throw Error("Save an OpenRouter key first");
    const controller = new AbortController();
    this.active.add(controller);
    try {
      const check = await this.transport(
        { action: "check", apiKey: c.apiKey },
        controller.signal,
      );
      if (this.read().revision !== c.revision)
        throw Error("Cloud configuration changed");
      this.save({ ...c, lastCheck: { ...check, checkedAt: Date.now() } });
      return this.status();
    } finally {
      this.active.delete(controller);
    }
  }
  enable(raw: unknown) {
    z.strictObject({ confirmed: z.literal(true) }).parse(raw);
    const c = this.read();
    if (!c.lastCheck?.ready || Date.now() - c.lastCheck.checkedAt > 300000)
      throw Error(
        "A successful recent free-only eligibility check is required",
      );
    this.save({ ...c, enabled: true, revision: randomUUID() });
    return this.status();
  }
  async generate(
    prompt: string,
    model: string,
    signal: AbortSignal,
    operationId: string,
  ) {
    const c = this.read();
    if (!c.enabled || !c.apiKey || model !== cloudModel)
      throw Error("Cloud profile is not enabled for this model");
    const ctrl = new AbortController();
    this.active.add(ctrl);
    try {
      const result = await this.transport(
        { action: "generate", apiKey: c.apiKey, prompt, operationId },
        AbortSignal.any([signal, ctrl.signal]),
      );
      if (this.read().revision !== c.revision)
        throw Error("Cloud authority changed; result held");
      return result;
    } finally {
      this.active.delete(ctrl);
    }
  }
  close() {
    this.stop();
    this.db.close();
  }
}
export async function cloudBridge(body: unknown, signal: AbortSignal) {
  const endpoint = process.env.BITTREES_CLOUD_HELPER_URL ?? "",
    token = process.env.BITTREES_CLOUD_HELPER_TOKEN ?? "";
  if (
    !/^http:\/\/127\.0\.0\.1:\d+\/cloud$/.test(endpoint) ||
    !/^[a-f0-9]{64}$/.test(token)
  )
    throw Error("Scoped cloud helper is not installed");
  const r = await fetch(endpoint, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.any([signal, AbortSignal.timeout(125000)]),
    headers: {
      "content-type": "application/json",
      authorization: "Bearer " + token,
    },
    body: JSON.stringify(body),
  });
  if (!r.ok)
    throw Error("Cloud request held; no automatic retry or paid fallback");
  if (!r.body) throw Error("Missing cloud receipt");
  let size = 0;
  const chunks: Uint8Array[] = [];
  for await (const chunk of r.body) {
    size += chunk.length;
    if (size > 65536) throw Error("Cloud receipt too large");
    chunks.push(chunk);
  }
  const result = JSON.parse(Buffer.concat(chunks).toString());
  if (result.error) throw Error(result.error);
  return result;
}

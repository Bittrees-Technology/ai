// Actual companion and Roles code with isolated synthetic Postgres, no network.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { RolesConnector } from "../modules/connectors/roles.js";
const root = process.env.ROLES_REPO;
if (!root) throw Error("ROLES_REPO required");
const require = createRequire(resolve(root, "package.json"));
const { PGlite } = require("@electric-sql/pglite");
const { readFile } = await import("node:fs/promises");
const load = (name: string): Promise<any> =>
  import(pathToFileURL(resolve(root, name)).href);
const { aiHttp } = await load("lib/ai-http.mjs"),
  { ensureProfile } = await load("lib/profiles.mjs");
const pg = new PGlite();
try {
  await pg.exec(await readFile(resolve(root, "schema.sql"), "utf8"));
  const make = (client: any): any => {
    const sql: any = (strings: TemplateStringsArray, ...values: any[]) => {
      const text = strings.reduce((s, v, i) => s + (i ? "$" + i : "") + v, "");
      return {
        text,
        values,
        then: (yes: any, no: any) =>
          client
            .query(text, values)
            .then((r: any) => r.rows)
            .then(yes, no),
      };
    };
    sql.transaction = (queries: any[]) =>
      client.transaction(async (tx: any) => {
        const out = [];
        for (const q of queries)
          out.push((await tx.query(q.text, q.values)).rows);
        return out;
      });
    return sql;
  };
  const sql = make(pg),
    identity = "0x" + "1".repeat(40),
    other = "0x" + "2".repeat(40),
    key = "c".repeat(64);
  const profileId = await ensureProfile(sql, identity);
  await sql`INSERT INTO roles_sessions(hash,identity,expires_at,authenticated_at) VALUES(${createHash("sha256").update(key).digest("hex")},${identity},now()+interval '1 hour',now())`;
  const payload = {
    roles: {
      [identity]: [{ label: "Moderator" }],
      [other]: [{ label: "PRIVATE_OTHER" }],
    },
    permissions: {},
  };
  await sql`INSERT INTO roles_assignment_sources(source,payload,revision,observed_at,attempted_at,health) VALUES('gov',${JSON.stringify(payload)}::jsonb,'synthetic',now(),now(),'healthy')`;
  let enabled = true;
  const dispatch = async (
    path: string,
    body: unknown,
    headers: Record<string, string> = {},
  ) => {
    let status = 0,
      value: any;
    const responseHeaders: Record<string, string> = {};
    const res: any = {
      setHeader: (k: string, v: string) => {
        responseHeaders[k] = v;
      },
      status: (n: number) => {
        status = n;
        return res;
      },
      json: (v: any) => {
        value = v;
      },
    };
    await aiHttp({ url: path, method: "POST", body, headers }, res, {
      sql,
      canSignIn: async (i: string) => i === identity,
      limited: async () => {},
      origin: "https://roles.bittrees.org",
      enabled: () => enabled,
    });
    return Response.json(value, { status, headers: responseHeaders });
  };
  let stored: Uint8Array | undefined;
  const connector = new RolesConnector(
    "synthetic-owner",
    {
      getSecret: async () => stored,
      setSecret: async (v) => {
        stored = v;
      },
      deleteCredential: async () => {
        stored = undefined;
        return true;
      },
    },
    async (url, init) => {
      const parsed = new URL(String(url));
      assert.equal(parsed.origin, "https://roles.bittrees.org");
      return dispatch(
        parsed.pathname,
        JSON.parse(String(init?.body)),
        Object.fromEntries(new Headers(init?.headers)),
      );
    },
  );
  const begin = await connector.begin();
  const headers = {
    cookie: "__Host-roles=" + key,
    origin: "https://roles.bittrees.org",
  };
  const consent = await dispatch(
    "/api/integrations/ai/authorize",
    {
      identity,
      profileId,
      challenge: new URL(begin.consentUrl).searchParams.get("challenge"),
      actions: ["read_own_access"],
      expiresInDays: 1,
    },
    headers,
  );
  assert.equal(consent.status, 201);
  const issued = await consent.json();
  await connector.finish(begin.id, issued.code);
  const report = await connector.read();
  assert.equal(report.projection.items.length, 1);
  assert.equal(report.projection.items[0]!.label, "Moderator");
  assert.ok(!JSON.stringify(report).includes(other));
  assert.ok(!JSON.stringify(report).includes("PRIVATE_OTHER"));
  assert.equal(report.projection.items[0]!.effectiveAccess, "not_verified");
  await sql`UPDATE roles_assignment_sources SET health='unavailable' WHERE source='gov'`;
  await assert.rejects(connector.read(), /SOURCE_UNAVAILABLE/);
  enabled = false;
  await connector.disconnect();
  assert.equal(await connector.status(), null);
  assert.ok(
    (await pg.query("SELECT revoked_at FROM roles_ai_grants")).rows[0]
      .revoked_at,
  );
  console.log(
    "Actual Roles consent/PKCE/read projection/hash/source-denial/disconnect contract passed in isolated Postgres. No production connection or browser acceptance claimed.",
  );
} finally {
  await pg.close();
}

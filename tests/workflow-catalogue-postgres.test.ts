import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { syncLocalCatalogue } from "../modules/coordinator/workflow-catalogue.js";
import { hash } from "../modules/coordinator/workflow-portal.js";

test(
  "catalogue skips identical writes but preserves progress, removal, ordering and authority",
  { skip: !process.env.CATALOGUE_TEST_DATABASE_URL },
  async () => {
    const pool = new Pool({
      connectionString: process.env.CATALOGUE_TEST_DATABASE_URL,
      max: 1,
    });
    const id = randomUUID(),
      other = randomUUID(),
      template = randomUUID(),
      token = "a".repeat(64);
    try {
      // Session-local synthetic tables: never migrate or change application data.
      await pool.query(`CREATE TEMP TABLE workflow_authorities(id uuid PRIMARY KEY, control_hash text, wallet_address text, revoked_at timestamptz, last_seen_at timestamptz);
   CREATE TEMP TABLE workflow_catalogue_snapshots(authority_id uuid PRIMARY KEY, observed_at bigint);
   CREATE TEMP TABLE workflow_local_catalogue(authority_id uuid,template_id uuid,revision bigint,kind text,state text,progress jsonb,removed_at timestamptz,updated_at timestamptz DEFAULT now(),PRIMARY KEY(authority_id,template_id));
   CREATE TEMP TABLE catalogue_writes(n int);
   CREATE FUNCTION pg_temp.count_catalogue_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO catalogue_writes VALUES(1); RETURN NEW; END $$;
   CREATE TRIGGER count_writes AFTER INSERT OR UPDATE ON workflow_local_catalogue FOR EACH ROW EXECUTE FUNCTION pg_temp.count_catalogue_write();`);
      await pool.query(
        "INSERT INTO workflow_authorities(id,control_hash,wallet_address) VALUES($1,$2,$3),($4,$5,$3)",
        [id, hash(token), "test-wallet", other, hash("b".repeat(64))],
      );
      let at = Date.now();
      const entry = {
        id: template,
        revision: 1,
        kind: "draft",
        state: "ready",
      };
      const sync = async (entries: unknown[], control = token) => {
        at++;
        return syncLocalCatalogue(
          pool,
          control,
          { action: "catalogue", observedAt: at, entries },
          at,
        );
      };
      const row = async () =>
        (
          await pool.query(
            "SELECT * FROM workflow_local_catalogue WHERE authority_id=$1",
            [id],
          )
        ).rows[0];
      const writes = async () =>
        Number(
          (await pool.query("SELECT count(*) FROM catalogue_writes")).rows[0]
            .count,
        );
      await sync([entry]);
      assert.equal(await writes(), 1);
      for (let i = 0; i < 60; i++) await sync([entry]);
      assert.equal(
        await writes(),
        1,
        "60 identical syncs must cause zero catalogue writes",
      );
      assert.equal(
        Number(
          (
            await pool.query(
              "SELECT observed_at FROM workflow_catalogue_snapshots WHERE authority_id=$1",
              [id],
            )
          ).rows[0].observed_at,
        ),
        at,
      );
      assert.ok(
        (
          await pool.query(
            "SELECT last_seen_at FROM workflow_authorities WHERE id=$1",
            [id],
          )
        ).rows[0].last_seen_at,
      );
      await sync([{ ...entry, state: "running" }]);
      assert.equal((await row()).state, "running");
      const progress = {
        peopleSaved: 1,
        target: 5,
        pagesProcessed: 1,
        queued: 0,
        failures: 0,
        skipped: 0,
        measuredAt: new Date().toISOString(),
      };
      await sync([{ ...entry, progress }]);
      assert.deepEqual((await row()).progress, progress);
      const count = await writes();
      await sync([
        {
          ...entry,
          progress: Object.fromEntries(Object.entries(progress).reverse()),
        },
      ]);
      assert.equal(await writes(), count, "JSON key order is immaterial");
      await sync([entry]);
      assert.equal((await row()).progress, null);
      await sync([{ ...entry, revision: 2 }]);
      await sync([{ ...entry, state: "failed" }]);
      assert.equal((await row()).revision, "2");
      assert.equal((await row()).state, "ready");
      await sync([]);
      assert.ok((await row()).removed_at);
      await sync([{ ...entry, revision: 2 }]);
      assert.equal((await row()).removed_at, null);
      await sync([{ ...entry, revision: 2 }], "b".repeat(64));
      assert.equal(
        (await pool.query("SELECT count(*) FROM workflow_local_catalogue"))
          .rows[0].count,
        "2",
      );
      const before = await writes();
      assert.equal(
        (
          await syncLocalCatalogue(
            pool,
            token,
            { action: "catalogue", observedAt: at - 1, entries: [] },
            at,
          )
        ).synced,
        false,
      );
      await pool.query(
        "UPDATE workflow_authorities SET revoked_at=now() WHERE id=$1",
        [id],
      );
      await assert.rejects(sync([]), /DENIED/);
      assert.equal(await writes(), before);
    } finally {
      await pool.end();
    }
  },
);

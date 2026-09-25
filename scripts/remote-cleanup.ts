import { Pool } from "pg";
import { cleanupRemote } from "../modules/remote/maintenance.js";
// No default database, batch size, scheduler or retention policy.
const args = process.argv.slice(2);
const batchSize = Number(args[2]);
const historyRetentionDays =
  args.length === 5 &&
  args[3] === "--history-retention-days" &&
  args[4] === "90"
    ? 90
    : undefined;
const connectionString = process.env.REMOTE_DATABASE_URL;
if (
  (args.length !== 3 && !(args.length === 5 && historyRetentionDays === 90)) ||
  args[0] !== "--apply" ||
  args[1] !== "--batch-size" ||
  !/^[1-9][0-9]*$/.test(args[2] ?? "") ||
  !Number.isSafeInteger(batchSize) ||
  batchSize > 1000 ||
  !connectionString
) {
  console.error(
    "Provide REMOTE_DATABASE_URL and --apply --batch-size <1..1000> [--history-retention-days 90]. No cleanup was started.",
  );
  process.exitCode = 1;
} else {
  const pool = new Pool({
    connectionString,
    max: 1,
    connectionTimeoutMillis: 5000,
    application_name: "bittrees-remote-cleanup",
  });
  try {
    console.log(
      JSON.stringify(
        await cleanupRemote(pool, batchSize, Date.now(), historyRetentionDays),
      ),
    );
  } catch {
    console.error(
      "Remote cleanup failed; no row details or connection settings are logged. Check database availability and migrations.",
    );
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";

for (const cause of ["parent-exit", "quit-signals"] as const) {
  test(`desktop engine finishes shutdown once after ${cause}`, async () => {
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        `
      import { bindProcessLifetime } from './apps/companion/lifetime.ts';
      const timer = setInterval(() => {}, 1000);
      bindProcessLifetime(async () => {
        console.log('stopping');
        await new Promise(resolve => setTimeout(resolve, 80));
        clearInterval(timer);
        console.log('closed');
      }, true);
      console.log('ready');
    `,
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    let output = "",
      errors = "";
    child.stdout.on("data", (data) => {
      output += data;
    });
    child.stderr.on("data", (data) => {
      errors += data;
    });
    const exited = once(child, "close");
    const deadline = setTimeout(() => child.kill("SIGKILL"), 15000);
    try {
      while (!output.includes("ready")) {
        await Promise.race([
          once(child.stdout, "data"),
          exited.then(() => {
            throw Error(errors || "Child exited before ready");
          }),
        ]);
      }
      if (cause === "parent-exit") child.stdin.end();
      else {
        // Keep the parent's pipe open: quit must not hang waiting for its EOF.
        child.kill("SIGTERM");
        child.kill("SIGINT");
      }
      const [code, signal] = await exited;
      assert.equal(signal, null);
      assert.equal(code, 0, errors);
      assert.equal(output, "ready\nstopping\nclosed\n");
    } finally {
      clearTimeout(deadline);
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
    }
  });
}

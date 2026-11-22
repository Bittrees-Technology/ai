import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { serveMcpWindow } from "../apps/companion/mcp-window.ts";
const dir = await mkdtemp(join(tmpdir(), "bittrees-mcp-channel-"));
try {
  // Fixed test executable. Its second invocation simulates an operator closing the window.
  const resources = join(dir, "Resources");
  const executables = join(dir, "Helpers/MCP Connections.app/Contents/MacOS");
  await mkdir(resources);
  await mkdir(executables, { recursive: true });
  const fixture = join(executables, "MCPConnections");
  await writeFile(
    fixture,
    '#!/bin/sh\nmarker="$(dirname "$0")/opened"\nif ! test -e "$marker"; then touch "$marker"; printf "local fixture result"; fi\n',
  );
  await chmod(fixture, 0o700);
  const policy =
    '(version 1)(allow default)(deny network*)(allow network-outbound (remote ip "localhost:*"))';
  const child = spawn(
    "/usr/bin/sandbox-exec",
    ["-p", policy, resolve(process.argv[2])],
    {
      stdio: ["ignore", "inherit", "inherit", "pipe"],
      timeout: 10_000,
    },
  );
  serveMcpWindow(child.stdio[3], resources);
  const code = await new Promise((res, rej) => {
    child.once("error", rej);
    child.once("close", res);
  });
  assert.equal(code, 0);
} finally {
  await rm(dir, { recursive: true, force: true });
}

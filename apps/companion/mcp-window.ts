import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import type { Duplex } from "node:stream";

// This private, inherited descriptor accepts one command: show the operator UI.
// The child cannot specify a tool, URL, token, command or executable.
export function serveMcpWindow(channel: Duplex, resources: string) {
  let helper: ChildProcess | undefined;
  channel.on("error", () => channel.destroy());
  channel.on("close", () => helper?.kill());
  channel.on("data", (command: Buffer) => {
    if (command.length !== 1 || command[0] !== 1 || helper) {
      channel.destroy();
      return;
    }
    const child = spawn(join(resources, "MCPConnections"), [], {
      stdio: ["ignore", "pipe", "ignore"],
      env: {
        HOME: process.env.HOME,
        TMPDIR: process.env.TMPDIR,
        PATH: "/usr/bin:/bin",
      },
    });
    helper = child;
    const chunks: Buffer[] = [];
    let length = 0;
    child.stdout.on("data", (data: Buffer) => {
      length += data.length;
      if (length > 160_000) child.kill();
      else chunks.push(data);
    });
    child.on("error", () => {}); // close follows a failed spawn as well.
    child.once("close", (code) => {
      helper = undefined;
      if (channel.destroyed) return;
      const ok = code === 0 && length <= 160_000;
      const payload = ok ? Buffer.concat(chunks) : Buffer.alloc(0);
      const header = Buffer.alloc(4);
      header.writeInt32BE(ok ? payload.length : -1);
      channel.write(Buffer.concat([header, payload]));
    });
  });
}

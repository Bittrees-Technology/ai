import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { storageActivityHelper } from "../modules/workflows/storage-activity-helper.js";
test("activity helper rejects arbitrary paths, missing tokens and changed operation authority", async () => {
  let reads = 0,
    revision: string | null = "approved",
    revoke = false;
  const token = "a".repeat(64),
    operationId = randomUUID();
  const server = storageActivityHelper({
    token,
    authorize: async (request) =>
      request.operationId === operationId ? revision : null,
    inspect: async () => {
      reads++;
      if (revoke) revision = null;
      return { available: true, busy: false, openFiles: true };
    },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const call = (body: unknown, auth = token) =>
    fetch(`http://127.0.0.1:${address.port}/activity`, {
      method: "POST",
      headers: {
        authorization: "Bearer " + auth,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
  const request = {
    operationId,
    path: homedir() + "/.npm/_cacache",
    checkout: null,
  };
  try {
    assert.equal((await call(request, "b".repeat(64))).status, 403);
    assert.equal((await call({ ...request, path: "/etc" })).status, 400);
    assert.equal(
      (await call({ ...request, operationId: randomUUID() })).status,
      403,
    );
    assert.equal(reads, 0);
    const result = await (await call(request)).json();
    assert.equal(result.openFiles, true);
    assert.equal(result.operationId, operationId);
    assert.deepEqual(
      Object.keys(result).sort(),
      ["available", "busy", "observedAt", "openFiles", "operationId"].sort(),
    );
    revoke = true;
    assert.equal((await call(request)).status, 403);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("incomplete helper bodies expire before any OS inspection", async () => {
  const { connect } = await import("node:net");
  let reads = 0;
  const token = "a".repeat(64);
  const server = storageActivityHelper({
    token,
    authorize: async () => "approved",
    inspect: async () => {
      reads++;
      return { available: true, busy: false, openFiles: false };
    },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const socket = connect(address.port, "127.0.0.1");
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(Error("Body deadline missing")),
        7000,
      );
      socket.on("error", () => {});
      socket.on("close", () => {
        clearTimeout(timeout);
        resolve();
      });
      socket.on("connect", () =>
        socket.write(
          `POST /activity HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer ${token}\r\nContent-Length: 1000\r\n\r\n{`,
        ),
      );
    });
    assert.equal(reads, 0);
  } finally {
    socket.destroy();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("real open files with escaped or Unicode ancestor names are held before inspection", async () => {
  const { mkdtemp, mkdir, open, rm } = await import("node:fs/promises");
  const { inspectStorageActivity } =
    await import("../modules/workflows/storage-activity-helper.js");
  const root = await mkdtemp(homedir() + "/.storage-path-test-");
  try {
    for (const character of ["\t", "\n", "\\", "é", "树"]) {
      const checkout = root + "/project" + character;
      const path = checkout + "/.next/cache/webpack";
      await mkdir(path, { recursive: true });
      const handle = await open(path + "/fixture", "w+");
      try {
        await assert.rejects(
          inspectStorageActivity(
            { operationId: randomUUID(), path, checkout },
            new AbortController().signal,
          ),
          /losslessly/,
        );
      } finally {
        await handle.close();
      }
    }
  } finally {
    await rm(root, { recursive: true });
  }
});

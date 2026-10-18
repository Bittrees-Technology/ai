import { createServer, type Server } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import {
  MyCloudOperationJournal,
  myCloudOperationIdSchema,
} from "./mycloud-operation-journal.js";
/** A single typed operation, never a network proxy or command runner. */
export function myCloudHelper(options: {
  token: string;
  journalPath: string;
  authorize: () => Promise<string | null>;
  check: (signal: AbortSignal) => Promise<string>;
  now?: () => number;
}) {
  if (!/^[a-f0-9]{64}$/.test(options.token))
    throw Error("Invalid helper credential");
  const now = options.now ?? Date.now;
  const journal = new MyCloudOperationJournal(options.journalPath);
  let active = false;
  const receipts = new Map<string, string>();
  const controllers = new Set<AbortController>();
  const server = createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Type", "application/json");
    const deny = (code: number) => {
      res.writeHead(code);
      res.end(
        JSON.stringify({ error: "MyCloud health operation unavailable" }),
      );
    };
    const actual = Buffer.from(req.headers.authorization ?? ""),
      expected = Buffer.from("Bearer " + options.token);
    if (
      req.socket.remoteAddress !== "127.0.0.1" ||
      req.method !== "POST" ||
      req.url !== "/health" ||
      req.headers.origin ||
      actual.length !== expected.length ||
      !timingSafeEqual(actual, expected)
    ) {
      deny(403);
      return;
    }
    let operationId: string;
    try {
      let body = "";
      for await (const chunk of req) {
        body += chunk.toString();
        if (body.length > 256) throw Error();
      }
      operationId = z
        .strictObject({ operationId: myCloudOperationIdSchema })
        .parse(JSON.parse(body)).operationId;
    } catch {
      deny(400);
      return;
    }
    const controller = new AbortController();
    const cancel = () => {
      if (!res.writableEnded) controller.abort();
    };
    res.on("close", cancel);
    try {
      const revision = await options.authorize();
      if (!revision || !/^[a-f0-9]{64}$/.test(revision)) {
        deny(403);
        return;
      }
      const prior = journal.get(operationId),
        cached = receipts.get(operationId);
      if (prior) {
        if (cached && journal.matchesCached(operationId, revision, cached))
          res.end(JSON.stringify({ operationId, raw: cached }));
        else deny(409);
        return;
      }
      if (active) {
        deny(429);
        return;
      }
      try {
        journal.reserve(operationId, revision, now());
      } catch {
        deny(429);
        return;
      }
      active = true;
      controllers.add(controller);
      try {
        const sourceSignal = AbortSignal.any([
          controller.signal,
          AbortSignal.timeout(20000),
        ]);
        const raw = await options.check(sourceSignal);
        if (Buffer.byteLength(raw) > 32768)
          throw Error("Oversized health response");
        sourceSignal.throwIfAborted();
        if ((await options.authorize()) !== revision)
          throw Error("Source approval revision changed");
        sourceSignal.throwIfAborted();
        journal.confirm(operationId, revision, raw);
        receipts.set(operationId, raw);
        // Response cache only; authoritative accepted evidence remains in the encrypted source store.
        while (receipts.size > 48)
          receipts.delete(receipts.keys().next().value!);
        res.end(JSON.stringify({ operationId, raw }));
      } catch (error) {
        try {
          journal.uncertain(operationId, revision);
        } catch {}
        throw error;
      } finally {
        active = false;
        controllers.delete(controller);
      }
    } catch {
      if (!res.destroyed) deny(503);
    } finally {
      res.off("close", cancel);
    }
  });
  server.requestTimeout = 25000;
  server.headersTimeout = 5000;
  server.maxConnections = 4;
  return {
    server,
    close: async () => {
      for (const c of controllers) c.abort();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      journal.close();
    },
  };
}
export async function helperMyCloudCheck(
  endpoint: string,
  token: string,
  signal: AbortSignal,
  operationId: string,
) {
  const u = new URL(endpoint);
  if (
    u.protocol !== "http:" ||
    u.hostname !== "127.0.0.1" ||
    !u.port ||
    u.pathname !== "/" ||
    u.username ||
    u.password ||
    u.search ||
    u.hash ||
    !/^[a-f0-9]{64}$/.test(token)
  )
    throw Error("Invalid fixed helper endpoint");
  myCloudOperationIdSchema.parse(operationId);
  const response = await fetch(new URL("/health", u), {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.any([signal, AbortSignal.timeout(25000)]),
    headers: {
      authorization: "Bearer " + token,
      "content-type": "application/json",
    },
    body: JSON.stringify({ operationId }),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw Error("MyCloud helper did not confirm operation");
  }
  if (!response.body) throw Error("No helper receipt");
  const reader = response.body.getReader();
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const r = await reader.read();
      if (r.done) break;
      size += r.value.length;
      if (size > 65536) throw Error("Helper response too large");
      chunks.push(r.value);
    }
  } finally {
    await reader.cancel();
  }
  return z
    .strictObject({
      operationId: z.literal(operationId),
      raw: z.string().max(32768),
    })
    .parse(JSON.parse(Buffer.concat(chunks).toString())).raw;
}

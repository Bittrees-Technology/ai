import { createServer, type Server } from "node:http";
import { timingSafeEqual, randomUUID } from "node:crypto";
import { z } from "zod";
/** A single typed operation, never a network proxy or command runner. */
export function myCloudHelper(options: {
  token: string;
  authorize: () => Promise<boolean>;
  check: (signal: AbortSignal) => Promise<string>;
  now?: () => number;
}) {
  if (!/^[a-f0-9]{64}$/.test(options.token))
    throw Error("Invalid helper credential");
  const now = options.now ?? Date.now;
  let active = false,
    last = -Infinity;
  const receipts = new Map<string, string>();
  const seen = new Set<string>();
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
        .strictObject({ operationId: z.uuid() })
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
      if (!(await options.authorize())) {
        deny(403);
        return;
      }
      const prior = receipts.get(operationId);
      if (prior) {
        res.end(JSON.stringify({ operationId, raw: prior }));
        return;
      }
      if (active || now() - last < 60000 || seen.size >= 10000) {
        deny(429);
        return;
      }
      // Failed/uncertain operation IDs cannot be blindly retried.
      if (seen.has(operationId)) {
        deny(409);
        return;
      }
      active = true;
      last = now();
      seen.add(operationId);
      receipts.set(operationId, "");
      controllers.add(controller);
      try {
        const raw = await options.check(
          AbortSignal.any([controller.signal, AbortSignal.timeout(20000)]),
        );
        if (Buffer.byteLength(raw) > 32768)
          throw Error("Oversized health response");
        controller.signal.throwIfAborted();
        if (!(await options.authorize())) throw Error("Source revoked");
        receipts.set(operationId, raw);
        // Response cache only; authoritative accepted evidence remains in the encrypted source store.
        while (receipts.size > 48)
          receipts.delete(receipts.keys().next().value!);
        res.end(JSON.stringify({ operationId, raw }));
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
    },
  };
}
export async function helperMyCloudCheck(
  endpoint: string,
  token: string,
  signal: AbortSignal,
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
  const operationId = randomUUID();
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

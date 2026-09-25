import { readFile } from "node:fs/promises";
import { createServer } from "node:https";
import { isIP } from "node:net";
import { resolve } from "node:path";
import type { Pool } from "pg";
import { z } from "zod";
import { createRemoteApp } from "../../modules/remote/http.js";
import { privateRelayPolicySchema } from "../../modules/remote/private-relay-contracts.js";

const count = z.number().int().min(1).max(10000);
export const remoteServerConfigSchema = z.strictObject({
  listenHost: z.string().refine((value) => isIP(value) !== 0),
  listenPort: z.number().int().min(1).max(65535),
  origin: z
    .string()
    .max(2048)
    .refine((value) => {
      try {
        const url = new URL(value);
        return url.protocol === "https:" && url.origin === value;
      } catch {
        return false;
      }
    }),
  chainId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  sessionMs: z.number().int().min(60000).max(86400000),
  deviceMs: z
    .number()
    .int()
    .min(60000)
    .max(30 * 86400000),
  tlsKeyFile: z.string().min(1).max(4096),
  tlsCertFile: z.string().min(1).max(4096),
  requestsPerMinute: z.number().int().min(1).max(1000),
  quotas: z.strictObject({
    pendingPairings: count,
    devicesPerOwner: count,
    statusesPerDevice: count,
  }),
  templateQuotas: z.strictObject({
    permissionsPerDevice: count,
    commandsPerDevice: count,
    pendingPerDevice: z.number().int().min(1).max(1000),
  }),
  privateRelay: privateRelayPolicySchema
    .pick({ maxMessagesPerOwner: true, maxBytesPerOwner: true })
    .optional(),
  mcpClientCredentialHash: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
});

/** Construct direct TLS only. The caller owns listening, PostgreSQL and shutdown. */
export async function createRemoteServer(pool: Pool, raw: unknown) {
  const config = remoteServerConfigSchema.parse(raw);
  const assets = resolve("dist/remote-web");
  const [key, cert] = await Promise.all([
    readFile(config.tlsKeyFile),
    readFile(config.tlsCertFile),
    readFile(resolve(assets, "index.html")),
  ]);
  const app = createRemoteApp(pool, {
    ...config,
    assets,
    retentionMs: 90 * 86400000,
    ...(config.privateRelay
      ? {
          privateRelayPolicy: {
            version: 1,
            origin: config.origin,
            chainId: config.chainId,
            receivedContent: "delete-after-receipt",
            unreceivedContent: { mode: "until-deleted" },
            operationalMetadataMs: 90 * 86400000,
            ...config.privateRelay,
          },
        }
      : {}),
  });
  const server = createServer({ key, cert, minVersion: "TLSv1.2" }, app);
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 5000;
  server.maxHeadersCount = 64;
  server.maxConnections = 512;
  return { server, config };
}

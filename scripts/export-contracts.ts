import {
  remoteControlSchema,
  remoteTemplateSchema,
  remoteReceiptSchema,
  statusBatchSchema,
} from "../modules/remote/status.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { schemas, contractVersion } from "../modules/contracts/index.js";
mkdirSync("contracts", { recursive: true });
const jsonSchemas = Object.fromEntries(
  Object.entries({
    ...schemas,
    remoteControl: remoteControlSchema,
    remoteTemplate: remoteTemplateSchema,
    remoteReceipt: remoteReceiptSchema,
    remoteStatusBatch: statusBatchSchema,
  }).map(([key, schema]) => [key, z.toJSONSchema(schema)]),
);
writeFileSync(
  "contracts/schemas.json",
  JSON.stringify({ contractVersion, schemas: jsonSchemas }, null, 2) + "\n",
);
// Endpoint shapes reserved by v1; implemented operations are listed in README.
const operation = (schema: string, code: string) => ({
  security: [{ localBearer: [] }],
  requestBody: {
    required: true,
    content: {
      "application/json": {
        schema: { $ref: `#/components/schemas/${schema}` },
      },
    },
  },
  responses: {
    [code]: { description: "Accepted" },
    "400": { description: "Invalid input" },
    "401": { description: "Authentication required" },
    "403": { description: "Denied" },
    "409": { description: "Conflicting revision or idempotency key" },
  },
});
writeFileSync(
  "contracts/openapi.json",
  JSON.stringify(
    {
      openapi: "3.1.0",
      info: { title: "Bittrees AI local API", version: contractVersion },
      paths: {
        "/v1/requests": { post: operation("request", "202") },
        "/v1/requests/{id}/commands": {
          parameters: [
            {
              name: "id",
              in: "path",
              required: true,
              schema: { type: "string" },
            },
          ],
          post: operation("command", "200"),
        },
        "/v1/messages": { post: operation("message", "201") },
      },
      components: {
        schemas: jsonSchemas,
        securitySchemes: { localBearer: { type: "http", scheme: "bearer" } },
      },
    },
    null,
    2,
  ) + "\n",
);

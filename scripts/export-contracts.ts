import { mcpActorSchema, mcpDelegationRequestSchema, mcpDelegationApprovalSchema, mcpDelegationRedeemSchema, mcpDispatchSchema } from "../modules/remote/mcp-delegation-contracts.js";
import {
  taskQuestionViewSchema,
  taskAnswerInputSchema,
  taskAnswerReceiptSchema,
} from "../modules/contracts/task-answer.js";
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
    taskQuestion: taskQuestionViewSchema,
    taskAnswer: taskAnswerInputSchema,
    taskAnswerReceipt: taskAnswerReceiptSchema,
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
        "/v1/messages/{id}/task-question": {
          parameters: [
            {
              name: "id",
              in: "path",
              required: true,
              schema: { type: "string", format: "uuid" },
            },
          ],
          get: {
            security: [{ localBearer: [] }],
            responses: {
              "200": {
                description: "Current owner-authorized question",
                content: {
                  "application/json": {
                    schema: { $ref: "#/components/schemas/taskQuestion" },
                  },
                },
              },
              "401": { description: "Authentication required" },
              "403": { description: "Source access denied" },
              "404": { description: "Question or local reference unavailable" },
              "409": { description: "Task changed during access validation" },
            },
          },
        },
        "/v1/messages/{id}/task-answer": {
          parameters: [
            {
              name: "id",
              in: "path",
              required: true,
              schema: { type: "string", format: "uuid" },
            },
            {
              name: "Idempotency-Key",
              in: "header",
              required: true,
              schema: { type: "string", format: "uuid" },
            },
          ],
          post: {
            ...operation("taskAnswer", "200"),
            responses: {
              ...operation("taskAnswer", "200").responses,
              "200": {
                description: "Saved answer receipt or exact original duplicate",
                content: {
                  "application/json": {
                    schema: { $ref: "#/components/schemas/taskAnswerReceipt" },
                  },
                },
              },
              "404": { description: "Question or local reference unavailable" },
            },
          },
        },
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

// The remote MCP contract has separate credentials from the local companion API.
writeFileSync("contracts/mcp-delegation-v1.json", JSON.stringify({
  contractVersion: 1,
  origin: "https://ai.bittrees.org",
  clientId: "bittrees-mcp",
  authentication: {
    clientHeader: "X-Bittrees-Mcp-Client",
    dispatch: "Confidential client header plus independently approved delegation bearer",
    browser: "Verified owner session, same Origin and displayed-account binding; never service or device credentials",
  },
  routes: {
    "/mcp/delegations/begin": { request: "request", authority: "client" },
    "/mcp/delegations/redeem": { request: "redeem", authority: "client" },
    "/mcp/templates/dispatch": { request: "dispatch", authority: "client-and-delegation" },
    "/mcp/templates/receipt": { request: "dispatch", authority: "client-and-delegation" },
    "/browser/mcp/approve": { request: "approval", authority: "verified-owner" },
  },
  schemas: Object.fromEntries(Object.entries({ actor: mcpActorSchema, request: mcpDelegationRequestSchema,
    approval: mcpDelegationApprovalSchema, redeem: mcpDelegationRedeemSchema, dispatch: mcpDispatchSchema,
  }).map(([name, schema]) => [name, z.toJSONSchema(schema)])),
}, null, 2) + "\n");

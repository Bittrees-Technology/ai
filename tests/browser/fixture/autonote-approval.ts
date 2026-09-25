import React from "react";
import { createRoot } from "react-dom/client";
import { AutoNoteApprovalPanel } from "../../../apps/dashboard/autonote-approval.js";
import "../../../apps/dashboard/style.css";
const main = document.createElement("main");
main.className = "content";
document.body.append(main);
const api = async (
  path: string,
  method = "GET",
  body?: unknown,
  headers?: Record<string, string>,
) => {
  const reply = await fetch(path, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!reply.ok) throw Error("Request failed");
  return reply.status === 204 ? null : reply.json();
};
createRoot(main).render(React.createElement(AutoNoteApprovalPanel, { api }));

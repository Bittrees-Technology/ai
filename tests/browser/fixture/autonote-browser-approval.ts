import React from "react";
import { createRoot } from "react-dom/client";
import { AutoNoteBrowserApproval } from "../../../apps/dashboard/autonote-browser-approval.js";
import "../../../apps/dashboard/style.css";
const main = document.createElement("main");
main.className = "content";
document.body.append(main);
const api = async (path: string, method = "GET", body?: unknown) => {
  const reply = await fetch(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!reply.ok) throw Error("Request failed");
  return reply.json();
};
createRoot(main).render(
  React.createElement(AutoNoteBrowserApproval, {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    expiresAt: new Date(Date.now() + 600000).toISOString(),
    api,
  }),
);

import React from "react";
import { createRoot } from "react-dom/client";
import { Inbox } from "../../../apps/dashboard/inbox.js";
import "../../../apps/dashboard/style.css";
const main = document.createElement("main");
main.style.cssText = "max-width:1100px;margin:auto;padding:20px";
document.body.replaceChildren(main);
const api = async (
  path: string,
  method = "GET",
  body?: unknown,
  headers?: Record<string, string>,
) => {
  const response = await fetch(path, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw Error("UNAVAILABLE");
  return response.json();
};
createRoot(main).render(React.createElement(Inbox, { api, onError: () => {} }));

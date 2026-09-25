import React, { useState } from "react";
import { MemoryAppScope } from "../../../apps/dashboard/app-memory.js";
import { createRoot } from "react-dom/client";
import { CrmDrafts } from "../../../apps/dashboard/crm-drafts.js";
import { AutoNoteDrafts } from "../../../apps/dashboard/autonote-drafts.js";
import { MailConnection } from "../../../apps/dashboard/mail-connection.js";
import "../../../apps/dashboard/style.css";
const main = document.createElement("main");
main.style.cssText = "max-width:1000px;margin:auto;padding:20px";
document.body.replaceChildren(main);
const api = async (
  path: string,
  method = "GET",
  body?: unknown,
  headers?: Record<string, string>,
) => {
  const r = await fetch(path, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!r.ok) throw Error("UNAVAILABLE");
  return r.json();
};
const source = new URLSearchParams(location.search).get("source");
const component =
  source === "crm"
    ? CrmDrafts
    : source === "autonote"
      ? AutoNoteDrafts
      : MailConnection;
function Fixture() {
  const [item, setItem] = useState({
    id: "memory-reference",
    revision: 1,
    text: "Keep the planning summary concise.",
    state: "approved",
    useApps: ["local"],
  });
  return React.createElement(
    React.Fragment,
    null,
    React.createElement(MemoryAppScope, {
      key: item.revision,
      item,
      api,
      disabled: false,
      onSaved: async () => {
        const data = await api("/v1/memories");
        setItem(data.items[0]);
      },
    }),
    React.createElement(component, {
      api,
      onError: () => {},
      onCreated: () => {},
      profiles: [{ id: "local", model: "synthetic:local" }],
    }),
  );
}
createRoot(main).render(React.createElement(Fixture));

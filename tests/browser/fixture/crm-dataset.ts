import React from "react";
import { createRoot } from "react-dom/client";
import { CrmDatasetPanel } from "../../../apps/dashboard/crm-dataset.js";
import "../../../apps/dashboard/style.css";
const root = document.createElement("main");
root.style.cssText = "max-width:1000px;margin:auto;padding:20px";
document.body.replaceChildren(root);
createRoot(root).render(
  React.createElement(CrmDatasetPanel, {
    api: async (path: string, method = "GET", body?: unknown) => {
      const r = await fetch(path, {
        method,
        headers: { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (!r.ok) throw Error("SOURCE_DENIED");
      return r.json();
    },
    onError: (e: unknown) => {
      const p = document.createElement("p");
      p.setAttribute("role", "alert");
      p.textContent = String(e);
      root.append(p);
    },
  }),
);

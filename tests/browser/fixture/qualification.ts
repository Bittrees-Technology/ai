import React from "react";
import { createRoot } from "react-dom/client";
import { QualificationPanel } from "../../../apps/dashboard/qualification.js";
import "../../../apps/dashboard/style.css";
const root = document.createElement("main");
root.style.cssText = "max-width:1000px;margin:auto;padding:20px";
document.body.replaceChildren(root);
createRoot(root).render(
  React.createElement(QualificationPanel, {
    profiles: [{ id: "local-model", model: "Synthetic local model" }],
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

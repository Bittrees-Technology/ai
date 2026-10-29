import React from "react";
import { createRoot } from "react-dom/client";
import { Workflows } from "../../../apps/dashboard/workflows.js";
import "../../../apps/dashboard/style.css";
const root = document.createElement("main");
root.style.cssText = "max-width:1000px;margin:auto;padding:20px";
document.body.replaceChildren(root);
createRoot(root).render(
  React.createElement(Workflows, {
    api: async (path: string, method = "GET", body?: unknown) => {
      const r = await fetch(path, {
        method,
        headers: { "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (!r.ok) throw Error("Unavailable");
      return r.json();
    },
  }),
);

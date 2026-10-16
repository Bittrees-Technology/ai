import React from "react";
import { createRoot } from "react-dom/client";
import { createLocalApi } from "../../../apps/dashboard/local-api.js";
import { ProjectWorkPanel } from "../../../apps/dashboard/project-work.js";
import "../../../apps/dashboard/style.css";
const root = document.createElement("main");
root.style.cssText = "max-width:1000px;margin:auto;padding:20px";
document.body.replaceChildren(root);
createRoot(root).render(
  React.createElement(ProjectWorkPanel, {
    profiles: [{ id: "local-test", model: "Local test model" }],
    api: createLocalApi(),
    onError: (e: unknown) => {
      const p = document.createElement("p");
      p.setAttribute("role", "alert");
      p.textContent = String(e);
      root.append(p);
    },
  }),
);

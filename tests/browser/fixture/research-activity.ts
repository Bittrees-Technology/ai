import React from "react";
import { createRoot } from "react-dom/client";
import { ResearchActivity } from "../../../apps/dashboard/research-activity.js";
import "../../../apps/dashboard/style.css";
const root = document.createElement("main");
root.style.cssText = "max-width:1000px;margin:auto;padding:20px";
document.body.replaceChildren(root);
createRoot(root).render(
  React.createElement(ResearchActivity, {
    api: async (path: string) => {
      const r = await fetch(path);
      if (!r.ok) throw Error("Unavailable");
      return r.json();
    },
    onConnections: () => {},
  }),
);

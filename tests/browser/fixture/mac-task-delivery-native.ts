import React from "react";
import { createRoot } from "react-dom/client";
import { PrivateRelayPanel } from "../../../apps/dashboard/private-relay.js";
import "../../../apps/dashboard/style.css";
const api = (window as any).nativeTaskApi;
if (typeof api !== "function")
  throw Error("Synthetic native API bridge missing");
const main = document.createElement("main");
main.style.cssText = "max-width:1000px;margin:auto;padding:20px;";
document.body.replaceChildren(main);
createRoot(main).render(React.createElement(PrivateRelayPanel, { api }));

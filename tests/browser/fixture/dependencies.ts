import React from "react";
import { createRoot } from "react-dom/client";
import { DependencyFailureNotice } from "../../../apps/dashboard/dependency-failure.js";
import "../../../apps/dashboard/style.css";
const main = document.createElement("main");
main.className = "content";
document.body.replaceChildren(main);
createRoot(main).render(
  React.createElement(DependencyFailureNotice, {
    result: {
      kind: "dependency_failure",
      prerequisites: [
        { taskId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", status: "failed" },
        { taskId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", status: "cancelled" },
        { taskId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", status: "expired" },
      ],
    },
  }),
);

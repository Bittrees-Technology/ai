import { SourceMemoryCapture } from "../../../apps/dashboard/source-memory-capture.js";
import React from "react";
import { createRoot } from "react-dom/client";
import { AutoNoteReviewControls } from "../../../apps/dashboard/autonote-reviews.js";
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
  React.createElement(
    React.Fragment,
    null,
    React.createElement(SourceMemoryCapture, {
      taskId: "synthetic-task",
      sourceApp: "autonote",
      api,
    }),
    React.createElement(AutoNoteReviewControls, {
      id: "synthetic-task",
      api,
      onError: () => {
        throw Error("Unexpected fixture error");
      },
    }),
  ),
);

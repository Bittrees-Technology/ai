import React from "react";
import type {
  ConversationDirections,
  ConversationChoices,
} from "./conversation-permission-state.js";
export const conversationDirections: [keyof ConversationDirections, string][] =
  [
    ["messagesToMac", "Messages from this browser to the Mac"],
    ["messagesToBrowser", "Messages from the Mac to this browser"],
    ["questionsToBrowser", "Task questions from the Mac to this browser"],
    ["answersToMac", "Reviewed answers from this browser to the Mac"],
  ];
export function ConversationChoicesView({
  choices,
}: {
  choices: ConversationChoices;
}) {
  return (
    <ul>
      {conversationDirections.map(([key, label]) => (
        <li key={key}>
          {label}:{" "}
          <strong>{choices.permissions[key] ? "Allowed" : "Off"}</strong>
        </li>
      ))}
    </ul>
  );
}

import { mountBrowserAutoNoteApprovals } from "../../../apps/remote-web/browser-autonote-approvals.js";
import "../../../apps/remote-web/browser-keys.css";
const root = document.createElement("main");
document.body.append(root);
let generation = 0;
const call = async (name: string, raw?: unknown) => {
  const response = await fetch("/approval-test/" + name, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(raw ?? {}),
  });
  if (!response.ok) throw Error("Synthetic failure");
  return response.json();
};
mountBrowserAutoNoteApprovals(root, {
  session: () => ({
    ownerId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    scope: "synthetic",
  }),
  keyContext: () =>
    ({ binding: { deviceId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" } }) as any,
  reviewVersion: () => generation,
  autoNoteApprovalAPI: {
    status: () => call("status"),
    inspect: (raw) => call("inspect", raw),
    receive: (raw) => call("receive", raw),
    reveal: (raw) => call("reveal", raw),
    export: (raw) => call("export", raw),
    remove: (raw) => call("remove", raw),
    invalidate: () => {
      generation++;
    },
  },
});

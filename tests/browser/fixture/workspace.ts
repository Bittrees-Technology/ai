// The actual local dashboard, driven only by synthetic routed HTTP in CI.
const root = document.createElement("div");
root.id = "root";
document.body.replaceChildren(root);
await import("../../../apps/dashboard/main.js");

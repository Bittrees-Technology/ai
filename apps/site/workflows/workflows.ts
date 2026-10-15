type Provider = {
  request: (args: { method: string; params?: unknown[] }) => Promise<any>;
  on?: (event: string, fn: () => void) => void;
};
type Wallet = { name: string; provider: Provider };
const root = document.querySelector("#workflows")!;
let wallets: Wallet[] = [],
  selected: Provider | undefined,
  wallet = "",
  busy = false,
  notice = "",
  error = "",
  grants: any[] = [],
  pending: any = null,
  pairCode = "",
  duration = "until-revoked",
  pairGrant: any = null;
const el = (tag: string, text = "", className = "") => {
  const e = document.createElement(tag);
  e.textContent = text;
  if (className) e.className = className;
  return e;
};
const time = (v: any) => (v ? new Date(v).toLocaleString() : "Not yet");
async function api(action: string, input?: unknown) {
  const r = await fetch("/api/workflows", {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action, input }),
    signal: AbortSignal.timeout(20000),
  });
  const data = await r.json();
  if (!r.ok) throw Error(data.error || "REQUEST_REJECTED");
  return data;
}
const messages: Record<string, string> = {
  SIGN_IN_REQUIRED: "Connect your wallet and sign in to view your workflows.",
  PERMISSIONS_CHANGED:
    "The permissions changed. Refresh and review a new approval.",
  CHALLENGE_EXPIRED: "This signature request expired. Start again.",
  PAIRING_EXPIRED:
    "The pairing code expired or was already used. Create a new one in the Mac app.",
  INVALID_SIGNATURE: "The signature did not match the selected wallet.",
  RATE_LIMITED: "Too many requests. Please try again in a few minutes.",
};
async function act(fn: () => Promise<void>) {
  if (busy) return;
  busy = true;
  error = "";
  render();
  try {
    await fn();
  } catch (e) {
    error =
      messages[(e as Error).message] ||
      "The request did not finish. Refresh to check its status before trying again.";
  } finally {
    busy = false;
    render();
  }
}
function button(text: string, fn: () => Promise<void>, className = "") {
  const b = el("button", text, className) as HTMLButtonElement;
  b.type = "button";
  b.disabled = busy;
  b.onclick = () => void act(fn);
  return b;
}
async function refresh() {
  const v = await api("list");
  wallet = v.wallet;
  grants = v.grants;
}
async function sign(message: string) {
  if (!selected) throw Error("SIGN_IN_REQUIRED");
  const accounts = await selected.request({ method: "eth_requestAccounts" });
  if (accounts[0]?.toLowerCase() !== wallet) throw Error("SIGN_IN_REQUIRED");
  const bytes = new TextEncoder().encode(message);
  return selected.request({
    method: "personal_sign",
    params: [
      "0x" + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(""),
      accounts[0],
    ],
  });
}
async function login(provider: Provider) {
  selected = provider;
  const accounts = await provider.request({ method: "eth_requestAccounts" });
  wallet = accounts[0]?.toLowerCase();
  const c = await api("challenge", { action: "login", wallet });
  const signature = await sign(c.message);
  await api("verify", { id: c.id, signature });
  provider.on?.("accountsChanged", () => {
    wallet = "";
    grants = [];
    pending = null;
    render();
  });
  provider.on?.("disconnect", () => {
    wallet = "";
    grants = [];
    pending = null;
    render();
  });
  await refresh();
}
async function approve(g: any, code?: string) {
  const c = await api("challenge", {
    action: "approve",
    wallet,
    authorityId: g.id,
    duration,
    ...(code ? { pairCode: code } : {}),
  });
  pending = { ...c, grant: g };
  notice = "Review the exact approval below, then sign with your wallet.";
}
function state(g: any) {
  if (g.revoked_at) return "Revoked";
  if (g.require_wallet && !g.signed_at) return "Awaiting wallet approval";
  if (
    g.approval_expires_at &&
    new Date(g.approval_expires_at).getTime() <= Date.now()
  )
    return "Approval expired";
  if (g.paused_at) return "Paused";
  return g.signed_at
    ? "Wallet approved"
    : "Operator configured — not wallet signed";
}
function grantView(g: any, code?: string) {
  const panel = el("section", "", "workflow-panel");
  panel.append(
    el("h2", g.device_label || "Your Mac"),
    el("p", state(g), "workflow-state"),
  );
  const dl = el("dl", "", "workflow-meta");
  for (const [label, value] of [
    ["Device ID", g.device_id || "Not registered"],
    ["Engine", g.model_label],
    ["Last connected", time(g.last_seen_at)],
    ["Approved", time(g.signed_at)],
    [
      "Permission ends",
      g.signed_at
        ? g.approval_expires_at
          ? time(g.approval_expires_at)
          : "Until revoked"
        : "Not approved",
    ],
  ]) {
    dl.append(el("dt", label), el("dd", value));
  }
  panel.append(dl);
  const scopes = g.scopes || [];
  panel.append(el("h3", "Allowed actions"));
  const ul = el("ul");
  const labels: Record<string, string> = {
    "mercado:publish:qualified":
      "Publish qualifying Mercado products; hold exceptions",
    "crm:import:qualified":
      "Import vendor organizations and follow-up tasks into the connected CRM workspace",
    "mcp:sources:propose": "Prepare product and vendor proposals",
    "mcp:sources:execute": "Coordinate approved actions through MCP Connect",
    "sync:sync": "Share workflow progress with your account",
    "crm:propose": "Prepare CRM records for validation",
    "mercado:propose": "Prepare Mercado products for validation",
  };
  for (const scope of scopes) ul.append(el("li", labels[scope] || scope));
  if (!scopes.length)
    ul.append(
      el(
        "li",
        "No app permissions connected. Pairing this device does not give it access to Mercado or CRM.",
      ),
    );
  panel.append(
    ul,
    el(
      "p",
      "Supplier workflow: every six hours, up to 20 offers per run. No spending, wallet transactions or outreach.",
      "workflow-small",
    ),
  );
  if (!g.revoked_at) {
    const actions = el("div", "", "workflow-actions");
    const label = el("label", "Approval duration");
    const select = el("select") as HTMLSelectElement;
    for (const [value, text] of [
      ["day", "One day"],
      ["month", "30 days"],
      ["until-revoked", "Until I revoke it"],
    ]) {
      const o = el("option", text) as HTMLOptionElement;
      o.value = value!;
      o.selected = value === duration;
      select.append(o);
    }
    select.onchange = () => {
      duration = select.value;
    };
    label.append(select);
    actions.append(
      label,
      button(
        g.paused_at && g.signed_at
          ? "Review & sign to resume"
          : "Review wallet approval",
        () => approve(g, code),
        "primary",
      ),
    );
    if (!code) {
      actions.append(
        button("Pause", async () => {
          await api("control", { action: "pause", authorityId: g.id });
          notice =
            "Paused. New actions are blocked; already accepted work may finish.";
          await refresh();
        }),
        button(
          "Revoke",
          async () => {
            if (
              !confirm(
                "Revoke this workflow permanently? A new connection will be needed to grant access again.",
              )
            )
              return;
            await api("control", { action: "revoke", authorityId: g.id });
            notice = "Revoked. Future actions are blocked.";
            await refresh();
          },
          "danger",
        ),
      );
    }
    panel.append(actions);
  }
  const exceptions = (g.runs || []).flatMap((r: any) =>
    (r.outcomes || [])
      .filter(
        (o: any) =>
          o.held ||
          o.decision === "changes_requested" ||
          o.state === "awaiting_review",
      )
      .map((o: any) => ({ ...o, at: r.updated_at })),
  );
  panel.append(el("h3", `Exceptions & reviews (${exceptions.length})`));
  if (!exceptions.length) panel.append(el("p", "No held items reported."));
  for (const o of exceptions) {
    const p = el(
      "p",
      `${o.source === "mercado" ? "Mercado" : "CRM"} · ${o.reason || "Awaiting review"} `,
    );
    const a = el("a", "Open review queue") as HTMLAnchorElement;
    a.href =
      o.source === "mercado"
        ? "https://mercado.bittrees.org/admin/submissions"
        : "https://crm.bittrees.org/connect/ai/leads";
    p.append(a);
    panel.append(p);
  }
  const details = el("details");
  details.append(el("summary", "Activity"));
  for (const r of g.runs || []) {
    const p = el(
      "p",
      `${time(r.updated_at)} — ` +
        Object.entries(r.counts)
          .map(([k, v]) => `${k.replace(":", " ")}: ${v}`)
          .join(", "),
    );
    details.append(p);
  }
  for (const a of g.activity || [])
    details.append(el("p", `${time(a.created_at)} — ${a.action}`));
  if (!(g.runs?.length || g.activity?.length))
    details.append(el("p", "No activity yet."));
  panel.append(details);
  return panel;
}
function render() {
  root.replaceChildren();
  if (error) root.append(el("p", error, "workflow-notice workflow-error"));
  if (notice) root.append(el("p", notice, "workflow-notice"));
  if (!wallet) {
    root.append(
      el("h2", "Connect your wallet"),
      el(
        "p",
        "Use your own Ethereum wallet. A sign-in signature opens your account; a separate approval delegates the workflow.",
      ),
    );
    if (!wallets.length)
      root.append(
        el(
          "p",
          "Open this page in your wallet’s browser or install a browser wallet. Smart-contract wallets and QR pairing are not supported by this initial release.",
        ),
      );
    for (const w of wallets)
      root.append(button(`Sign in with ${w.name}`, () => login(w.provider)));
    return;
  }
  const account = el("div", "", "workflow-actions");
  account.append(
    el("span", wallet, "wallet-line"),
    button("Refresh", refresh),
    button("Sign out", async () => {
      await api("logout");
      wallet = "";
      grants = [];
      pending = null;
      notice = "";
    }),
  );
  root.append(account);
  if (!selected) {
    root.append(
      el(
        "p",
        wallets.length
          ? "Reconnect the wallet below before signing a new approval."
          : "Open this page in a wallet browser or install a browser wallet to sign a new approval.",
      ),
    );
    for (const w of wallets)
      root.append(button(`Connect ${w.name}`, () => login(w.provider)));
  }
  if (pending) {
    const review = el("section", "", "workflow-panel");
    review.append(
      el("h2", "Review your signed approval"),
      el("pre", pending.message),
      button(
        "Sign this approval",
        async () => {
          const p = pending;
          const signature = await sign(p.message);
          await api("verify", { id: p.id, signature });
          pending = null;
          pairGrant = null;
          pairCode = "";
          notice =
            "Wallet approval saved. Only the listed connected permissions are authorized.";
          await refresh();
        },
        "primary",
      ),
      button("Cancel", async () => {
        pending = null;
        notice = "";
      }),
    );
    root.append(review);
  }
  for (const g of grants) root.append(grantView(g));
  if (!grants.length)
    root.append(
      el(
        "p",
        "No devices connected yet. Open Workflows & permissions in your Mac app and create a pairing code.",
      ),
    );
  const pair = el("section", "", "workflow-panel");
  pair.append(
    el("h2", "Connect another Mac"),
    el(
      "p",
      "Each person pairs their own device and approves its permissions with their own wallet. Source apps must separately authorize access.",
    ),
  );
  const label = el("label", "Pairing code from your Mac");
  const input = el("input") as HTMLInputElement;
  input.value = pairCode;
  input.autocomplete = "off";
  input.oninput = () => {
    pairCode = input.value.trim();
  };
  label.append(input);
  pair.append(
    label,
    button("Review this Mac", async () => {
      const v = await api("pair", { pairCode });
      pending = null;
      pairGrant = v.grant;
    }),
  );
  root.append(pair);
  if (pairGrant) root.append(grantView(pairGrant, pairCode));
}
window.addEventListener("eip6963:announceProvider", ((event: CustomEvent) => {
  const d = event.detail;
  if (!wallets.some((w) => w.provider === d.provider)) {
    wallets.push({
      name: String(d.info.name).slice(0, 50),
      provider: d.provider,
    });
    render();
  }
}) as EventListener);
window.dispatchEvent(new Event("eip6963:requestProvider"));
const injected = (window as any).ethereum;
if (injected && !wallets.some((w) => w.provider === injected))
  wallets.push({ name: "browser wallet", provider: injected });
void api("list")
  .then((v) => {
    wallet = v.wallet;
    grants = v.grants;
    render();
  })
  .catch(() => render());
render();

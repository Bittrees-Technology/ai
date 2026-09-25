import type { BrowserKeyHost } from "../../modules/remote/browser-key-host.js";
type Host = Pick<
  BrowserKeyHost,
  "autoNoteApprovalAPI" | "session" | "keyContext" | "reviewVersion"
>;
type Entry = Awaited<ReturnType<Host["autoNoteApprovalAPI"]["status"]>>[number];
type Queue = Awaited<ReturnType<Host["autoNoteApprovalAPI"]["inspect"]>>;
type Cursor = NonNullable<Queue["item"]>["cursor"] | null;
type Review = {
  action: "receive" | "reveal" | "export" | "remove";
  id?: string;
  queue?: Queue;
  after: Cursor;
  at: number;
  mono: number;
  expires: number;
  version: number;
  context: string;
};
export function mountBrowserAutoNoteApprovals(
  root: HTMLElement,
  host: Host,
  now = Date.now,
  mono = () => performance.now(),
  beforeWork = () => {},
) {
  let disposed = false,
    busy = false,
    epoch = 0,
    review: Review | null = null,
    shownUntil = 0,
    shownAt = 0,
    shownMono = 0,
    shownContext = "",
    shownVersion = 0;
  let entries: Entry[] = [],
    queue: Queue | null = null,
    after: Cursor = null;
  const urls = new Set<string>();
  const el = <K extends keyof HTMLElementTagNameMap>(
    tag: K,
    text = "",
    cls = "",
  ) => {
    const node = document.createElement(tag);
    node.textContent = text;
    node.className = cls;
    return node;
  };
  const button = (text: string, fn: () => void) => {
    const b = el("button", text);
    b.type = "button";
    b.onclick = fn;
    return b;
  };
  const box = el("section", "", "browser-keys browser-autonote-approvals"),
    list = el("div"),
    stage = el("div", "", "browser-keys-stage"),
    notes = el("div"),
    notice = el("p"),
    error = el("p", "", "browser-keys-error"),
    actions = el("div", "", "browser-keys-actions");
  box.setAttribute("aria-label", "AutoNote browser review");
  error.setAttribute("role", "alert");
  notice.setAttribute("role", "status");
  const focused = () => document.hasFocus() && !document.hidden;
  const context = () =>
    JSON.stringify([host.session(), host.keyContext()?.binding]);
  function clear(cancelHost = true) {
    const hadWork = busy || !!review || !!queue || shownUntil > 0 || urls.size > 0;
    epoch++;
    review = null;
    queue = null;
    stage.replaceChildren();
    notes.replaceChildren();
    shownUntil = 0;
    for (const url of urls) URL.revokeObjectURL(url);
    urls.clear();
    // An idle sibling panel must not cancel another panel's host review.
    if (cancelHost && hadWork) host.autoNoteApprovalAPI.invalidate();
    controls();
  }
  function controls() {
    for (const b of [
      ...actions.querySelectorAll("button"),
      ...list.querySelectorAll("button"),
    ])
      b.disabled = busy || !!review;
  }
  async function run(fn: (valid: () => boolean) => Promise<void>) {
    if (busy || disposed || !focused()) return;
    busy = true;
    error.textContent = "";
    controls();
    const g = epoch;
    try {
      await fn(() => !disposed && g === epoch && focused());
    } catch {
      if (!disposed && g === epoch) {
        clear();
        error.textContent =
          "The result was not confirmed. Refresh saved offers before retrying. No source save is performed here.";
      }
    } finally {
      busy = false;
      if (!disposed) controls();
    }
  }
  const refresh = button("Refresh encrypted AutoNote offers", () => {
    beforeWork();
    clear();
    void run(async (valid) => {
      const saved = await host.autoNoteApprovalAPI.status();
      if (valid()) {
        entries = saved;
        render();
        notice.textContent = `${saved.length} retained offers.`;
      }
    });
  });
  const inspect = button("Inspect next encrypted item", () => {
    beforeWork();
    clear();
    void run(async (valid) => {
      const found = await host.autoNoteApprovalAPI.inspect({
        after,
        confirmed: true,
      });
      if (!valid()) return;
      queue = found;
      if (!found.item) {
        notice.textContent =
          "No item found after this position. Start from the beginning to check again.";
        return;
      }
      prepare("receive");
    });
  });
  const restart = button("Start queue from beginning", () => {
    clear();
    after = null;
    notice.textContent = "Queue position reset. Inspect to continue.";
  });
  actions.append(refresh, inspect, restart);
  box.append(
    el("h2", "AutoNote notes on this browser"),
    el(
      "p",
      "Receive encrypted parts from your paired Mac, then reveal the complete meeting notes. Approve/reject return controls are still being built; nothing is saved to AutoNote here.",
    ),
    actions,
    notice,
    error,
    list,
    stage,
    notes,
  );
  root.append(box);
  function render() {
    list.replaceChildren();
    for (const entry of entries) {
      const row = el("div"),
        expired = entry.expiresAt <= now();
      row.append(
        el(
          "p",
          `${entry.received} encrypted parts retained. ${expired ? "Offer expired." : "Expires " + new Date(entry.expiresAt).toLocaleString() + "."}`,
        ),
      );
      for (const [action, label] of [
        ["reveal", "Review revealing complete notes"],
        ["export", "Review encrypted export"],
        ["remove", "Review local deletion"],
      ] as const) {
        const b = button(label, () => {
          beforeWork();
          clear();
          prepare(action, entry.offerId);
        });
        if (expired && action === "reveal") b.hidden = true;
        row.append(b);
      }
      list.append(row);
    }
    controls();
  }
  const validReview = (r: Review) =>
    focused() &&
    now() >= r.at &&
    now() < r.expires &&
    mono() >= r.mono &&
    mono() - r.mono < r.expires - r.at &&
    r.version === host.reviewVersion() &&
    r.context === context();
  function prepare(action: Review["action"], id?: string) {
    if (!focused()) return;
    const expires = Math.min(
      now() + 60000,
      action === "receive"
        ? (queue?.item?.expiresAt ?? 0)
        : (entries.find((e) => e.offerId === id)?.expiresAt ?? Infinity),
    );
    review = {
      action,
      id,
      queue: queue ?? undefined,
      after,
      at: now(),
      mono: mono(),
      expires: ["export", "remove"].includes(action) ? now() + 60000 : expires,
      version: host.reviewVersion(),
      context: context(),
    };
    const r = review;
    stage.replaceChildren(
      el(
        "h3",
        {
          receive: "Receive this encrypted part",
          reveal: "Reveal complete meeting notes",
          export: "Export encrypted parts",
          remove: "Delete this local offer",
        }[action],
      ),
      el(
        "p",
        action === "receive"
          ? "Only a valid AutoNote part from your paired Mac is retained. Other encrypted content is left for its own controls."
          : action === "remove"
            ? "Deletes the retained encrypted parts here. The source notes are unchanged. This offer cannot be silently reimported."
            : "This action does not approve notes or save them at the source.",
      ),
    );
    const label = el("label", "", "browser-keys-check"),
      ack = el("input");
    ack.type = "checkbox";
    label.append(
      ack,
      el("span", "I understand and want to perform this action."),
    );
    const confirm = button("Confirm AutoNote action", () => {
      if (!ack.checked || !validReview(r)) {
        clear();
        return;
      }
      void run(async (valid) => {
        review = null;
        stage.replaceChildren();
        if (r.action === "receive") {
          const result = await host.autoNoteApprovalAPI.receive({
            after: r.after,
            selection: r.queue!.item!.selection,
            confirmed: true,
          });
          if (!valid()) return;
          after = r.queue!.item!.cursor;
          notice.textContent = `${result.received.received} of ${result.received.total} parts retained. Refresh saved offers to continue.`;
        } else if (r.action === "reveal") {
          const opened = await host.autoNoteApprovalAPI.reveal({
            offerId: r.id,
            confirmed: true,
          });
          if (!valid()) return;
          shownAt = now();
          shownMono = mono();
          shownUntil = Math.min(now() + 60000, opened.manifest.expiresAt);
          shownContext = context();
          shownVersion = host.reviewVersion();
          notes.append(
            el("h3", opened.detail.title),
            el(
              "p",
              "Audience: " +
                (opened.detail.visibility === "workspace"
                  ? "Workspace"
                  : "Private"),
            ),
            el("h4", "Resulting notes"),
            el("p", opened.detail.notes.summary),
          );
          for (const group of [
            "topics",
            "decisions",
            "actions",
            "questions",
            "recommendations",
          ] as const) {
            notes.append(el("h4", group[0]!.toUpperCase() + group.slice(1)));
            for (const item of opened.detail.notes[group])
              notes.append(
                el("p", item.text),
                el(
                  "p",
                  `Evidence: ${item.evidence.join(", ")}. Status: ${item.status}.${item.owner ? " Owner: " + item.owner : ""}${item.dueDate ? " Due: " + item.dueDate : ""}`,
                ),
              );
            if (!opened.detail.notes[group].length)
              notes.append(el("p", "None"));
          }
          notes.append(button("Hide meeting notes", () => clear()));
        } else if (r.action === "export") {
          const value = await host.autoNoteApprovalAPI.export({
            offerId: r.id,
            confirmed: true,
          });
          if (!valid()) return;
          const url = URL.createObjectURL(
            new Blob([JSON.stringify(value)], { type: "application/json" }),
          );
          urls.add(url);
          const link = el("a", "Download encrypted AutoNote offer");
          link.href = url;
          link.download = "autonote-encrypted-offer.json";
          notes.append(link);
        } else {
          await host.autoNoteApprovalAPI.remove({
            offerId: r.id,
            confirmed: true,
          });
          if (!valid()) return;
          entries = entries.filter((e) => e.offerId !== r.id);
          render();
          notice.textContent = "Local encrypted offer deleted.";
        }
      });
    });
    confirm.disabled = true;
    ack.onchange = () => {
      confirm.disabled = !ack.checked || !validReview(r);
    };
    stage.append(
      label,
      confirm,
      button("Cancel AutoNote action", () => clear()),
    );
    controls();
  }
  const blur = () => clear(),
    hidden = () => {
      if (document.hidden) clear();
    },
    escape = (e: KeyboardEvent) => {
      if (e.key === "Escape") clear();
    },
    outside = (e: PointerEvent) => {
      if (!box.contains(e.target as Node)) clear();
    };
  window.addEventListener("blur", blur);
  document.addEventListener("visibilitychange", hidden);
  window.addEventListener("keydown", escape);
  document.addEventListener("pointerdown", outside);
  const timer = setInterval(() => {
    if (
      (review && !validReview(review)) ||
      (shownUntil &&
        (now() < shownAt ||
          now() >= shownUntil ||
          mono() < shownMono ||
          mono() - shownMono >= shownUntil - shownAt ||
          shownContext !== context() ||
          shownVersion !== host.reviewVersion()))
    )
      clear();
  }, 250);
  return {
    invalidate() {
      clear(false);
    },
    destroy() {
      disposed = true;
      clear();
      clearInterval(timer);
      window.removeEventListener("blur", blur);
      document.removeEventListener("visibilitychange", hidden);
      window.removeEventListener("keydown", escape);
      document.removeEventListener("pointerdown", outside);
      box.remove();
    },
  };
}

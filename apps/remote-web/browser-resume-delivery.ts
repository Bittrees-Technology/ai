import type { BrowserKeyHost } from "../../modules/remote/browser-key-host.js";
type Host = Pick<
  BrowserKeyHost,
  | "resumeAPI"
  | "resumeDeliveryAPI"
  | "relayResumeAPI"
  | "session"
  | "reviewVersion"
>;
type History = Awaited<ReturnType<Host["resumeDeliveryAPI"]["history"]>>;
type Permissions = Awaited<ReturnType<Host["resumeAPI"]["status"]>>;
type Queue = Awaited<ReturnType<Host["relayResumeAPI"]["inspect"]>>;
type Review = {
  action: "prepare" | "send" | "stop" | "receive" | "clear";
  input: Record<string, unknown>;
  snapshot: string;
  started: number;
  mono: number;
  expires: number;
  identity: string;
  version: number;
};
/** Explicit, independently reviewed operations. No background upload or retry. */
export function mountBrowserResumeDelivery(
  root: HTMLElement,
  host: Host,
  now = Date.now,
  monotonic = () => performance.now(),
  closeOthers = () => {},
) {
  let disposed = false,
    busy = false,
    generation = 0;
  let permissions: Permissions | null = null,
    entries: History = [],
    review: Review | null = null;
  let navigation: {
    entry: History[number];
    after: Queue["nextCursor"];
  } | null = null;
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
  const button = (text: string, action: () => void) => {
    const node = el("button", text);
    node.type = "button";
    node.onclick = action;
    return node;
  };
  const box = el("section", "", "browser-keys");
  box.setAttribute("aria-label", "Mac resume requests");
  const notice = el(
    "p",
    "Refresh to choose a saved resume permission.",
    "browser-keys-notice",
  );
  notice.setAttribute("role", "status");
  const error = el("p", "", "browser-keys-error");
  error.setAttribute("role", "alert");
  const actions = el("div", "", "browser-keys-actions");
  const columns = el("div", "", "browser-keys-columns"),
    list = el("div"),
    stage = el("div", "", "browser-keys-stage");
  const choice = el("select"),
    label = el("label", "Saved permission for this task");
  choice.id = `resume-request-${crypto.randomUUID()}`;
  label.htmlFor = choice.id;
  const prepare = button(
    "Review new resume request",
    () => void begin("prepare"),
  );
  const reviewBox = el("div"),
    heading = el("h3"),
    detail = el("p", "", "browser-keys-reference");
  const ackLabel = el("label", "", "browser-keys-check"),
    ack = el("input");
  ack.type = "checkbox";
  ackLabel.append(
    ack,
    el("span", "I reviewed this task, Mac, model, expiry and action."),
  );
  const confirm = button("Confirm reviewed action", () => void submit());
  ack.onchange = () => {
    confirm.disabled = !review || !ack.checked || busy;
  };
  reviewBox.append(
    heading,
    detail,
    ackLabel,
    confirm,
    button("Cancel resume request review", () => invalidate()),
  );
  const nextItem = button("Inspect next relay item", () => {
    const next = navigation;
    if (next) void inspect(next.entry, next.after);
  });
  const refresh = button("Refresh resume requests", () => void load());
  actions.append(
    refresh,
    nextItem,
    button("Export resume request history", () => void exportHistory()),
    button("Review deleting resume requests", () => void begin("clear")),
  );
  stage.append(label, choice, prepare, reviewBox);
  columns.append(list, stage);
  box.append(
    el("h2", "Resume a task on your Mac"),
    el(
      "p",
      "Choose a saved permission, prepare one request, then review sending it. A relay delivery confirmation does not mean your Mac accepted or completed the task.",
    ),
    actions,
    notice,
    error,
    columns,
  );
  root.append(box);
  const identity = () => JSON.stringify(host.session());
  const snapshot = () => JSON.stringify({ permissions, entries });
  const focused = () =>
    document.visibilityState !== "hidden" && document.hasFocus();
  const valid = (r: Review) =>
    !disposed &&
    focused() &&
    identity() === r.identity &&
    host.reviewVersion() === r.version &&
    now() >= r.started &&
    now() < r.expires &&
    monotonic() >= r.mono &&
    monotonic() - r.mono < Math.min(120000, r.expires - r.started);
  const describe = (entry: History[number]) =>
    `Task ${entry.taskId}, version ${entry.taskRevision}. Mac ${entry.peerId}. Model ${entry.modelDigest}. Request ${entry.id}. Permission ${entry.permissionId}. Access ends ${new Date(entry.expiresAt).toLocaleString()}.`;
  function controls() {
    nextItem.hidden = !navigation;
    nextItem.disabled = busy || !navigation;
    reviewBox.hidden = !review;
    confirm.disabled = busy || !review || !ack.checked;
    choice.disabled = busy || !!review;
    prepare.disabled = busy || !!review || !choice.value;
    refresh.disabled = busy;
  }
  function invalidate() {
    generation++;
    review = null;
    ack.checked = false;
    host.resumeDeliveryAPI.invalidate();
    navigation = null;
    controls();
  }
  function render() {
    choice.replaceChildren(el("option", "Choose a permission"));
    choice.options[0]!.value = "";
    for (const grant of permissions?.grants ?? []) {
      if (
        grant.revoked ||
        grant.choices.expiresAt <= now() ||
        entries.some((e) => e.permissionId === grant.choices.permissionId)
      )
        continue;
      const option = el(
        "option",
        `Task ${grant.choices.taskId} on Mac ${grant.choices.peerId}`,
      );
      option.value = grant.id;
      choice.append(option);
    }
    list.replaceChildren(el("h3", "Saved requests"));
    if (!entries.length) list.append(el("p", "No resume requests saved yet."));
    for (const entry of entries) {
      const row = el("div"),
        text =
          entry.state === "accepted"
            ? "Mac accepted the resume request. Task completion is not confirmed."
            : entry.stopped
              ? "Further sending stopped locally."
              : "Request saved. Mac acceptance is not confirmed.";
      row.append(
        el("h4", text),
        el("p", describe(entry), "browser-keys-reference"),
      );
      if (!entry.stopped && entry.state !== "accepted")
        row.append(
          button(
            "Review sending resume request",
            () => void begin("send", entry),
          ),
          button(
            "Review stopping resume request",
            () => void begin("stop", entry),
          ),
        );
      if (entry.state !== "preparing")
        row.append(
          button("Check for Mac resume receipt", () => void inspect(entry)),
        );
      list.append(row);
    }
    controls();
  }
  async function read() {
    permissions = await host.resumeAPI.status();
    entries = await host.resumeDeliveryAPI.history();
  }
  async function run(work: (check: () => void) => Promise<void>) {
    if (disposed || busy) return;
    busy = true;
    const g = generation,
      owner = identity(),
      version = host.reviewVersion(),
      start = now(),
      mono = monotonic();
    const check = () => {
      if (
        disposed ||
        g !== generation ||
        owner !== identity() ||
        version !== host.reviewVersion() ||
        !focused() ||
        now() < start ||
        now() - start >= 120000 ||
        monotonic() < mono ||
        monotonic() - mono >= 120000
      )
        throw Error("DENIED");
    };
    error.textContent = "";
    controls();
    try {
      check();
      await work(check);
      check();
    } catch {
      if (!disposed && g === generation) {
        review = null;
        ack.checked = false;
        error.textContent =
          "The result was not confirmed. Refresh saved requests before another action. A failed response can follow a successful save or delivery.";
      }
    } finally {
      busy = false;
      if (!disposed) controls();
    }
  }
  async function load() {
    invalidate();
    await run(async (check) => {
      await read();
      check();
      render();
      notice.textContent =
        "Saved requests loaded. Delivery and Mac acceptance are separate steps.";
    });
  }
  async function begin(
    action: Review["action"],
    entry?: History[number],
    selected?: Queue["item"],
    after: Queue["nextCursor"] = null,
  ) {
    if (busy) return;
    const grantId = choice.value;
    closeOthers();
    invalidate();
    await run(async (check) => {
      await read();
      check();
      if (
        entry &&
        !entries.some((e) => JSON.stringify(e) === JSON.stringify(entry))
      )
        throw Error("CONFLICT");
      let input: Record<string, unknown>,
        text: string,
        expires = now() + 120000;
      if (action === "prepare") {
        const grant = permissions!.grants.find(
          (g) => g.id === grantId && !g.revoked,
        );
        if (!grant) throw Error("DENIED");
        expires = Math.min(expires, grant.choices.expiresAt);
        input = {
          grantId,
          id: crypto.randomUUID(),
          expiresAt: expires,
          confirmed: true,
        };
        text = `Prepare a resume request for task ${grant.choices.taskId}, version ${grant.choices.taskRevision}, on Mac ${grant.choices.peerId}. Model ${grant.choices.modelDigest}. Permission ${grant.choices.permissionId}. Access ends ${new Date(expires).toLocaleString()}. Preparation does not send or run it.`;
      } else if (action === "clear") {
        input = {
          expectedConsentRevision: permissions!.revision,
          confirmed: true,
        };
        text =
          "Delete all saved resume requests and receipts on this browser, and lock its resume permissions. This cannot withdraw requests already delivered. Fresh device setup is required before new permission can be saved.";
      } else {
        if (!entry) throw Error("DENIED");
        input = {
          grantId: entry.grantId,
          id: entry.id,
          expectedRevision: entry.revision,
          confirmed: true,
        };
        text = describe(entry);
        if (action === "send") {
          expires = Math.min(expires, entry.expiresAt);
          text +=
            " Send this exact saved request to your Mac. Retrying reuses the same request.";
        }
        if (action === "stop")
          text +=
            " Stop further sending on this browser. A request already sent can still be accepted by the Mac.";
        if (action === "receive") {
          if (!selected) throw Error("DENIED");
          input = { ...input, after, selection: selected.selection };
          expires = Math.min(expires, selected.expiresAt);
          text += ` Check selected receipt ${selected.selection.messageId}, fingerprint ${selected.selection.envelopeHash}. Only an authenticated matching Mac receipt records acceptance.`;
        }
      }
      review = {
        action,
        input,
        snapshot: snapshot(),
        started: now(),
        mono: monotonic(),
        expires,
        identity: identity(),
        version: host.reviewVersion(),
      };
      heading.textContent =
        action === "prepare"
          ? "Prepare resume request"
          : action === "send"
            ? "Send resume request"
            : action === "stop"
              ? "Stop further sending"
              : action === "clear"
                ? "Delete local requests"
                : "Check Mac acceptance";
      detail.textContent = text;
      ack.checked = false;
      notice.textContent =
        "Review the exact task and action. Leaving this window closes the review.";
    });
  }
  async function submit() {
    const r = review;
    if (!r || !ack.checked || !valid(r)) {
      invalidate();
      return;
    }
    await run(async (check) => {
      await read();
      check();
      if (!valid(r) || snapshot() !== r.snapshot) throw Error("CONFLICT");
      review = null;
      ack.checked = false;
      if (r.action === "prepare") await host.resumeDeliveryAPI.prepare(r.input);
      else if (r.action === "send") await host.relayResumeAPI.send(r.input);
      else if (r.action === "stop") await host.resumeDeliveryAPI.stop(r.input);
      else if (r.action === "clear")
        await host.resumeDeliveryAPI.clear(r.input);
      else await host.relayResumeAPI.receive(r.input);
      check();
      if (!valid(r)) throw Error("DENIED");
      await read();
      check();
      render();
      notice.textContent =
        r.action === "send"
          ? "Relay stored the request. Mac acceptance is not yet confirmed."
          : r.action === "receive"
            ? "Mac acceptance receipt saved. This does not confirm task completion."
            : r.action === "prepare"
              ? "Request saved. Review sending it when ready."
              : r.action === "stop"
                ? "Further sending stopped locally."
                : "Local requests deleted and browser resume permissions locked.";
    });
  }
  async function inspect(
    entry: History[number],
    after: Queue["nextCursor"] = null,
  ) {
    if (busy) return;
    invalidate();
    let result: Queue | undefined;
    await run(async (check) => {
      result = await host.relayResumeAPI.inspect({ after, confirmed: true });
      check();
      notice.textContent = result.item
        ? "A relay item is available for checking. Inspecting or skipping it does not acknowledge or delete it."
        : "No further relay item is available. Refresh to check again later.";
    });
    if (result?.item) {
      await begin("receive", entry, result.item, after);
      if (review && result.nextCursor)
        navigation = { entry, after: result.nextCursor };
      controls();
    }
  }
  async function exportHistory() {
    await run(async (check) => {
      const archive = await host.resumeDeliveryAPI.export({ confirmed: true });
      check();
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(archive, null, 2)], {
          type: "application/json",
        }),
      );
      const link = el("a");
      link.href = url;
      link.download = "bittrees-resume-history.json";
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      notice.textContent =
        "Request history exported. This file cannot restore permission.";
    });
  }
  choice.onchange = controls;
  const conceal = () => {
    invalidate();
    notice.textContent = "Review closed. Refresh saved requests when ready.";
  };
  const visibility = () => {
    if (document.visibilityState === "hidden") conceal();
  };
  const keydown = (e: KeyboardEvent) => {
    if (e.key === "Escape") conceal();
  };
  window.addEventListener("blur", conceal);
  document.addEventListener("visibilitychange", visibility);
  box.addEventListener("keydown", keydown);
  const timer = setInterval(() => {
    if (review && !valid(review)) conceal();
  }, 500);
  controls();
  return {
    invalidate: conceal,
    destroy() {
      disposed = true;
      invalidate();
      clearInterval(timer);
      window.removeEventListener("blur", conceal);
      document.removeEventListener("visibilitychange", visibility);
      box.removeEventListener("keydown", keydown);
      box.remove();
    },
  };
}

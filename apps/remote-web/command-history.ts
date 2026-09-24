import type { BrowserCommandJournal } from "./command-history-operations.js";
import type { CommandHistory } from "../../modules/remote/browser-command-history.js";
type Scope = { ownerId: string; scope: string };
type Review = {
  action: "retry" | "export" | "delete";
  before: CommandHistory;
  id?: string;
  wall: number;
  mono: number;
  expires: number;
};
const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
export function mountCommandHistory(
  root: HTMLElement,
  journal: BrowserCommandJournal,
  current: () => Scope | null,
  hostBusy: () => boolean,
  clearCommandReview = () => {},
  now = Date.now,
  mono = () => performance.now(),
) {
  let state: CommandHistory | null = null,
    review: Review | null = null;
  let generation = 0,
    busy = false,
    disposed = false,
    session = JSON.stringify(current()),
    listKey = "";
  const urls = new Set<string>(),
    timers = new Set<ReturnType<typeof setTimeout>>();
  const el = <K extends keyof HTMLElementTagNameMap>(
    tag: K,
    text = "",
    cls = "",
  ) => {
    const n = document.createElement(tag);
    n.textContent = text;
    n.className = cls;
    return n;
  };
  const button = (text: string, fn: () => void) => {
    const b = el("button", text);
    b.type = "button";
    b.onclick = fn;
    return b;
  };
  const notice = el(
      "p",
      "Refresh saved commands to read this account’s local history.",
    ),
    error = el("p", "", "browser-keys-error");
  notice.setAttribute("role", "status");
  error.setAttribute("role", "alert");
  const list = el("ul"),
    controls = el("div", "", "browser-keys-actions"),
    reviewBox = el("div", "", "browser-keys-stage"),
    title = el("h3"),
    detail = el("p", "", "browser-keys-reference"),
    ack = el("input"),
    ackLabel = el("label", "", "browser-keys-check"),
    ackText = el("span");
  list.setAttribute("aria-label", "Saved commands");
  title.tabIndex = -1;
  ack.type = "checkbox";
  ackLabel.append(ack, ackText);
  const refresh = button("Refresh saved commands", () => void load()),
    exportButton = button(
      "Review command history export",
      () => void begin("export"),
    ),
    deleteButton = button(
      "Review command history deletion",
      () => void begin("delete"),
    ),
    confirm = button("Confirm command history action", () => void submit()),
    cancel = button("Cancel command history review", () =>
      reset("Review closed. Refresh saved commands to continue."),
    );
  controls.append(refresh, exportButton, deleteButton);
  reviewBox.append(title, detail, ackLabel, confirm, cancel);
  root.classList.add("browser-keys");
  root.append(
    el("h2", "Saved command history"),
    el(
      "p",
      "Pause and cancel requests stay in this browser until you delete them. A saved request does not prove that your Mac received or applied it. Checking a receipt never resends the command.",
    ),
    controls,
    notice,
    error,
    list,
    reviewBox,
  );
  const focused = () =>
    document.visibilityState !== "hidden" && document.hasFocus();
  const live = () =>
    !disposed &&
    !!current() &&
    JSON.stringify(current()) === session &&
    focused() &&
    !hostBusy();
  const timed = (r: Review) =>
    now() >= r.wall &&
    now() < r.expires &&
    mono() >= r.mono &&
    mono() - r.mono < r.expires - r.wall;
  const can = () => live() && !busy;
  function cleanup() {
    for (const t of timers) clearTimeout(t);
    timers.clear();
    for (const u of urls) URL.revokeObjectURL(u);
    urls.clear();
  }
  function reset(message: string) {
    generation++;
    busy = false;
    state = null;
    review = null;
    ack.checked = false;
    cleanup();
    notice.textContent = message;
    error.textContent = "";
    render();
  }
  function guard(g: number, scope: Scope, r?: Review) {
    if (
      g !== generation ||
      !live() ||
      !same(scope, current()) ||
      (r && !timed(r))
    )
      throw Error("DENIED");
  }
  function render() {
    root.hidden = !current();
    const ready = can();
    refresh.disabled = !ready;
    exportButton.disabled = !ready || !state?.entries.length || !!review;
    deleteButton.disabled = exportButton.disabled;
    reviewBox.hidden = !review;
    confirm.disabled = !ready || !review || !ack.checked || !timed(review);
    ack.disabled = busy;
    cancel.disabled = false;
    const key = JSON.stringify([
      state,
      !!review,
      ready,
      state?.entries.map((e) => [
        Date.parse(e.command.expiresAt) <= now(),
        e.observation &&
          Date.parse(e.observation.value.command.expiresAt) <= now(),
      ]),
    ]);
    if (key === listKey) return;
    listKey = key;
    list.replaceChildren();
    if (state && !review) {
      if (!state.entries.length)
        list.append(
          el("li", "No commands are saved for this account on this browser."),
        );
      for (const entry of [...state.entries].reverse()) {
        const c = entry.command,
          observed = entry.observation,
          li = el("li");
        li.append(
          el("h3", c.command === "pause" ? "Pause request" : "Cancel request"),
          el(
            "p",
            `Command ${c.id}. Device ${c.deviceId}. Task ${c.taskId}, reviewed revision ${c.expectedRevision}.`,
            "browser-keys-reference",
          ),
          el(
            "p",
            `Saved ${new Date(entry.savedAt).toLocaleString()}. Requested deadline ${new Date(c.expiresAt).toLocaleString()}.`,
          ),
          el(
            "p",
            observed
              ? `Last server outcome: ${observed.value.receipt?.outcome ?? observed.value.state}. Checked ${new Date(observed.at).toLocaleString()}. Server deadline ${new Date(observed.value.command.expiresAt).toLocaleString()}. This is a receipt, not current task progress.`
              : "No server outcome is saved. The original request may or may not have reached the server.",
          ),
        );
        const check = button("Check saved receipt", () => void inspect(c.id)),
          retry = button(
            "Review retrying original command",
            () => void begin("retry", c.id),
          );
        check.disabled = !ready;
        retry.disabled =
          !ready ||
          Date.parse(c.expiresAt) <= now() ||
          !!(
            observed &&
            (observed.value.state !== "pending" ||
              Date.parse(observed.value.command.expiresAt) <= now())
          );
        li.append(check, retry);
        list.append(li);
      }
    }
  }
  function failure(e: unknown) {
    const code = e instanceof Error ? e.message : "";
    error.textContent =
      code === "CAPACITY" || code === "LOCAL_HISTORY_FULL"
        ? "Local command history is full. Export and delete it before preparing another command."
        : code === "CONFLICT"
          ? "The saved command or history changed. Refresh saved commands and review again."
          : code === "DENIED"
            ? "This account or command is unavailable. A missing receipt can also mean server retention ended; it does not prove the command was never applied."
            : "The action could not be confirmed. A sent request may already have reached the server. Refresh saved commands and check its original receipt; do not assume it failed.";
  }
  async function work(fn: (g: number, scope: Scope) => Promise<void>) {
    if (!can()) return;
    const g = generation,
      scope = current()!;
    busy = true;
    error.textContent = "";
    render();
    try {
      await fn(g, scope);
    } catch (e) {
      if (g === generation && live()) {
        state = null;
        review = null;
        ack.checked = false;
        failure(e);
      }
    } finally {
      if (g === generation) {
        busy = false;
        render();
        if (review) title.focus();
      }
    }
  }
  async function load() {
    if (!can()) return;
    review = null;
    ack.checked = false;
    await work(async (g, scope) => {
      const loaded = await journal.history.read(scope.ownerId, () =>
        guard(g, scope),
      );
      guard(g, scope);
      state = loaded;
      notice.textContent =
        "Saved command history loaded. These records are local to this browser.";
    });
  }
  async function begin(action: Review["action"], id?: string) {
    if (!state || !can()) return;
    const before = structuredClone(state);
    let expires = now() + 120000;
    if (action === "retry") {
      const e = before.entries.find((e) => e.command.id === id);
      if (!e) return;
      expires = Math.min(
        expires,
        Date.parse(e.command.expiresAt),
        e.observation
          ? Date.parse(e.observation.value.command.expiresAt)
          : Infinity,
      );
      if (
        expires <= now() ||
        (e.observation && e.observation.value.state !== "pending")
      )
        return;
    }
    const next: Review = {
      action,
      before,
      id,
      wall: now(),
      mono: mono(),
      expires,
    };
    await work(async (g, scope) => {
      const fresh = await journal.history.read(scope.ownerId, () =>
        guard(g, scope, next),
      );
      if (!same(fresh, before)) throw Error("CONFLICT");
      guard(g, scope, next);
      clearCommandReview();
      guard(g, scope, next);
      review = next;
      ack.checked = false;
      title.textContent =
        action === "retry"
          ? "Retry the original command"
          : action === "delete"
            ? "Delete local command history"
            : "Export local command history";
      const e = before.entries.find((e) => e.command.id === id);
      detail.textContent =
        `Account ${scope.ownerId}. History revision ${before.revision}. ` +
        (e
          ? `${e.command.command === "pause" ? "Pause" : "Cancel"} task ${e.command.taskId} on device ${e.command.deviceId}, using original command ${e.command.id} and task revision ${e.command.expectedRevision}. Deadline ${new Date(expires).toLocaleString()}. The original request may already have been accepted. Current server permission is required; this never creates a new command ID.`
          : action === "delete"
            ? `Delete ${before.entries.length} local records. This does not cancel commands, remove server receipts or delete exported files.`
            : `Download ${before.entries.length} records containing command, device and task IDs, timing and observed outcomes. No task text or credentials are included.`);
      ackText.textContent =
        action === "retry"
          ? "Retry this exact original command once."
          : action === "delete"
            ? "Delete this account’s command history from this browser."
            : "Download this account’s local command metadata.";
      confirm.textContent =
        action === "retry"
          ? "Retry reviewed command"
          : action === "delete"
            ? "Delete reviewed command history"
            : "Export reviewed command history";
    });
  }
  async function inspect(id: string) {
    if (!state || !can()) return;
    const revision = state.revision;
    await work(async (g, scope) => {
      const loaded = await journal.inspect(scope.ownerId, revision, id, () =>
        guard(g, scope),
      );
      guard(g, scope);
      state = loaded;
      notice.textContent =
        "Original command receipt checked and saved. Nothing was resent.";
    });
  }
  async function submit() {
    if (!can() || !review || !ack.checked || !timed(review)) return;
    const selected = review;
    review = null;
    ack.checked = false;
    await work(async (g, scope) => {
      const check = () => guard(g, scope, selected),
        fresh = await journal.history.read(scope.ownerId, check);
      check();
      if (!same(fresh, selected.before)) throw Error("CONFLICT");
      if (selected.action === "retry") {
        const entry = fresh.entries.find((e) => e.command.id === selected.id)!;
        const loaded = await journal.submit(
          scope.ownerId,
          entry.command,
          check,
          fresh.revision,
        );
        check();
        state = loaded;
        notice.textContent =
          "Original command retried once. Its last server receipt is saved below.";
      } else if (selected.action === "delete") {
        const loaded = await journal.history.clear(
          scope.ownerId,
          fresh.revision,
          true,
          check,
        );
        check();
        state = loaded;
        notice.textContent =
          "Local command history deleted. Server commands and exported files remain separate.";
      } else {
        check();
        const url = URL.createObjectURL(
          new Blob([JSON.stringify(fresh, null, 2)], {
            type: "application/json",
          }),
        );
        urls.add(url);
        const a = el("a");
        a.href = url;
        a.download = "bittrees-command-history.json";
        document.body.append(a);
        a.click();
        a.remove();
        const t = setTimeout(() => {
          URL.revokeObjectURL(url);
          urls.delete(url);
          timers.delete(t);
        }, 30000);
        timers.add(t);
        state = fresh;
        notice.textContent =
          "Command history exported. The download contains local status metadata.";
      }
      check();
    });
  }
  ack.onchange = render;
  const hide = () =>
      reset("History hidden. Refresh saved commands to continue."),
    visibility = () => {
      if (document.visibilityState === "hidden") hide();
    },
    keydown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && (state || review || busy)) hide();
    };
  window.addEventListener("blur", hide);
  document.addEventListener("visibilitychange", visibility);
  window.addEventListener("keydown", keydown);
  function sync() {
    if (disposed) return;
    const next = JSON.stringify(current());
    if (next !== session || (hostBusy() && (state || review || busy))) {
      session = next;
      reset(
        "Account or task controls changed. Refresh saved commands to continue.",
      );
    } else if (review && !timed(review))
      reset(
        "Command history review expired. Refresh saved commands to continue.",
      );
    else render();
  }
  const timer = setInterval(sync, 500);
  render();
  return {
    sync,
    hide,
    destroy() {
      disposed = true;
      generation++;
      cleanup();
      clearInterval(timer);
      window.removeEventListener("blur", hide);
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("keydown", keydown);
      root.replaceChildren();
    },
  };
}

import type { BrowserPrivateOutbox } from "../../modules/remote/browser-outbox.js";
import { privateResultPayloadSchema } from "../../modules/remote/private-task-contracts.js";
import "./private-results.css";
type API = Pick<
  BrowserPrivateOutbox,
  "export" | "readResult" | "stop" | "clear"
>;
type Row = Awaited<ReturnType<API["export"]>>["entries"][number];
/** Internal view, mounted only by a trusted host after real identity/key/consent setup.
 * scope must change on every account/key/permission change; call invalidate immediately too.
 * No transport, key setup, task submission, model action, or production auto-mount.
 */
export function mountPrivateResults(
  root: HTMLElement,
  api: API,
  scope: () => string | null,
) {
  let generation = 0,
    disposed = false,
    busy = false,
    loadedScope: string | null = null;
  let rows: Row[] = [],
    metaRevision: number | null = null,
    selected: { id: string; revision: number } | null = null;
  let reviewDelete: number | null = null;
  const urls = new Set<string>(),
    timers = new Set<ReturnType<typeof setTimeout>>();
  const element = <K extends keyof HTMLElementTagNameMap>(
    tag: K,
    text = "",
    className = "",
  ) => {
    const el = document.createElement(tag);
    el.textContent = text;
    if (className) el.className = className;
    return el;
  };
  const box = element("section", "", "private-results");
  box.setAttribute("aria-label", "Private task history");
  const header = element("header"),
    title = element("h2", "Private task history"),
    intro = element(
      "p",
      "Your Mac’s responses stay encrypted here until you open them.",
    );
  header.append(title, intro);
  const actions = element("div", "", "private-results-actions"),
    notice = element(
      "p",
      "Load this browser’s history to review a response.",
      "private-results-notice",
    ),
    error = element("p", "", "private-results-error");
  notice.setAttribute("role", "status");
  error.setAttribute("role", "alert");
  const button = (text: string, fn: () => void) => {
    const b = element("button", text);
    b.type = "button";
    b.onclick = fn;
    return b;
  };
  const refreshButton = button("Refresh history", () => void refresh()),
    downloadButton = button(
      "Download encrypted history",
      () => void download(),
    ),
    deleteButton = button("Review deletion", () => showDelete());
  actions.append(refreshButton, downloadButton, deleteButton);
  const exportNote = element(
    "p",
    "Downloads contain encrypted messages and connection details. They are not a key backup.",
    "private-results-note",
  );
  const columns = element("div", "", "private-results-columns"),
    listArea = element("div", "", "private-results-history"),
    listTitle = element("h3", "Tasks on this browser"),
    list = element("ul");
  list.setAttribute("aria-label", "Stored private tasks");
  listArea.append(listTitle, list);
  const responseArea = element("section", "", "private-results-response"),
    responseTitle = element("h3", "Response hidden"),
    responseNote = element(
      "p",
      "Choose a stored response to review. Leaving this page hides its text.",
    ),
    output = element("div", "", "private-results-output"),
    hideButton = button("Hide response", () => hide());
  responseArea.setAttribute("aria-label", "Response review");
  responseTitle.tabIndex = -1;
  hideButton.hidden = true;
  output.hidden = true;
  responseArea.append(responseTitle, responseNote, output, hideButton);
  columns.append(listArea, responseArea);
  const deletion = element("section", "", "private-results-delete");
  deletion.hidden = true;
  deletion.setAttribute("aria-label", "Delete browser history review");
  const deleteTitle = element("h3", "Delete this browser’s history?"),
    deleteCopy = element(
      "p",
      "This removes encrypted tasks and responses from this browser. It does not cancel tasks or delete history on your Mac. Sending from this browser will require pairing again.",
    );
  const label = element("label"),
    confirm = element("input");
  confirm.type = "checkbox";
  label.append(
    confirm,
    document.createTextNode(" I understand what will be deleted."),
  );
  const deleteConfirm = button("Delete browser history", () => void clear()),
    deleteCancel = button("Keep history", () => {
      deletion.hidden = true;
      reviewDelete = null;
      confirm.checked = false;
      deleteButton.focus();
    });
  deletion.append(deleteTitle, deleteCopy, label, deleteConfirm, deleteCancel);
  box.append(header, actions, exportNote, notice, error, columns, deletion);
  root.replaceChildren(box);
  function focused() {
    return document.visibilityState === "visible" && document.hasFocus();
  }
  function current(token: number, captured: string | null) {
    return (
      !disposed &&
      token === generation &&
      !!captured &&
      captured === scope() &&
      focused()
    );
  }
  function erase() {
    selected = null;
    output.replaceChildren();
    output.hidden = true;
    hideButton.hidden = true;
    responseTitle.textContent = "Response hidden";
    responseNote.textContent =
      "Choose a stored response to review. Leaving this page hides its text.";
  }
  function controls() {
    for (const b of list.querySelectorAll("button")) b.disabled = busy;
    refreshButton.disabled = busy;
    downloadButton.disabled = busy || !loadedScope;
    deleteButton.disabled = busy || metaRevision === null;
    deleteConfirm.disabled = busy || !confirm.checked;
  }
  confirm.onchange = controls;
  function hide(message = "Response hidden.") {
    generation++;
    busy = false;
    erase();
    deletion.hidden = true;
    reviewDelete = null;
    confirm.checked = false;
    notice.textContent = message;
    error.textContent = "";
    controls();
  }
  function invalidate() {
    hide("Access changed. Refresh history before opening a response.");
    rows = [];
    metaRevision = null;
    loadedScope = null;
    renderList();
  }
  function failure(e: unknown) {
    const code = e instanceof Error ? e.message : "";
    error.textContent =
      code === "CONFLICT"
        ? "History changed. Refresh it and review the latest entry."
        : code === "CAPACITY"
          ? "Browser storage could not complete this change. Existing history is retained."
          : code === "SETUP_REQUIRED"
            ? "This browser needs fresh pairing before private tasks can continue."
            : "This response is unavailable. Check your account, keys and permission, then refresh history.";
  }
  async function refresh() {
    hide("Loading encrypted history…");
    const token = generation,
      captured = scope();
    busy = true;
    controls();
    try {
      if (!captured || !focused()) throw Error("DENIED");
      const snapshot = await api.export();
      if (!current(token, captured)) return;
      rows = snapshot.entries;
      metaRevision = snapshot.meta?.revision ?? null;
      loadedScope = captured;
      notice.textContent = snapshot.meta?.locked
        ? "History is cleared. Fresh pairing is required before sending again."
        : rows.length
          ? `${rows.length} stored ${rows.length === 1 ? "task" : "tasks"}. Responses open only when you choose.`
          : "No private tasks are stored on this browser.";
      renderList();
    } catch (e) {
      if (!disposed && token === generation && focused()) {
        rows = [];
        metaRevision = null;
        loadedScope = null;
        renderList();
        failure(e);
      }
    } finally {
      if (token === generation) {
        busy = false;
        controls();
      }
    }
  }
  function renderList() {
    list.replaceChildren();
    if (!rows.length) {
      list.append(element("li", "No tasks loaded.", "private-results-empty"));
      controls();
      return;
    }
    for (const row of [...rows].sort(
      (a, b) =>
        b.header.issuedAt - a.header.issuedAt || a.id.localeCompare(b.id),
    )) {
      const item = element("li"),
        date = element(
          "p",
          new Date(row.header.issuedAt).toLocaleString(undefined, {
            dateStyle: "medium",
            timeStyle: "short",
          }),
          "private-results-date",
        ),
        ref = element(
          "p",
          `Reference ${row.id.slice(-8)}`,
          "private-results-reference",
        );
      const state = row.resultEnvelope
        ? "Response available"
        : row.state === "accepted"
          ? "Accepted on your Mac"
          : row.state === "stopped"
            ? "Retries stopped"
            : row.state === "reserved"
              ? "Not ready to send"
              : "Waiting for your Mac";
      item.append(date, element("p", state), ref);
      if (row.resultEnvelope) {
        const view = button("Review response", () => void open(row));
        view.disabled = busy;
        view.dataset.taskId = row.id;
        item.append(view);
      } else if (row.state === "pending" || row.state === "reserved") {
        const stop = button("Stop retries", () => void stopRow(row));
        stop.disabled = busy;
        item.append(stop);
      }
      list.append(item);
    }
    controls();
  }
  async function open(row: Row) {
    hide("Opening response…");
    const token = generation,
      captured = loadedScope;
    busy = true;
    controls();
    try {
      if (!captured || captured !== scope() || !focused())
        throw Error("DENIED");
      const value = privateResultPayloadSchema.parse(
        await api.readResult({
          id: row.id,
          expectedRevision: row.revision,
          confirmed: true,
        }),
      );
      if (!current(token, captured)) return;
      selected = { id: row.id, revision: row.revision };
      show(value);
      notice.textContent = "Response open. Leaving this page hides its text.";
      responseTitle.focus();
    } catch (e) {
      if (current(token, captured)) {
        erase();
        failure(e);
      }
    } finally {
      if (token === generation) {
        busy = false;
        controls();
      }
    }
  }
  function show(value: ReturnType<typeof privateResultPayloadSchema.parse>) {
    const status = value.task.status;
    responseTitle.textContent =
      status === "completed"
        ? "Draft result"
        : status === "failed"
          ? "Task failed"
          : status === "cancelled"
            ? "Task cancelled"
            : "Task expired";
    responseNote.textContent =
      status === "completed"
        ? "AI-generated draft. Check important details before using it."
        : status === "failed"
          ? "Your Mac could not complete this task. No result was returned."
          : status === "cancelled"
            ? "Your Mac reported this task as cancelled."
            : "Your Mac reported that this task expired.";
    output.textContent = value.task.output ?? "";
    output.hidden = status !== "completed";
    hideButton.hidden = false;
  }
  async function validateVisible() {
    if (disposed) return;
    if (!focused()) {
      if (selected) hide();
      return;
    }
    if (loadedScope && loadedScope !== scope()) {
      invalidate();
      return;
    }
    if (!selected || busy) return;
    const item = selected,
      token = generation,
      captured = loadedScope;
    busy = true;
    controls();
    try {
      await api.readResult({
        id: item.id,
        expectedRevision: item.revision,
        confirmed: true,
      });
      if (!current(token, captured)) {
        if (token === generation) invalidate();
      }
    } catch {
      if (token === generation) invalidate();
    } finally {
      if (token === generation) {
        busy = false;
        controls();
      }
    }
  }
  async function stopRow(row: Row) {
    hide("Stopping retries…");
    const token = generation,
      captured = loadedScope;
    busy = true;
    controls();
    try {
      if (!current(token, captured)) throw Error("DENIED");
      await api.stop({
        id: row.id,
        expectedRevision: row.revision,
        confirmed: true,
      });
      if (current(token, captured)) {
        await refresh();
        if (
          !disposed &&
          loadedScope === captured &&
          scope() === captured &&
          focused()
        ) {
          notice.textContent =
            "Retries stopped here. A task already accepted on your Mac may still run.";
        }
      }
    } catch (e) {
      if (current(token, captured)) failure(e);
    } finally {
      if (token === generation) {
        busy = false;
        controls();
      }
    }
  }
  function showDelete() {
    hide();
    if (!loadedScope || loadedScope !== scope() || metaRevision === null)
      return;
    reviewDelete = metaRevision;
    deletion.hidden = false;
    confirm.checked = false;
    controls();
    confirm.focus();
  }
  async function clear() {
    if (!confirm.checked || reviewDelete === null) return;
    const revision = reviewDelete;
    hide("Deleting browser history…");
    const token = generation,
      captured = loadedScope;
    busy = true;
    controls();
    try {
      if (!current(token, captured)) throw Error("DENIED");
      await api.clear({ expectedRevision: revision, confirmed: true });
      if (current(token, captured)) {
        rows = [];
        metaRevision = null;
        renderList();
        notice.textContent =
          "Browser history deleted. Your Mac’s history is unchanged. Fresh pairing is required to send again.";
      }
    } catch (e) {
      if (current(token, captured)) failure(e);
    } finally {
      if (token === generation) {
        busy = false;
        controls();
      }
    }
  }
  async function download() {
    hide("Preparing encrypted history…");
    const token = generation,
      captured = loadedScope;
    busy = true;
    controls();
    try {
      if (!current(token, captured)) throw Error("DENIED");
      const snapshot = await api.export();
      if (!current(token, captured)) return;
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(snapshot, null, 2)], {
          type: "application/json",
        }),
      );
      urls.add(url);
      const a = element("a");
      a.href = url;
      a.download = "bittrees-encrypted-history.json";
      a.hidden = true;
      box.append(a);
      a.click();
      a.remove();
      const timer = setTimeout(() => {
        URL.revokeObjectURL(url);
        urls.delete(url);
        timers.delete(timer);
      }, 30000);
      timers.add(timer);
      notice.textContent =
        "Encrypted history downloaded. Keep your recovery keys separately.";
    } catch (e) {
      if (current(token, captured)) failure(e);
    } finally {
      if (token === generation) {
        busy = false;
        controls();
      }
    }
  }
  const leave = () => hide(),
    visibility = () => {
      if (document.visibilityState !== "visible") hide();
    },
    escape = (e: KeyboardEvent) => {
      if (e.key === "Escape") hide();
    };
  window.addEventListener("blur", leave);
  window.addEventListener("pagehide", leave);
  document.addEventListener("visibilitychange", visibility);
  box.addEventListener("keydown", escape);
  const interval = setInterval(() => void validateVisible(), 2000);
  renderList();
  return {
    invalidate,
    destroy() {
      if (disposed) return;
      hide();
      disposed = true;
      clearInterval(interval);
      window.removeEventListener("blur", leave);
      window.removeEventListener("pagehide", leave);
      document.removeEventListener("visibilitychange", visibility);
      box.removeEventListener("keydown", escape);
      for (const timer of timers) clearTimeout(timer);
      for (const url of urls) URL.revokeObjectURL(url);
      root.replaceChildren();
    },
  };
}

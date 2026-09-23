import { z } from "zod";
import type { BrowserKeyLifecycle } from "../../modules/remote/browser-key-lifecycle.js";
import {
  privateBindingSchema,
  type PrivateBinding,
} from "../../modules/remote/private-peer-contracts.js";
import {
  browserKeyRecoverySchema,
  newBrowserRecoveryCode,
  browserRecoveryKey,
  openBrowserKeyRecovery,
  type BrowserKeyRecovery,
} from "../../modules/remote/browser-key-recovery.js";
import "./browser-keys.css";
type API = Pick<
  BrowserKeyLifecycle,
  | "status"
  | "begin"
  | "prepareRecovery"
  | "activatePrepared"
  | "revoke"
  | "remove"
  | "clear"
  | "reset"
  | "recovery"
  | "invalidate"
>;
const contextSchema = z.strictObject({
  scope: z.string().min(1).max(1024),
  localOwner: z.string().min(1).max(256),
  binding: privateBindingSchema.nullable(),
  freshRegistration: z.boolean(),
});
export type BrowserKeyViewContext = z.infer<typeof contextSchema>;
type Status = Awaited<ReturnType<API["status"]>>;
type Action = "begin" | "resume" | "revoke" | "remove" | "clear" | "reset";
type Review = {
  action: Action;
  keyId?: string;
  epoch?: number;
  revision: number;
  scope: string;
  binding: PrivateBinding | null;
  expires: number;
};
const names: Record<Action, string> = {
  begin: "Start key setup",
  resume: "Resume key setup",
  revoke: "Stop using key",
  remove: "Delete key",
  clear: "Delete all browser keys",
  reset: "Use new browser registration",
};
const messages: Record<string, string> = {
  CONFLICT: "The key or review changed. Refresh keys and review again.",
  DENIED:
    "This step was not confirmed. Check your account, recovery code and backup, then refresh keys.",
  SETUP_REQUIRED: "Register this browser again before starting key setup.",
  CREATION_INCOMPLETE:
    "This key attempt did not finish. Review replacement to use a fresh key.",
  DELETED: "This key was deleted. Refresh keys to see the current state.",
  MISSING: "The selected key is no longer available. Refresh keys.",
  CAPACITY:
    "Browser storage or the retained-key limit was reached. No key was replaced automatically.",
  BUSY: "Another key operation is finishing. Refresh keys before trying again.",
  STORAGE_UNAVAILABLE:
    "Browser storage is unavailable. No fallback key was created.",
  BROWSER_KEY_RECOVERY_FAILED:
    "The backup and recovery code could not be verified. Check both saved copies.",
};
/** Internal view for a fixed trusted local owner. The host must invalidate immediately
 * on account/permission changes and supply verified context; DOM values are never authority.
 * No auto-mount, network request, registration, pairing or historical-key restore. */
export function mountBrowserKeys(
  root: HTMLElement,
  api: API,
  context: () => BrowserKeyViewContext | null,
  now = Date.now,
) {
  let disposed = false,
    generation = 0,
    busy = false,
    loaded: string | null = null,
    status: Status | null = null,
    review: Review | null = null,
    mode: "none" | "review" | "code" | "backup" | "check" = "none",
    originalCode = "",
    selectedKit: BrowserKeyRecovery | null = null,
    checkKit: BrowserKeyRecovery | null = null;
  const urls = new Set<string>(),
    timers = new Set<ReturnType<typeof setTimeout>>();
  const el = <K extends keyof HTMLElementTagNameMap>(
    tag: K,
    text = "",
    className = "",
  ) => {
    const e = document.createElement(tag);
    e.textContent = text;
    if (className) e.className = className;
    return e;
  };
  const button = (text: string, action: () => void) => {
    const b = el("button", text);
    b.type = "button";
    b.onclick = action;
    return b;
  };
  const box = el("section", "", "browser-keys");
  box.setAttribute("aria-label", "Browser keys and recovery");
  const title = el("h2", "Keep this browser recoverable"),
    intro = el(
      "p",
      "Bittrees cannot recover these keys for you. Keep the encrypted backup and recovery code in separate places.",
    ),
    notice = el(
      "p",
      "Refresh keys to review this browser.",
      "browser-keys-notice",
    ),
    error = el("p", "", "browser-keys-error");
  notice.setAttribute("role", "status");
  error.setAttribute("role", "alert");
  const account = el("p", "", "browser-keys-reference"),
    actions = el("div", "", "browser-keys-actions"),
    refreshButton = button("Refresh keys", () => void refresh()),
    setupButton = button("Review new key", () => showReview("begin")),
    clearButton = button("Review deletion of all keys", () =>
      showReview("clear"),
    ),
    resetButton = button("Review new registration", () => showReview("reset")),
    checkButton = button("Check a saved backup", () => showCheck());
  actions.append(
    refreshButton,
    setupButton,
    checkButton,
    clearButton,
    resetButton,
  );
  const columns = el("div", "", "browser-keys-columns"),
    history = el("section"),
    listTitle = el("h3", "Keys on this browser"),
    list = el("ul");
  list.setAttribute("aria-label", "Browser key history");
  history.append(listTitle, list);
  const stage = el("section", "", "browser-keys-stage");
  stage.setAttribute("aria-label", "Key setup and review");
  columns.append(history, stage);
  const idle = el(
      "p",
      "Choose a key action. A browser key alone does not enable private task access.",
    ),
    reviewBox = el("section"),
    reviewTitle = el("h3"),
    reviewCopy = el("p"),
    reviewDetails = el("p", "", "browser-keys-reference");
  reviewBox.setAttribute("aria-label", "Review key change");
  reviewTitle.tabIndex = -1;
  const checkbox = (text: string) => {
    const label = el("label", "", "browser-keys-check"),
      input = el("input");
    input.type = "checkbox";
    label.append(input, document.createTextNode(text));
    input.onchange = () => controls();
    return { label, input };
  };
  const reviewAck = checkbox("I understand this exact change."),
    reviewConfirm = button("Confirm key change", () => void confirmReview()),
    cancel = button("Cancel review", () =>
      resetView("Review cancelled. Stored keys are unchanged."),
    );
  reviewBox.append(
    reviewTitle,
    reviewCopy,
    reviewDetails,
    reviewAck.label,
    reviewConfirm,
    cancel,
  );
  const codeBox = el("section");
  codeBox.setAttribute("aria-label", "Save recovery code");
  const codeTitle = el("h3", "Save the recovery code"),
    codeNote = el(
      "p",
      "Keep this code separately from the encrypted backup. Anyone with both copies can open the key. Leaving this window hides the code.",
    ),
    codeOutput = el("textarea");
  codeOutput.readOnly = true;
  codeOutput.rows = 3;
  codeOutput.setAttribute("aria-label", "Recovery code");
  codeOutput.autocomplete = "off";
  codeOutput.spellcheck = false;
  codeOutput.hidden = true;
  const reveal = button("Reveal recovery code", () => {
      if (!validReview() || !originalCode) return;
      codeOutput.value = originalCode;
      codeOutput.hidden = false;
      reveal.disabled = true;
      codeOutput.focus();
    }),
    downloadCode = button("Download recovery code", () => {
      if (validReview() && originalCode) {
        download(
          originalCode + "\n",
          `bittrees-recovery-code-${review!.keyId}.txt`,
          "text/plain",
        );
        notice.textContent =
          "Recovery code download started. Keep it separately from the encrypted backup.";
      }
    });
  const password = (labelText: string) => {
    const label = el("label", labelText),
      input = el("input");
    input.type = "password";
    input.autocomplete = "off";
    input.spellcheck = false;
    input.maxLength = 80;
    input.setAttribute("aria-label", labelText);
    label.append(input);
    return { label, input };
  };
  const savedCode = password("Recovery code from your saved copy"),
    codeAck = checkbox("I saved this recovery code separately."),
    prepareButton = button("Prepare encrypted backup", () => void prepare());
  savedCode.input.oninput = () => {
    codeAck.input.checked = false;
    controls();
  };
  codeBox.append(
    codeTitle,
    codeNote,
    reveal,
    downloadCode,
    codeOutput,
    savedCode.label,
    codeAck.label,
    prepareButton,
  );
  const backupBox = el("section");
  backupBox.setAttribute("aria-label", "Check backup before activation");
  const backupTitle = el("h3", "Check the backup before activation"),
    backupNote = el(
      "p",
      "Download the encrypted backup, select that saved file, then enter your recovery code. The key stays inactive until this check succeeds.",
    ),
    downloadBackup = button("Download this encrypted backup", () => {
      if (review?.keyId) void exportKit(review.keyId);
    });
  const file = (labelText: string) => {
    const label = el("label", labelText),
      input = el("input");
    input.type = "file";
    input.accept = ".json,application/json";
    input.setAttribute("aria-label", labelText);
    label.append(input);
    return { label, input };
  };
  const backupFile = file("Saved encrypted backup file"),
    activateCode = password("Recovery code for activation"),
    activateAck = checkbox("I saved both recovery items in separate places."),
    activateButton = button(
      "Check backup and activate key",
      () => void activate(),
    );
  backupFile.input.onchange = () => void readFile(backupFile.input, "activate");
  activateCode.input.oninput = () => {
    activateAck.input.checked = false;
    controls();
  };
  backupBox.append(
    backupTitle,
    backupNote,
    downloadBackup,
    backupFile.label,
    activateCode.label,
    activateAck.label,
    activateButton,
  );
  const checkBox = el("section");
  checkBox.setAttribute("aria-label", "Check saved recovery items");
  const checkTitle = el("h3", "Check a saved backup"),
    checkNote = el(
      "p",
      "This checks whether your saved file and code can open the original key. It does not restore a device, pairing, permissions or messages.",
    ),
    checkFile = file("Encrypted backup to check"),
    checkCode = password("Recovery code to check"),
    checkRun = button("Check saved items", () => void checkSaved()),
    checkResult = el("p", "", "browser-keys-result");
  checkResult.setAttribute("aria-live", "polite");
  checkFile.input.onchange = () => void readFile(checkFile.input, "check");
  checkCode.input.oninput = () => {
    checkResult.textContent = "";
    controls();
  };
  checkBox.append(
    checkTitle,
    checkNote,
    checkFile.label,
    checkCode.label,
    checkRun,
    checkResult,
  );
  const hide = button("Hide recovery details", () =>
    conceal("Recovery details hidden. Use your saved code to continue."),
  );
  stage.append(idle, reviewBox, codeBox, backupBox, checkBox, hide);
  box.append(title, intro, account, actions, notice, error, columns);
  root.append(box);
  function ctx() {
    try {
      const p = contextSchema.safeParse(context());
      return p.success ? p.data : null;
    } catch {
      return null;
    }
  }
  const scope = () => {
    const c = ctx();
    return c ? JSON.stringify(c) : null;
  };
  const focused = () =>
    document.visibilityState !== "hidden" && document.hasFocus();
  const current = (g: number, c: string | null) =>
    !disposed &&
    g === generation &&
    !!c &&
    c === loaded &&
    c === scope() &&
    focused();
  const online = () => {
    const b = ctx()?.binding;
    return !!b && b.expiresAt > now();
  };
  const validReview = () =>
    !!review &&
    review.scope === loaded &&
    loaded === scope() &&
    review.expires > now() &&
    focused() &&
    !busy;
  const codeValid = (input: HTMLInputElement) =>
    /^btre1_[A-Za-z0-9_-]{43}$/.test(input.value.trim());
  function failure(e: unknown) {
    const code = e instanceof Error ? e.message : "";
    error.textContent =
      messages[code] ??
      "The operation was not confirmed. Refresh keys before another attempt.";
  }
  function revokeURLs() {
    for (const u of urls) URL.revokeObjectURL(u);
    urls.clear();
    for (const t of timers) clearTimeout(t);
    timers.clear();
  }
  function clearSecrets() {
    originalCode = "";
    codeOutput.value = "";
    codeOutput.hidden = true;
    savedCode.input.value = "";
    activateCode.input.value = "";
    checkCode.input.value = "";
    backupFile.input.value = "";
    checkFile.input.value = "";
    selectedKit = null;
    checkKit = null;
    reviewAck.input.checked = false;
    codeAck.input.checked = false;
    activateAck.input.checked = false;
    checkResult.textContent = "";
    revokeURLs();
  }
  function conceal(
    message = "Recovery codes hidden after leaving this window. Re-enter your saved code before continuing.",
  ) {
    generation++;
    api.invalidate();
    busy = false;
    clearSecrets();
    notice.textContent = message;
    controls();
  }
  function resetView(message = "Review closed.") {
    conceal(message);
    review = null;
    mode = "none";
    error.textContent = "";
    controls();
  }
  function invalidate() {
    resetView("Account or access changed. Refresh keys to continue.");
    status = null;
    loaded = null;
    list.replaceChildren();
    account.textContent = "";
    controls();
  }
  function registrationChanged() {
    const binding = ctx()?.binding;
    return (
      !!binding &&
      !!status?.registrationDeviceId &&
      status.registrationDeviceId !== binding.deviceId
    );
  }
  function controls() {
    const ready = !!loaded && loaded === scope() && focused() && !busy,
      canOnline = ready && online(),
      c = ctx();
    refreshButton.disabled = busy || !focused() || !c;
    setupButton.disabled =
      !canOnline ||
      !status ||
      status.legacySlots > 0 ||
      registrationChanged() ||
      (status.locked && status.revision > 0) ||
      (status.requiresFreshRegistration && !c?.freshRegistration);
    clearButton.disabled =
      !ready ||
      !status ||
      status.revision === 0 ||
      status.slots.every((x) => x.state === "deleted");
    resetButton.hidden =
      !status ||
      !(
        (status.locked && status.revision > 0) ||
        status.legacySlots > 0 ||
        registrationChanged()
      );
    resetButton.disabled = !canOnline || !c?.freshRegistration;
    checkButton.disabled = !ready;
    for (const b of list.querySelectorAll("button"))
      b.disabled =
        !ready ||
        (b.dataset.online === "true" && (!canOnline || registrationChanged()));
    idle.hidden = mode !== "none";
    reviewBox.hidden = mode !== "review";
    codeBox.hidden = mode !== "code";
    backupBox.hidden = mode !== "backup";
    checkBox.hidden = mode !== "check";
    hide.hidden = mode === "none";
    hide.disabled = busy;
    reviewConfirm.disabled = !validReview() || !reviewAck.input.checked;
    cancel.disabled = busy;
    reveal.disabled = !validReview() || !originalCode || !codeOutput.hidden;
    downloadCode.disabled = !validReview() || !originalCode;
    savedCode.input.disabled = !ready;
    codeAck.input.disabled = !ready;
    prepareButton.disabled =
      !validReview() ||
      !online() ||
      !codeAck.input.checked ||
      !codeValid(savedCode.input);
    downloadBackup.disabled = !validReview();
    backupFile.input.disabled = !ready;
    activateCode.input.disabled = !ready;
    activateAck.input.disabled = !ready;
    activateButton.disabled =
      !validReview() ||
      !online() ||
      !selectedKit ||
      !codeValid(activateCode.input) ||
      !activateAck.input.checked;
    checkFile.input.disabled = !ready;
    checkCode.input.disabled = !ready;
    checkRun.disabled = !ready || !checkKit || !codeValid(checkCode.input);
  }
  async function run<T>(
    fn: () => Promise<T>,
  ): Promise<{ ok: true; value: T } | { ok: false; stale: boolean }> {
    const g = generation,
      c = loaded;
    if (!current(g, c) || busy) return { ok: false, stale: true };
    busy = true;
    error.textContent = "";
    controls();
    try {
      const value = await fn();
      if (!current(g, c)) return { ok: false, stale: true };
      return { ok: true, value };
    } catch (e) {
      if (current(g, c)) failure(e);
      return { ok: false, stale: !current(g, c) };
    } finally {
      if (g === generation) {
        busy = false;
        controls();
      }
    }
  }
  function render() {
    list.replaceChildren();
    const c = ctx();
    account.textContent = c?.binding
      ? `Account ${c.binding.ownerId}. This browser ${c.binding.deviceId}.`
      : "Offline key maintenance. New setup needs a current browser registration.";
    if (!status) return;
    if (!status.slots.length) list.append(el("li", "No browser keys saved."));
    for (const row of status.slots) {
      const li = el("li"),
        heading = el("h4", `Key ${row.keyEpoch}`),
        state = el(
          "p",
          row.state === "active"
            ? "Ready for pairing"
            : row.state === "preparing"
              ? "Setup unfinished"
              : row.state === "retired"
                ? "Stopped locally"
                : "Deleted",
        ),
        id = el("p", row.id, "browser-keys-reference");
      li.append(heading, state, id);
      if (row.state === "preparing") {
        const b = button("Resume setup", () => showReview("resume", row.id));
        b.dataset.online = "true";
        li.append(b);
      }
      if (row.state !== "deleted") {
        li.append(
          button("Download encrypted backup", () => void exportKit(row.id)),
        );
        if (row.state === "active" || row.state === "preparing")
          li.append(
            button("Review stop using key", () => showReview("revoke", row.id)),
          );
        li.append(
          button("Review key deletion", () => showReview("remove", row.id)),
        );
      }
      list.append(li);
    }
    controls();
  }
  async function refresh(outcome?: string) {
    resetView("Loading browser keys…");
    status = null;
    loaded = scope();
    render();
    if (!loaded) {
      controls();
      return;
    }
    const result = await run(() => api.status());
    if (!result.ok) {
      if (!result.stale && outcome)
        notice.textContent =
          outcome + " Refresh keys to load their current state.";
      return;
    }
    status = result.value;
    render();
    notice.textContent =
      outcome ??
      (registrationChanged()
        ? "Browser registration changed. Review the new registration for local keys; existing backups remain available."
        : status.legacySlots
          ? "Earlier key storage found. Keep its backups before reviewing a fresh browser registration."
          : status.locked && status.revision > 0
            ? "Key material was cleared. Register a different browser identity before setup."
            : "Key history loaded. Private task access is separate.");
  }
  function showReview(action: Action, keyId?: string) {
    if (!status || !loaded || loaded !== scope() || busy || !focused()) return;
    if (["begin", "resume", "reset"].includes(action) && !online()) return;
    const row = keyId ? status.slots.find((x) => x.id === keyId) : null;
    if (keyId && !row) return;
    resetView("Review this change before confirming.");
    const c = ctx()!;
    review = {
      action,
      keyId,
      epoch: row?.keyEpoch,
      revision: status.revision,
      scope: loaded!,
      binding: c.binding,
      expires: Math.min(
        now() + 120000,
        ["begin", "resume", "reset"].includes(action)
          ? c.binding!.expiresAt
          : Infinity,
      ),
    };
    mode = "review";
    reviewTitle.textContent = names[action];
    reviewConfirm.textContent = `Confirm ${names[action].toLowerCase()}`;
    reviewCopy.textContent =
      action === "begin"
        ? "Starting setup stops use of the currently selected key. Its backup remains available. The new key stays inactive while you save and check its recovery items."
        : action === "resume"
          ? "Continue this exact unfinished setup using the recovery code you already saved. An interrupted key attempt cannot be regenerated."
          : action === "revoke"
            ? "Stop using this key locally. Its encrypted backup is retained. Other devices and already delivered copies are unchanged."
            : action === "remove"
              ? "Delete this key and its encrypted backup from this browser. History may become unreadable without your separate recovery items. Exported copies and other devices are unchanged."
              : action === "clear"
                ? "Delete all key material and encrypted key backups on this browser. Stored encrypted messages remain, but may be unreadable. Fresh browser registration is required before setup."
                : "Use the current fresh browser registration. Existing keys become retired history; this does not restore their permissions or pairing.";
    reviewDetails.textContent = `${keyId ? `Key ${row!.keyEpoch}: ${keyId}. ` : ""}${c.binding ? `Account ${c.binding.ownerId}. Browser ${c.binding.deviceId}. ` : ""}Review expires ${new Date(review.expires).toLocaleTimeString()}.`;
    controls();
    reviewTitle.focus();
  }
  async function confirmReview() {
    if (!validReview() || !reviewAck.input.checked) return;
    const r = review!;
    reviewAck.input.checked = false;
    mode = "none";
    controls();
    if (r.action === "begin") {
      const result = await run(() =>
        api.begin({ expectedRevision: r.revision, confirmed: true }),
      );
      if (!result.ok) {
        if (result.stale) return;
        review = null;
        return;
      }
      review = {
        ...r,
        keyId: result.value.keyId,
        epoch: result.value.keyEpoch,
        revision: result.value.revision,
      };
      status = null;
      list.replaceChildren(
        el("li", "Setup reserved. Refresh keys to reload history."),
      );
      originalCode = newBrowserRecoveryCode();
      mode = "code";
      notice.textContent =
        "Setup reserved. Save the recovery code before preparing its encrypted backup.";
      controls();
      codeTitle.tabIndex = -1;
      codeTitle.focus();
      return;
    }
    if (r.action === "resume") {
      mode = "code";
      notice.textContent =
        "Enter the recovery code you saved for this unfinished key.";
      controls();
      savedCode.input.focus();
      return;
    }
    const result = await run(() =>
      r.action === "clear"
        ? api.clear({ expectedRevision: r.revision, confirmed: true })
        : r.action === "reset"
          ? api.reset({ expectedRevision: r.revision, confirmed: true })
          : r.action === "revoke"
            ? api.revoke({
                keyId: r.keyId,
                expectedRevision: r.revision,
                confirmed: true,
              })
            : api.remove({
                keyId: r.keyId,
                expectedRevision: r.revision,
                confirmed: true,
              }),
    );
    if (!result.ok) {
      if (result.stale) return;
      review = null;
      return;
    }
    status = null;
    list.replaceChildren();
    review = null;
    const outcome =
      r.action === "revoke"
        ? "Key stopped locally. Its encrypted backup is retained."
        : r.action === "reset"
          ? "New registration selected. Review setup to create a fresh key."
          : "Key material deleted locally. Exported copies and other devices are unchanged.";
    await refresh(outcome);
  }
  async function prepare() {
    if (
      !validReview() ||
      !review?.keyId ||
      !codeAck.input.checked ||
      !codeValid(savedCode.input)
    )
      return;
    const r = review,
      code = savedCode.input.value.trim();
    if (originalCode && code !== originalCode) {
      error.textContent =
        "The entered code does not match the code generated for this setup.";
      return;
    }
    clearSecrets();
    const result = await run(() =>
      api.prepareRecovery(
        { keyId: r.keyId, expectedRevision: r.revision, confirmed: true },
        code,
      ),
    );
    if (!result.ok) {
      if (result.stale) return;
      mode = "none";
      review = null;
      controls();
      return;
    }
    mode = "backup";
    notice.textContent =
      "Encrypted backup prepared. The key is still inactive. Download it and check your saved copies.";
    controls();
    backupTitle.tabIndex = -1;
    backupTitle.focus();
  }
  async function activate() {
    if (
      !validReview() ||
      !review?.keyId ||
      !selectedKit ||
      !activateAck.input.checked ||
      !codeValid(activateCode.input)
    )
      return;
    const r = review,
      kit = selectedKit,
      code = activateCode.input.value.trim();
    clearSecrets();
    mode = "none";
    controls();
    const result = await run(() =>
      api.activatePrepared(
        {
          keyId: r.keyId,
          expectedRevision: r.revision,
          confirmed: true,
          recoverySaved: true,
        },
        code,
        kit,
      ),
    );
    if (!result.ok && result.stale) return;
    review = null;
    if (!result.ok) {
      controls();
      return;
    }
    await refresh(
      "Browser key ready. Private task access and pairing have not been enabled.",
    );
  }
  function download(value: string, filename: string, type: string) {
    const u = URL.createObjectURL(new Blob([value], { type }));
    urls.add(u);
    const a = el("a");
    a.href = u;
    a.download = filename;
    box.append(a);
    a.click();
    a.remove();
    const timer = setTimeout(() => {
      URL.revokeObjectURL(u);
      urls.delete(u);
      timers.delete(timer);
    }, 30000);
    timers.add(timer);
  }
  async function exportKit(id: string) {
    const result = await run(() =>
      api.recovery({ keyId: id, confirmed: true }),
    );
    if (!result.ok) return;
    download(
      JSON.stringify(result.value, null, 2) + "\n",
      `bittrees-encrypted-key-${id}.json`,
      "application/json",
    );
    notice.textContent =
      "Encrypted backup download started. Keep its recovery code separately.";
  }
  async function readFile(
    input: HTMLInputElement,
    purpose: "activate" | "check",
  ) {
    const file = input.files?.[0];
    if (purpose === "activate") {
      selectedKit = null;
      activateAck.input.checked = false;
    } else {
      checkKit = null;
      checkResult.textContent = "";
    }
    controls();
    if (!file) return;
    const result = await run(async () => {
      if (file.size < 1 || file.size > 8192)
        throw Error("BROWSER_KEY_RECOVERY_FAILED");
      return browserKeyRecoverySchema.parse(JSON.parse(await file.text()));
    });
    if (!result.ok) return;
    if (purpose === "activate") selectedKit = result.value;
    else checkKit = result.value;
    controls();
  }
  function showCheck() {
    if (!loaded || busy || !focused()) return;
    resetView(
      "Choose the saved encrypted backup, then enter its recovery code.",
    );
    mode = "check";
    controls();
    checkTitle.tabIndex = -1;
    checkTitle.focus();
  }
  async function checkSaved() {
    if (!checkKit || !codeValid(checkCode.input) || !loaded) return;
    const kit = checkKit,
      code = checkCode.input.value.trim(),
      c = ctx();
    checkCode.input.value = "";
    checkResult.textContent = "";
    const result = await run(async () => {
      const opened = await openBrowserKeyRecovery(
        kit,
        await browserRecoveryKey(code),
      );
      if (
        !c ||
        opened.identity.localOwner !== c.localOwner ||
        (c.binding && opened.identity.binding.ownerId !== c.binding.ownerId)
      )
        throw Error("DENIED");
      return {
        keyId: opened.identity.keyId,
        deviceId: opened.identity.binding.deviceId,
      };
    });
    if (!result.ok) return;
    checkResult.textContent = `Backup checked. Key ${result.value.keyId} came from browser ${result.value.deviceId}. No device, permission or message was restored.`;
    controls();
  }
  const onBlur = () => conceal(),
    onVisibility = () => {
      if (document.visibilityState === "hidden") conceal();
    },
    onFocus = () => controls(),
    onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape")
        conceal("Recovery details hidden. Stored keys are unchanged.");
    };
  window.addEventListener("blur", onBlur);
  window.addEventListener("focus", onFocus);
  document.addEventListener("visibilitychange", onVisibility);
  box.addEventListener("keydown", onKey);
  const interval = setInterval(() => {
    if (disposed) return;
    if (loaded && loaded !== scope()) {
      invalidate();
      return;
    }
    if (review && review.expires <= now()) {
      resetView("Review expired. Refresh keys and review again.");
      return;
    }
    controls();
  }, 1000);
  controls();
  return {
    invalidate,
    destroy() {
      if (disposed) return;
      disposed = true;
      generation++;
      api.invalidate();
      clearSecrets();
      clearInterval(interval);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
      box.removeEventListener("keydown", onKey);
      box.remove();
    },
  };
}

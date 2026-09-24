import type { BrowserKeyHost } from "../../modules/remote/browser-key-host.js";
import {
  privateEnvelopeSchema,
  type PrivateEnvelope,
} from "../../modules/remote/private-envelope.js";
type Host = Pick<
  BrowserKeyHost,
  | "session"
  | "keyContext"
  | "reviewVersion"
  | "conversationAPI"
  | "conversationContentAPI"
  | "relayConversationContentAPI"
>;
type Status = Awaited<ReturnType<Host["conversationAPI"]["status"]>>;
type Grant = Status["grants"][number];
type Entry = Awaited<
  ReturnType<Host["conversationContentAPI"]["list"]>
>[number];
type Opened = Awaited<ReturnType<Host["conversationContentAPI"]["read"]>>;
type State = { status: Status; grantId: string; entries: Entry[] };
type Queue = Awaited<
  ReturnType<Host["relayConversationContentAPI"]["inspect"]>
>;
type Cursor = NonNullable<Queue["item"]>["cursor"] | null;
type Review = {
  action:
    | "prepare"
    | "import"
    | "download"
    | "export"
    | "clear"
    | "seal"
    | "send"
    | "stop"
    | "receive"
    | "reconcile";
  queue?: { value: Queue; after: Cursor };
  before: State;
  started: number;
  mono: number;
  expires: number;
  request?: {
    grantId: string;
    id: string;
    kind: "message" | "answer";
    parentId: string | null;
    content: string;
    expiresAt: number;
    confirmed: true;
  };
  envelope?: PrivateEnvelope;
  entry?: Entry;
};
const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
/** Reviewed local conversation actions. No automatic reveal, relay send or draft persistence. */
export function mountBrowserConversationContent(
  root: HTMLElement,
  host: Host,
  now = Date.now,
  monotonic = () => performance.now(),
  beforeWork: () => void = () => {},
) {
  let disposed = false,
    generation = 0,
    version = host.reviewVersion(),
    busy = false;
  let loaded: string | null = null,
    state: State | null = null,
    opened: Opened | null = null,
    review: Review | null = null,
    pending: Review | null = null,
    queue: { value: Queue; after: Cursor } | null = null;
  let fileEnvelope: PrivateEnvelope | null = null,
    fileName = "",
    intent: "new" | "reply" | "answer" = "new";
  const urls = new Set<string>(),
    timers = new Set<ReturnType<typeof setTimeout>>();
  const el = <K extends keyof HTMLElementTagNameMap>(
    tag: K,
    text = "",
    className = "",
  ) => {
    const node = document.createElement(tag);
    node.textContent = text;
    node.className = className;
    return node;
  };
  const button = (text: string, action: () => void) => {
    const node = el("button", text);
    node.type = "button";
    node.onclick = action;
    return node;
  };
  const box = el("section", "", "browser-keys conversation-content");
  box.setAttribute("aria-label", "Saved conversations");
  const notice = el(
      "p",
      "Refresh saved conversations to choose a conversation you approved.",
      "browser-keys-notice",
    ),
    error = el("p", "", "browser-keys-error");
  notice.setAttribute("role", "status");
  error.setAttribute("role", "alert");
  const actions = el("div", "", "browser-keys-actions"),
    refresh = button("Refresh saved conversations", () => void load()),
    archive = button(
      "Review conversation export",
      () => void maintenance("export"),
    ),
    remove = button(
      "Review deleting saved conversations",
      () => void maintenance("clear"),
    );
  actions.append(refresh, archive, remove);
  const selectorLabel = el("label", "Conversation to open"),
    selector = el("select");
  selector.id = "saved-conversation-choice";
  selectorLabel.htmlFor = selector.id;
  selector.onchange = () => void load(selector.value);
  const selectorWrap = el("div", "", "browser-permission-select");
  selectorWrap.append(selector);
  const columns = el("div", "", "conversation-content-columns"),
    sidebar = el("div"),
    list = el("ul"),
    stage = el("div", "", "conversation-content-stage");
  const view = el("div"),
    messageTitle = el("h3", "Choose a saved message"),
    messageText = el(
      "p",
      "Open a message from the list to read it.",
      "conversation-content-text",
    ),
    messageDetail = el("p", "", "browser-keys-reference");
  messageTitle.tabIndex = -1;
  const reply = button("Reply to this message", () => chooseIntent("reply")),
    answer = button("Answer this question", () => chooseIntent("answer")),
    newMessage = button("Write a new message", () => chooseIntent("new")),
    download = button(
      "Review encrypted message download",
      () => void downloadReview(),
    );
  const delivery = el("div", "", "conversation-delivery-history"),
    deliveryDetail = el("p"),
    seal = button(
      "Review preparing delivery",
      () => void deliveryReview("seal"),
    ),
    send = button("Review sending to Mac", () => void deliveryReview("send"));
  delivery.append(el("h3", "Delivery history"), deliveryDetail, seal, send);
  const composer = el("div"),
    draftTitle = el("h3", "New message to your Mac"),
    draftLabel = el("label", "Message text"),
    draft = el("textarea"),
    prepare = button("Review saving message", () => void prepareReview());
  draft.id = "saved-conversation-draft";
  draftLabel.htmlFor = draft.id;
  draft.rows = 5;
  draft.maxLength = 32000;
  draft.autocomplete = "off";
  draft.spellcheck = false;
  draft.oninput = controls;
  composer.append(
    draftTitle,
    draftLabel,
    draft,
    el(
      "p",
      "Saving keeps a copy in this browser. Prepare delivery separately, then review sending it to your Mac or downloading an encrypted file.",
    ),
    prepare,
  );
  view.append(
    messageTitle,
    messageText,
    messageDetail,
    reply,
    answer,
    newMessage,
    download,
    delivery,
    composer,
  );
  const files = el("div", "", "conversation-content-file"),
    fileLabel = el("label", "Choose an encrypted message file"),
    file = el("input"),
    fileDescription = el("p", "No message file selected."),
    importButton = button("Review message file", () => void importReview());
  file.type = "file";
  file.accept = ".json,application/json";
  file.id = "saved-conversation-file";
  fileLabel.htmlFor = file.id;
  files.append(
    el("h3", "Open a message from your Mac"),
    fileLabel,
    file,
    fileDescription,
    importButton,
  );
  const queueBox = el("div", "", "conversation-content-file"),
    queueDetail = el(
      "p",
      "Inspect incoming delivery to see one queued item.",
      "browser-keys-reference",
    ),
    inspectQueueButton = button(
      "Inspect incoming delivery",
      () => void inspectQueue(null),
    ),
    nextQueue = button(
      "Inspect next queued item",
      () => void inspectQueue(queue?.value.item?.cursor ?? null),
    ),
    receiveQueue = button(
      "Review receiving queued message",
      () => void queueReview(false),
    ),
    receiptLabel = el("label", "Saved copy for storage receipt"),
    receiptChoice = el("select"),
    reconcileQueue = button(
      "Review queued storage receipt",
      () => void queueReview(true),
    );
  receiptChoice.id = "conversation-receipt-copy";
  receiptLabel.htmlFor = receiptChoice.id;
  receiptChoice.onchange = controls;
  queueBox.append(
    el("h3", "Incoming delivery"),
    queueDetail,
    inspectQueueButton,
    nextQueue,
    receiveQueue,
    receiptLabel,
    receiptChoice,
    reconcileQueue,
  );
  const reviewBox = el("div", "", "conversation-content-review"),
    heading = el("h3"),
    details = el("p"),
    reviewText = el("p", "", "conversation-content-text"),
    identity = el("p", "", "browser-keys-reference"),
    ackLabel = el("label", "", "browser-keys-check"),
    ack = el("input"),
    ackText = el("span", "I reviewed this conversation and this exact action."),
    confirm = button("Confirm conversation action", () => void submit()),
    cancel = button("Cancel conversation action", () =>
      reset("Review closed. Refresh saved conversations to continue."),
    );
  ack.type = "checkbox";
  ack.onchange = controls;
  ackLabel.append(ack, ackText);
  heading.tabIndex = -1;
  reviewBox.append(
    heading,
    details,
    identity,
    reviewText,
    ackLabel,
    confirm,
    cancel,
  );
  sidebar.append(el("h3", "Saved messages"), list, queueBox, files);
  stage.append(view, reviewBox);
  columns.append(sidebar, stage);
  box.append(
    el("h2", "Your conversations"),
    el(
      "p",
      "Read saved messages, reply to your Mac, or answer a specific AI question. Prepare and send delivery separately, or exchange encrypted files. A receipt confirms local storage, not that a message was read or a task finished.",
    ),
    actions,
    notice,
    error,
    selectorLabel,
    selectorWrap,
    columns,
  );
  root.append(box);
  const scope = () => {
    const s = host.session();
    return s ? JSON.stringify([s, host.keyContext()?.binding ?? null]) : null;
  };
  const focused = () =>
    document.visibilityState !== "hidden" && document.hasFocus();
  const current = () =>
    !!state &&
    !!loaded &&
    loaded === scope() &&
    version === host.reviewVersion();
  const selected = () =>
    state?.status.grants.find((g) => g.id === state!.grantId);
  const usable = () => {
    const g = selected();
    return !!g && !g.revoked && g.choices.expiresAt > now();
  };
  const alive = (g: number, s: string | null) =>
    !disposed &&
    g === generation &&
    !!s &&
    s === scope() &&
    version === host.reviewVersion() &&
    focused() &&
    (!pending || timed(pending));
  const timed = (r: Review) => {
    const elapsed = monotonic() - r.mono;
    return (
      Number.isSafeInteger(now()) &&
      now() >= r.started &&
      now() < r.expires &&
      Number.isFinite(elapsed) &&
      elapsed >= 0 &&
      elapsed < r.expires - r.started
    );
  };
  const describe = (e: Entry) =>
    e.kind === "conversation.question"
      ? "Question from Mac"
      : e.kind === "conversation.answer"
        ? "Answer to Mac"
        : e.direction === "incoming"
          ? "Message from Mac"
          : "Message to Mac";
  function controls() {
    const ready = current() && focused() && !busy,
      grant = selected();
    refresh.disabled = !scope() || !focused() || busy;
    archive.disabled = !ready;
    remove.disabled = !ready || !state?.status.revision;
    selector.disabled = !ready || !!review;
    for (const node of list.querySelectorAll<HTMLButtonElement>("button"))
      node.disabled =
        !ready || !!review || (node.dataset.action !== "stop" && !usable());
    delivery.hidden = !opened;
    seal.disabled =
      !ready ||
      !usable() ||
      !opened ||
      opened.deliveryPrepared ||
      opened.expiresAt <= now() ||
      !!review;
    send.disabled =
      !ready ||
      !usable() ||
      !opened?.deliveryPrepared ||
      !!opened?.relayStopped ||
      opened.expiresAt <= now() ||
      !!review;
    send.textContent =
      opened?.direction === "incoming"
        ? "Review sending storage receipt"
        : "Review sending to Mac";
    inspectQueueButton.disabled = !ready || !usable() || !!review;
    nextQueue.disabled = inspectQueueButton.disabled || !queue?.value.item;
    receiveQueue.disabled = inspectQueueButton.disabled || !queue?.value.item;
    receiptChoice.disabled = inspectQueueButton.disabled;
    reconcileQueue.disabled = receiveQueue.disabled || !receiptChoice.value;
    reply.disabled =
      !ready ||
      !usable() ||
      !opened ||
      !grant?.choices.permissions.messagesToMac ||
      !!review;
    answer.hidden = opened?.content.type !== "conversation.question";
    answer.disabled =
      !ready ||
      !usable() ||
      !grant?.choices.permissions.answersToMac ||
      opened?.content.type !== "conversation.question" ||
      opened.content.deadline <= now() ||
      !!review;
    newMessage.disabled =
      !ready ||
      !usable() ||
      !grant?.choices.permissions.messagesToMac ||
      !!review;
    download.disabled =
      !ready || !usable() || !opened || opened.expiresAt <= now() || !!review;
    download.textContent =
      opened?.direction === "incoming"
        ? "Review receipt download"
        : "Review encrypted message download";
    draft.disabled =
      !ready ||
      !usable() ||
      !!review ||
      (intent === "answer"
        ? answer.disabled
        : !grant?.choices.permissions.messagesToMac);
    prepare.disabled =
      draft.disabled || !draft.value.trim() || (intent !== "new" && !opened);
    file.disabled = !scope() || !focused() || busy || !!review;
    importButton.disabled =
      !ready ||
      !usable() ||
      !fileEnvelope ||
      !!review ||
      !(
        grant?.choices.permissions.messagesToBrowser ||
        grant?.choices.permissions.questionsToBrowser
      );
    view.hidden = !!review;
    sidebar.hidden = !!review;
    box.classList.toggle("reviewing", !!review);
    reviewBox.hidden = !review;
    ack.disabled = busy;
    confirm.disabled = !ready || !review || !timed(review) || !ack.checked;
    cancel.disabled = busy;
  }
  function clearDownloads() {
    for (const t of timers) clearTimeout(t);
    timers.clear();
    for (const u of urls) URL.revokeObjectURL(u);
    urls.clear();
  }
  function wipe(keepFile = false) {
    opened = null;
    queue = null;
    queueDetail.textContent =
      "Inspect incoming delivery to see one queued item.";
    deliveryDetail.textContent = "";
    review = null;
    pending = null;
    intent = "new";
    draft.value = "";
    ack.checked = false;
    messageTitle.textContent = "Choose a saved message";
    messageText.textContent = "Open a message from the list to read it.";
    messageDetail.textContent = "";
    reviewText.textContent = details.textContent = identity.textContent = "";
    draftTitle.textContent = "New message to your Mac";
    prepare.textContent = "Review saving message";
    if (!keepFile) {
      fileEnvelope = null;
      fileName = "";
      file.value = "";
      fileDescription.textContent = "No message file selected.";
    }
    clearDownloads();
  }
  function reset(message: string, cancelHost = true) {
    generation++;
    if (cancelHost) host.conversationContentAPI.invalidate();
    version = host.reviewVersion();
    busy = false;
    loaded = null;
    state = null;
    wipe();
    list.replaceChildren();
    selector.replaceChildren();
    notice.textContent = message;
    error.textContent = "";
    controls();
  }
  function begin(message: string, keepFile = false) {
    beforeWork();
    host.conversationContentAPI.invalidate();
    generation++;
    version = host.reviewVersion();
    wipe(keepFile);
    busy = true;
    notice.textContent = message;
    error.textContent = "";
    controls();
    return { g: generation, s: scope() };
  }
  function failure(e: unknown) {
    const code = e instanceof Error ? e.message : "";
    error.textContent =
      code === "PARENT_PENDING"
        ? "Receive or open the earlier message first. Inspect the next queued item, then retry this original message."
        : code === "CAPACITY"
          ? "Storage is full. Export and review deleting saved conversations before trying again."
          : code === "CONFLICT"
            ? "The saved conversation changed. Refresh it and review the exact action again."
            : code === "BUSY"
              ? "Another device action is finishing. Refresh before trying again."
              : "The result was not confirmed. Refresh saved conversations to inspect what was saved before trying again.";
  }
  async function work<T>(
    message: string,
    action: () => Promise<T>,
    publish: (value: T) => void,
    keepFile = false,
  ) {
    const { g, s } = begin(message, keepFile);
    try {
      const result = await action();
      if (alive(g, s)) {
        loaded = s;
        publish(result);
      }
    } catch (e) {
      if (alive(g, s)) {
        loaded = null;
        failure(e);
      }
    } finally {
      if (g === generation) {
        busy = false;
        controls();
      }
    }
  }
  function deliveryText(e: Entry) {
    const observation = e.relayObservation;
    return [
      e.deliveryPrepared
        ? "Delivery copy prepared."
        : "Delivery copy not prepared.",
      `${e.relayAttempts} upload attempt${e.relayAttempts === 1 ? "" : "s"}.`,
      e.relayStopped
        ? "Further uploads stopped locally."
        : "Uploads are not stopped.",
      observation
        ? `Last server observation: ${observation.receipt.state} (${new Date(observation.observedAt).toLocaleString()}).`
        : e.relayAttempts
          ? "Upload result unconfirmed. Refresh before reviewing an original-copy retry."
          : "No server storage observed.",
      e.direction === "outgoing"
        ? e.recipientAccepted
          ? "Mac storage receipt authenticated."
          : "Mac storage receipt not confirmed."
        : "Saved in this browser; only its storage receipt can be sent back.",
      e.expiresAt <= now()
        ? "Delivery window ended. Saved content is retained."
        : `Delivery window ends ${new Date(e.expiresAt).toLocaleString()}.`,
    ].join(" ");
  }
  function render() {
    selector.replaceChildren();
    list.replaceChildren();
    receiptChoice.replaceChildren(el("option", "Choose an outgoing copy"));
    receiptChoice.options[0]!.value = "";
    for (const [i, grant] of (state?.status.grants ?? []).entries()) {
      const option = el(
        "option",
        `Conversation ${i + 1}, Mac ${grant.choices.peerId.slice(0, 8)}${grant.revoked || grant.choices.expiresAt <= now() ? " (access ended)" : ""}`,
      );
      option.value = grant.id;
      selector.append(option);
    }
    selector.value = state?.grantId ?? "";
    if (!state?.entries.length)
      list.append(
        el(
          "li",
          selected()
            ? "No messages are listed for this access. You can open a message file from your Mac or write a new message."
            : "Approve conversation access above, then refresh here.",
        ),
      );
    for (const [index, entry] of (state?.entries ?? []).entries()) {
      const row = el("li"),
        open = button(
          `Open ${describe(entry).toLowerCase()} ${index + 1}`,
          () => void openEntry(entry),
        );
      row.append(
        el(
          "p",
          `${describe(entry)}${entry.state === "preparing" ? ", saved locally" : ""}`,
        ),
        open,
      );
      const history = el(
          "p",
          deliveryText(entry),
          "conversation-delivery-summary",
        ),
        stop = button(
          `Review stopping delivery ${index + 1}`,
          () => void deliveryReview("stop", entry),
        );
      stop.dataset.action = "stop";
      stop.hidden = entry.relayStopped;
      row.append(history, stop);
      list.append(row);
      if (entry.direction === "outgoing" && entry.deliveryPrepared) {
        const option = el("option", `${describe(entry)} ${index + 1}`);
        option.value = entry.id;
        receiptChoice.append(option);
      }
    }
  }
  async function load(grantId = selector.value) {
    if (busy || !focused() || !scope()) return;
    await work(
      "Checking saved conversation access…",
      async () => {
        const status = await host.conversationAPI.status(),
          id = status.grants.some((g) => g.id === grantId)
            ? grantId
            : (status.grants.find(
                (g) => !g.revoked && g.choices.expiresAt > now(),
              )?.id ??
              status.grants[0]?.id ??
              "");
        const entries = (
            await host.conversationContentAPI.deliveryHistory()
          ).filter((e) => e.grantId === id),
          unavailable = false;
        return { status, grantId: id, entries, unavailable };
      },
      (result) => {
        state = result;
        render();
        notice.textContent = result.unavailable
          ? "Permission history loaded. Message access could not be verified; local deletion is still available."
          : "Saved conversation list loaded. Open a message to read it.";
      },
      true,
    );
  }
  async function fresh(before: State, needsContent = true, offline = false) {
    const status = await host.conversationAPI.status();
    if (!same(status, before.status)) throw Error("CONFLICT");
    if (needsContent) {
      const entries = offline
        ? (await host.conversationContentAPI.deliveryHistory()).filter(
            (e) => e.grantId === before.grantId,
          )
        : await host.conversationContentAPI.list({ grantId: before.grantId });
      if (
        !same(
          [...entries].sort((a, b) => a.id.localeCompare(b.id)),
          [...before.entries].sort((a, b) => a.id.localeCompare(b.id)),
        )
      )
        throw Error("CONFLICT");
    }
  }
  function show(value: Opened) {
    opened = value;
    messageTitle.textContent = describe(value);
    messageText.textContent = value.content.content;
    deliveryDetail.textContent = deliveryText(value);
    messageDetail.textContent =
      value.content.type === "conversation.question"
        ? `Answer by ${new Date(value.content.deadline).toLocaleString()}. An ordinary reply does not resume this task.`
        : value.direction === "incoming"
          ? "Saved in this browser. A receipt confirms storage only."
          : "Saved in this browser. Preparing or downloading a copy does not deliver it to the Mac.";
    notice.textContent = "Selected message opened.";
    controls();
    messageTitle.focus();
  }
  async function openEntry(entry: Entry) {
    if (!current() || busy || !focused() || !usable() || !state) return;
    const before = structuredClone(state);
    await work(
      "Opening the selected saved message…",
      async () => {
        await fresh(before);
        return host.conversationContentAPI.read({
          grantId: entry.grantId,
          id: entry.id,
        });
      },
      show,
    );
  }
  function chooseIntent(next: typeof intent) {
    if (
      !current() ||
      busy ||
      !focused() ||
      !usable() ||
      (next !== "new" && !opened)
    )
      return;
    if (
      (next === "answer" && answer.disabled) ||
      (next === "reply" && reply.disabled) ||
      (next === "new" && newMessage.disabled)
    )
      return;
    intent = next;
    draft.value = "";
    draftTitle.textContent =
      next === "answer"
        ? "Answer this exact question"
        : next === "reply"
          ? "Reply to the selected message"
          : "New message to your Mac";
    prepare.textContent =
      next === "answer" ? "Review saving answer" : "Review saving message";
    controls();
    draft.focus();
  }
  function reviewBase(action: Review["action"], before: State): Review {
    return {
      action,
      before,
      started: now(),
      mono: monotonic(),
      expires: now() + 120000,
    };
  }
  function showReview(
    r: Review,
    title: string,
    explanation: string,
    text: string,
    confirmation: string,
  ) {
    review = r;
    heading.textContent = title;
    details.textContent = explanation;
    reviewText.textContent = text;
    confirm.textContent = confirmation;
    ack.checked = false;
    const grant = r.before.status.grants.find((g) => g.id === r.before.grantId);
    identity.textContent =
      r.action === "clear" || r.action === "export"
        ? `Account ${host.session()?.ownerId}. All saved browser conversations.`
        : grant
          ? `Conversation ${grant.choices.scope.conversationRef}. Mac ${grant.choices.peerId}. Fingerprint ${grant.peer.fingerprint}.`
          : "";
    if (r.entry)
      identity.textContent += ` Saved copy ${r.entry.id}, revision ${r.entry.revision}.`;
    if (r.queue?.value.item)
      identity.textContent += ` Queued item ${r.queue.value.item.selection.messageId}. Envelope hash ${r.queue.value.item.selection.envelopeHash}.`;
    notice.textContent =
      "Review this exact action. Leaving this window closes the review.";
    controls();
    heading.focus();
  }
  async function prepareReview() {
    if (prepare.disabled || !state) return;
    const before = structuredClone(state),
      grant = selected()!,
      content = draft.value,
      parent = opened ? structuredClone(opened) : null,
      kind = intent === "answer" ? "answer" : "message",
      parentId = intent === "new" ? null : parent!.id;
    const expiresAt = Math.min(
      now() + 300000,
      grant.choices.expiresAt,
      kind === "answer" && parent?.content.type === "conversation.question"
        ? parent.content.deadline
        : Infinity,
    );
    const r = reviewBase("prepare", before);
    r.expires = Math.min(r.expires, expiresAt);
    r.request = {
      grantId: grant.id,
      id: crypto.randomUUID(),
      kind,
      parentId,
      content,
      expiresAt,
      confirmed: true,
    };
    await work(
      "Checking the exact message to save…",
      async () => {
        await fresh(before);
        if (parentId) {
          const live = await host.conversationContentAPI.read({
            grantId: grant.id,
            id: parentId,
          });
          if (!same(live, parent)) throw Error("CONFLICT");
        }
        return r;
      },
      (review) =>
        showReview(
          review,
          kind === "answer"
            ? "Save this answer for your Mac"
            : "Save this message for your Mac",
          `${kind === "answer" ? "This answers the selected AI question. The Mac will still verify its exact task and revision before resuming work." : parentId ? "This is an ordinary reply to the selected message. It will not resume a waiting task." : "This starts a new message in the selected conversation."} Save locally, then prepare and review delivery separately. Its delivery window ends ${new Date(expiresAt).toLocaleString()}.`,
          parentId && parent
            ? `${kind === "answer" ? "Question" : "Replying to"}:\n${parent.content.content}\n\n${kind === "answer" ? "Your answer" : "Your reply"}:\n${content}`
            : content,
          kind === "answer" ? "Save reviewed answer" : "Save reviewed message",
        ),
    );
  }
  file.onchange = async () => {
    const chosen = file.files?.[0],
      g = generation,
      s = scope();
    file.value = "";
    if (!chosen || !s || busy) return;
    fileEnvelope = null;
    fileName = "";
    fileDescription.textContent = "Reading selected file…";
    controls();
    try {
      if (chosen.size > 98304) throw Error("SIZE");
      const raw = await chosen.text();
      if (!alive(g, s)) return;
      fileEnvelope = privateEnvelopeSchema.parse(JSON.parse(raw));
      fileName = chosen.name;
      fileDescription.textContent = `Selected: ${fileName}. Its sender and content are checked only when you confirm opening it.`;
    } catch {
      if (alive(g, s)) {
        fileDescription.textContent =
          "Choose an encrypted message JSON file no larger than 96 KiB.";
        fileEnvelope = null;
      }
    }
    controls();
  };
  async function importReview() {
    if (importButton.disabled || !state || !fileEnvelope) return;
    const r = reviewBase("import", structuredClone(state));
    r.envelope = structuredClone(fileEnvelope);
    r.expires = Math.min(
      r.expires,
      r.envelope.header.expiresAt,
      selected()!.choices.expiresAt,
    );
    const name = fileName;
    await work(
      "Checking selected conversation access…",
      async () => {
        await fresh(r.before);
        return r;
      },
      (r) =>
        showReview(
          r,
          "Open and save this message file",
          "The sender, permission and message are authenticated before saving. A missing earlier message must be opened first. This action does not acknowledge a relay or resume a Mac task.",
          name,
          "Open reviewed message file",
        ),
    );
  }
  async function downloadReview() {
    if (download.disabled || !opened || !state) return;
    const r = reviewBase("download", structuredClone(state));
    r.entry = structuredClone(opened);
    r.expires = Math.min(
      r.expires,
      opened.expiresAt,
      selected()!.choices.expiresAt,
    );
    const receipt = opened.direction === "incoming";
    await work(
      "Checking the saved item before download…",
      async () => {
        await fresh(r.before);
        return r;
      },
      (r) =>
        showReview(
          r,
          receipt
            ? "Download a storage receipt"
            : "Download this encrypted message",
          receipt
            ? "This receipt confirms storage in this browser only. It does not mean the message was read or a task completed."
            : "Download the original encrypted message for the selected Mac. You must transfer it separately before its delivery window ends.",
          "",
          receipt ? "Download reviewed receipt" : "Download reviewed message",
        ),
    );
  }
  async function deliveryReview(
    action: "seal" | "send" | "stop",
    entry: Entry | null = opened,
  ) {
    if (
      !current() ||
      busy ||
      !focused() ||
      !state ||
      !entry ||
      (action !== "stop" && !usable())
    )
      return;
    if (
      (action === "seal" && seal.disabled) ||
      (action === "send" && send.disabled)
    )
      return;
    const r = reviewBase(action, structuredClone(state));
    r.entry = structuredClone(entry);
    if (action !== "stop")
      r.expires = Math.min(
        r.expires,
        entry.expiresAt,
        selected()!.choices.expiresAt,
      );
    const receipt = entry.direction === "incoming";
    await work(
      "Checking this exact saved delivery…",
      async () => {
        await fresh(r.before, true, action === "stop");
        const content =
          action === "stop"
            ? null
            : await host.conversationContentAPI.read({
                grantId: entry.grantId,
                id: entry.id,
              });
        if (content && content.revision !== entry.revision)
          throw Error("CONFLICT");
        return {
          r,
          text: action === "stop" || receipt ? "" : content!.content.content,
        };
      },
      ({ r, text }) =>
        showReview(
          r,
          action === "stop"
            ? "Stop delivery of this copy"
            : action === "seal"
              ? "Prepare this delivery copy"
              : receipt
                ? "Send this storage receipt"
                : "Send this message to your Mac",
          action === "stop"
            ? "Stop later uploads of this exact copy on this browser. Content and history stay saved. This cannot withdraw a copy already uploaded."
            : action === "seal"
              ? "Prepare and retain the encrypted original for this Mac. Nothing is uploaded or downloaded. Review sending separately."
              : receipt
                ? "Upload only the original encrypted storage receipt. It confirms storage in this browser, not reading or task completion."
                : "Upload the original encrypted message for this Mac. A server storage response does not confirm Mac acceptance or task completion. An unconfirmed attempt must be inspected before an explicit retry.",
          text,
          action === "stop"
            ? "Stop reviewed delivery"
            : action === "seal"
              ? "Prepare reviewed delivery"
              : receipt
                ? "Send reviewed storage receipt"
                : "Send reviewed message",
        ),
    );
  }
  async function inspectQueue(after: Cursor) {
    if (inspectQueueButton.disabled || !state) return;
    const before = structuredClone(state);
    await work(
      "Inspecting one incoming delivery…",
      async () => {
        await fresh(before);
        return host.relayConversationContentAPI.inspect({
          after,
          confirmed: true,
        });
      },
      (value) => {
        queue = { value, after };
        queueDetail.textContent = value.item
          ? `Queued item ${value.item.selection.messageId}. Delivery window ends ${new Date(value.item.expiresAt).toLocaleString()}. Content has not been opened or acknowledged.`
          : "No queued item at this position. Start a new inspection to check from the beginning.";
        notice.textContent =
          "Incoming delivery inspected. Review receipt separately.";
      },
    );
  }
  async function queueReview(receipt: boolean) {
    if (
      (receipt ? reconcileQueue.disabled : receiveQueue.disabled) ||
      !queue?.value.item ||
      !state
    )
      return;
    const r = reviewBase(
      receipt ? "reconcile" : "receive",
      structuredClone(state),
    );
    r.queue = structuredClone(queue);
    r.expires = Math.min(
      r.expires,
      queue.value.item.expiresAt,
      selected()!.choices.expiresAt,
    );
    if (receipt)
      r.entry = state.entries.find(
        (e) => e.id === receiptChoice.value && e.direction === "outgoing",
      );
    if (receipt && !r.entry) return;
    await work(
      "Checking the selected incoming item…",
      async () => {
        await fresh(r.before);
        const content = r.entry
          ? await host.conversationContentAPI.read({
              grantId: r.entry.grantId,
              id: r.entry.id,
            })
          : null;
        if (content && content.revision !== r.entry!.revision)
          throw Error("CONFLICT");
        return { r, text: content?.content.content ?? "" };
      },
      ({ r, text }) =>
        showReview(
          r,
          receipt
            ? "Check storage receipt for this copy"
            : "Receive this queued message",
          receipt
            ? "Authenticate the selected queued item as a storage receipt for this exact outgoing copy. Save it before acknowledging transport. This does not resend content or confirm reading or task completion."
            : "Authenticate and save this selected message or question before acknowledging transport. A missing earlier message stays queued. Reading and sending a storage receipt remain separate actions.",
          text,
          receipt
            ? "Check reviewed storage receipt"
            : "Receive reviewed message",
        ),
    );
  }
  async function maintenance(action: "export" | "clear") {
    if (
      !current() ||
      busy ||
      !focused() ||
      !state ||
      (action === "clear" && remove.disabled)
    )
      return;
    const r = reviewBase(action, structuredClone(state));
    await work(
      "Checking saved conversation history…",
      async () => {
        await fresh(r.before, false);
        return r;
      },
      (r) =>
        showReview(
          r,
          action === "export"
            ? "Export readable conversation history"
            : "Delete this browser’s saved conversations",
          action === "export"
            ? "This downloads readable message content for your account. Store the file privately. It cannot restore permission or keys."
            : "Delete all saved conversation content and its local encryption keys in this browser, and lock conversation permissions. Exported files, Mac copies and task history remain. A new browser registration and key are required before permission reset.",
          "",
          action === "export"
            ? "Export reviewed conversations"
            : "Delete reviewed conversations",
        ),
    );
  }
  function saveFile(data: unknown, name: string) {
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(data, null, 2) + "\n"], {
        type: "application/json",
      }),
    );
    urls.add(url);
    const link = el("a");
    link.href = url;
    link.download = name;
    box.append(link);
    link.click();
    link.remove();
    const timer = setTimeout(() => {
      URL.revokeObjectURL(url);
      urls.delete(url);
      timers.delete(timer);
    }, 30000);
    timers.add(timer);
  }
  async function submit() {
    if (confirm.disabled || !review || !ack.checked || !timed(review)) return;
    const r = review;
    review = null;
    pending = r;
    ack.checked = false;
    busy = true;
    const g = generation,
      s = loaded;
    controls();
    try {
      await fresh(
        r.before,
        r.action !== "export" && r.action !== "clear",
        r.action === "stop",
      );
      if (!alive(g, s) || !timed(r)) return;
      if (r.action === "prepare") {
        await host.conversationContentAPI.prepare(r.request!);
        if (alive(g, s))
          notice.textContent =
            "Message saved locally. Refresh the list to open it and review preparing delivery or an encrypted download. Nothing was sent.";
      } else if (r.action === "import") {
        const result = await host.conversationContentAPI.accept({
          grantId: r.before.grantId,
          envelope: r.envelope!,
          confirmed: true,
        });
        if (alive(g, s))
          notice.textContent = result.duplicate
            ? "This message was already saved. Refresh the list to open it."
            : "Message authenticated and saved. Refresh the list to open it.";
      } else if (r.action === "download") {
        const e = r.entry!,
          wire = await host.conversationContentAPI.envelope({
            grantId: e.grantId,
            id: e.id,
            expectedRevision: e.revision,
            confirmed: true,
          });
        if (alive(g, s)) {
          saveFile(
            wire,
            e.direction === "incoming"
              ? "bittrees-conversation-receipt.json"
              : "bittrees-conversation-message.json",
          );
          notice.textContent =
            "Encrypted file downloaded. Nothing was sent automatically. Refresh before another action.";
        }
      } else if (
        r.action === "seal" ||
        r.action === "send" ||
        r.action === "stop"
      ) {
        const e = r.entry!,
          input = {
            grantId: e.grantId,
            id: e.id,
            expectedRevision: e.revision,
            confirmed: true as const,
          };
        if (r.action === "seal")
          await host.conversationContentAPI.envelope(input);
        else if (r.action === "send")
          await host.relayConversationContentAPI.send(input);
        else await host.relayConversationContentAPI.stop(input);
        if (alive(g, s))
          notice.textContent =
            r.action === "seal"
              ? "Delivery copy prepared locally. Refresh before separately reviewing sending."
              : r.action === "stop"
                ? "Further delivery stopped locally. Saved content and history remain."
                : "Server storage response saved. Refresh delivery history; recipient storage is confirmed separately.";
      } else if (r.action === "receive" || r.action === "reconcile") {
        const q = r.queue!,
          e = r.entry;
        const result = await host.relayConversationContentAPI.receive({
          after: q.after,
          selection: q.value.item!.selection,
          confirmed: true,
          target:
            r.action === "receive"
              ? { action: "receive", grantId: r.before.grantId }
              : {
                  action: "reconcile",
                  grantId: e!.grantId,
                  id: e!.id,
                  expectedRevision: e!.revision,
                },
        });
        if (alive(g, s))
          notice.textContent =
            r.action === "reconcile"
              ? "Mac storage receipt authenticated and transport acknowledged. Refresh the saved copy to inspect it."
              : result.received.duplicate
                ? "Original message already saved; transport acknowledged. Refresh to inspect it."
                : "Message authenticated and saved; transport acknowledged. Refresh to open it. Storage receipt delivery is separate.";
      } else if (r.action === "export") {
        const data = await host.conversationContentAPI.export({
          confirmed: true,
        });
        if (alive(g, s)) {
          saveFile(data, "bittrees-conversation-history.json");
          notice.textContent =
            "Readable conversation history exported. Keep the file private. Refresh before another action.";
        }
      } else {
        await host.conversationContentAPI.clear({
          expectedConsentRevision: r.before.status.revision,
          confirmed: true,
        });
        if (alive(g, s))
          notice.textContent =
            "Saved conversations deleted and conversation permissions locked. Task history is unchanged.";
      }
      if (alive(g, s)) {
        loaded = null;
        state = null;
        opened = null;
        draft.value = "";
        messageText.textContent = "Refresh to inspect saved conversations.";
        reviewText.textContent = "";
        list.replaceChildren();
        selector.replaceChildren();
      }
    } catch (e) {
      if (alive(g, s)) {
        loaded = null;
        opened = null;
        messageText.textContent = reviewText.textContent = "";
        failure(e);
      }
    } finally {
      if (g === generation) {
        pending = null;
        busy = false;
        controls();
      }
    }
  }
  const blur = () =>
      reset(
        "Private text hidden after leaving this window. Refresh saved conversations to continue.",
      ),
    focus = () => controls(),
    visibility = () => {
      if (document.visibilityState === "hidden") blur();
    },
    escape = (e: KeyboardEvent) => {
      if (e.key === "Escape")
        reset("Private text hidden. Refresh saved conversations to continue.");
    };
  window.addEventListener("blur", blur);
  window.addEventListener("focus", focus);
  document.addEventListener("visibilitychange", visibility);
  box.addEventListener("keydown", escape);
  const timer = setInterval(() => {
    if (disposed) return;
    if (
      (loaded || busy) &&
      ((loaded && loaded !== scope()) ||
        version !== host.reviewVersion() ||
        !scope())
    )
      reset(
        "Account or device access changed. Refresh saved conversations to continue.",
        false,
      );
    else if ((review && !timed(review)) || (pending && !timed(pending)))
      reset(
        "Review expired. Refresh saved conversations before another action.",
      );
    else if (opened && !usable())
      reset(
        "Conversation access ended. Refresh to review access or export your history.",
      );
    controls();
  }, 500);
  controls();
  return {
    invalidate() {
      reset("Access changed. Refresh saved conversations to continue.", false);
    },
    destroy() {
      if (disposed) return;
      disposed = true;
      generation++;
      host.conversationContentAPI.invalidate();
      wipe();
      clearInterval(timer);
      window.removeEventListener("blur", blur);
      window.removeEventListener("focus", focus);
      document.removeEventListener("visibilitychange", visibility);
      box.removeEventListener("keydown", escape);
      box.remove();
    },
  };
}

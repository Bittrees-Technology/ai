/** Browser transport binds each owner action to the account actually displayed. */
export function browserApi(fetcher, account) {
  return async (path, body) => {
    const ownerId = account();
    const response = await fetcher(path, {
      method: "POST",
      credentials: "same-origin",
      redirect: "error",
      cache: "no-store",
      headers: {
        "Content-Type": "application/json",
        "X-Bittrees-Request": "1",
        ...(ownerId ? { "X-Bittrees-Account": ownerId } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    const data = await response.json();
    if (!response.ok) throw Error(data.error);
    return data;
  };
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export class RemoteWebController {
  state = {
    commandReview: null,
    commandResult: null,
    templates: [],
    templateCursor: null,
    templateDeviceId: null,
    templateReview: null,
    templateResult: null,
    account: null,
    sessionScope: null,
    confirmation: "",
    devices: [],
    deviceCursor: null,
    statuses: [],
    statusCursor: null,
    deviceId: null,
    error: "",
    notice: "",
    busy: false,
  };
  epoch = 0;
  authEpoch = 0;
  activeAction = null;
  authAction = null;
  signingOut = null;
  logoutRequired = false;
  sessionTurn = null;
  constructor(
    api,
    wallet,
    settings,
    changed,
    sessions = null,
    commands = null,
  ) {
    this.api = api;
    this.wallet = wallet;
    this.settings = settings;
    this.changed = changed;
    this.sessions = sessions;
    this.commands = commands;
  }
  set(patch) {
    this.state = { ...this.state, ...patch };
    this.changed(this.state);
  }
  concealed() {
    return {
      commandReview: null,
      commandResult: null,
      templates: [],
      templateCursor: null,
      templateDeviceId: null,
      templateReview: null,
      templateResult: null,
      confirmation: "",
      statuses: [],
      statusCursor: null,
      deviceId: null,
      error: "",
      notice: "",
    };
  }
  hide() {
    this.epoch++;
    this.set(this.concealed());
  }
  // Authentication changes are distinct from ordinary view concealment. Publish
  // the empty scope atomically so a mounted key host can invalidate immediately.
  invalidateSession() {
    this.authEpoch++;
    this.epoch++;
    this.sessionTurn = null;
    this.set({
      ...this.concealed(),
      account: null,
      sessionScope: null,
      devices: [],
      deviceCursor: null,
    });
    return this.authEpoch;
  }
  sessionContext() {
    const { account, sessionScope } = this.state;
    return account &&
      sessionScope &&
      account.expiresAt > Date.now() &&
      (!this.sessions ||
        (this.sessionTurn && this.sessions.current(this.sessionTurn, true)))
      ? { ownerId: account.ownerId, scope: sessionScope }
      : null;
  }
  checkAuth(epoch) {
    if (
      epoch !== this.authEpoch ||
      (this.sessions &&
        this.sessionTurn &&
        !this.sessions.current(this.sessionTurn))
    )
      throw Error("DENIED");
  }
  peerSessionChanged() {
    this.invalidateSession();
    this.set({
      notice:
        "Account access changed in another tab. Refresh your session to continue.",
    });
  }
  async authWork(kind, epoch, fn) {
    if (!this.sessions) return fn();
    return this.sessions.run(
      kind,
      async (turn) => {
        this.checkAuth(epoch);
        this.sessionTurn = turn;
        if (turn.cleanupRequired) await this.clearServerSession();
        this.checkAuth(epoch);
        return fn();
      },
      () => this.checkAuth(epoch),
    );
  }
  acceptSession(account) {
    if (this.sessions) this.sessions.accepted(this.sessionTurn);
    this.set({ account, sessionScope: crypto.randomUUID() });
  }
  sessionAccount(raw) {
    if (
      !raw ||
      typeof raw.ownerId !== "string" ||
      typeof raw.address !== "string" ||
      !uuid.test(raw.ownerId ?? "") ||
      !/^0x[0-9a-f]{40}$/i.test(raw.address ?? "") ||
      raw.chainId !== this.settings.chainId ||
      !Number.isSafeInteger(raw.expiresAt) ||
      raw.expiresAt <= Date.now()
    )
      throw Error("DENIED");
    return {
      ownerId: raw.ownerId,
      address: raw.address,
      chainId: raw.chainId,
      expiresAt: raw.expiresAt,
    };
  }
  act(fn, authentication = false) {
    if (this.state.busy) return Promise.resolve();
    const epoch = this.authEpoch;
    let finish;
    const pending = new Promise((resolve) => {
      finish = resolve;
    });
    this.activeAction = pending;
    if (authentication) this.authAction = pending;
    this.set({ busy: true, error: "", notice: "" });
    void (async () => {
      try {
        this.checkAuth(epoch);
        await fn();
      } catch (e) {
        if (epoch === this.authEpoch)
          this.set({
            error:
              e?.message === "SESSION_STORAGE_REQUIRED"
                ? "This browser must allow local storage and session coordination before you can sign in. Check its privacy settings, then refresh."
                : e?.message === "LOCAL_HISTORY_FULL"
                  ? "Local command history is full. Export and delete saved commands before preparing another request."
                  : e?.message === "STORAGE_UNAVAILABLE"
                    ? "Local command history is unavailable. Restore browser storage access, then refresh saved commands and check the original receipt before retrying."
                    : e?.message === "CAPACITY"
                      ? "The remote service has reached a storage limit. Try again after expired records have been cleaned up or contact the service operator."
                      : e?.message === "DENIED"
                        ? "Your session or device access is unavailable. Sign in again or refresh the device list."
                        : e?.message === "WALLET_REQUIRED"
                          ? "Open this page in a browser with an Ethereum wallet."
                          : e?.message === "CHAIN_MISMATCH"
                            ? "Switch your wallet to the network shown on this page, then sign in again."
                            : "The action could not be completed. Refresh and review before trying again.",
          });
      } finally {
        this.activeAction = null;
        if (authentication) this.authAction = null;
        this.set({ busy: !!this.signingOut });
        finish();
      }
    })();
    return pending;
  }
  async clearServerSession() {
    // A failed cleanup stays sticky: refresh/login must retry it before they can
    // adopt cookies or begin another login. Never claim a remote logout on error.
    this.logoutRequired = true;
    if (this.sessions && this.sessionTurn)
      this.sessions.clearing(this.sessionTurn);
    await this.api("/browser/logout", {});
    this.logoutRequired = false;
    if (this.sessions && this.sessionTurn)
      this.sessions.cleaned(this.sessionTurn);
  }
  async checkWallet(account, epoch) {
    if (!this.wallet?.request) return;
    const addresses = await this.wallet.request({ method: "eth_accounts" });
    this.checkAuth(epoch);
    const chain = await this.wallet.request({ method: "eth_chainId" });
    this.checkAuth(epoch);
    if (
      addresses[0]?.toLowerCase() !== account.address.toLowerCase() ||
      Number(BigInt(chain)) !== account.chainId
    )
      throw Error("DENIED");
  }
  walletChanged() {
    return this.logout();
  }
  async refresh() {
    const epoch = this.invalidateSession();
    return this.act(
      () =>
        this.authWork("refresh", epoch, async () => {
          try {
            if (this.logoutRequired) await this.clearServerSession();
            this.checkAuth(epoch);
            const raw = await this.api("/browser/session", {});
            this.checkAuth(epoch);
            const account = this.sessionAccount(raw);
            await this.checkWallet(account, epoch);
            this.checkAuth(epoch);
            this.acceptSession(account);
          } catch (e) {
            // Sign-out owns cleanup if requested; otherwise invalidate a mismatched
            // or expired server identity before any subsequent attempt can adopt it.
            if (e?.message === "DENIED" && !this.signingOut) {
              await this.clearServerSession();
              return;
            }
            throw e;
          }
        }),
      true,
    );
  }
  async login() {
    if (this.state.busy) return;
    const epoch = this.invalidateSession();
    return this.act(
      () =>
        this.authWork("login", epoch, async () => {
          let verificationStarted = false;
          try {
            if (this.logoutRequired) await this.clearServerSession();
            this.checkAuth(epoch);
            if (!this.wallet?.request) throw Error("WALLET_REQUIRED");
            const [address] = await this.wallet.request({
              method: "eth_requestAccounts",
            });
            this.checkAuth(epoch);
            if (!/^0x[0-9a-f]{40}$/i.test(address ?? "")) throw Error("DENIED");
            const chain = await this.wallet.request({ method: "eth_chainId" });
            this.checkAuth(epoch);
            if (Number(BigInt(chain)) !== this.settings.chainId)
              throw Error("CHAIN_MISMATCH");
            const challenge = await this.api("/browser/login/challenge", {
              address,
            });
            this.checkAuth(epoch);
            const hex =
              "0x" +
              Array.from(new TextEncoder().encode(challenge.message), (x) =>
                x.toString(16).padStart(2, "0"),
              ).join("");
            const signature = await this.wallet.request({
              method: "personal_sign",
              params: [hex, address],
            });
            this.checkAuth(epoch);
            await this.checkWallet(
              { address, chainId: this.settings.chainId },
              epoch,
            );
            this.checkAuth(epoch);
            verificationStarted = true;
            await this.api("/browser/login/verify", {
              message: challenge.message,
              signature,
            });
            this.checkAuth(epoch);
            const raw = await this.api("/browser/session", {});
            this.checkAuth(epoch);
            const account = this.sessionAccount(raw);
            if (account.address.toLowerCase() !== address.toLowerCase())
              throw Error("DENIED");
            await this.checkWallet(account, epoch);
            this.checkAuth(epoch);
            this.acceptSession(account);
            this.set({
              notice:
                "Signed in. Review a pairing request or load your devices.",
            });
          } catch (e) {
            if (verificationStarted && !this.signingOut)
              await this.clearServerSession();
            throw e;
          }
        }),
      true,
    );
  }
  logout() {
    this.invalidateSession();
    this.logoutRequired = true;
    try {
      this.sessions?.cancel();
    } catch {
      this.set({
        error:
          "Local access is cleared, but this browser could not retain the sign-out request. Check storage settings and retry sign-out.",
      });
    }
    if (this.signingOut) return this.signingOut;
    const active = this.authAction;
    // Serialize cookie cleanup after any outstanding verification response. Keep
    // new actions blocked until it settles, including repeated wallet changes.
    const pending = Promise.resolve().then(async () => {
      await active;
      try {
        if (this.sessions)
          await this.sessions.run("logout", async (turn) => {
            this.sessionTurn = turn;
            await this.clearServerSession();
          });
        else await this.clearServerSession();
      } catch {
        this.set({
          error:
            "Local access is cleared, but server sign-out could not be confirmed. Refresh or sign in to retry cleanup.",
        });
      } finally {
        this.signingOut = null;
        this.set({ busy: !!this.activeAction });
      }
    });
    this.signingOut = pending;
    this.set({ busy: true });
    return pending;
  }
  async approve(details, confirmed) {
    if (!confirmed || !this.state.account) return;
    const [id, approvalCode, extra] = details.trim().split(".");
    if (
      extra ||
      !uuid.test(id ?? "") ||
      !/^[A-Za-z0-9_-]{43}$/.test(approvalCode ?? "")
    ) {
      this.set({
        error: "Paste the full pairing details copied from your Mac.",
      });
      return;
    }
    const epoch = this.epoch,
      owner = this.state.account.ownerId;
    return this.act(async () => {
      const result = await this.api("/browser/pairings/approve", {
        id,
        approvalCode,
        confirmed: true,
      });
      if (result.ownerId !== owner) throw Error("DENIED");
      if (epoch === this.epoch)
        this.set({
          confirmation: owner,
          notice:
            "Pairing approved. Copy the account confirmation code back to your Mac.",
        });
    });
  }
  async devices(more = false) {
    if (!this.state.account) return;
    const epoch = this.epoch;
    return this.act(async () => {
      const page = await this.api(
        "/browser/devices",
        more && this.state.deviceCursor
          ? { after: this.state.deviceCursor }
          : {},
      );
      if (epoch !== this.epoch) return;
      this.set({
        notice: page.items.length
          ? ""
          : "No devices are available on this page.",
        commandReview: null,
        templates: [],
        templateCursor: null,
        templateDeviceId: null,
        templateReview: null,
        templateResult: null,
        devices: more ? [...this.state.devices, ...page.items] : page.items,
        deviceCursor: page.nextCursor,
      });
    });
  }
  async statuses(deviceId, more = false) {
    if (!uuid.test(deviceId)) return;
    const epoch = this.epoch;
    return this.act(async () => {
      const page = await this.api("/browser/status", {
        deviceId,
        ...(more && this.state.deviceId === deviceId && this.state.statusCursor
          ? { after: this.state.statusCursor }
          : {}),
      });
      if (epoch === this.epoch)
        this.set({
          commandReview: null,
          deviceId,
          statuses: more ? [...this.state.statuses, ...page.items] : page.items,
          statusCursor: page.nextCursor,
        });
    });
  }
  async controls(deviceId, enable, confirmed) {
    if (!confirmed || !this.state.account) return;
    const device = this.state.devices.find((d) => d.id === deviceId);
    if (!device || device.revoked || device.expiresAt <= Date.now()) return;
    const epoch = this.epoch;
    return this.act(async () => {
      await this.api(
        enable ? "/browser/controls/approve" : "/browser/controls/disable",
        enable
          ? { deviceId, expectedEpoch: device.epoch, confirmed: true }
          : { deviceId },
      );
      if (epoch !== this.epoch) return;
      this.set({
        commandReview: null,
        commandResult: null,
        devices: this.state.devices.map((d) =>
          d.id === deviceId && !enable ? { ...d, controlsEnabled: false } : d,
        ),
        notice: enable
          ? "Approved for five minutes. Return to this Mac and explicitly enable pause/cancel, then refresh devices here."
          : "Remote pause/cancel disabled. Pending commands will no longer be delivered.",
      });
    });
  }
  reviewCommand(taskId, action) {
    if (
      this.state.busy ||
      !this.state.account ||
      !["pause", "cancel"].includes(action)
    )
      return;
    const task = this.state.statuses.find((t) => t.id === taskId);
    const device = this.state.devices.find((d) => d.id === this.state.deviceId);
    if (
      !task ||
      !device?.controlsEnabled ||
      device.revoked ||
      device.expiresAt <= Date.now() ||
      ["completed", "failed", "cancelled", "expired"].includes(task.status) ||
      (action === "pause" && task.status === "paused")
    )
      return;
    const now = Date.now();
    this.set({
      commandResult: null,
      commandReview: {
        id: crypto.randomUUID(),
        deviceId: device.id,
        taskId: task.id,
        command: action,
        expectedRevision: task.revision,
        issuedAt: new Date(now).toISOString(),
        expiresAt: new Date(now + 300000).toISOString(),
      },
    });
  }
  async submitCommand(confirmed) {
    const command = this.state.commandReview,
      epoch = this.epoch;
    if (!confirmed || !command || !this.state.account) return;
    return this.act(async () => {
      if (this.commands) {
        const scope = this.sessionContext();
        if (!scope) throw Error("DENIED");
        const check = () => {
          if (
            epoch !== this.epoch ||
            JSON.stringify(scope) !== JSON.stringify(this.sessionContext())
          )
            throw Error("DENIED");
        };
        const saved = await this.commands.submit(scope.ownerId, command, check);
        check();
        const observed = saved.entries.find((e) => e.command.id === command.id)
          ?.observation?.value;
        if (!observed) throw Error("CONFLICT");
        this.set({
          commandReview: null,
          commandResult: {
            id: command.id,
            state: observed.state,
            receipt: observed.receipt,
          },
          notice:
            "Command outcome saved on this browser. It records the last server receipt; task progress remains separately shared.",
        });
        return;
      }
      await this.api("/browser/commands", { command, confirmed: true });
      if (epoch === this.epoch)
        this.set({
          commandReview: null,
          commandResult: { id: command.id, state: "pending", receipt: null },
          notice:
            "Command queued. The Mac must receive and apply it before the deadline.",
        });
    });
  }
  async commandReceipt() {
    const id = this.state.commandResult?.id,
      epoch = this.epoch;
    if (!id || !this.state.account) return;
    return this.act(async () => {
      if (this.commands) {
        const scope = this.sessionContext();
        if (!scope) throw Error("DENIED");
        const check = () => {
          if (
            epoch !== this.epoch ||
            JSON.stringify(scope) !== JSON.stringify(this.sessionContext())
          )
            throw Error("DENIED");
        };
        const before = await this.commands.history.read(scope.ownerId, check);
        const saved = await this.commands.inspect(
          scope.ownerId,
          before.revision,
          id,
          check,
        );
        check();
        const observed = saved.entries.find((e) => e.command.id === id)
          .observation.value;
        this.set({
          commandResult: {
            id,
            state: observed.state,
            receipt: observed.receipt,
          },
        });
        return;
      }
      const result = await this.api("/browser/commands/receipt", { id });
      if (epoch === this.epoch)
        this.set({
          commandResult: { id, state: result.state, receipt: result.receipt },
        });
    });
  }
  async templates(deviceId, more = false) {
    if (!this.state.account || !uuid.test(deviceId)) return;
    const device = this.state.devices.find((d) => d.id === deviceId);
    if (!device || device.revoked || device.expiresAt <= Date.now()) return;
    const epoch = this.epoch;
    return this.act(async () => {
      const page = await this.api("/browser/templates", {
        deviceId,
        ...(more &&
        this.state.templateDeviceId === deviceId &&
        this.state.templateCursor
          ? { after: this.state.templateCursor }
          : {}),
      });
      if (epoch !== this.epoch) return;
      this.set({
        templates:
          more && this.state.templateDeviceId === deviceId
            ? [...this.state.templates, ...page.items]
            : page.items,
        templateCursor: page.nextCursor,
        templateDeviceId: deviceId,
        templateReview: null,
        templateResult: null,
      });
    });
  }
  reviewTemplate(permissionId, action = "run") {
    if (
      this.state.busy ||
      !this.state.account ||
      !["run", "revoke"].includes(action)
    )
      return;
    const template = this.state.templates.find(
      (t) => t.permissionId === permissionId,
    );
    const device = this.state.devices.find(
      (d) => d.id === this.state.templateDeviceId,
    );
    const now = Date.now();
    if (
      !template ||
      !device ||
      device.revoked ||
      device.expiresAt <= now ||
      template.deviceId !== device.id ||
      template.expiresAt <= now ||
      (action === "run" &&
        (template.submittedRuns >= template.maxRuns ||
          template.approvedAt > now))
    )
      return;
    this.set({
      templateResult: null,
      templateReview: {
        action,
        template: { ...template },
        ...(action === "run"
          ? {
              intent: {
                permissionId,
                command: {
                  id: crypto.randomUUID(),
                  deviceId: device.id,
                  templateId: template.templateId,
                  templateRevision: template.templateRevision,
                  issuedAt: new Date(now).toISOString(),
                  expiresAt: new Date(
                    Math.min(
                      now + 300000,
                      template.expiresAt,
                      device.expiresAt,
                    ),
                  ).toISOString(),
                },
              },
            }
          : {}),
      },
    });
  }
  async submitTemplate(confirmed) {
    const review = this.state.templateReview,
      epoch = this.epoch;
    if (!confirmed || !review || !this.state.account) return;
    return this.act(async () => {
      if (review.action === "revoke") {
        await this.api("/browser/templates/revoke", {
          permissionId: review.template.permissionId,
          confirmed: true,
        });
        if (epoch === this.epoch)
          this.set({
            templateReview: null,
            templateResult: null,
            templates: this.state.templates.filter(
              (t) => t.permissionId !== review.template.permissionId,
            ),
            notice:
              "Permission revoked remotely. Previously delivered work may continue until its local deadline if the Mac is offline.",
          });
      } else {
        await this.api("/browser/templates/run", {
          ...review.intent,
          confirmed: true,
        });
        if (epoch === this.epoch)
          this.set({
            templateReview: null,
            templateResult: {
              permissionId: review.intent.permissionId,
              id: review.intent.command.id,
              state: "pending",
              receipt: null,
            },
            notice:
              "Request queued for delivery. The Mac must check requests before the deadline. A queued task receipt does not mean the work finished.",
          });
      }
    });
  }
  async templateReceipt() {
    const result = this.state.templateResult,
      epoch = this.epoch;
    if (!result || !this.state.account) return;
    return this.act(async () => {
      const receipt = await this.api("/browser/templates/receipt", {
        permissionId: result.permissionId,
        id: result.id,
      });
      if (epoch === this.epoch)
        this.set({ templateResult: { ...result, ...receipt } });
    });
  }
  async revoke(deviceId, confirmed) {
    if (!confirmed || !uuid.test(deviceId)) return;
    return this.act(async () => {
      await this.api("/browser/devices/revoke", { deviceId });
      this.hide();
      this.set({
        devices: this.state.devices.map((d) =>
          d.id === deviceId ? { ...d, revoked: true } : d,
        ),
        notice: "Device revoked. Its stored remote statuses were removed.",
      });
    });
  }
}

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
  constructor(api, wallet, settings, changed) {
    this.api = api;
    this.wallet = wallet;
    this.settings = settings;
    this.changed = changed;
  }
  set(patch) {
    this.state = { ...this.state, ...patch };
    this.changed(this.state);
  }
  hide() {
    this.epoch++;
    this.set({
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
    });
  }
  async act(fn) {
    if (this.state.busy) return;
    this.set({ busy: true, error: "", notice: "" });
    try {
      await fn();
    } catch (e) {
      this.set({
        error:
          e?.message === "CAPACITY"
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
      this.set({ busy: false });
    }
  }
  async checkWallet(account) {
    if (!this.wallet?.request) return;
    const addresses = await this.wallet.request({ method: "eth_accounts" });
    if (!addresses.length) return;
    const chain = await this.wallet.request({ method: "eth_chainId" });
    if (
      addresses[0].toLowerCase() !== account.address.toLowerCase() ||
      Number(BigInt(chain)) !== account.chainId
    ) {
      await this.api("/browser/logout", {});
      throw Error("DENIED");
    }
  }
  async walletChanged() {
    if (!this.state.account) return;
    this.hide();
    this.set({ account: null, devices: [], deviceCursor: null });
    try {
      await this.api("/browser/logout", {});
    } catch {
      this.set({
        error: "Wallet changed. Refresh your session before continuing.",
      });
    }
  }
  async refresh() {
    this.hide();
    const epoch = this.epoch;
    return this.act(async () => {
      try {
        const account = await this.api("/browser/session", {});
        await this.checkWallet(account);
        if (epoch === this.epoch)
          this.set({
            account,
            devices: [],
            deviceCursor: null,
            statuses: [],
            deviceId: null,
            statusCursor: null,
          });
      } catch (e) {
        if (e?.message !== "DENIED") throw e;
        this.set({ account: null, devices: [] });
      }
    });
  }
  async login() {
    return this.act(async () => {
      this.hide();
      this.set({ account: null, devices: [], deviceCursor: null });
      if (!this.wallet?.request) throw Error("WALLET_REQUIRED");
      const [address] = await this.wallet.request({
        method: "eth_requestAccounts",
      });
      const chain = await this.wallet.request({ method: "eth_chainId" });
      if (Number(BigInt(chain)) !== this.settings.chainId)
        throw Error("CHAIN_MISMATCH");
      const challenge = await this.api("/browser/login/challenge", { address });
      const hex =
        "0x" +
        Array.from(new TextEncoder().encode(challenge.message), (x) =>
          x.toString(16).padStart(2, "0"),
        ).join("");
      const signature = await this.wallet.request({
        method: "personal_sign",
        params: [hex, address],
      });
      const [current] = await this.wallet.request({ method: "eth_accounts" });
      const currentChain = await this.wallet.request({ method: "eth_chainId" });
      if (
        current?.toLowerCase() !== address.toLowerCase() ||
        currentChain !== chain
      )
        throw Error("DENIED");
      await this.api("/browser/login/verify", {
        message: challenge.message,
        signature,
      });
      const account = await this.api("/browser/session", {});
      if (
        account.address.toLowerCase() !== address.toLowerCase() ||
        account.chainId !== this.settings.chainId
      )
        throw Error("DENIED");
      await this.checkWallet(account);
      this.set({
        account,
        notice: "Signed in. Review a pairing request or load your devices.",
      });
    });
  }
  async logout() {
    return this.act(async () => {
      this.hide();
      this.set({ account: null, devices: [], deviceCursor: null });
      await this.api("/browser/logout", {});
    });
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

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export class RemoteWebController {
  state = {
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
          e?.message === "DENIED"
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
          deviceId,
          statuses: more ? [...this.state.statuses, ...page.items] : page.items,
          statusCursor: page.nextCursor,
        });
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

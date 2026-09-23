import { BrowserKeyHost } from "../../modules/remote/browser-key-host.js";
import { mountBrowserSetup } from "./browser-setup.js";
import type { BrowserDeviceContext } from "../../modules/remote/browser-device-client.js";
/** Own the asynchronous open and synchronous teardown of one signed-in view. */
export class BrowserSetupMount {
  private stamp: string | null = null;
  private generation = 0;
  private view: ReturnType<typeof mountBrowserSetup> | null = null;
  private opened = false;
  private disposed = false;
  constructor(
    private section: HTMLElement,
    private root: HTMLElement,
    private button: HTMLButtonElement,
    private notice: HTMLElement,
    private context: () => BrowserDeviceContext | null,
  ) {
    this.button.onclick = () => {
      this.opened = true;
      void this.open();
    };
  }
  sync() {
    if (this.disposed) return;
    const next = this.context();
    const stamp = next ? JSON.stringify(next) : null;
    if (stamp === this.stamp) return;
    this.generation++;
    this.view?.destroy();
    this.view = null;
    this.root.replaceChildren();
    this.stamp = stamp;
    this.opened = false;
    this.section.hidden = !stamp;
    this.notice.textContent = "";
    this.button.hidden = false;
    this.button.disabled = !stamp;
  }
  private async open() {
    if (this.disposed || !this.opened || !this.stamp || this.button.disabled)
      return;
    const stamp = this.stamp,
      generation = ++this.generation;
    this.button.disabled = true;
    this.notice.textContent = "Opening recovery controls…";
    try {
      const host = await BrowserKeyHost.open(this.context);
      if (
        this.disposed ||
        generation !== this.generation ||
        JSON.stringify(this.context()) !== stamp
      ) {
        host.close();
        return;
      }
      this.root.replaceChildren();
      this.view = mountBrowserSetup(this.root, host);
      this.button.hidden = true;
      this.notice.textContent = "";
    } catch {
      if (generation !== this.generation || this.disposed) return;
      this.button.disabled = false;
      this.notice.textContent =
        "Recovery controls could not be opened. Check that this browser allows local storage, then try again. Your saved keys have not been deleted.";
    }
  }
  destroy() {
    this.disposed = true;
    this.generation++;
    this.view?.destroy();
    this.view = null;
    this.root.replaceChildren();
    this.button.onclick = null;
    this.section.hidden = true;
  }
}

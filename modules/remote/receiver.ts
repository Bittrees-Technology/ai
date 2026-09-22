import { RemoteClientError } from "./client.js";
type Timer = { cancel(): void };
export type Schedule = (fn: () => void, delay: number) => Timer;
const schedule: Schedule = (fn, delay) => {
  const timer = setTimeout(fn, delay);
  timer.unref();
  return { cancel: () => clearTimeout(timer) };
};
/** One receiver per companion. No requests until start(), and only saved explicit opt-in receives. */
export class RemoteReceiver {
  private timer?: Timer;
  private flight?: Promise<void>;
  private abort?: AbortController;
  private epoch = 0;
  private changing = false;
  private stopped = false;
  private failures = 0;
  private view: {
    state: "off" | "waiting" | "receiving" | "retrying" | "attention";
    lastCheckedAt: number | null;
    nextCheckAt: number | null;
    received: number;
  } = { state: "off", lastCheckedAt: null, nextCheckAt: null, received: 0 };
  constructor(
    private client: {
      readonly running: boolean;
      status(): Promise<{
        backgroundReceiving: boolean;
        controls: string;
      } | null>;
      pollControls(signal?: AbortSignal): Promise<{ receipts: unknown[] }>;
      setReceiving?(enabled: boolean): Promise<void>;
    },
    private schedule: Schedule = schedule,
    private now = Date.now,
  ) {}
  status() {
    return { ...this.view };
  }
  start() {
    if (this.stopped || this.timer || this.flight) return;
    this.queue(0);
  }
  private queue(delay: number) {
    const epoch = this.epoch;
    if (this.view.state !== "retrying") this.view.state = "waiting";
    this.view.nextCheckAt = this.now() + delay;
    this.timer = this.schedule(() => {
      this.timer = undefined;
      if (epoch !== this.epoch || this.stopped) return;
      this.abort = new AbortController();
      this.flight = this.run(epoch, this.abort.signal).finally(() => {
        this.flight = undefined;
        this.abort = undefined;
      });
    }, delay);
  }
  private async run(epoch: number, signal: AbortSignal) {
    try {
      if (this.client.running) {
        this.queue(10000);
        return;
      }
      const status = await this.client.status();
      if (epoch !== this.epoch) return;
      if (!status?.backgroundReceiving) {
        this.view.state = "off";
        this.view.nextCheckAt = null;
        return;
      }
      if (status.controls !== "enabled") {
        this.view.state = "attention";
        this.view.nextCheckAt = null;
        return;
      }
      this.view.state = "receiving";
      this.view.nextCheckAt = null;
      const result = await this.client.pollControls(signal);
      if (epoch !== this.epoch) return;
      this.failures = 0;
      this.view = {
        state: "waiting",
        lastCheckedAt: this.now(),
        nextCheckAt: null,
        received: result.receipts.length,
      };
      this.queue(10000);
    } catch (error) {
      if (epoch !== this.epoch || signal.aborted) return;
      const code = error instanceof RemoteClientError ? error.code : "INTERNAL";
      if (code !== "UNAVAILABLE" && code !== "BUSY") {
        this.view.state = "attention";
        this.view.nextCheckAt = null;
        return;
      }
      this.view.state = "retrying";
      const delay =
        code === "BUSY"
          ? 10000
          : Math.min(60000, 10000 * 2 ** Math.min(this.failures++, 3));
      this.queue(delay);
    }
  }
  /** Stop an in-flight delivery before local mutations; preserves the saved preference. */
  async pause() {
    this.epoch++;
    this.timer?.cancel();
    this.timer = undefined;
    this.abort?.abort();
    await this.flight;
    this.view.state = "off";
    this.view.nextCheckAt = null;
  }
  async configure(enabled: boolean) {
    if (!this.client.setReceiving)
      throw new RemoteClientError("CONTROL_CONFIRMATION_REQUIRED");
    return this.configureWith(
      () => this.client.setReceiving!(enabled),
      enabled,
    );
  }
  /** Drain delivery before persisting a separately reviewed preference. */
  async configureWith(change: () => Promise<void>, restart = true) {
    if (this.changing || this.stopped) throw new RemoteClientError("BUSY");
    this.changing = true;
    try {
      await this.pause();
      await change();
      this.failures = 0;
      if (restart) this.start();
      return this.status();
    } finally {
      this.changing = false;
    }
  }
  async shutdown() {
    this.stopped = true;
    await this.pause();
  }
}

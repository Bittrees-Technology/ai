import { RemoteClientError, type RemoteClient } from "./client.js";
import { RemoteReceiver, type Schedule } from "./receiver.js";
/** Independent opt-in per permission; one bounded pass per tick, in round-robin order. */
export class RemoteTemplateReceiver {
  private receiver: RemoteReceiver;
  private lastPermission: string | undefined;
  constructor(
    private client: Pick<
      RemoteClient,
      "status" | "pollTemplate" | "setTemplateReceiving" | "running"
    >,
    schedule?: Schedule,
    now = Date.now,
  ) {
    this.receiver = new RemoteReceiver(
      {
        get running() {
          return client.running;
        },
        status: async () => {
          const status = await client.status();
          const selected =
            status?.templates.filter((t) => t.backgroundReceiving) ?? [];
          return {
            backgroundReceiving: selected.length > 0,
            controls:
              status?.state === "paired" &&
              selected.some((t) => t.state === "active")
                ? "enabled"
                : "confirmation_required",
          };
        },
        pollControls: async (signal) => {
          const status = await client.status();
          signal?.throwIfAborted();
          const selected =
            status?.state === "paired"
              ? status.templates.filter(
                  (t) => t.backgroundReceiving && t.state === "active",
                )
              : [];
          if (!selected.length)
            throw new RemoteClientError("TEMPLATE_CONFIRMATION_REQUIRED");
          const index = selected.findIndex(
            (t) => t.permissionId === this.lastPermission,
          );
          const next = selected[(index + 1) % selected.length]!;
          this.lastPermission = next.permissionId;
          return client.pollTemplate(next.permissionId, signal);
        },
      },
      schedule,
      now,
    );
  }
  status() {
    return this.receiver.status();
  }
  start() {
    this.receiver.start();
  }
  pause() {
    return this.receiver.pause();
  }
  shutdown() {
    return this.receiver.shutdown();
  }
  configure(permissionId: string, enabled: boolean) {
    return this.receiver.configureWith(() =>
      this.client.setTemplateReceiving(permissionId, enabled),
    );
  }
}

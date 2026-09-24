import { BrowserCommandHistory } from "../../modules/remote/browser-command-history.js";
import { parseRemoteControl } from "../../modules/remote/status.js";
type Check = () => void;
type Api = (path: string, body: unknown) => Promise<unknown>;
/** One explicitly requested operation at a time; persistence is a prerequisite
 * for dispatch, and observation never resends a command. */
export class BrowserCommandJournal {
  constructor(
    readonly history: BrowserCommandHistory,
    private api: Api,
    private now = Date.now,
  ) {}
  async submit(
    owner: string,
    raw: unknown,
    check: Check,
    expectedRevision?: number,
  ) {
    check();
    const command = parseRemoteControl(raw, this.now());
    const before = await this.history.read(owner, check);
    check();
    const prior = before.entries.find((e) => e.command.id === command.id);
    if (
      prior?.observation &&
      (prior.observation.value.state !== "pending" ||
        Date.parse(prior.observation.value.command.expiresAt) <= this.now())
    )
      throw Error("CONFLICT");
    const saved = await this.history
      .reserve(owner, expectedRevision ?? before.revision, command, check)
      .catch((error: unknown) => {
        if (error instanceof Error && error.message === "CAPACITY")
          throw Error("LOCAL_HISTORY_FULL");
        throw error;
      });
    check();
    parseRemoteControl(command, this.now());
    await this.api("/browser/commands", { command, confirmed: true });
    check();
    // A duplicate submission response does not establish pending versus applied.
    // Read the original command's actual receipt before recording an outcome.
    return this.inspect(owner, saved.revision, command.id, check);
  }
  async inspect(owner: string, revision: number, id: string, check: Check) {
    check();
    const saved = await this.history.read(owner, check);
    if (
      saved.revision !== revision ||
      !saved.entries.some((e) => e.command.id === id)
    )
      throw Error("CONFLICT");
    check();
    const response = await this.api("/browser/commands/receipt", { id });
    check();
    return this.history.observe(owner, revision, id, response, check);
  }
}

/** Non-secret coordination only. Server identity checks remain authoritative. */
const storageKey = "bittrees.browser-session.v1";
const lockName = "bittrees.browser-auth.v1";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Record = { version: 1; revision: string; cleanupRequired: boolean };
export type SessionTurn = {
  revision: string;
  kind: "login" | "refresh" | "logout";
  cleanupRequired: boolean;
};
export class BrowserSessionCoordinator {
  private revision = "";
  private closed = false;
  private storageChanged: (event: StorageEvent) => void;
  constructor(private changed: () => void) {
    this.storageChanged = (event) => {
      if (
        event.storageArea !== localStorage ||
        (event.key !== storageKey && event.key !== null)
      )
        return;
      try {
        const next = this.read();
        if (next.revision === this.revision) return;
        this.revision = next.revision;
      } catch {
        /* Corrupt/unavailable storage invalidates local authority. */
      }
      this.changed();
    };
    window.addEventListener("storage", this.storageChanged);
  }
  private read(): Record {
    if (this.closed || !navigator.locks?.request)
      throw Error("SESSION_STORAGE_REQUIRED");
    try {
      const text = localStorage.getItem(storageKey);
      if (!text) {
        // Missing metadata never proves logout completed. Reconcile cookies first.
        const record: Record = {
          version: 1,
          revision: crypto.randomUUID(),
          cleanupRequired: true,
        };
        localStorage.setItem(storageKey, JSON.stringify(record));
        return record;
      }
      const r = JSON.parse(text);
      if (
        !r ||
        r.version !== 1 ||
        typeof r.revision !== "string" ||
        !uuid.test(r.revision) ||
        typeof r.cleanupRequired !== "boolean" ||
        Object.keys(r).length !== 3
      )
        throw Error();
      return r;
    } catch {
      throw Error("SESSION_STORAGE_REQUIRED");
    }
  }
  private write(record: Record) {
    try {
      localStorage.setItem(storageKey, JSON.stringify(record));
    } catch {
      throw Error("SESSION_STORAGE_REQUIRED");
    }
    this.revision = record.revision;
  }
  cancel() {
    this.read();
    this.write({
      version: 1,
      revision: crypto.randomUUID(),
      cleanupRequired: true,
    });
  }
  current(turn: SessionTurn, accepted = false) {
    try {
      const current = this.read();
      return (
        current.revision === turn.revision &&
        (!accepted || !current.cleanupRequired)
      );
    } catch {
      return false;
    }
  }
  accepted(turn: SessionTurn) {
    if (!this.current(turn)) throw Error("DENIED");
    this.write({ version: 1, revision: turn.revision, cleanupRequired: false });
  }
  clearing(turn: SessionTurn) {
    if (!this.current(turn)) return;
    const record = this.read();
    if (record.cleanupRequired) return;
    turn.revision = crypto.randomUUID();
    this.write({ version: 1, revision: turn.revision, cleanupRequired: true });
  }
  cleaned(turn: SessionTurn) {
    // A pending login stays marked until adoption. A crash must reconcile its cookie.
    if (turn.kind !== "login" && this.current(turn)) this.accepted(turn);
  }
  async run<T>(
    kind: SessionTurn["kind"],
    fn: (turn: SessionTurn) => Promise<T>,
    before: () => void = () => {},
  ): Promise<T> {
    this.revision = this.read().revision;
    return navigator.locks.request(lockName, async () => {
      before();
      let current = this.read();
      const cleanupRequired = current.cleanupRequired;
      if (kind === "login") {
        current = {
          version: 1,
          revision: crypto.randomUUID(),
          cleanupRequired: true,
        };
        this.write(current);
      }
      this.revision = current.revision;
      return fn({ revision: current.revision, kind, cleanupRequired });
    });
  }
  close() {
    this.closed = true;
    window.removeEventListener("storage", this.storageChanged);
  }
}

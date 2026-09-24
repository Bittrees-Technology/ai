import {
  BrowserCommandHistory,
  commandHistoryDatabaseName,
} from "../../../modules/remote/browser-command-history.js";
let allowed = true;
let checks = 0,
  denyAt = Infinity;
const check = () => {
  if (!allowed || ++checks >= denyAt) throw Error("DENIED");
};
const store = new BrowserCommandHistory();
const harness = {
  databaseName: commandHistoryDatabaseName,
  allow(value: boolean, after = Infinity) {
    allowed = value;
    checks = 0;
    denyAt = after;
  },
  read(owner: string) {
    return store.read(owner, check);
  },
  reserve(owner: string, revision: number, command: unknown) {
    return store.reserve(owner, revision, command, check);
  },
  observe(owner: string, revision: number, id: string, value: unknown) {
    return store.observe(owner, revision, id, value, check);
  },
  clear(owner: string, revision: number) {
    return store.clear(owner, revision, true, check);
  },
};
declare global {
  interface Window {
    commandHistoryTest: typeof harness;
  }
}
window.commandHistoryTest = harness;

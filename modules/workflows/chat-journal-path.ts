import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  type Stats,
} from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

export const chatJournalApplicationId = 0x42544348;
export const chatJournalVersion = 1;
const owner = () => process.geteuid?.();
const absent = (path: string) => {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
};
const same = (a: Stats, b: Stats) =>
  a.dev === b.dev &&
  a.ino === b.ino &&
  a.uid === b.uid &&
  a.gid === b.gid &&
  a.mode === b.mode;
function privateFile(info: Stats) {
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.uid !== owner() ||
    info.nlink !== 1 ||
    (info.mode & 0o7777) !== 0o600
  )
    throw Error("Unsafe Chat journal file");
}
/** SQLite opens paths, not supplied descriptors. Require an operator-owned 0700 parent,
 * reject unsafe ancestors and retain a no-follow descriptor for identity checks around open.
 * This assumes no hostile same-UID process controls the private directory; it is not an
 * OS isolation boundary against another process with the operator's full filesystem rights.
 */
export function prepareChatJournalPath(path: string) {
  if (owner() === undefined || !isAbsolute(path) || resolve(path) !== path)
    throw Error("Absolute canonical journal path required");
  const parents: { path: string; info: Stats }[] = [];
  for (let p = dirname(path); ; p = dirname(p)) {
    const info = lstatSync(p);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      ![0, owner()].includes(info.uid)
    )
      throw Error("Unsafe Chat journal parent");
    // Root-owned sticky temporary ancestors are acceptable above the private direct parent.
    if (
      (info.mode & 0o022) !== 0 &&
      !(info.uid === 0 && (info.mode & 0o1000) !== 0)
    )
      throw Error("Writable Chat journal ancestor");
    parents.push({ path: p, info });
    if (p === dirname(p)) break;
  }
  const direct = parents[0]!.info;
  if (direct.uid !== owner() || (direct.mode & 0o7777) !== 0o700)
    throw Error("Private owned journal directory required");
  const initial = absent(path);
  const siblings = () => {
    for (const suffix of ["-wal", "-shm", "-journal"]) {
      const info = absent(path + suffix);
      if (info) {
        privateFile(info);
        if (!initial || suffix === "-journal")
          throw Error("Unexpected Chat journal sidecar");
      }
    }
  };
  siblings();
  if (initial) privateFile(initial);
  // EXCL never truncates an existing file. NOFOLLOW is mandatory, including the creation path.
  const fd = openSync(
    path,
    initial
      ? constants.O_RDONLY | constants.O_NOFOLLOW
      : constants.O_RDWR |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
    0o600,
  );
  try {
    const pinned = fstatSync(fd);
    privateFile(pinned);
    if (initial && !same(initial, pinned))
      throw Error("Chat journal changed during open");
    if (initial) {
      const header = Buffer.alloc(100);
      if (
        readSync(fd, header, 0, 100, 0) !== 100 ||
        header.subarray(0, 16).toString("binary") !== "SQLite format 3\0" ||
        header.readUInt32BE(68) !== chatJournalApplicationId ||
        header.readUInt32BE(60) !== chatJournalVersion
      )
        throw Error("Foreign or uninitialized Chat journal");
    }
    if (initial) {
      // Reserved SQLite sidecars must also identify as SQLite WAL/index data before
      // SQLite can open them. Never chmod, truncate or repair an unrelated sibling.
      for (const suffix of ["-wal", "-shm"]) {
        const side = absent(path + suffix);
        if (!side) continue;
        privateFile(side);
        const handle = openSync(
          path + suffix,
          constants.O_RDONLY | constants.O_NOFOLLOW,
        );
        try {
          if (!same(side, fstatSync(handle)))
            throw Error("Chat sidecar changed");
          const header = Buffer.alloc(32);
          const count = readSync(handle, header, 0, 32, 0);
          if (suffix === "-wal") {
            if (
              side.size !== 0 &&
              (count !== 32 ||
                ![0x377f0682, 0x377f0683].includes(header.readUInt32BE(0)))
            )
              throw Error("Foreign Chat WAL");
          } else if (
            side.size < 32768 ||
            side.size % 32768 !== 0 ||
            count !== 32 ||
            ![header.readUInt32LE(0), header.readUInt32BE(0)].includes(3007000)
          )
            throw Error("Foreign Chat WAL index");
        } finally {
          closeSync(handle);
        }
      }
    }
    const assertUnchanged = () => {
      for (const parent of parents)
        if (!same(parent.info, lstatSync(parent.path)))
          throw Error("Chat journal parent changed");
      const current = lstatSync(path);
      privateFile(current);
      if (!same(pinned, current) || !same(pinned, fstatSync(fd)))
        throw Error("Chat journal identity changed");
      siblings();
    };
    assertUnchanged();
    return { created: !initial, assertUnchanged, close: () => closeSync(fd) };
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

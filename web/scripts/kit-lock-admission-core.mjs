import { dirname } from "node:path";
import { checkAdmissionInput, guard, refuse } from "./kit-lock-admission-policy.mjs";

export { KitLockAdmissionError } from "./kit-lock-admission-policy.mjs";

const XFS_MAGIC = 0x58465342n;
const PROC_MAGIC = 0x9fa0n;
const S_IFMT = 0o170000n;
const S_IFDIR = 0o040000n;

const identity = (stat) => `${stat.dev}:${stat.ino}`;
const isDirectory = (stat) => (stat.mode & S_IFMT) === S_IFDIR;

// Environment seam for deterministic tests; production uses kit-lock-admission.mjs.
export function createKitLockAdmission(env) {
  const { fs } = env;

  // Any group or other writable ancestor is refused, sticky or not.
  function checkAncestors(root) {
    for (let path = dirname(root); ; path = dirname(path)) {
      const stat = guard(`lstat ${path}`, () => fs.lstat(path));
      if (!isDirectory(stat)) refuse(`ancestor ${path} is not a directory`);
      if (stat.uid !== 0n && stat.uid !== BigInt(env.euid)) {
        refuse(`ancestor ${path} has untrusted owner`);
      }
      if ((stat.mode & 0o022n) !== 0n) refuse(`ancestor ${path} is group or world writable`);
      if (path === dirname(path)) return;
    }
  }

  // The root must be an owned directory with exactly mode 0700, special bits included.
  function checkRootStat(stat, label) {
    if (!isDirectory(stat)) refuse(`${label} is not a directory`);
    if (stat.uid !== BigInt(env.euid)) refuse(`${label} is not owned by the current user`);
    if ((stat.mode & 0o7777n) !== 0o700n) refuse(`${label} mode is not exactly 0700`);
  }

  function checkProcfs(fd, root, expected) {
    const proc = guard("lstat /proc", () => fs.lstat("/proc"));
    if (!isDirectory(proc)) refuse("/proc is not a directory");
    if (guard("statfs /proc", () => fs.statfsType("/proc")) !== PROC_MAGIC) {
      refuse("/proc is not procfs");
    }
    if (guard("readlink /proc/self", () => fs.readlink("/proc/self")) !== String(env.pid)) {
      refuse("/proc/self is not this process");
    }
    const link = `/proc/self/fd/${fd}`;
    if (guard("readlink descriptor", () => fs.readlink(link)) !== root) {
      refuse("descriptor link does not name the root");
    }
    if (identity(guard("stat descriptor", () => fs.stat(link))) !== expected) {
      refuse("procfs descriptor identity changed");
    }
    return link;
  }

  function verify(root, fd, expected) {
    const opened = guard("fstat root", () => fs.fstat(fd));
    checkRootStat(opened, "root descriptor");
    const id = identity(opened);
    if (expected !== undefined && expected !== id) refuse("root identity changed");
    const link = checkProcfs(fd, root, id);
    checkAncestors(root);
    const before = guard("lstat root", () => fs.lstat(root));
    checkRootStat(before, "root");
    if (identity(before) !== id) refuse("root identity changed");
    for (const target of [root, link]) {
      if (guard("statfs", () => fs.statfsType(target)) !== XFS_MAGIC) refuse("root is not on XFS");
    }
    const after = guard("lstat root", () => fs.lstat(root));
    const afterDescriptor = guard("fstat root", () => fs.fstat(fd));
    checkRootStat(after, "root");
    checkRootStat(afterDescriptor, "root descriptor");
    if (identity(after) !== id || identity(afterDescriptor) !== id) {
      refuse("root identity changed");
    }
    return id;
  }

  return function admit(path) {
    checkAdmissionInput(env, path);
    // Validate ancestors and the root pathname before opening anything.
    checkAncestors(path);
    const initial = guard("lstat root", () => fs.lstat(path));
    checkRootStat(initial, "root");
    const fd = guard("open root", () => fs.open(path));
    let open = true;
    const close = () => {
      if (!open) return;
      open = false;
      fs.close(fd);
    };
    const id = identity(initial);
    // Close on any failure but keep the primary error; a failed cleanup close is attached.
    const closing = (operation) => {
      try {
        return operation();
      } catch (primary) {
        try {
          close();
        } catch (closeError) {
          primary.cleanupError = closeError;
        }
        throw primary;
      }
    };
    return closing(() => {
      verify(path, fd, id);
      return {
        path,
        recheck() {
          if (!open) refuse("handle is closed");
          closing(() => verify(path, fd, id));
        },
        close,
      };
    });
  };
}

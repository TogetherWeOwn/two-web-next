import * as nodeFs from "node:fs";
import { createKitLockAdmission } from "./kit-lock-admission-core.mjs";
export { KitLockAdmissionError } from "./kit-lock-admission-core.mjs";

const { O_RDONLY, O_DIRECTORY, O_NOFOLLOW } = nodeFs.constants;
const flags = O_RDONLY | O_DIRECTORY | O_NOFOLLOW;

/**
 * Internal API for the Kit lock state machine; it takes no lock and installs nothing.
 * Admits an absolute, symlink-free directory with mode exactly 0700 owned by this user,
 * under ancestors that no group or other can write, on exact XFS. Stable root, ancestors
 * and mounts are a cooperative prerequisite: no ABA protection, no physical-media claim.
 * The handle retains an O_DIRECTORY|O_NOFOLLOW descriptor until close(); recheck()
 * re-verifies identity, ancestors, procfs and XFS and closes the handle if it fails.
 * The effective UID must remain stable during admission and for the handle's lifetime.
 */
export const admitKitLockRoot = createKitLockAdmission({
  platform: process.platform,
  nodeVersion: process.versions.node,
  pid: process.pid,
  getEuid: () => (typeof process.geteuid === "function" ? process.geteuid() : -1),
  fs: {
    lstat: (path) => nodeFs.lstatSync(path, { bigint: true }),
    fstat: (fd) => nodeFs.fstatSync(fd, { bigint: true }),
    stat: (path) => nodeFs.statSync(path, { bigint: true }),
    statfsType: (path) => nodeFs.statfsSync(path, { bigint: true }).type,
    readlink: nodeFs.readlinkSync,
    open: (path) => nodeFs.openSync(path, flags),
    close: nodeFs.closeSync,
  },
});

import assert from "node:assert/strict";
import {
  closeSync,
  constants,
  fstatSync,
  mkdtempSync,
  openSync,
  renameSync,
  rmSync,
  statfsSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { admitKitLockRoot, KitLockAdmissionError } from "../web/scripts/kit-lock-admission.mjs";

const {
  XFS_FIXTURE_ROOT: root,
  XFS_FIXTURE_ALIAS: alias,
  XFS_FIXTURE_NON_XFS: nested,
} = process.env;
assert.ok(root && alias && nested, "fixture paths are required");
const xfs = 0x58465342;
const tmpfs = 0x01021994;

for (const path of [root, alias, nested]) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    const pathname = statSync(path);
    const descriptor = fstatSync(fd);
    assert.equal(pathname.dev, descriptor.dev);
    assert.equal(pathname.ino, descriptor.ino);
    const expected = path === nested ? tmpfs : xfs;
    const pathnameType = statfsSync(path).type;
    const descriptorType = statfsSync(`/proc/self/fd/${fd}`).type;
    assert.equal(pathnameType, expected);
    assert.equal(descriptorType, expected);
    if (path === nested) {
      // The fixture makes the tmpfs root owned by this user with mode 0700, so only the
      // filesystem type can refuse it.
      assert.throws(
        () => admitKitLockRoot(path),
        (error) =>
          error instanceof KitLockAdmissionError && /root is not on XFS/.test(error.message),
      );
    } else {
      const admitted = admitKitLockRoot(path);
      admitted.recheck();
      admitted.close();
    }
    console.log(
      `${path === root ? "root" : path === alias ? "alias" : "nested"}: pathname and descriptor statfs=0x${expected.toString(16)}`,
    );
  } finally {
    closeSync(fd);
  }
}
assert.equal(statSync(root).dev, statSync(alias).dev);
assert.equal(statSync(root).ino, statSync(alias).ino);

// A retained handle fails closed when its root is renamed away, and a fresh admission works.
const sub = mkdtempSync(join(root, "lock-"));
try {
  const handle = admitKitLockRoot(sub);
  renameSync(sub, `${sub}-moved`);
  assert.throws(() => handle.recheck(), KitLockAdmissionError);
  assert.throws(() => handle.recheck(), /closed/);
  renameSync(`${sub}-moved`, sub);
  const fresh = admitKitLockRoot(sub);
  fresh.recheck();
  fresh.close();
} finally {
  rmSync(sub, { recursive: true, force: true });
  rmSync(`${sub}-moved`, { recursive: true, force: true });
}
if (process.argv[2] === "fail") process.exitCode = 42;

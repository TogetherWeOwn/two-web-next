import assert from "node:assert/strict";
import { closeSync, constants, fstatSync, openSync, statfsSync, statSync } from "node:fs";

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
    console.log(
      `${path === root ? "root" : path === alias ? "alias" : "nested"}: pathname and descriptor statfs=0x${expected.toString(16)}`,
    );
  } finally {
    closeSync(fd);
  }
}
assert.equal(statSync(root).dev, statSync(alias).dev);
assert.equal(statSync(root).ino, statSync(alias).ino);
if (process.argv[2] === "fail") process.exitCode = 42;

// Read-only composition: authenticated archive, bounded data-only inspection and
// a fresh named native version. Neither a rollback nor permanent retention.
import assert from "node:assert/strict";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyPureHonoArchiveContents } from "./pure-hono-archive-contents.mjs";
import { downloadPureHonoArchive } from "./pure-hono-archive.mjs";
import { readPureHonoVersion } from "./pure-hono-rollback.mjs";

function boundedFile(path, limit) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    assert.ok(stat.isFile() && stat.size > 0 && stat.size <= limit);
    const bytes = readFileSync(fd);
    assert.ok(bytes.length > 0 && bytes.length <= limit);
    assert.equal(bytes.length, stat.size);
    return bytes;
  } finally {
    closeSync(fd);
  }
}

export async function verifyArchivedPureHonoRollback(
  pointer,
  { artifactId, token, directory, expectedVersionId },
  {
    download = downloadPureHonoArchive,
    readVersion = readPureHonoVersion,
    verifyContents = verifyPureHonoArchiveContents,
  } = {},
) {
  try {
    assert.match(
      expectedVersionId,
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    assert.equal(pointer?.versionId, expectedVersionId);
    assert.ok(isAbsolute(directory));
    assert.equal(realpathSync(directory), directory);
    const stat = lstatSync(directory);
    assert.ok(stat.isDirectory() && !stat.isSymbolicLink());
    assert.equal(stat.uid, process.getuid());
    assert.equal(stat.mode & 0o777, 0o700);
    assert.deepEqual(readdirSync(directory), []);
    const destination = join(directory, "rollback.zip");
    const transport = await download(pointer, { artifactId, token, destination });
    const archive = boundedFile(destination, 64 * 1024 * 1024);
    const nativeVersion = await readVersion(expectedVersionId);
    const receipt = await verifyContents(pointer, archive, transport, nativeVersion);
    writeFileSync(join(directory, "verified.json"), `${JSON.stringify(receipt, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    return receipt;
  } catch {
    // Never expose downloaded content, signed URLs, native bindings or tokens.
    throw new Error("archived pure-Hono rollback verification failed");
  }
}

async function main() {
  const [pointerPath, artifactId, directory, ...extra] = process.argv.slice(2);
  assert.ok(pointerPath && artifactId && directory && !extra.length);
  const pointer = JSON.parse(boundedFile(pointerPath, 16 * 1024).toString("utf8"));
  await verifyArchivedPureHonoRollback(pointer, {
    artifactId,
    token: process.env.GITHUB_TOKEN,
    directory,
    expectedVersionId: process.env.ROLLBACK_VERSION_ID,
  });
  console.log("archived pure-Hono rollback verified (read-only; no retention guarantee)");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    console.error("::error::archived pure-Hono rollback verification failed");
    process.exitCode = 1;
  });
}

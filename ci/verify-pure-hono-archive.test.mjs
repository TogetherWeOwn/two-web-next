import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { verifyArchivedPureHonoRollback } from "./verify-pure-hono-archive.mjs";

const FAILURE = "archived pure-Hono rollback verification failed";
const SECRET = "ghs_secret_token_value";
const ZIP = Buffer.from("PK-fake-archive-bytes");
const VERSION = "123e4567-e89b-42d3-a456-426614174000";
const pointer = { runId: "123", runAttempt: "1", sourceSha: "a".repeat(40), versionId: VERSION };
const transportReceipt = { digest: "sha256:abc", bytes: ZIP.length };
const nativeVersion = { id: VERSION, secret: "native-body" };
const contentsReceipt = { verified: true, files: 3 };

let root;
let directory;
let calls;

const mode = (path) => statSync(path).mode & 0o777;

// Builds fake collaborators that record their call order and arguments.
function makeDeps(overrides = {}) {
  return {
    download: async (ptr, options) => {
      calls.push(["download", ptr, options]);
      writeFileSync(options.destination, ZIP, { mode: 0o600 });
      return transportReceipt;
    },
    readVersion: async (versionId) => {
      calls.push(["readVersion", versionId]);
      return nativeVersion;
    },
    verifyContents: async (...args) => {
      calls.push(["verifyContents", ...args]);
      return contentsReceipt;
    },
    ...overrides,
  };
}

const run = (deps = makeDeps(), dir = directory, extra = {}) =>
  verifyArchivedPureHonoRollback(
    pointer,
    { artifactId: "999", token: SECRET, directory: dir, expectedVersionId: VERSION, ...extra },
    deps,
  );

async function assertSanitizedFailure(promise) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.message, FAILURE);
    assert.ok(!String(error.stack).includes(SECRET));
    assert.equal(error.cause, undefined);
    return true;
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "verify-archive-"));
  directory = join(root, "work");
  mkdirSync(directory, { mode: 0o700 });
  chmodSync(directory, 0o700);
  calls = [];
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("verifyArchivedPureHonoRollback", () => {
  test("composes download, native read and content verification in order", async () => {
    const receipt = await run();

    assert.deepEqual(
      calls.map(([name]) => name),
      ["download", "readVersion", "verifyContents"],
    );
    const [, downloadPointer, downloadOptions] = calls[0];
    assert.equal(downloadPointer, pointer);
    assert.deepEqual(downloadOptions, {
      artifactId: "999",
      token: SECRET,
      destination: join(directory, "rollback.zip"),
    });
    assert.equal(calls[1][1], VERSION);
    const [, verifyPointer, archive, transport, native] = calls[2];
    assert.equal(verifyPointer, pointer);
    assert.ok(Buffer.isBuffer(archive));
    assert.deepEqual(archive, ZIP);
    assert.equal(transport, transportReceipt);
    assert.equal(native, nativeVersion);
    assert.equal(receipt, contentsReceipt);
  });

  test("writes the receipt privately and exclusively next to the zip", async () => {
    await run();

    assert.deepEqual(readdirSync(directory).sort(), ["rollback.zip", "verified.json"]);
    assert.deepEqual(
      JSON.parse(readFileSync(join(directory, "verified.json"), "utf8")),
      contentsReceipt,
    );
    assert.equal(mode(join(directory, "verified.json")), 0o600);
    assert.equal(mode(join(directory, "rollback.zip")), 0o600);
  });

  test("rejects unsafe directories before any download", async () => {
    const file = join(root, "file");
    writeFileSync(file, "x");
    const link = join(root, "link");
    symlinkSync(directory, link);
    const open = join(root, "open");
    mkdirSync(open, { mode: 0o755 });
    chmodSync(open, 0o755);
    const stale = join(root, "stale");
    mkdirSync(stale, { mode: 0o700 });
    writeFileSync(join(stale, "verified.json"), "{}");

    for (const dir of ["relative/dir", join(root, "missing"), file, link, open, stale, undefined]) {
      await assertSanitizedFailure(run(makeDeps(), directory, { directory: dir }));
    }
    assert.deepEqual(calls, []);
    assert.equal(readFileSync(join(stale, "verified.json"), "utf8"), "{}");
  });

  test("rejects a missing, mismatched or malformed expected version before any call", async () => {
    const other = "223e4567-e89b-42d3-a456-426614174000";
    for (const expectedVersionId of [undefined, other, VERSION.toUpperCase(), "ver-1", 7]) {
      await assertSanitizedFailure(run(makeDeps(), directory, { expectedVersionId }));
    }
    assert.deepEqual(calls, []);
    assert.deepEqual(readdirSync(directory), []);
  });

  test("stops at the first failure and sanitizes the error", async () => {
    const cases = [
      ["download", ["download"]],
      ["readVersion", ["download", "readVersion"]],
      ["verifyContents", ["download", "readVersion", "verifyContents"]],
    ];

    for (const [failing, expected] of cases) {
      calls = [];
      for (const name of readdirSync(directory)) rmSync(join(directory, name));
      const deps = makeDeps();
      const real = deps[failing];
      deps[failing] = async (...args) => {
        await real(...args);
        throw Object.assign(new Error(`leaked ${SECRET}`), { cause: new Error(SECRET) });
      };
      await assertSanitizedFailure(run(deps));
      assert.deepEqual(
        calls.map(([name]) => name),
        expected,
      );
      assert.ok(!readdirSync(directory).includes("verified.json"));
    }
  });

  test("leaves no receipt when any step fails", async () => {
    await assertSanitizedFailure(
      run(makeDeps({ verifyContents: async () => Promise.reject(new Error("bad")) })),
    );
    assert.ok(!readdirSync(directory).includes("verified.json"));
  });

  test("rejects a missing, symlinked or oversized saved zip", async () => {
    const outside = join(root, "outside.zip");
    writeFileSync(outside, ZIP);
    const saves = [
      () => {},
      (dest) => symlinkSync(outside, dest),
      (dest) => {
        writeFileSync(dest, "", { mode: 0o600 });
        truncateSync(dest, 64 * 1024 * 1024 + 1);
      },
    ];

    for (const save of saves) {
      calls = [];
      for (const name of readdirSync(directory)) rmSync(join(directory, name));
      const deps = makeDeps({
        download: async (_ptr, { destination }) => {
          save(destination);
          return transportReceipt;
        },
      });
      await assertSanitizedFailure(run(deps));
      assert.deepEqual(calls, []);
    }
  });

  test("CLI refuses malformed, oversized or linked pointers without exposing credentials", () => {
    const good = join(root, "pointer.json");
    writeFileSync(good, JSON.stringify(pointer));
    const linked = join(root, "linked.json");
    symlinkSync(good, linked);
    const oversized = join(root, "oversized.json");
    writeFileSync(oversized, " ".repeat(16 * 1024 + 1));
    const malformed = join(root, "malformed.json");
    writeFileSync(malformed, SECRET);
    const script = new URL("./verify-pure-hono-archive.mjs", import.meta.url).pathname;
    for (const args of [[], [linked], [oversized], [malformed], [good]]) {
      const result = spawnSync(process.execPath, [script, ...args, "999", directory], {
        encoding: "utf8",
        timeout: 10_000,
        env: { GITHUB_TOKEN: SECRET, ROLLBACK_VERSION_ID: "wrong" },
      });
      assert.equal(result.status, 1);
      assert.equal(result.stdout, "");
      assert.equal(result.stderr, `::error::${FAILURE}\n`);
      assert.deepEqual(readdirSync(directory), []);
    }
  });

  test("refuses to overwrite a receipt created during verification", async () => {
    const deps = makeDeps({
      verifyContents: async () => {
        writeFileSync(join(directory, "verified.json"), "planted");
        return contentsReceipt;
      },
    });

    await assertSanitizedFailure(run(deps));
    assert.equal(readFileSync(join(directory, "verified.json"), "utf8"), "planted");
  });
});

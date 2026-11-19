import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { KitLockAdmissionError } from "../web/scripts/kit-lock-admission.mjs";
import { withKitLock } from "../web/scripts/kit-lock.mjs";

const root = process.env.XFS_FIXTURE_ROOT;
const alias = process.env.XFS_FIXTURE_ALIAS;
const nonXfs = process.env.XFS_FIXTURE_NON_XFS;
assert.ok(root && alias && nonXfs, "fixture paths are required");
const lock = join(root, ".kit-install.lock");

if (process.argv[2] === "child") {
  try {
    await withKitLock(root, async () => {
      process.send("holding");
      await new Promise((resolve, reject) => {
        const onMessage = () => {
          process.off("disconnect", onDisconnect);
          resolve();
        };
        const onDisconnect = () => {
          process.off("message", onMessage);
          reject(new Error("parent disconnected"));
        };
        process.once("message", onMessage);
        process.once("disconnect", onDisconnect);
      });
    });
    process.send("released");
  } catch (error) {
    if (process.connected) process.send({ error: String(error) });
    process.exitCode = 1;
  }
  if (process.connected) process.disconnect();
} else {
  let called = false;
  await assert.rejects(
    withKitLock(nonXfs, () => {
      called = true;
    }),
    (error) => error instanceof KitLockAdmissionError && /root is not on XFS/.test(error.message),
  );
  assert.equal(called, false);

  const child = fork(fileURLToPath(import.meta.url), ["child"], {
    stdio: ["ignore", "inherit", "inherit", "ipc"],
  });
  const messages = [];
  let notify;
  const enqueue = (message) => {
    messages.push(message);
    notify?.();
  };
  child.on("message", enqueue);
  child.on("error", (error) => enqueue({ error: String(error) }));
  const exited = new Promise((resolve) =>
    child.once("close", (code, signal) => {
      const result = { code, signal };
      enqueue(result);
      resolve(result);
    }),
  );
  const next = async () => {
    if (!messages.length) {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          notify = undefined;
          reject(new Error("child message timed out"));
        }, 15000);
        notify = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      notify = undefined;
    }
    return messages.shift();
  };
  try {
    assert.equal(await next(), "holding");
    assert.equal(existsSync(lock), true);
    await assert.rejects(
      withKitLock(alias, () => {
        called = true;
      }),
      { code: "EEXIST" },
    );
    assert.equal(called, false);
    child.send("release");
    assert.equal(await next(), "released");
    assert.deepEqual(await next(), { code: 0, signal: null });
    assert.equal(existsSync(lock), false);

    const operationError = new Error("operation failed");
    await assert.rejects(
      withKitLock(
        root,
        async () => {
          throw operationError;
        },
        async (error) => {
          assert.equal(error, operationError);
          assert.equal(existsSync(lock), true);
          await assert.rejects(
            withKitLock(alias, () => {}),
            { code: "EEXIST" },
          );
        },
      ),
      (error) => error === operationError,
    );
    assert.equal(existsSync(lock), false);

    const rollbackError = new Error("rollback failed");
    await assert.rejects(
      withKitLock(
        root,
        async () => {
          writeFileSync(join(lock, "unexpected"), "retained");
          throw operationError;
        },
        async () => {
          throw rollbackError;
        },
      ),
      (error) => {
        assert.ok(error instanceof AggregateError);
        assert.equal(error.errors[0], operationError);
        assert.equal(error.errors[1], rollbackError);
        assert.equal(error.errors[2].code, "ENOTEMPTY");
        return true;
      },
    );
    assert.equal(existsSync(join(lock, "unexpected")), true);
    rmSync(lock, { recursive: true });

    mkdirSync(lock);
    await assert.rejects(
      withKitLock(root, () => {}),
      { code: "EEXIST" },
    );
    assert.equal(existsSync(lock), true);
    rmSync(lock, { recursive: true });

    await assert.rejects(
      withKitLock(root, async () => {
        renameSync(lock, `${lock}-original`);
        mkdirSync(lock);
      }),
      /kit lock failed/,
    );
    assert.equal(existsSync(lock), true);
    assert.equal(existsSync(`${lock}-original`), true);
    rmSync(lock, { recursive: true });
    rmSync(`${lock}-original`, { recursive: true });
    assert.equal(await withKitLock(root, async () => "reacquired"), "reacquired");
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    let timer;
    try {
      await Promise.race([
        exited,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("child cleanup timed out")), 15000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
}

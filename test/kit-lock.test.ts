import { describe, expect, it } from "vitest";
import { createKitLock } from "../web/scripts/kit-lock.mjs";

function fixture() {
  let inode: bigint | undefined;
  let sequence = 0n;
  let checks = 0;
  let failCheck = 0;
  let failClose = false;
  let failRemove = false;
  let replaceOnSecondStat = false;
  let stats = 0;
  const events: string[] = [];
  const run = createKitLock({
    admit: (path) => {
      let closed = false;
      return {
        path,
        recheck() {
          events.push("check");
          if (closed) throw new Error("handle closed");
          if (++checks === failCheck) {
            closed = true;
            throw new Error("admission changed");
          }
        },
        close() {
          if (closed) return;
          closed = true;
          events.push("close");
          if (failClose) throw new Error("close failed");
        },
      };
    },
    mkdir: (_path, options) => {
      expect(options.mode).toBe(0o700);
      if (inode !== undefined) throw new Error("EEXIST");
      inode = ++sequence;
      events.push("acquire");
    },
    lstat: () => {
      if (++stats === 2 && replaceOnSecondStat) inode = ++sequence;
      if (inode === undefined) throw new Error("ENOENT");
      return { dev: 1n, ino: inode, isDirectory: () => true, isSymbolicLink: () => false };
    },
    rmdir: () => {
      events.push("release");
      if (failRemove) throw new Error("remove failed");
      inode = undefined;
    },
  });
  return {
    run,
    events,
    replace: () => {
      inode = ++sequence;
    },
    present: () => inode !== undefined,
    replaceBeforeOperation: () => {
      replaceOnSecondStat = true;
    },
    failCheck: (at: number) => {
      failCheck = at;
    },
    failClose: () => {
      failClose = true;
    },
    failRemove: () => {
      failRemove = true;
    },
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("inactive Kit lock state machine", () => {
  it("excludes contenders through the callback and awaited rollback", async () => {
    const f = fixture();
    const entered = deferred();
    const continueRollback = deferred();
    const failed = new Error("operation");
    const first = f.run(
      "/root",
      async () => {
        throw failed;
      },
      async (error) => {
        expect(error).toBe(failed);
        entered.resolve();
        await continueRollback.promise;
      },
    );
    await entered.promise;
    await expect(f.run("/root", () => 2)).rejects.toThrow("EEXIST");
    expect(f.present()).toBe(true);
    continueRollback.resolve();
    await expect(first).rejects.toBe(failed);
    expect(f.present()).toBe(false);
    await expect(f.run("/root", () => 3)).resolves.toBe(3);
  });

  it("excludes a contender during a successful asynchronous operation", async () => {
    const f = fixture();
    const entered = deferred();
    const resume = deferred();
    const first = f.run("/root", async () => {
      entered.resolve();
      await resume.promise;
      return 42;
    });
    await entered.promise;
    await expect(f.run("/root", () => 0)).rejects.toThrow("EEXIST");
    expect(f.present()).toBe(true);
    resume.resolve();
    await expect(first).resolves.toBe(42);
    await expect(f.run("/root", () => 7)).resolves.toBe(7);
  });

  it("refuses a replacement before the operation", async () => {
    const f = fixture();
    f.replaceBeforeOperation();
    let called = false;
    await expect(
      f.run("/root", () => {
        called = true;
      }),
    ).rejects.toThrow("kit lock failed");
    expect(called).toBe(false);
    expect(f.present()).toBe(true);
    expect(f.events).not.toContain("release");
  });

  it("does not steal existing or stale locks", async () => {
    const f = fixture();
    f.replace();
    let called = false;
    await expect(
      f.run("/root", () => {
        called = true;
      }),
    ).rejects.toThrow("EEXIST");
    expect(called).toBe(false);
    expect(f.present()).toBe(true);
    expect(f.events).not.toContain("release");
  });

  it("preserves replacement instead of releasing it", async () => {
    const f = fixture();
    await expect(f.run("/root", () => f.replace())).rejects.toThrow("kit lock failed");
    expect(f.present()).toBe(true);
    expect(f.events).not.toContain("release");
  });

  it("fails closed on recheck failure and closes the admission handle", async () => {
    const f = fixture();
    f.failCheck(2);
    let thrown: unknown;
    try {
      await f.run("/root", () => {
        throw new Error("must not run");
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AggregateError);
    expect((thrown as AggregateError).errors.map((error: Error) => error.message)).toEqual([
      "admission changed",
      "handle closed",
    ]);
    expect(f.present()).toBe(true);
    expect(f.events).not.toContain("release");
  });

  it("preserves operation, rollback, release and close errors in order", async () => {
    const f = fixture();
    const operation = new Error("operation");
    const rollback = new Error("rollback");
    f.failRemove();
    f.failClose();
    let thrown: unknown;
    try {
      await f.run(
        "/root",
        () => {
          throw operation;
        },
        () => {
          throw rollback;
        },
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AggregateError);
    const errors = (thrown as AggregateError).errors;
    expect(errors[0]).toBe(operation);
    expect(errors[1]).toBe(rollback);
    expect(errors.slice(2).map((error: Error) => error.message)).toEqual([
      "remove failed",
      "close failed",
    ]);
    expect(f.present()).toBe(true);
  });
});

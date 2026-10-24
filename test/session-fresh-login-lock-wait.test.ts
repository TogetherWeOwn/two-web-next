// Bounded fresh-login lock wait: a holder that never settles its tail (for
// example a disconnect-cancelled callback) must not wedge later same-user
// logins on the isolate indefinitely. The waiter proceeds after
// FRESH_LOGIN_LOCK_WAIT_MS; FIFO order is preserved for settled holders and
// different users never wait on each other. Unit-level proof only —
// overlapping-issuance end states are pinned in
// test/session-overlapping-signin.test.ts (acceptance-owned).
import { describe, expect, it } from "vitest";
import { withFreshLoginUserLock } from "../src/index";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("withFreshLoginUserLock bounded wait", () => {
  it("a waiter proceeds after the bound when the holder never settles", async () => {
    let releaseHolder!: () => void;
    const holderGate = new Promise<void>((resolve) => {
      releaseHolder = resolve;
    });
    const order: string[] = [];
    const holder = withFreshLoginUserLock("u-bound", async () => {
      order.push("holder-start");
      await holderGate;
      order.push("holder-done");
      return "holder";
    });
    // Let the holder acquire before the waiter queues.
    await sleep(10);
    let waiterStarted = false;
    const waiter = withFreshLoginUserLock(
      "u-bound",
      async () => {
        waiterStarted = true;
        return "waiter";
      },
      50,
    );
    const waiterResult = await waiter;
    expect(waiterResult).toBe("waiter");
    // The waiter ran while the holder was still pending: bounded, not wedged.
    expect(waiterStarted).toBe(true);
    expect(order).toEqual(["holder-start"]);
    releaseHolder();
    expect(await holder).toBe("holder");
    expect(order).toEqual(["holder-start", "holder-done"]);
  });

  it("settled holders keep FIFO order and release the key", async () => {
    const order: string[] = [];
    const first = withFreshLoginUserLock("u-fifo", async () => {
      await sleep(30);
      order.push("first");
    });
    const second = withFreshLoginUserLock("u-fifo", async () => {
      order.push("second");
    });
    await Promise.all([first, second]);
    expect(order).toEqual(["first", "second"]);
    // Key released: a later issuance runs immediately.
    let ran = false;
    await withFreshLoginUserLock("u-fifo", async () => {
      ran = true;
    });
    expect(ran).toBe(true);
  });

  it("different users never wait on each other", async () => {
    let releaseA!: () => void;
    const gateA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    const pendingA = withFreshLoginUserLock("u-a", () => gateA);
    await sleep(10);
    let bRan = false;
    await withFreshLoginUserLock("u-b", async () => {
      bRan = true;
    });
    expect(bRan).toBe(true);
    releaseA();
    await pendingA;
  });
});

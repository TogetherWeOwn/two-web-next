import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { URL as NodeURL } from "node:url";
import { describe, expect, it, vi } from "vitest";

// Executes the shipped island binder against a fake DOM, then lets each test
// resolve or reject deferred Clipboard.writeText promises in any order.
const binder = readFileSync(new NodeURL("../public/islands/copy-link.js", import.meta.url), "utf8");
const canonical = "https://next.example.test/e/01ARZ3NDEKTSV4RRFFQ69G5FAV";
const feedCanonical = "https://next.example.test/events.ics";
const copiedText = "Event link copied.";
const failedText = "That link didn't copy — copy it from the address bar.";

type Click = { button: number; preventDefault: () => void };
type Deferred = { promise: Promise<void>; resolve: () => void; reject: (err: unknown) => void };

function deferred(): Deferred {
  let resolve!: () => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// Enough microtask turns for a settled writeText to run the whole copy() tail.
async function settle() {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

function browser(opts: { copied?: boolean; feed?: boolean; clipboard?: boolean } = {}) {
  const toast = { textContent: "" };
  const active = { focus: vi.fn() };
  const selection = {
    rangeCount: 0,
    getRangeAt: vi.fn(),
    removeAllRanges: vi.fn(),
    addRange: vi.fn(),
  };
  const field = {
    value: "",
    className: "",
    tabIndex: 0,
    setAttribute: vi.fn(),
    select: vi.fn(),
    remove: vi.fn(),
  };
  const attributes = new Map([["data-copy-link", opts.feed ? feedCanonical : canonical]]);
  if (opts.feed) attributes.set("data-copy-feed", "");
  let click: (e: Click) => void = () => {};
  const link = {
    getAttribute: (key: string) => attributes.get(key),
    setAttribute: (key: string, value: string) => attributes.set(key, value),
    addEventListener: (kind: string, fn: (e: Click) => void) => {
      if (kind === "click") click = fn;
    },
  };
  const writes: Deferred[] = [];
  const writeText = vi.fn(() => {
    const d = deferred();
    writes.push(d);
    return d.promise;
  });
  const exec = vi.fn(() => opts.copied ?? true);
  let timerId = 0;
  const timers = new Map<number, () => void>();
  const setTimeout = vi.fn((fn: () => void, _ms: number) => {
    timers.set(++timerId, fn);
    return timerId;
  });
  const clearTimeout = vi.fn((id: number) => {
    timers.delete(id);
  });
  runInNewContext(binder, {
    document: {
      querySelector: (selector: string) => (selector === "[data-copy-link]" ? link : toast),
      activeElement: active,
      createElement: () => field,
      body: { appendChild: vi.fn() },
      execCommand: exec,
    },
    window: { getSelection: () => selection },
    navigator: opts.clipboard === false ? {} : { clipboard: { writeText } },
    setTimeout,
    clearTimeout,
  });
  return {
    toast,
    active,
    field,
    exec,
    writeText,
    writes,
    timers,
    setTimeout,
    clearTimeout,
    click() {
      click({ button: 0, preventDefault: vi.fn() });
    },
    runTimer: (call: number) => setTimeout.mock.calls[call]![0](),
  };
}

describe("Copy-link attempt ordering", () => {
  it("keeps the newer success when the older pending writeText rejects afterwards", async () => {
    const b = browser();
    b.click(); // attempt 1, pending
    b.click(); // attempt 2, pending
    expect(b.writeText).toHaveBeenCalledTimes(2);

    b.writes[1]!.resolve(); // newer attempt succeeds first
    await settle();
    expect(b.toast.textContent).toBe(copiedText);
    expect(b.timers.size).toBe(1);

    b.writes[0]!.reject(new Error("denied")); // stale attempt fails late
    await settle();
    expect(b.toast.textContent).toBe(copiedText);
    expect(b.exec).not.toHaveBeenCalled(); // stale failure never ran the fallback
    expect(b.field.remove).not.toHaveBeenCalled();
    expect(b.active.focus).not.toHaveBeenCalled();
    expect(b.timers.size).toBe(1); // no extra reset timer armed over the newer toast
    expect(b.clearTimeout).toHaveBeenCalledTimes(3);

    b.timers.values().next().value!(); // surviving timer belongs to attempt 2
    await settle();
    expect(b.toast.textContent).toBe("");
  });

  it("keeps the newer failure when the older pending writeText resolves afterwards", async () => {
    const b = browser({ copied: false });
    b.click(); // attempt 1, pending
    b.click(); // attempt 2, pending

    b.writes[1]!.reject(new Error("denied")); // newer attempt fails first
    await settle();
    expect(b.exec).toHaveBeenCalledTimes(1); // latest attempt owns the fallback
    expect(b.toast.textContent).toBe(failedText);
    expect(b.timers.size).toBe(1);

    b.writes[0]!.resolve(); // stale attempt succeeds late
    await settle();
    expect(b.toast.textContent).toBe(failedText); // stale success must not overwrite
    expect(b.timers.size).toBe(1);
    expect(b.clearTimeout).toHaveBeenCalledTimes(3);
    expect(b.setTimeout).toHaveBeenCalledTimes(3);
  });

  it("gives three rapid clicks to the last attempt regardless of settle order", async () => {
    const b = browser();
    b.click();
    b.click();
    b.click();

    b.writes[2]!.resolve(); // newest first
    await settle();
    expect(b.toast.textContent).toBe(copiedText);

    b.writes[0]!.resolve(); // then oldest
    b.writes[1]!.reject(new Error("denied")); // then the middle fails
    await settle();
    expect(b.toast.textContent).toBe(copiedText);
    expect(b.exec).not.toHaveBeenCalled();
    expect(b.timers.size).toBe(1);
    expect(b.setTimeout).toHaveBeenCalledTimes(4);
  });

  it.each(["success", "failure"] as const)(
    "clears prior %s feedback while the next attempt is pending",
    async (outcome) => {
      const b = browser({ copied: false });
      b.click();
      if (outcome === "success") b.writes[0]!.resolve();
      else b.writes[0]!.reject(new Error("denied"));
      await settle();
      expect(b.toast.textContent).toBe(outcome === "success" ? copiedText : failedText);
      const [priorTimer, priorReset] = b.timers.entries().next().value!;
      const fallbackCalls = b.exec.mock.calls.length;

      b.click(); // new owner remains pending beyond the previous toast's lifetime
      expect(b.toast.textContent).toBe("");
      expect(b.clearTimeout).toHaveBeenLastCalledWith(priorTimer);
      expect(b.timers.size).toBe(1); // only the new owner's deadline is live
      priorReset(); // even an already-queued old callback may not write feedback
      await settle();
      expect(b.toast.textContent).toBe("");
      expect(b.exec).toHaveBeenCalledTimes(fallbackCalls);

      if (outcome === "success") b.writes[1]!.reject(new Error("denied"));
      else b.writes[1]!.resolve();
      await settle();
      const latestText = outcome === "success" ? failedText : copiedText;
      expect(b.toast.textContent).toBe(latestText);
      expect(b.timers.size).toBe(1);
      priorReset(); // the old callback cannot clear the new owner's eventual result
      expect(b.toast.textContent).toBe(latestText);
      b.timers.values().next().value!();
      expect(b.toast.textContent).toBe("");
    },
  );

  it("lets a still-current failed attempt report honestly", async () => {
    const b = browser({ copied: false });
    b.click(); // only attempt: its failure is current, not stale
    b.writes[0]!.reject(new Error("denied"));
    await settle();
    expect(b.exec).toHaveBeenCalledTimes(1);
    expect(b.field.remove).toHaveBeenCalled(); // fallback still cleans up
    expect(b.active.focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(b.toast.textContent).toBe(failedText);
    expect(b.timers.size).toBe(1);
  });
});

describe("Copy-link pending attempts", () => {
  const unconfirmedText =
    "Copy not confirmed — if it isn't on your clipboard, copy the link from the address bar.";

  it("announces unconfirmed guidance at the deadline without a second write or fallback", async () => {
    const b = browser();
    b.click();
    const deadlineMs = b.setTimeout.mock.calls[0]?.[1];
    expect(deadlineMs).toBeGreaterThan(0);
    expect(deadlineMs).toBeLessThanOrEqual(10_000);

    b.runTimer(0); // writeText is still pending when the deadline elapses
    expect(b.toast.textContent).toBe(unconfirmedText);
    expect(b.writeText).toHaveBeenCalledTimes(1);
    expect(b.exec).not.toHaveBeenCalled();
  });

  it("drops a late rejection after the deadline instead of running the fallback", async () => {
    const b = browser();
    b.click();
    b.runTimer(0);
    b.writes[0]!.reject(new Error("denied"));
    await settle();
    expect(b.exec).not.toHaveBeenCalled();
    expect(b.field.remove).not.toHaveBeenCalled();
    expect(b.toast.textContent).toBe(unconfirmedText);
  });

  it("drops a late success after the deadline rather than claiming a copy", async () => {
    const b = browser();
    b.click();
    b.runTimer(0);
    b.writes[0]!.resolve();
    await settle();
    expect(b.toast.textContent).toBe(unconfirmedText);
    expect(b.exec).not.toHaveBeenCalled();
  });

  it.each(["success", "denial"] as const)(
    "a timely %s disarms the deadline so a late callback cannot overwrite it",
    async (outcome) => {
      const b = browser({ copied: false });
      b.click();
      if (outcome === "success") b.writes[0]!.resolve();
      else b.writes[0]!.reject(new Error("denied"));
      await settle();
      const reported = outcome === "success" ? copiedText : failedText;
      expect(b.toast.textContent).toBe(reported);

      b.runTimer(0); // this attempt's deadline, now stale
      expect(b.toast.textContent).toBe(reported);
      expect(b.writeText).toHaveBeenCalledTimes(1);
    },
  );

  it("lets an explicit later activation succeed after an expired attempt", async () => {
    const b = browser();
    b.click();
    b.runTimer(0);
    b.click(); // explicit retry
    expect(b.writeText).toHaveBeenCalledTimes(2);
    expect(b.toast.textContent).toBe("");

    b.writes[0]!.reject(new Error("denied")); // expired attempt settles late
    await settle();
    expect(b.exec).not.toHaveBeenCalled();
    expect(b.toast.textContent).toBe("");

    b.writes[1]!.resolve();
    await settle();
    expect(b.toast.textContent).toBe(copiedText);
  });

  it("ignores a superseded attempt's deadline so the newer attempt keeps ownership", async () => {
    const b = browser();
    b.click(); // attempt 1
    b.click(); // attempt 2 supersedes attempt 1
    b.runTimer(0); // attempt 1's deadline arrives late
    expect(b.toast.textContent).toBe("");
    expect(b.writeText).toHaveBeenCalledTimes(2);

    b.writes[1]!.resolve();
    await settle();
    expect(b.toast.textContent).toBe(copiedText);
  });

  it("clears unconfirmed guidance on the standard four-second reset", async () => {
    const b = browser();
    b.click();
    b.runTimer(0);
    expect(b.toast.textContent).toBe(unconfirmedText);
    const reset = b.setTimeout.mock.calls.length - 1;
    expect(b.setTimeout.mock.calls[reset]?.[1]).toBe(4000);

    b.runTimer(reset);
    expect(b.toast.textContent).toBe("");
  });
});

describe("Copy-link feed copies", () => {
  const feedManualText = "Select the feed URL and copy it manually in your calendar app.";

  it("announces feed manual guidance at the deadline while the write is still pending", async () => {
    const b = browser({ feed: true });
    b.click();
    const deadlineMs = b.setTimeout.mock.calls[0]?.[1];
    expect(deadlineMs).toBeGreaterThan(0);
    expect(deadlineMs).toBeLessThanOrEqual(10_000);

    b.runTimer(0); // writeText is still pending when the deadline elapses
    expect(b.toast.textContent).toBe(feedManualText);
    expect(b.writeText).toHaveBeenCalledTimes(1);
    expect(b.writeText).toHaveBeenCalledWith(feedCanonical);
    expect(b.exec).not.toHaveBeenCalled();
  });

  it("never runs the execCommand fallback for a rejected feed write", async () => {
    const b = browser({ feed: true, copied: true }); // execCommand would claim success
    b.click();
    b.writes[0]!.reject(new Error("denied"));
    await settle();
    expect(b.exec).not.toHaveBeenCalled();
    expect(b.field.remove).not.toHaveBeenCalled();
    expect(b.toast.textContent).toBe(feedManualText);
    expect(b.timers.size).toBe(1);
  });

  it("never runs the execCommand fallback for a feed copy without a Clipboard API", async () => {
    const b = browser({ feed: true, copied: true, clipboard: false });
    b.click();
    await settle();
    expect(b.exec).not.toHaveBeenCalled();
    expect(b.field.remove).not.toHaveBeenCalled();
    expect(b.toast.textContent).toBe(feedManualText);
    expect(b.timers.size).toBe(1);
  });
});

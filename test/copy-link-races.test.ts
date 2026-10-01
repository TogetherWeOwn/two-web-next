import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { URL as NodeURL } from "node:url";
import { describe, expect, it, vi } from "vitest";

// Executes the shipped island binder against a fake DOM, then lets each test
// resolve or reject deferred Clipboard.writeText promises in any order.
const binder = readFileSync(new NodeURL("../public/islands/copy-link.js", import.meta.url), "utf8");
const canonical = "https://next.example.test/e/01ARZ3NDEKTSV4RRFFQ69G5FAV";
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

function browser(opts: { copied?: boolean } = {}) {
  const toast = { textContent: "" };
  const active = { focus: vi.fn() };
  const selection = { rangeCount: 0, getRangeAt: vi.fn(), removeAllRanges: vi.fn(), addRange: vi.fn() };
  const field = { value: "", className: "", tabIndex: 0, setAttribute: vi.fn(), select: vi.fn(), remove: vi.fn() };
  const attributes = new Map([["data-copy-link", canonical]]);
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
    navigator: { clipboard: { writeText } },
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
    expect(b.clearTimeout).toHaveBeenCalledTimes(1);

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
    expect(b.clearTimeout).toHaveBeenCalledTimes(1);
    expect(b.setTimeout).toHaveBeenCalledTimes(1);
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
    expect(b.setTimeout).toHaveBeenCalledTimes(1);
  });

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

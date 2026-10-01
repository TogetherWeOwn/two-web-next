import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { URL as NodeURL } from "node:url";
import { describe, expect, it, vi } from "vitest";

const binder = readFileSync(new NodeURL("../public/islands/copy-link.js", import.meta.url), "utf8");
const canonical = "https://next.example.test/e/01ARZ3NDEKTSV4RRFFQ69G5FAV";

type Click = { button: number; ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean; altKey?: boolean; preventDefault: () => void };
type Key = { key: string; preventDefault: () => void };

function browser(opts: { clipboard?: { writeText: (text: string) => Promise<void> }; copied?: boolean; throws?: boolean; missing?: boolean } = {}) {
  const toast = { textContent: "" };
  const active = { focus: vi.fn() };
  const range = {};
  const selection = { rangeCount: 1, getRangeAt: () => range, removeAllRanges: vi.fn(), addRange: vi.fn() };
  const field = { value: "", className: "", tabIndex: 0, setAttribute: vi.fn(), select: vi.fn(), remove: vi.fn() };
  const append = vi.fn();
  const attributes = new Map([["data-copy-link", canonical]]);
  let click: (e: Click) => void = () => {};
  let keydown: (e: Key) => void = () => {};
  const link = {
    getAttribute: (key: string) => attributes.get(key),
    setAttribute: (key: string, value: string) => attributes.set(key, value),
    addEventListener: (kind: string, fn: typeof click | typeof keydown) => {
      if (kind === "click") click = fn as typeof click;
      if (kind === "keydown") keydown = fn as typeof keydown;
    },
  };
  const exec = vi.fn(() => {
    if (opts.throws) throw new Error("Copy unavailable");
    return opts.copied ?? true;
  });
  let timerId = 0;
  const timers = new Map<number, () => void>();
  const setTimeout = vi.fn((fn: () => void, _ms: number) => { timers.set(++timerId, fn); return timerId; });
  const clearTimeout = vi.fn((id: number) => { timers.delete(id); });
  runInNewContext(binder, {
    document: {
      querySelector: (selector: string) => opts.missing ? null : selector === "[data-copy-link]" ? link : toast,
      activeElement: active, createElement: () => field, body: { appendChild: append }, execCommand: exec,
    },
    window: { getSelection: () => selection }, navigator: { clipboard: opts.clipboard }, setTimeout, clearTimeout,
  });
  return {
    toast, active, selection, range, field, append, exec, attributes, setTimeout, clearTimeout, timers,
    async click(extra: Partial<Click> = {}) {
      const e = { button: 0, preventDefault: vi.fn(), ...extra };
      click(e);
      await Promise.resolve();
      await Promise.resolve();
      return e;
    },
    async key(key: string) {
      const e = { key, preventDefault: vi.fn() };
      keydown(e);
      await Promise.resolve();
      await Promise.resolve();
      return e;
    },
  };
}

describe("Copy-link island DOM double", () => {
  it("copies the canonical SSR URL with Clipboard API and clears the live status after four seconds", async () => {
    const writeText = vi.fn(async () => {});
    const b = browser({ clipboard: { writeText } });
    expect(b.attributes.get("role")).toBe("button");
    expect((await b.click()).preventDefault).toHaveBeenCalled();
    expect(writeText).toHaveBeenCalledWith(canonical);
    expect(b.exec).not.toHaveBeenCalled();
    expect(b.toast.textContent).toBe("Event link copied.");
    expect(b.setTimeout).toHaveBeenCalledWith(expect.any(Function), 4000);
    b.timers.values().next().value!();
    expect(b.toast.textContent).toBe("");
  });

  it.each(["absent", "rejected"])("falls back to readonly textarea selection when Clipboard API is %s", async (mode) => {
    const b = browser(mode === "rejected" ? { clipboard: { writeText: async () => { throw new Error("Denied"); } } } : {});
    await b.click();
    expect(b.field.value).toBe(canonical);
    expect(b.field.className).toBe("sr-only");
    expect(b.field.setAttribute).toHaveBeenCalledWith("readonly", "");
    expect(b.field.setAttribute).toHaveBeenCalledWith("aria-hidden", "true");
    expect(b.field.tabIndex).toBe(-1);
    expect(b.append).toHaveBeenCalledWith(b.field);
    expect(b.field.select).toHaveBeenCalled();
    expect(b.exec).toHaveBeenCalledWith("copy");
    expect(b.field.remove).toHaveBeenCalled();
    expect(b.active.focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(b.selection.removeAllRanges).toHaveBeenCalled();
    expect(b.selection.addRange).toHaveBeenCalledWith(b.range);
    expect(b.toast.textContent).toBe("Event link copied.");
  });

  it.each([{ copied: false }, { throws: true }])("reports failed fallback honestly and still removes the temporary field", async (opts) => {
    const b = browser(opts);
    await b.click();
    expect(b.toast.textContent).toBe("That link didn't copy — copy it from the address bar.");
    expect(b.field.remove).toHaveBeenCalled();
    expect(b.active.focus).toHaveBeenCalled();
  });

  it("supports Space and normal Enter clicks, but preserves modified link navigation", async () => {
    const writeText = vi.fn(async () => {});
    const b = browser({ clipboard: { writeText } });
    expect((await b.key(" ")).preventDefault).toHaveBeenCalled();
    expect(writeText).toHaveBeenCalledTimes(1);
    expect((await b.key("Escape")).preventDefault).not.toHaveBeenCalled();
    for (const extra of [{ button: 1 }, { ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }]) {
      expect((await b.click(extra)).preventDefault).not.toHaveBeenCalled();
    }
    expect(writeText).toHaveBeenCalledTimes(1);
    await b.click(); // Enter on the anchor dispatches a normal click.
    expect(writeText).toHaveBeenCalledTimes(2);
  });

  it("replaces the old toast timer on repeated copies", async () => {
    const b = browser();
    await b.click();
    await b.click();
    expect(b.clearTimeout).toHaveBeenLastCalledWith(1);
    expect(b.timers.size).toBe(1);
  });

  it("does nothing when the SSR controls are missing", async () => {
    const b = browser({ missing: true });
    expect((await b.click()).preventDefault).not.toHaveBeenCalled();
    expect(b.attributes.has("role")).toBe(false);
    expect(b.exec).not.toHaveBeenCalled();
    expect(b.setTimeout).not.toHaveBeenCalled();
  });
});

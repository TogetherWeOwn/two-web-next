import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const binder = readFileSync(new NodeURL("../public/islands/copy-link.js", import.meta.url), "utf8");
const canonical = "https://next.example.test/e/01ARZ3NDEKTSV4RRFFQ69G5FAV";
type ClipboardMode = "available" | "absent" | "rejected";
type Activation = {
  button?: number;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
  key?: string;
  repeat?: boolean;
};

function browser(mode: ClipboardMode = "available", copied = true) {
  const attributes = new Map([["data-copy-link", canonical]]);
  const link = Object.assign(new EventTarget(), {
    getAttribute: (name: string) => attributes.get(name),
    setAttribute: (name: string, value: string) => attributes.set(name, value),
  });
  const toast = { textContent: "" };
  const field = {
    value: "",
    className: "",
    tabIndex: 0,
    setAttribute: vi.fn(),
    select: vi.fn(),
    remove: vi.fn(),
  };
  const active = { focus: vi.fn() };
  const append = vi.fn();
  const exec = vi.fn(() => copied);
  const writeText = vi.fn(async (_text: string) => {
    if (mode === "rejected") throw new Error("Clipboard permission denied");
  });
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
      body: { appendChild: append },
      execCommand: exec,
    },
    window: { getSelection: () => null },
    navigator: { clipboard: mode === "absent" ? undefined : { writeText } },
    setTimeout,
    clearTimeout,
  });
  return {
    attributes,
    toast,
    field,
    active,
    append,
    exec,
    writeText,
    timers,
    setTimeout,
    clearTimeout,
    async activate(type: "click" | "keydown", extra: Activation = {}, cancelled = false) {
      const event = Object.assign(new Event(type, { cancelable: true }), {
        button: 0,
        key: " ",
        repeat: false,
        ...extra,
      });
      if (cancelled) event.preventDefault();
      const preventDefault = vi.spyOn(event, "preventDefault");
      link.dispatchEvent(event);
      await Promise.resolve();
      await Promise.resolve();
      return { event, preventDefault };
    },
  };
}

function feedback(b: ReturnType<typeof browser>) {
  return {
    text: b.toast.textContent,
    timers: [...b.timers.entries()],
    setCalls: b.setTimeout.mock.calls.length,
    clearCalls: b.clearTimeout.mock.calls.length,
    clipboardCalls: b.writeText.mock.calls.length,
    fallbackCalls: b.exec.mock.calls.length,
    appendCalls: b.append.mock.calls.length,
    focusCalls: b.active.focus.mock.calls.length,
  };
}

describe("Copy-link activation admission", () => {
  describe.each<ClipboardMode>(["available", "absent", "rejected"])("with %s clipboard", (mode) => {
    it.each(["click", "keydown"] as const)(
      "ignores a previously prevented %s without changing existing feedback",
      async (type) => {
        const b = browser(mode);
        await b.activate("click");
        const before = feedback(b);
        const { event, preventDefault } = await b.activate(type, {}, true);
        expect(event.defaultPrevented).toBe(true);
        expect(preventDefault).not.toHaveBeenCalled();
        expect(feedback(b)).toEqual(before);
      },
    );

    it.each([" ", "Enter"] as const)(
      "admits one %s press but ignores held-key repeats and admits the next press",
      async (key) => {
        const b = browser(mode);
        const first = await b.activate("keydown", { key });
        expect(first.preventDefault).toHaveBeenCalledOnce();
        const before = feedback(b);
        for (let i = 0; i < 3; i++) {
          const repeated = await b.activate("keydown", { key, repeat: true });
          expect(repeated.preventDefault).toHaveBeenCalledOnce();
          expect(repeated.event.defaultPrevented).toBe(true);
          expect(feedback(b)).toEqual(before);
        }
        await b.activate("keydown", { key });
        expect(mode === "absent" ? b.exec : b.writeText).toHaveBeenCalledTimes(2);
      },
    );

    it.each(["click", "keydown"] as const)(
      "preserves ordinary %s copying, link semantics and four-second feedback",
      async (type) => {
        const b = browser(mode);
        const { event, preventDefault } = await b.activate(type);
        expect(b.attributes.has("role")).toBe(false);
        expect(event.defaultPrevented).toBe(true);
        expect(preventDefault).toHaveBeenCalledOnce();
        if (mode === "absent") expect(b.writeText).not.toHaveBeenCalled();
        else expect(b.writeText).toHaveBeenCalledExactlyOnceWith(canonical);
        if (mode === "available") expect(b.exec).not.toHaveBeenCalled();
        else {
          expect(b.exec).toHaveBeenCalledExactlyOnceWith("copy");
          expect(b.field.value).toBe(canonical);
          expect(b.field.remove).toHaveBeenCalledOnce();
          expect(b.active.focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
        }
        expect(b.toast.textContent).toBe("Event link copied.");
        expect(b.setTimeout).toHaveBeenCalledWith(expect.any(Function), 4000);
        b.timers.values().next().value!();
        expect(b.toast.textContent).toBe("");
      },
    );
  });

  it("does not start clipboard work for cancelled or repeated activations before any successful copy", async () => {
    const b = browser();
    const before = feedback(b);
    await b.activate("click", {}, true);
    await b.activate("keydown", {}, true);
    const repeated = await b.activate("keydown", { repeat: true });
    expect(repeated.preventDefault).toHaveBeenCalledOnce();
    expect(repeated.event.defaultPrevented).toBe(true);
    expect(feedback(b)).toEqual(before);
  });

  it("leaves modified/non-primary clicks and unrelated keys alone", async () => {
    const b = browser();
    for (const extra of [
      { button: 1 },
      { button: 2 },
      { ctrlKey: true },
      { metaKey: true },
      { shiftKey: true },
      { altKey: true },
    ]) {
      const { event, preventDefault } = await b.activate("click", extra);
      expect(event.defaultPrevented).toBe(false);
      expect(preventDefault).not.toHaveBeenCalled();
    }
    const { event, preventDefault } = await b.activate("keydown", { key: "Escape" });
    expect(event.defaultPrevented).toBe(false);
    expect(preventDefault).not.toHaveBeenCalled();
    for (const key of [" ", "Enter"] as const) {
      for (const extra of [
        { ctrlKey: true },
        { metaKey: true },
        { shiftKey: true },
        { altKey: true },
      ]) {
        const modified = await b.activate("keydown", { key, ...extra });
        expect(modified.event.defaultPrevented).toBe(false);
        expect(modified.preventDefault).not.toHaveBeenCalled();
      }
    }
    expect(b.writeText).not.toHaveBeenCalled();
    expect(b.setTimeout).not.toHaveBeenCalled();
    // Enter activates the copy directly, exactly like Space and plain click.
    const entered = await b.activate("keydown", { key: "Enter" });
    expect(entered.preventDefault).toHaveBeenCalledOnce();
    expect(b.writeText).toHaveBeenCalledExactlyOnceWith(canonical);
    await b.activate("click");
    expect(b.writeText).toHaveBeenCalledTimes(2);
  });

  it("does not supersede a pending clipboard attempt with ignored activations", async () => {
    const b = browser();
    let resolve!: () => void;
    b.writeText.mockImplementationOnce(
      () =>
        new Promise<void>((done) => {
          resolve = done;
        }),
    );
    await b.activate("click");
    const before = feedback(b);
    await b.activate("click", {}, true);
    await b.activate("keydown", {}, true);
    await b.activate("keydown", { repeat: true });
    expect(feedback(b)).toEqual(before);
    resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(b.writeText).toHaveBeenCalledTimes(1);
    expect(b.toast.textContent).toBe("Event link copied.");
    expect(b.timers.size).toBe(1);
  });

  it("keeps failure feedback intact across cancelled activations and repeated Space", async () => {
    const b = browser("rejected", false);
    await b.activate("click");
    expect(b.toast.textContent).toBe("That link didn't copy — copy it from the address bar.");
    const before = feedback(b);
    await b.activate("click", {}, true);
    await b.activate("keydown", {}, true);
    await b.activate("keydown", { repeat: true });
    expect(feedback(b)).toEqual(before);
  });
});

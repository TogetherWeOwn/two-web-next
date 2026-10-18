import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { URL as NodeURL } from "node:url";
import { describe, expect, it, vi } from "vitest";

// Acceptance suite for the join preview widget focus/error state.
//
// Contract under test (from the card spec, written blind to the fix):
//  1. Nothing is created or contacted before the visitor clicks.
//  2. After a click the frame is built with the unchanged sandbox/referrer
//     attributes, but focus moves into it ONLY after the frame signals
//     `load` — never immediately.
//  3. If the frame signals `error` (blocked frame fixture), focus never
//     moves into the dead frame and a visible message appears in the
//     preview slot pointing at the invite fallback (text mentioning the
//     invite, or a link to the invite URL).
//  4. If the frame never signals load within a bounded timeout
//     (load-timeout fixture: a scheduled timer between 0.5s and 30s),
//     the same guided-fallback outcome as (3) happens.
//  5. A load that arrives after the failure outcome must not steal focus,
//     and an error after a successful load must not replace the loaded
//     preview with guidance.
//
// The harness is deliberately shape-tolerant: listeners may be registered
// via addEventListener or onload/onerror, timers via the global or window,
// and guidance may be any element/text/link inserted into the preview slot.
// It pins outcomes, not the Builder's DOM structure.

const binder = readFileSync(
  new NodeURL("../public/islands/join-widget.js", import.meta.url),
  "utf8",
);
const WIDGET = "https://discord.com/widget?id=326474832151838730&theme=dark";
const INVITE = "https://discord.gg/invite";

type El = {
  tagName: string;
  children: El[];
  attrs: Record<string, string>;
  listeners: Record<string, Array<(e: unknown) => void>>;
  textContent: string;
  className: string;
  style: Record<string, string>;
  src?: string;
  href?: string;
  title?: string;
  width?: string;
  height?: string;
  onload?: ((e: unknown) => void) | null;
  onerror?: ((e: unknown) => void) | null;
  removed: boolean;
  focus: ReturnType<typeof vi.fn>;
  setAttribute: (k: string, v: string) => void;
  getAttribute: (k: string) => string | null;
  addEventListener: (k: string, fn: (e: unknown) => void) => void;
  removeEventListener: (k: string, fn: (e: unknown) => void) => void;
  appendChild: (n: El) => El;
  append: (...n: El[]) => void;
  replaceChildren: (...n: El[]) => void;
  remove: () => void;
  closest: (sel: string) => El | null;
  querySelector: (sel: string) => El | null;
  fire: (kind: string) => void;
};

function page() {
  const created: El[] = [];
  const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];

  const invite = makeEl("a");
  invite.href = INVITE;
  invite.textContent = "Join with an invite link";

  function makeEl(tag: string): El {
    const el: El = {
      tagName: tag.toUpperCase(),
      children: [],
      attrs: {},
      listeners: {},
      textContent: "",
      className: "",
      style: {},
      removed: false,
      focus: vi.fn(),
      setAttribute(k, v) {
        el.attrs[k] = String(v);
        if (k === "src") el.src = String(v);
        if (k === "href") el.href = String(v);
      },
      getAttribute(k) {
        if (k === "href" && el.href) return el.href;
        if (k === "src" && el.src) return el.src;
        return k in el.attrs ? (el.attrs[k] ?? null) : null;
      },
      addEventListener(k, fn) {
        (el.listeners[k] ??= []).push(fn);
      },
      removeEventListener(k, fn) {
        el.listeners[k] = (el.listeners[k] ?? []).filter((f) => f !== fn);
      },
      appendChild(n) {
        el.children.push(n);
        return n;
      },
      append(...n) {
        el.children.push(...n);
      },
      replaceChildren(...n) {
        el.children = [...n];
      },
      remove() {
        el.removed = true;
      },
      closest(sel) {
        return sel === ".join-preview" ? preview : null;
      },
      querySelector(sel) {
        return sel.includes("invite") ? invite : null;
      },
      fire(kind) {
        for (const fn of [...(el.listeners[kind] ?? [])]) fn({ type: kind });
        const prop = kind === "load" ? el.onload : kind === "error" ? el.onerror : null;
        if (typeof prop === "function") prop({ type: kind });
      },
    };
    return el;
  }

  const preview = makeEl("div");
  const link = makeEl("a");
  link.href = WIDGET;
  preview.children = [link];

  const document = {
    querySelector(sel: string) {
      if (sel === "[data-join-widget]") return link;
      if (sel.includes("invite")) return invite;
      return null;
    },
    querySelectorAll(sel: string) {
      return sel === "[data-join-widget]" ? [link] : [];
    },
    createElement(tag: string) {
      const el = makeEl(tag);
      created.push(el);
      return el;
    },
    createTextNode(text: string) {
      const el = makeEl("#text");
      el.textContent = String(text);
      created.push(el);
      return el;
    },
  };

  const sandbox: Record<string, unknown> = {
    document,
    setTimeout(fn: () => void, ms = 0) {
      timers.push({ fn, ms: Number(ms) || 0, cleared: false });
      return timers.length;
    },
    clearTimeout(id: number) {
      const t = timers[id - 1];
      if (t) t.cleared = true;
    },
    console,
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  runInNewContext(binder, sandbox);

  const frame = () => created.find((e) => e.tagName === "IFRAME");

  function deepText(el: El): string {
    return [el.textContent, ...el.children.map(deepText)].join(" ");
  }
  function deepNodes(el: El): El[] {
    return [el, ...el.children.flatMap(deepNodes)];
  }
  /** Visible guidance in the preview slot pointing at the invite fallback. */
  function guidance(): boolean {
    const f = frame();
    const nodes = deepNodes(preview).filter((n) => n !== preview && n !== f && n !== link);
    const texts = nodes.map(deepText).join(" ");
    if (/invite|discord\.gg/i.test(texts)) return true;
    // Guidance set directly on the preview slot itself.
    if (/invite|discord\.gg/i.test(preview.textContent)) return true;
    return nodes.some((n) => {
      const href = n.href ?? n.attrs.href ?? "";
      return href.includes("discord.gg") || href === INVITE;
    });
  }

  return {
    created,
    timers,
    preview,
    link,
    invite,
    frame,
    guidance,
    click() {
      const event = { button: 0, preventDefault: vi.fn() };
      for (const fn of [...(link.listeners.click ?? [])]) fn(event);
      return event;
    },
    fireTimers() {
      for (const t of timers) if (!t.cleared) t.fn();
    },
  };
}

describe("join-widget acceptance: focus and error state", () => {
  it("contacts nothing and schedules nothing before the visitor clicks", () => {
    const p = page();
    expect(p.created).toEqual([]);
    expect(p.timers).toEqual([]);
    expect(p.frame()).toBeUndefined();
  });

  it("keeps the unchanged sandbox/referrer attributes on the clicked frame", () => {
    const p = page();
    p.click();
    const f = p.frame();
    expect(f, "a click builds the widget frame").toBeDefined();
    expect(f?.src).toBe(WIDGET);
    expect(f?.attrs.sandbox).toBe("allow-scripts allow-same-origin");
    expect(f?.attrs.referrerpolicy).toBe("no-referrer");
    expect(f?.attrs["data-testid"]).toBe("join-widget");
  });

  it("does not move focus into the frame before it signals load", () => {
    const p = page();
    p.click();
    const f = p.frame();
    expect(f).toBeDefined();
    expect(f?.focus, "focus must wait for load, not move on click").not.toHaveBeenCalled();
  });

  it("moves focus into the frame once it signals load, with no guidance", () => {
    const p = page();
    p.click();
    const f = p.frame();
    f?.fire("load");
    expect(f?.focus).toHaveBeenCalledTimes(1);
    expect(p.guidance(), "a loaded preview shows no failure guidance").toBe(false);
  });

  it("blocked frame: on error focus stays put and guidance points at the invite fallback", () => {
    const p = page();
    p.click();
    const f = p.frame();
    f?.fire("error");
    expect(f?.focus, "focus must never move into a dead frame").not.toHaveBeenCalled();
    expect(p.guidance(), "a visible message points at the invite fallback").toBe(true);
  });

  it("load timeout: a bounded timer fires the same guided fallback without stealing focus", () => {
    const p = page();
    p.click();
    const f = p.frame();
    const bounded = p.timers.filter((t) => t.ms >= 500 && t.ms <= 30_000);
    expect(bounded.length, "a bounded load timeout (0.5s–30s) is scheduled").toBeGreaterThan(0);
    p.fireTimers();
    expect(f?.focus, "focus must never move into a frame that never loaded").not.toHaveBeenCalled();
    expect(p.guidance(), "a visible message points at the invite fallback").toBe(true);
  });

  it("a load arriving after the timeout outcome does not steal focus", () => {
    const p = page();
    p.click();
    const f = p.frame();
    p.fireTimers();
    f?.fire("load");
    expect(
      f?.focus,
      "late load must not move focus after guidance was shown",
    ).not.toHaveBeenCalled();
    expect(p.guidance()).toBe(true);
  });

  it("an error after a successful load does not replace the preview with guidance", () => {
    const p = page();
    p.click();
    const f = p.frame();
    f?.fire("load");
    f?.fire("error");
    expect(f?.focus).toHaveBeenCalledTimes(1);
    expect(p.guidance(), " guidance must not appear after a successful load").toBe(false);
  });
});

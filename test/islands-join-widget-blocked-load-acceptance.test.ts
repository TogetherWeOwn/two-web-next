import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { URL as NodeURL } from "node:url";
import { describe, expect, it, type Mock, vi } from "vitest";

// Acceptance suite for blocked widget navigations that still fire `load`.
//
// Why this contract shape: an ad/tracker blocker, corporate filter, DNS
// failure, refused connection, X-Frame-Options or CSP frame-ancestors block
// commits a browser error page in the frame, and the frame element fires
// `load` for it. Verified in Chromium against locally stubbed navigations
// (abort blockedbyclient / connectionrefused, a DENY response, and a real
// 200): all four are indistinguishable from page script — every one fires
// `load`, `contentDocument` is null, reading the frame location throws, and
// resource timing is zeroed without Timing-Allow-Origin. There is no
// readiness signal to wait for, so this contract never asks the island to
// tell a blocked `load` from a rendered one at load time.
//
// Contract under test (extends, never replaces, the focus/error suite):
//  1. Success path unchanged at load time: `load` moves focus into the
//     frame and shows no guidance yet.
//  2. The bounded load timer survives `load`: when it later fires, visible
//     guidance pointing at the invite fallback appears in the preview slot
//     even though `load` happened. This is what covers a blocked embed.
//  3. That guidance is beside the frame, not a replacement: the frame is
//     still in the preview slot afterwards, so a widget that really did
//     render keeps working.
//  4. Post-load timer guidance is announcement-only: it never moves focus
//     out of a loaded frame. A blocked `load` and a rendered `load` are
//     indistinguishable, so rescuing focus from a possibly dead frame
//     would steal it from every working preview still in use when the
//     timer fires. Guidance is announced (live region) beside the frame;
//     a stranded keyboard visitor Tabs once from frame to invite. Revised
//     2026-10-18: the original rescue-focus pin demanded the opposite end
//     state for identical inputs; never move focus on a timer that cannot
//     prove the frame is dead.
//  5. Anti-steal: if the visitor has moved focus elsewhere after load, the
//     timer guidance appears without moving focus at all. This includes
//     focus resting on the page body (the visitor clicked plain page text),
//     which is the only focus state that reaches the post-load focus branch.
//  6. A signaled `error` still guides immediately, without the timer.
//
// The harness is deliberately shape-tolerant like the focus/error suite:
// listeners via addEventListener or onload/onerror, timers via the global
// or window, guidance as any element/text/link inserted into the preview
// slot. `document.activeElement` tracks focus/blur calls so end-state
// focus outcomes are pinned, not the Builder's mechanism.

const binder = readFileSync(
  new NodeURL("../public/islands/join-widget.js", import.meta.url),
  "utf8",
);
const WIDGET = "https://discord.com/widget?id=326474832151838730&theme=dark";
const INVITE = "https://discord.gg/invite";

type El = {
  tagName: string;
  children: El[];
  parent: El | null;
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
  focus: Mock<() => void>;
  blur: Mock<() => void>;
  setAttribute: (k: string, v: string) => void;
  getAttribute: (k: string) => string | null;
  addEventListener: (k: string, fn: (e: unknown) => void) => void;
  removeEventListener: (k: string, fn: (e: unknown) => void) => void;
  appendChild: (n: El) => El;
  append: (...n: El[]) => void;
  replaceChildren: (...n: El[]) => void;
  insertBefore: (n: El, ref: El | null) => El;
  after: (...n: El[]) => void;
  before: (...n: El[]) => void;
  remove: () => void;
  contains: (n: El) => boolean;
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

  function adopt(parent: El, nodes: El[], at?: number) {
    for (const n of nodes) n.parent = parent;
    if (at === undefined) parent.children.push(...nodes);
    else parent.children.splice(at, 0, ...nodes);
  }

  function makeEl(tag: string): El {
    const el: El = {
      tagName: tag.toUpperCase(),
      children: [],
      parent: null,
      attrs: {},
      listeners: {},
      textContent: "",
      className: "",
      style: {},
      removed: false,
      focus: vi.fn(() => {
        document.activeElement = el;
      }),
      blur: vi.fn(() => {
        if (document.activeElement === el) document.activeElement = body;
      }),
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
        adopt(el, [n]);
        return n;
      },
      append(...n) {
        adopt(el, n);
      },
      replaceChildren(...n) {
        el.children = [];
        adopt(el, n);
      },
      insertBefore(n, ref) {
        const at = ref ? el.children.indexOf(ref) : -1;
        adopt(el, [n], at === -1 ? undefined : at);
        return n;
      },
      after(...n) {
        if (el.parent) adopt(el.parent, n, el.parent.children.indexOf(el) + 1);
      },
      before(...n) {
        if (el.parent) adopt(el.parent, n, el.parent.children.indexOf(el));
      },
      remove() {
        el.removed = true;
        if (el.parent) el.parent.children = el.parent.children.filter((c) => c !== el);
      },
      contains(n) {
        return n === el || el.children.some((c) => c.contains(n));
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

  const body = makeEl("body");
  const preview = makeEl("div");
  const link = makeEl("a");
  link.href = WIDGET;
  adopt(preview, [link]);

  const document: {
    body: El;
    activeElement: El | null;
    querySelector: (sel: string) => El | null;
    querySelectorAll: (sel: string) => El[];
    createElement: (tag: string) => El;
    createTextNode: (text: string) => El;
  } = {
    body,
    activeElement: body,
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
    body,
    document,
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
    clearFocusCounts() {
      for (const el of [invite, preview, link, body, ...created]) {
        el.focus.mockClear();
        el.blur.mockClear();
      }
    },
    focusCallsDuring(fn: () => void): number {
      this.clearFocusCounts();
      fn();
      return [invite, preview, link, body, ...created].reduce(
        (sum, el) => sum + el.focus.mock.calls.length + el.blur.mock.calls.length,
        0,
      );
    },
  };
}

describe("join-widget acceptance: blocked navigation that fires load", () => {
  it("success path at load time: load focuses the frame and shows no guidance yet", () => {
    const p = page();
    p.click();
    const f = p.frame();
    f?.fire("load");
    expect(f?.focus).toHaveBeenCalledTimes(1);
    expect(p.guidance(), "no guidance at load time; load is not treated as failure").toBe(false);
  });

  it("blocked embed: guidance appears after load when the bounded timer fires", () => {
    const p = page();
    p.click();
    const f = p.frame();
    // A blocked navigation commits an error page and fires `load`.
    f?.fire("load");
    expect(p.guidance()).toBe(false);
    p.fireTimers();
    expect(p.guidance(), "the timer must survive load so a blocked embed still gets guidance").toBe(
      true,
    );
  });

  it("timer guidance is beside the frame, not a replacement for it", () => {
    const p = page();
    p.click();
    const f = p.frame();
    f?.fire("load");
    p.fireTimers();
    expect(p.guidance()).toBe(true);
    expect(f?.removed, "a frame that really rendered must not be removed").toBe(false);
    expect(f && p.preview.contains(f), "the frame stays in the preview slot").toBe(true);
  });

  it("post-load timer guidance is announcement-only: focus stays in the loaded frame", () => {
    const p = page();
    p.click();
    const f = p.frame();
    f?.fire("load");
    expect(p.document.activeElement).toBe(f);
    const calls = p.focusCallsDuring(() => p.fireTimers());
    expect(p.guidance()).toBe(true);
    expect(calls, "a timer that cannot prove the frame is dead must not move focus at all").toBe(0);
    expect(
      p.document.activeElement,
      "focus stays in the frame; a working preview keeps its visitor",
    ).toBe(f);
    const announced = p.created.some(
      (n) =>
        n.attrs.role === "status" ||
        n.attrs["aria-live"] === "polite" ||
        n.attrs["aria-live"] === "assertive",
    );
    expect(announced, "guidance is announced via a live region, not by moving focus").toBe(true);
  });

  it("anti-steal: timer guidance does not move focus the visitor has moved elsewhere", () => {
    const p = page();
    p.click();
    const f = p.frame();
    f?.fire("load");
    // The visitor has since moved on to the page-level invite link.
    p.invite.focus();
    expect(p.document.activeElement).toBe(p.invite);
    const calls = p.focusCallsDuring(() => p.fireTimers());
    expect(p.guidance(), "guidance still appears").toBe(true);
    expect(calls, "guidance must not steal focus from where the visitor put it").toBe(0);
    expect(p.document.activeElement).toBe(p.invite);
  });

  it("anti-steal from body: timer guidance does not focus the invite when focus rests on the page body", () => {
    const p = page();
    p.click();
    const f = p.frame();
    f?.fire("load");
    // The visitor clicked plain page text, so focus rests on the body. Of
    // the post-load focus states, only body/null reaches the focus branch,
    // so this is the case that pins the loaded-frame guard in the bundle.
    f?.blur();
    expect(p.document.activeElement).toBe(p.body);
    const calls = p.focusCallsDuring(() => p.fireTimers());
    expect(p.guidance(), "guidance still appears").toBe(true);
    expect(calls, "post-load guidance is announcement-only, even from body focus").toBe(0);
    expect(p.document.activeElement).toBe(p.body);
  });

  it("a signaled error still guides immediately, without waiting for the timer", () => {
    const p = page();
    p.click();
    const f = p.frame();
    f?.fire("error");
    expect(f?.focus, "focus must never move into a dead frame").not.toHaveBeenCalled();
    expect(p.guidance()).toBe(true);
  });
});

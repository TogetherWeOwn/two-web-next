import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { URL as NodeURL } from "node:url";
import { describe, expect, it, vi } from "vitest";

const binder = readFileSync(
  new NodeURL("../public/islands/join-widget.js", import.meta.url),
  "utf8",
);
const widget = "https://discord.com/widget?id=326474832151838730&theme=dark";
const invite = "https://discord.gg/invite";

type Click = {
  button: number;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
  preventDefault: () => void;
};

function page(opts: { missing?: boolean; orphan?: boolean; noInvite?: boolean } = {}) {
  const listeners: Record<string, (e: unknown) => void> = {};
  const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
  const createdEls: Array<{
    attrs: Record<string, string>;
    textContent: string;
    focus: ReturnType<typeof vi.fn>;
  }> = [];
  const frame = {
    title: "",
    src: "",
    width: "",
    height: "",
    attrs: {} as Record<string, string>,
    setAttribute: vi.fn((key: string, value: string) => {
      frame.attrs[key] = value;
    }),
    focus: vi.fn(),
    addEventListener: vi.fn((kind: string, fn: (e: unknown) => void) => {
      listeners[kind] = fn;
    }),
    fire: (kind: string) => listeners[kind]?.({ type: kind }),
  };
  type Message = {
    attrs: Record<string, string>;
    textContent: string;
    focus: ReturnType<typeof vi.fn>;
    children: Array<{
      attrs: Record<string, string>;
      textContent: string;
      focus: ReturnType<typeof vi.fn>;
    }>;
  };
  const preview = {
    children: [] as Array<unknown>,
    replaceChildren: vi.fn((...nodes: Array<unknown>) => {
      preview.children = [...nodes];
    }),
    appendChild: vi.fn(),
  };
  const messageOf = (call: number) =>
    (preview.replaceChildren.mock.calls[call]?.[0] ?? null) as Message | null;
  const createElement = vi.fn((tag: string) => {
    if (tag === "iframe") return frame;
    const el = {
      attrs: {} as Record<string, string>,
      textContent: "",
      focus: vi.fn(),
      children: [] as Array<{
        attrs: Record<string, string>;
        textContent: string;
        focus: ReturnType<typeof vi.fn>;
      }>,
      setAttribute(key: string, value: string) {
        el.attrs[key] = value;
      },
      appendChild(node: {
        attrs: Record<string, string>;
        textContent: string;
        focus: ReturnType<typeof vi.fn>;
      }) {
        el.children.push(node);
        return node;
      },
    };
    createdEls.push(el);
    return el;
  });
  // After replaceChildren removes the clicked link, a real browser drops
  // focus to <body>. `active` models document.activeElement so the suite can
  // pin the steal-guard: focus moves in only when the visitor hasn't moved
  // elsewhere since the click.
  const body = {};
  let active: unknown = body;
  let onClick: (e: Click) => void = () => {};
  const link = {
    getAttribute: (key: string) => (key === "href" ? widget : null),
    closest: (selector: string) => (selector === ".join-preview" && !opts.orphan ? preview : null),
    addEventListener: (kind: string, fn: typeof onClick) => {
      if (kind === "click") onClick = fn;
    },
  };
  const inviteLink = opts.noInvite
    ? null
    : { getAttribute: (key: string) => (key === "href" ? invite : null) };
  const documentStub = {
    querySelector: (selector: string) => {
      if (selector === "[data-join-widget]") return opts.missing ? null : link;
      if (selector.includes("join-invite")) return inviteLink;
      return null;
    },
    createElement,
    get activeElement() {
      return active;
    },
    body,
  };
  runInNewContext(binder, {
    document: documentStub,
    setTimeout: (fn: () => void, ms = 0) => {
      timers.push({ fn, ms: Number(ms) || 0, cleared: false });
      return timers.length;
    },
    clearTimeout: (id: number) => {
      const timer = timers[id - 1];
      if (timer) timer.cleared = true;
    },
  });
  return {
    frame,
    preview,
    messageOf,
    timers,
    createElement,
    createdEls,
    body,
    moveFocusTo(target: unknown) {
      active = target;
    },
    async click(extra: Partial<Click> = {}) {
      const event = { button: 0, preventDefault: vi.fn(), ...extra };
      onClick(event);
      return event;
    },
    fireTimers() {
      for (const timer of timers) if (!timer.cleared) timer.fn();
    },
  };
}

describe("join-widget island", () => {
  it("contacts nothing until the visitor clicks", () => {
    const p = page();
    expect(p.createElement).not.toHaveBeenCalled();
    expect(p.preview.replaceChildren).not.toHaveBeenCalled();
    expect(p.timers).toEqual([]);
  });

  it("swaps the link for the sandboxed widget frame without stealing focus", async () => {
    const p = page();
    const event = await p.click();
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(p.createElement).toHaveBeenCalledWith("iframe");
    expect(p.frame.src).toBe(widget);
    expect(p.frame.title).toBe("TWO Discord server preview");
    expect(p.frame.attrs.sandbox).toBe("allow-scripts allow-same-origin");
    expect(p.frame.attrs.referrerpolicy).toBe("no-referrer");
    expect(p.frame.attrs["data-testid"]).toBe("join-widget");
    expect(p.preview.replaceChildren).toHaveBeenCalledWith(p.frame);
    // Focus waits for the frame to prove it rendered.
    expect(p.frame.focus).not.toHaveBeenCalled();
  });

  it("moves focus into the frame once it signals load", async () => {
    const p = page();
    await p.click();
    p.frame.fire("load");
    expect(p.frame.focus).toHaveBeenCalledOnce();
    expect(p.preview.replaceChildren).toHaveBeenCalledOnce();
  });

  it("does not steal focus on load when the visitor moved elsewhere since the click", async () => {
    const p = page();
    await p.click();
    p.moveFocusTo({ tag: "header-link" });
    p.frame.fire("load");
    expect(p.frame.focus).not.toHaveBeenCalled();
  });

  // Scope note: the failure paths below exercise the observable signals —
  // a signaled `error` event and the bounded load timeout. A blocked
  // navigation that commits an error page fires `load` instead, which is
  // indistinguishable from a real render cross-origin; that case is covered
  // by test/islands-join-widget-blocked-load-acceptance.test.ts (the timer
  // survives `load` and announces beside-frame guidance without moving
  // focus).
  it("moves focus to the invite fallback when the frame signals error", async () => {
    const p = page();
    await p.click();
    p.frame.fire("error");
    const message = p.messageOf(1)!;
    expect(message.attrs.tabindex).toBe("-1");
    const fallback = message.children[0]!;
    expect(fallback.focus).toHaveBeenCalledOnce();
  });

  it("moves focus to the guidance itself when no invite fallback exists", async () => {
    const p = page({ noInvite: true });
    await p.click();
    p.frame.fire("error");
    const message = p.messageOf(1)!;
    expect(message.attrs.tabindex).toBe("-1");
    expect(message.focus).toHaveBeenCalledOnce();
  });

  it("does not steal focus on failure when the visitor moved elsewhere since the click", async () => {
    const p = page();
    await p.click();
    p.moveFocusTo({ tag: "header-link" });
    p.frame.fire("error");
    const message = p.messageOf(1)!;
    expect(message.attrs["data-testid"]).toBe("join-widget-error");
    expect(message.children[0]!.focus).not.toHaveBeenCalled();
    expect(message.focus).not.toHaveBeenCalled();
  });

  it("does not steal focus on timeout when the visitor moved elsewhere since the click", async () => {
    const p = page();
    await p.click();
    p.moveFocusTo({ tag: "header-link" });
    p.fireTimers();
    const message = p.messageOf(1)!;
    expect(message.attrs["data-testid"]).toBe("join-widget-error");
    expect(message.children[0]!.focus).not.toHaveBeenCalled();
    expect(message.focus).not.toHaveBeenCalled();
  });

  it("on a signaled error keeps focus put and guides to the invite fallback", async () => {
    const p = page();
    await p.click();
    p.frame.fire("error");
    expect(p.frame.focus).not.toHaveBeenCalled();
    expect(p.preview.replaceChildren).toHaveBeenCalledTimes(2);
    const message = p.messageOf(1)!;
    expect(message.attrs["data-testid"]).toBe("join-widget-error");
    const fallback = message.children[0]!;
    expect(fallback.attrs.href).toBe(invite);
    expect(`${message.textContent} ${fallback.textContent}`).toMatch(/invite/i);
  });

  it("on a bounded load timeout keeps focus put and guides to the invite fallback", async () => {
    const p = page();
    await p.click();
    const bounded = p.timers.filter((timer) => timer.ms >= 500 && timer.ms <= 30_000);
    expect(bounded.length).toBeGreaterThan(0);
    p.fireTimers();
    expect(p.frame.focus).not.toHaveBeenCalled();
    expect(p.preview.replaceChildren).toHaveBeenCalledTimes(2);
    expect(p.messageOf(1)!.attrs["data-testid"]).toBe("join-widget-error");
  });

  it("ignores a load arriving after the timeout guided away", async () => {
    const p = page();
    await p.click();
    p.fireTimers();
    p.frame.fire("load");
    expect(p.frame.focus).not.toHaveBeenCalled();
  });

  it("guides with text alone when the invite link is absent", async () => {
    const p = page({ noInvite: true });
    await p.click();
    p.frame.fire("error");
    expect(p.frame.focus).not.toHaveBeenCalled();
    expect(p.messageOf(1)!.textContent).toMatch(/invite/i);
  });

  it.each([
    { button: 1 },
    { button: 0, ctrlKey: true },
    { button: 0, metaKey: true },
    { button: 0, shiftKey: true },
    { button: 0, altKey: true },
  ])("leaves modified or non-primary clicks to the browser (%o)", async (extra) => {
    const p = page();
    const event = await p.click(extra);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(p.createElement).not.toHaveBeenCalled();
  });

  it("does nothing without the link or outside a preview slot", () => {
    const absent = page({ missing: true });
    expect(absent.createElement).not.toHaveBeenCalled();
    const orphan = page({ orphan: true });
    expect(orphan.createElement).not.toHaveBeenCalled();
  });
});

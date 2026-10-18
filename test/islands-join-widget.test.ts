import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { URL as NodeURL } from "node:url";
import { describe, expect, it, vi } from "vitest";

const binder = readFileSync(
  new NodeURL("../public/islands/join-widget.js", import.meta.url),
  "utf8",
);
const widget = "https://discord.com/widget?id=326474832151838730&theme=dark";

type Click = {
  button: number;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
  preventDefault: () => void;
};

function page(opts: { missing?: boolean; orphan?: boolean } = {}) {
  const frame = { setAttribute: vi.fn(), focus: vi.fn() } as {
    title?: string;
    src?: string;
    width?: string;
    height?: string;
    setAttribute: ReturnType<typeof vi.fn>;
    focus: ReturnType<typeof vi.fn>;
  };
  const preview = { replaceChildren: vi.fn() };
  const createElement = vi.fn(() => frame);
  let onClick: (e: Click) => void = () => {};
  const link = {
    getAttribute: (key: string) => (key === "href" ? widget : null),
    closest: (selector: string) => (selector === ".join-preview" && !opts.orphan ? preview : null),
    addEventListener: (kind: string, fn: typeof onClick) => {
      if (kind === "click") onClick = fn;
    },
  };
  runInNewContext(binder, {
    document: {
      querySelector: (selector: string) =>
        opts.missing || selector !== "[data-join-widget]" ? null : link,
      createElement,
    },
  });
  return {
    frame,
    preview,
    createElement,
    async click(extra: Partial<Click> = {}) {
      const event = { button: 0, preventDefault: vi.fn(), ...extra };
      onClick(event);
      return event;
    },
  };
}

describe("join-widget island", () => {
  it("contacts nothing until the visitor clicks", () => {
    const p = page();
    expect(p.createElement).not.toHaveBeenCalled();
    expect(p.preview.replaceChildren).not.toHaveBeenCalled();
  });

  it("swaps the link for the sandboxed widget frame and keeps focus in it", async () => {
    const p = page();
    const event = await p.click();
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(p.createElement).toHaveBeenCalledWith("iframe");
    expect(p.frame.src).toBe(widget);
    expect(p.frame.title).toBe("TWO Discord server preview");
    expect(p.frame.setAttribute).toHaveBeenCalledWith("sandbox", "allow-scripts allow-same-origin");
    expect(p.frame.setAttribute).toHaveBeenCalledWith("referrerpolicy", "no-referrer");
    expect(p.frame.setAttribute).toHaveBeenCalledWith("data-testid", "join-widget");
    expect(p.preview.replaceChildren).toHaveBeenCalledWith(p.frame);
    expect(p.frame.focus).toHaveBeenCalledOnce();
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

import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { URL as NodeURL } from "node:url";
import { describe, expect, it, vi } from "vitest";

const binder = readFileSync(new NodeURL("../public/islands/avatar.js", import.meta.url), "utf8");
const css = readFileSync(new NodeURL("../public/styles.css", import.meta.url), "utf8");

function avatar(opts: { complete?: boolean; naturalWidth?: number; missingImage?: boolean; missingInitial?: boolean } = {}) {
  const listeners = new Map<string, () => void>();
  const image = {
    hidden: false,
    complete: opts.complete ?? false,
    naturalWidth: opts.naturalWidth ?? 0,
    addEventListener: vi.fn((event: string, listener: () => void) => listeners.set(event, listener)),
  };
  const initial = { hidden: true };
  const root = {
    querySelector: (selector: string) => {
      if (selector === "img") return opts.missingImage ? null : image;
      if (selector === "[data-avatar-initial]") return opts.missingInitial ? null : initial;
      throw new Error(`Unexpected selector: ${selector}`);
    },
  };
  return { root, image, initial, error: () => listeners.get("error")?.() };
}

function mount(avatars: ReturnType<typeof avatar>[]) {
  runInNewContext(binder, {
    document: {
      querySelectorAll: (selector: string) => {
        expect(selector).toBe("[data-avatar]");
        return avatars.map((a) => a.root);
      },
    },
  });
}

describe("Avatar island DOM fixture", () => {
  it.each([{ complete: false, naturalWidth: 0 }, { complete: true, naturalWidth: 64 }])(
    "keeps a pending or successfully loaded image visible (%j)", (opts) => {
      const a = avatar(opts);
      mount([a]);
      expect(a.image.addEventListener).toHaveBeenCalledWith("error", expect.any(Function));
      expect(a.image.hidden).toBe(false);
      expect(a.initial.hidden).toBe(true);
    },
  );

  it("reveals the initial and hides the broken image on a later error, idempotently", () => {
    const a = avatar();
    mount([a]);
    a.error();
    expect(a.image.hidden).toBe(true);
    expect(a.initial.hidden).toBe(false);
    a.error();
    expect(a.image.hidden).toBe(true);
    expect(a.initial.hidden).toBe(false);
  });

  it("handles an image that failed before the deferred script ran", () => {
    const a = avatar({ complete: true, naturalWidth: 0 });
    mount([a]);
    expect(a.image.hidden).toBe(true);
    expect(a.initial.hidden).toBe(false);
  });

  it("only swaps the failed image when multiple avatars are present", () => {
    const first = avatar();
    const second = avatar({ complete: true, naturalWidth: 64 });
    mount([first, second]);
    first.error();
    expect(first.initial.hidden).toBe(false);
    expect(second.initial.hidden).toBe(true);
    expect(second.image.hidden).toBe(false);
  });

  it("tolerates pages without avatars, initials-only avatars and incomplete markup", () => {
    expect(() => mount([])).not.toThrow();
    for (const opts of [{ missingImage: true }, { missingInitial: true }]) {
      const a = avatar(opts);
      mount([a]);
      expect(a.image.addEventListener).not.toHaveBeenCalled();
    }
  });
});

describe("Avatar stylesheet drift", () => {
  it("reserves 64×64 for both states and does not override hidden with display:flex/block", () => {
    expect(css).toMatch(/\.avatar \{[^}]*width: 64px;[^}]*height: 64px;[^}]*flex-shrink: 0;/);
    expect(css).toContain(".avatar img, .avatar-initial { width: 100%; height: 100%; }");
    expect(css).toContain(".avatar [hidden] { display: none; }");
  });
});

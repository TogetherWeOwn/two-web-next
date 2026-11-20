import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { runInNewContext } from "node:vm";
import { expect, test, vi } from "vitest";

test.each(["assets", "public"])(
  "%s header island leaves the fragment menu without inert",
  (root) => {
    const trigger = { setAttribute: vi.fn(), addEventListener: vi.fn() };
    const sheet = {};
    const header = {
      querySelector: (selector: string) => (selector === ".menu-toggle" ? trigger : sheet),
      hasAttribute: () => false,
      setAttribute: vi.fn(),
    };
    const binder = readFileSync(
      new URL(`../${root}/islands/site-header-menu.js`, import.meta.url),
      "utf8",
    );
    const matchMedia = vi.fn();
    runInNewContext(binder, { document: { querySelector: () => header }, matchMedia });
    expect(matchMedia).not.toHaveBeenCalled();
    expect(header.setAttribute).not.toHaveBeenCalled();
    expect(trigger.setAttribute).not.toHaveBeenCalled();
    expect(trigger.addEventListener).not.toHaveBeenCalled();
  },
);

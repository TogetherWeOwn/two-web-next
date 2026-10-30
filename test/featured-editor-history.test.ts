import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

function browser(type: string, state: unknown = null, hasBaseline = true) {
  const baseline = { value: "fresh-row-baseline" };
  const windowListeners = new Map<string, () => void>();
  const formListeners = new Map<string, (event: { preventDefault: () => void }) => void>();
  const created: Record<string, unknown>[] = [];
  const editor = {
    hasAttribute: () => false,
    setAttribute: vi.fn(),
    removeAttribute: vi.fn(),
    addEventListener: (kind: string, handler: (event: { preventDefault: () => void }) => void) =>
      formListeners.set(kind, handler),
    parentNode: { insertBefore: (node: Record<string, unknown>) => created.push(node) },
  };
  const history = { state, replaceState: vi.fn() };
  runInNewContext(readFileSync("public/islands/featured-edit-history.js", "utf8"), {
    document: {
      querySelector: (selector: string) =>
        selector === "[data-event-editor]"
          ? editor
          : selector === 'input[name="saved_baseline"]' && hasBaseline
            ? baseline
            : null,
      createElement: () => ({ setAttribute: vi.fn(), appendChild: vi.fn(), focus: vi.fn() }),
    },
    window: {
      history,
      performance: { getEntriesByType: () => [{ type }] },
      location: { pathname: "/admin/featured/1", search: "", origin: "https://next.example.test" },
      addEventListener: (kind: string, handler: () => void) => windowListeners.set(kind, handler),
    },
    FormData: class {
      *[Symbol.iterator]() {
        yield ["title", "Restored private draft"];
      }
    },
    URLSearchParams,
    URL,
    setTimeout: vi.fn(),
    clearTimeout: vi.fn(),
  });
  return {
    baseline,
    history,
    created,
    submit: () => formListeners.get("submit")!({ preventDefault: vi.fn() }),
  };
}

describe("featured baseline belongs to the history entry", () => {
  it.each(["back_forward", "reload"])(
    "keeps the original entry baseline across a %s network GET",
    (type) => {
      const b = browser(type, { twoFeaturedBaseline: "original-entry-baseline" });
      expect(b.baseline.value).toBe("original-entry-baseline");
      // Restoration can happen after deferred script execution: submit must pin it again.
      b.baseline.value = "fresh-row-baseline";
      b.submit();
      expect(b.baseline.value).toBe("original-entry-baseline");
      expect(b.history.replaceState).not.toHaveBeenCalled();
    },
  );
  it("a legacy history entry without a pinned baseline fails closed", () => {
    const b = browser("back_forward");
    expect(b.baseline.value).toBe("");
    b.submit();
    expect(b.baseline.value).toBe("");
  });
  it("fresh explicit review pins its own baseline without discarding other history state", () => {
    const b = browser("navigate", { existingRouterState: "keep" });
    expect(b.history.replaceState).toHaveBeenCalledWith(
      { existingRouterState: "keep", twoFeaturedBaseline: "fresh-row-baseline" },
      "",
    );
    expect(b.baseline.value).toBe("fresh-row-baseline");
  });
  it("does not attach featured history behavior to other editors", () => {
    const b = browser("back_forward", null, false);
    expect(b.history.replaceState).not.toHaveBeenCalled();
  });
});

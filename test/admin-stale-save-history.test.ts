import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const scripts = ["admin-save-baseline", "admin-event-editor"];
function islandSource(directory: string) {
  return scripts
    .map((name) =>
      readFileSync(new URL(`../${directory}/islands/${name}.js`, import.meta.url), "utf8"),
    )
    .join("\n");
}
const A = "a".repeat(64);
const B = "b".repeat(64);

function loadIslands(directory: string, token: string, state: unknown, unavailable: boolean) {
  const baseline = { value: token };
  const values = new Map([["title", "Saved title"]]);
  const formListeners = new Map<string, (event: Event) => void>();
  const windowListeners = new Map<string, (event: Event) => void>();
  const attrs = new Set<string>();
  const editor = {
    hasAttribute: (name: string) => attrs.has(name),
    setAttribute: (name: string) => attrs.add(name),
    removeAttribute: (name: string) => attrs.delete(name),
    addEventListener: (type: string, listener: (event: Event) => void) => {
      const prior = formListeners.get(type);
      formListeners.set(type, (event) => {
        prior?.(event);
        listener(event);
      });
    },
  };
  const history = {
    state,
    replaceState: vi.fn((next: unknown) => {
      if (unavailable) throw new Error("History unavailable");
      history.state = next;
    }),
  };
  runInNewContext(islandSource(directory), {
    document: {
      querySelector: (selector: string) =>
        selector === "[data-event-editor]"
          ? editor
          : selector.includes('input[name="saved_baseline"]')
            ? baseline
            : null,
    },
    window: {
      history,
      location: { pathname: "/admin/featured/7" },
      addEventListener: (type: string, listener: (event: Event) => void) =>
        windowListeners.set(type, listener),
    },
    FormData: class {
      [Symbol.iterator]() {
        return new Map([...values, ["saved_baseline", baseline.value]])[Symbol.iterator]();
      }
    },
    URLSearchParams,
    setTimeout: vi.fn(),
    clearTimeout: vi.fn(),
  });
  return { baseline, history, values, formListeners, windowListeners };
}

describe.each(["assets", "public"])("%s moderator draft history token binding", (directory) => {
  const load = (token: string, state: unknown = null, unavailable = false) =>
    loadIslands(directory, token, state, unavailable);
  it("pins the displayed token in this entry without storing any form contents or replacing Kit state", () => {
    const b = load(A, { kit: { index: 7 } });
    expect(b.history.state).toEqual({
      kit: { index: 7 },
      twoAdminSaveBaseline: { path: "/admin/featured/7", token: A },
    });
    expect(JSON.stringify(b.history.state)).not.toContain("Saved title");
    expect(b.history.replaceState).toHaveBeenCalledOnce();
  });

  it("Back with restored draft text cannot pair it with a fresh GET token", () => {
    const original = load(A);
    const back = load(B, original.history.state);
    expect(back.baseline.value).toBe(A);
    back.values.set("title", "Recovered losing draft");
    // Native restoration can run after island initialization or pageshow.
    back.windowListeners.get("pageshow")!(new Event("pageshow"));
    back.baseline.value = B;
    back.formListeners.get("submit")!(new Event("submit", { cancelable: true }));
    expect(back.baseline.value).toBe(A);
    expect(back.values.get("title")).toBe("Recovered losing draft");
  });

  it("marks a freshly re-rendered old history entry dirty even before another keystroke", () => {
    const b = load(B, load(A).history.state);
    const departure = new Event("beforeunload", { cancelable: true });
    b.windowListeners.get("beforeunload")!(departure);
    expect(departure.defaultPrevented).toBe(true);
  });

  it("does not inherit a token from another record, and a new tab gets its fresh token", () => {
    const other = load(B, { twoAdminSaveBaseline: { path: "/admin/featured/8", token: A } });
    expect(other.baseline.value).toBe(B);
    expect(load(B).baseline.value).toBe(B);
  });

  it("fails closed through the recoverable missing-token response when history cannot bind the entry", () => {
    const b = load(B, null, true);
    expect(b.baseline.value).toBe("");
    b.baseline.value = B;
    b.formListeners.get("submit")!(new Event("submit", { cancelable: true }));
    expect(b.baseline.value).toBe("");
  });
});

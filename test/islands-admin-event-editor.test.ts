import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { URL as NodeURL } from "node:url";
import { describe, expect, it, vi } from "vitest";

const binder = readFileSync(new NodeURL("../public/islands/admin-event-editor.js", import.meta.url), "utf8");

function browser(missing = false) {
  const values = new Map([
    ["title", "Game night"], ["game", "Game"], ["description", "Bring friends"],
    ["starts_at", "2099-10-01 20:00"], ["ends_at", "2099-10-01 22:00"],
    ["timezone", "Europe/London"], ["location", "Discord"], ["capacity", ""],
  ]);
  const listeners = new Map<string, () => void>();
  const editor = { addEventListener: (kind: string, fn: () => void) => listeners.set(kind, fn) };
  const search = { q: "", listeners: new Map<string, () => void>() };
  const windowListeners = new Map<string, (event: { preventDefault: () => void; returnValue?: string }) => void>();
  runInNewContext(binder, {
    document: { querySelector: (selector: string) => !missing && selector === "[data-event-editor]" ? editor : null },
    window: { addEventListener: (kind: string, fn: (event: { preventDefault: () => void; returnValue?: string }) => void) => windowListeners.set(kind, fn) },
    FormData: class {
      constructor(form: unknown) { expect(form).toBe(editor); }
      [Symbol.iterator]() { return values[Symbol.iterator](); }
    },
    URLSearchParams,
  });
  return {
    values, search, windowListeners,
    navigate(kind: "search" | "sort" | "save") {
      if (kind === "save") listeners.get("submit")?.();
      if (kind === "search") search.listeners.get("submit")?.();
      const event = { preventDefault: vi.fn(), returnValue: undefined as string | undefined };
      windowListeners.get("beforeunload")?.(event);
      return event;
    },
  };
}

describe("Admin event editor navigation guard", () => {
  it.each(["search", "sort"] as const)("allows clean roster %s navigation", (kind) => {
    const b = browser();
    expect(b.navigate(kind).preventDefault).not.toHaveBeenCalled();
  });

  it.each(["search", "sort"] as const)("dirty roster %s requests a native leave/stay prompt; staying keeps the draft", (kind) => {
    const b = browser();
    b.values.set("title", "Unsaved game night");
    const event = b.navigate(kind);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(event.returnValue).toBe("");
    // Cancelling beforeunload leaves this document intact; no handler clears it.
    expect(b.values.get("title")).toBe("Unsaved game night");
    expect(b.navigate(kind).preventDefault).toHaveBeenCalledOnce();
  });

  it.each(["title", "game", "description", "starts_at", "ends_at", "timezone", "location", "capacity"])("tracks %s and allows navigation after reverting the edit", (field) => {
    const b = browser();
    const initial = b.values.get(field)!;
    b.values.set(field, initial + " changed");
    expect(b.navigate("sort").preventDefault).toHaveBeenCalledOnce();
    b.values.set(field, initial);
    expect(b.navigate("search").preventDefault).not.toHaveBeenCalled();
  });

  it("does not treat roster search values as event edits", () => {
    const b = browser();
    b.search.q = "Alice";
    expect(b.navigate("search").preventDefault).not.toHaveBeenCalled();
  });

  it("only exempts the event Save submit, never a roster search submit", () => {
    const b = browser();
    b.values.set("description", "Unsaved notes");
    expect(b.navigate("search").preventDefault).toHaveBeenCalledOnce();
    expect(b.navigate("save").preventDefault).not.toHaveBeenCalled();
  });

  it("restores the guard when Back returns to a saved document from the browser cache", () => {
    const b = browser();
    b.values.set("title", "Saved game night");
    expect(b.navigate("save").preventDefault).not.toHaveBeenCalled();
    b.windowListeners.get("pageshow")!({ preventDefault: vi.fn() });
    b.values.set("title", "Another unsaved title");
    expect(b.navigate("sort").preventDefault).toHaveBeenCalledOnce();
  });

  it("does nothing without an event editor", () => {
    const b = browser(true);
    expect(b.windowListeners.size).toBe(0);
    expect(b.navigate("sort").preventDefault).not.toHaveBeenCalled();
  });
});

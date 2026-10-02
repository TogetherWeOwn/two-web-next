import { describe, expect, it, vi } from "vitest";
import { eventEditorBrowser as browser } from "./helpers/admin-event-editor";

describe("Admin event editor navigation guard", () => {
  it.each(["search", "sort"] as const)("allows clean roster %s navigation", (kind) => {
    const b = browser();
    expect(b.navigate(kind).preventDefault).not.toHaveBeenCalled();
  });

  it.each(["search", "sort"] as const)(
    "dirty roster %s requests a native leave/stay prompt; staying keeps the draft",
    (kind) => {
      const b = browser();
      b.values.set("title", "Unsaved game night");
      const event = b.navigate(kind);
      expect(event.preventDefault).toHaveBeenCalledOnce();
      expect(event.returnValue).toBe("");
      // Cancelling beforeunload leaves this document intact; no handler clears it.
      expect(b.values.get("title")).toBe("Unsaved game night");
      expect(b.navigate(kind).preventDefault).toHaveBeenCalledOnce();
    },
  );

  it.each([
    "title",
    "game",
    "description",
    "starts_at",
    "ends_at",
    "timezone",
    "location",
    "capacity",
  ])("tracks %s and allows navigation after reverting the edit", (field) => {
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

  it.each(["search", "sort"] as const)(
    "protects an untouched failed-Save draft on %s departure",
    (kind) => {
      const b = browser({ draft: true, initial: { title: "Rejected draft" } });
      expect(b.navigate(kind).preventDefault).toHaveBeenCalledOnce();
      expect(b.values.get("title")).toBe("Rejected draft");
      expect(b.navigate("save").preventDefault).not.toHaveBeenCalled();
      expect(b.navigate(kind).preventDefault).toHaveBeenCalledOnce();
    },
  );

  it("consumes the Save exemption when this document survives interrupted navigation", () => {
    const b = browser();
    b.values.set("title", "Unsaved draft");
    expect(b.navigate("save").preventDefault).not.toHaveBeenCalled();
    // Loading stops after beforeunload; no replacement document or pageshow.
    expect(b.navigate("sort").preventDefault).toHaveBeenCalledOnce();
    expect(b.navigate("search").preventDefault).toHaveBeenCalledOnce();
    expect(b.navigate("save").preventDefault).not.toHaveBeenCalled();
    expect(b.navigate("sort").preventDefault).toHaveBeenCalledOnce();
  });

  it("re-arms on edits if Save navigation never reaches beforeunload", () => {
    const b = browser();
    b.listeners.get("submit")!();
    b.values.set("title", "Another unsaved title");
    b.listeners.get("input")!();
    expect(b.navigate("sort").preventDefault).toHaveBeenCalledOnce();
  });

  it("does nothing without an event editor", () => {
    const b = browser({ missing: true });
    expect(b.windowListeners.size).toBe(0);
    expect(b.navigate("sort").preventDefault).not.toHaveBeenCalled();
  });
});

import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { eventEditorBrowser as browser } from "./helpers/admin-event-editor";

// Keep the acceptance-owned expiry harness unchanged; this fixture owns only
// the new review link and its dirty snapshot.
function reviewBrowser(draft = false) {
  const values = new Map([["title", "Game night"]]);
  const link = {
    href: "https://next.example/e/abc?review=1",
    onclick: null as (() => void) | null,
  };
  const listeners = new Map<
    string,
    (event: { preventDefault: () => void; returnValue?: string }) => void
  >();
  const editor = { hasAttribute: () => draft, addEventListener: vi.fn() };
  runInNewContext(
    readFileSync(new URL("../public/islands/admin-event-editor.js", import.meta.url), "utf8"),
    {
      document: {
        querySelector: (selector: string) =>
          selector === "[data-event-editor]"
            ? editor
            : selector === '[data-testid="review-event"]'
              ? link
              : null,
      },
      window: {
        addEventListener: (
          name: string,
          fn: (event: { preventDefault: () => void; returnValue?: string }) => void,
        ) => listeners.set(name, fn),
      },
      FormData: class {
        [Symbol.iterator]() {
          return values[Symbol.iterator]();
        }
      },
      URLSearchParams,
    },
  );
  return {
    values,
    link,
    click: () => link.onclick!(),
    navigate: () => {
      const event = { preventDefault: vi.fn(), returnValue: undefined as string | undefined };
      listeners.get("beforeunload")!(event);
      return event;
    },
  };
}

describe("Admin event editor navigation guard", () => {
  it.each(["/auth/recover\\n", "/auth/recover\\r\\n", "/auth/recover\\u2028"])(
    "refuses a recovery path with a trailing control: %j",
    (path) => {
      const b = browser();
      b.expireSession(path);
      expect(b.recoveryLink()!.href).toBe("/auth/recover?next=%2Fadmin%2Fevents%2Fabc");
    },
  );

  it("marks review navigation only while edits are unsaved and leaves protection armed", () => {
    const b = reviewBrowser();
    const link = b.link;
    b.click();
    expect(link.href).toBe("https://next.example/e/abc?review=1");
    const saved = b.values.get("title")!;
    b.values.set("title", "Unsaved title");
    b.click();
    expect(link.href).toBe("https://next.example/e/abc?review=1&unsaved=1");
    expect(b.navigate().preventDefault).toHaveBeenCalledOnce();
    b.values.set("title", saved);
    b.click();
    expect(link.href).toBe("https://next.example/e/abc?review=1");
    expect(b.navigate().preventDefault).not.toHaveBeenCalled();
  });

  it("marks a rejected Save as unsaved even without another keystroke", () => {
    const b = reviewBrowser(true);
    b.click();
    expect(b.link.href).toContain("&unsaved=1");
    expect(b.navigate().preventDefault).toHaveBeenCalledOnce();
  });

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
    // The Save lock lapses after its bound before a retried Save can go out.
    b.fireTimers();
    expect(b.navigate("save").preventDefault).not.toHaveBeenCalled();
    expect(b.navigate("sort").preventDefault).toHaveBeenCalledOnce();
  });

  it("restores departure protection after an interrupted Save unlocks without another input", () => {
    const b = browser();
    b.values.set("title", "Unsaved draft");
    b.submit();
    // No departure, input, or pageshow before the ten-second lock lapses.
    b.fireTimers();
    const departure = b.navigate("sort");
    expect(departure.preventDefault).toHaveBeenCalledOnce();
    expect(departure.returnValue).toBe("");
  });

  it("gives a retried Save after timeout its own one-shot departure exemption", () => {
    const b = browser();
    b.values.set("title", "Unsaved draft");
    b.submit();
    b.fireTimers();
    expect(b.navigate("save").preventDefault).not.toHaveBeenCalled();
    expect(b.navigate("sort").preventDefault).toHaveBeenCalledOnce();
  });

  it("keeps clean navigation unprompted after an interrupted Save unlocks", () => {
    const b = browser();
    b.submit();
    b.fireTimers();
    expect(b.navigate("sort").preventDefault).not.toHaveBeenCalled();
  });

  it("re-arms on edits if Save navigation never reaches beforeunload", () => {
    const b = browser();
    b.submit();
    b.values.set("title", "Another unsaved title");
    b.input();
    expect(b.navigate("sort").preventDefault).toHaveBeenCalledOnce();
  });

  it("does nothing without an event editor", () => {
    const b = browser({ missing: true });
    expect(b.windowListeners.size).toBe(0);
    expect(b.navigate("sort").preventDefault).not.toHaveBeenCalled();
  });
});

describe("Admin event editor repeated submit", () => {
  it("lets the first Save submit go out untouched", () => {
    const b = browser();
    expect(b.submit().preventDefault).not.toHaveBeenCalled();
  });

  it("cancels every further submit, so exactly one Save goes out", () => {
    const b = browser();
    const submits = [b.submit(), b.submit(), b.submit()];
    expect(submits.filter((s) => !s.defaultPrevented)).toHaveLength(1);
    expect(submits[1]!.preventDefault).toHaveBeenCalledOnce();
  });

  it("does not re-arm the Save exemption for a cancelled repeat", () => {
    const b = browser();
    b.values.set("description", "Unsaved notes");
    b.submit();
    b.submit();
    expect(b.navigate("sort").preventDefault).not.toHaveBeenCalled();
    expect(b.navigate("sort").preventDefault).toHaveBeenCalledOnce();
  });

  it("marks the form aria-busy while locked and clears it on pageshow", () => {
    const b = browser();
    b.submit();
    expect(b.editor.attrs["aria-busy"]).toBe("true");
    b.windowListeners.get("pageshow")!({ preventDefault: vi.fn() });
    expect(b.editor.attrs["aria-busy"]).toBeUndefined();
    expect(b.submit().preventDefault).not.toHaveBeenCalled();
  });

  it("releases the lock within 10 seconds so an aborted navigation cannot strand the form", () => {
    const b = browser();
    b.submit();
    expect(b.pendingTimers()).toHaveLength(1);
    expect(Math.max(...b.pendingTimers())).toBeLessThanOrEqual(10_000);
    b.fireTimers();
    expect(b.editor.attrs["aria-busy"]).toBeUndefined();
    expect(b.submit().defaultPrevented).toBe(false);
    expect(b.submit().defaultPrevented).toBe(true);
  });

  it("clears the pending release timer on pageshow", () => {
    const b = browser();
    b.submit();
    expect(b.pendingTimers()).toHaveLength(1);
    b.windowListeners.get("pageshow")!({ preventDefault: vi.fn() });
    expect(b.pendingTimers()).toEqual([]);
  });

  it("moves no focus and inserts no DOM while locked", () => {
    const b = browser();
    b.submit();
    b.submit();
    expect(b.created).toHaveLength(0);
    expect(b.inserted).toHaveLength(0);
  });

  it("leaves the roster search submit unaffected while a Save is locked", () => {
    const b = browser();
    b.submit();
    expect(b.searchSubmit().defaultPrevented).toBe(false);
  });
});

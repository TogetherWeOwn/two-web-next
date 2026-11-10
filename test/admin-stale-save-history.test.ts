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

function loadIslands(
  directory: string,
  token: string,
  state: unknown,
  unavailable: boolean,
  navType = "",
  pathname = "/admin/featured/7",
  initialValues: Record<string, string> = {},
) {
  const baseline = { value: token };
  const values = new Map([["title", "Saved title"], ...Object.entries(initialValues)]);
  const formListeners = new Map<string, (event: Event) => void>();
  const windowListeners = new Map<string, (event: Event) => void>();
  const attrs = new Set<string>();
  const editor = {
    hasAttribute: (name: string) => attrs.has(name),
    setAttribute: (name: string) => attrs.add(name),
    removeAttribute: (name: string) => attrs.delete(name),
    querySelector: (selector: string) => (selector.includes("saved_baseline") ? baseline : null),
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
    replaceState: vi.fn((next: unknown, url: unknown) => {
      // The Web IDL requires the second string argument: a one-argument
      // replaceState throws in a browser and the island fails closed.
      // Emulate it so the VM suite cannot stay green while the shipped
      // island is broken in a browser.
      if (url !== "")
        throw new TypeError(
          "Failed to execute 'replaceState': parameters 1 is not of type 'string'.",
        );
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
      location: { pathname },
      performance: {
        getEntriesByType: () => (navType ? [{ type: navType }] : []),
      },
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
  return { attrs, baseline, history, values, formListeners, windowListeners };
}

describe.each(["assets", "public"])("%s moderator draft history token binding", (directory) => {
  const load = (token: string, state: unknown = null, unavailable = false) =>
    loadIslands(directory, token, state, unavailable);
  // A genuine user edit: the browser sets the value, then fires input/change.
  function userEdit(islands: ReturnType<typeof loadIslands>, field: string, value: string) {
    islands.values.set(field, value);
    islands.formListeners.get("input")!(new Event("input"));
    islands.formListeners.get("change")!(new Event("change"));
  }
  it("pins the displayed token in this entry without storing any form contents or replacing Kit state", () => {
    const b = load(A, { kit: { index: 7 } });
    expect(b.history.state).toEqual({
      kit: { index: 7 },
      twoAdminSaveBaseline: { path: "/admin/featured/7", token: A, clean: true },
    });
    expect(JSON.stringify(b.history.state)).not.toContain("Saved title");
    expect(b.history.replaceState).toHaveBeenCalledOnce();
    expect(b.history.replaceState).toHaveBeenCalledWith(
      {
        kit: { index: 7 },
        twoAdminSaveBaseline: { path: "/admin/featured/7", token: A, clean: true },
      },
      "",
    );
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

  it.each(["/admin/events/01K00000000000000000000001", "/admin/featured/7"])(
    "reload of %s adopts the fresh GET token and stays clean",
    (pathname) => {
      const original = loadIslands(directory, A, null, false, "", pathname);
      const reloaded = loadIslands(directory, B, original.history.state, false, "reload", pathname);
      expect(reloaded.baseline.value).toBe(B);
      expect(reloaded.history.state).toEqual({
        twoAdminSaveBaseline: { path: pathname, token: B, clean: true },
      });
      const departure = new Event("beforeunload", { cancelable: true });
      reloaded.windowListeners.get("beforeunload")!(departure);
      expect(departure.defaultPrevented).toBe(false);
      reloaded.baseline.value = A;
      reloaded.formListeners.get("submit")!(new Event("submit", { cancelable: true }));
      expect(reloaded.baseline.value).toBe(B);
    },
  );

  it("back/forward traversal keeps the original token for a restored draft", () => {
    const original = load(A);
    const back = loadIslands(directory, B, original.history.state, false, "back_forward");
    expect(back.baseline.value).toBe(A);
    const departure = new Event("beforeunload", { cancelable: true });
    back.windowListeners.get("beforeunload")!(departure);
    expect(departure.defaultPrevented).toBe(true);
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

  it.each([
    ["/admin/events/01K00000000000000000000001", "title", "My unsaved draft"],
    ["/admin/featured/7", "title", "My unsaved draft"],
    ["/admin/events/01K00000000000000000000001", "capacity", "4"],
    ["/admin/featured/7", "position", "9"],
  ])(
    "dirty reload of %s restores old %s values without upgrading the draft to the fresh token (%s)",
    (pathname, field, draft) => {
      const original = loadIslands(directory, A, null, false, "", pathname);
      userEdit(original, field, draft);
      const freshValue = field === "title" ? "Saved title" : field === "capacity" ? "8" : "0";
      // Restoration at initialization: the browser hands the old draft to the
      // reload before the island runs. Injected restoration is adversarial
      // simulation, not native reproduction.
      const restoredAtInit = loadIslands(
        directory,
        B,
        original.history.state,
        false,
        "reload",
        pathname,
        { [field]: draft },
      );
      expect(restoredAtInit.baseline.value).toBe(A);
      expect(restoredAtInit.attrs.has("data-event-draft")).toBe(true);
      restoredAtInit.formListeners.get("submit")!(new Event("submit", { cancelable: true }));
      expect(restoredAtInit.baseline.value).toBe(A);
      expect(restoredAtInit.values.get(field)).toBe(draft);
      // Restoration after pageshow, and immediately before submit: same entry,
      // fresh values at init, old values reappear with no user input events.
      for (const timing of ["pageshow", "submit"] as const) {
        const late = loadIslands(directory, B, original.history.state, false, "reload", pathname, {
          [field]: freshValue,
        });
        expect(late.baseline.value).toBe(A);
        if (timing === "pageshow") late.windowListeners.get("pageshow")!(new Event("pageshow"));
        late.values.set(field, draft);
        late.formListeners.get("submit")!(new Event("submit", { cancelable: true }));
        expect(late.baseline.value).toBe(A);
        expect(late.values.get(field)).toBe(draft);
        expect(late.history.state).toEqual({
          twoAdminSaveBaseline: { path: pathname, token: A, clean: false },
        });
      }
    },
  );

  it.each(["/admin/events/01K00000000000000000000001", "/admin/featured/7"])(
    "clean reload of %s adopts the fresh token and saves a legitimate post-reload edit",
    (pathname) => {
      const original = loadIslands(directory, A, null, false, "", pathname);
      const reloaded = loadIslands(directory, B, original.history.state, false, "reload", pathname);
      expect(reloaded.baseline.value).toBe(B);
      userEdit(reloaded, "title", "Edited after a clean reload");
      reloaded.formListeners.get("submit")!(new Event("submit", { cancelable: true }));
      expect(reloaded.baseline.value).toBe(B);
      expect(reloaded.values.get("title")).toBe("Edited after a clean reload");
    },
  );

  it("clean reload with values restored only after initialization still refuses under the old token", () => {
    const original = loadIslands(directory, A, null, false, "", "/admin/featured/7");
    expect(original.history.state).toEqual({
      twoAdminSaveBaseline: { path: "/admin/featured/7", token: A, clean: true },
    });
    const reloaded = loadIslands(directory, B, original.history.state, false, "reload");
    expect(reloaded.baseline.value).toBe(B);
    // No input/change fires for native restoration: the submit must bind the
    // returned fields to the entry's original token, not the adopted fresh B.
    reloaded.values.set("title", "Restored old draft");
    reloaded.formListeners.get("submit")!(new Event("submit", { cancelable: true }));
    expect(reloaded.baseline.value).toBe(A);
    expect(reloaded.values.get("title")).toBe("Restored old draft");
  });

  it("back retains the original token and re-marks the entry dirty so a following reload cannot adopt fresh", () => {
    const original = load(A);
    const back = loadIslands(directory, B, original.history.state, false, "back_forward");
    expect(back.baseline.value).toBe(A);
    expect(back.history.state).toEqual({
      twoAdminSaveBaseline: { path: "/admin/featured/7", token: A, clean: false },
    });
    const reloaded = loadIslands(directory, B, back.history.state, false, "reload");
    expect(reloaded.baseline.value).toBe(A);
    expect(reloaded.history.state).toEqual({
      twoAdminSaveBaseline: { path: "/admin/featured/7", token: A, clean: false },
    });
  });

  it("pins the conditional late-restoration plus later edit of another control case", () => {
    // Conditional gap, not a demonstrated native overwrite: native
    // restoration is unproven. If one control is silently restored before
    // the user edits a different control, the genuine edit clears the
    // adopted-token guard and the combined fields submit under the adopted
    // fresh token. This documents the current behavior for Security; it is
    // not a safety proof.
    const original = load(A);
    const reloaded = loadIslands(directory, B, original.history.state, false, "reload");
    expect(reloaded.baseline.value).toBe(B);
    reloaded.values.set("title", "Restored old draft");
    userEdit(reloaded, "capacity", "4");
    reloaded.formListeners.get("submit")!(new Event("submit", { cancelable: true }));
    expect(reloaded.baseline.value).toBe(B);
    expect(reloaded.values.get("title")).toBe("Restored old draft");
    expect(reloaded.values.get("capacity")).toBe("4");
  });

  it("writes history once per dirty transition instead of on every input/change", () => {
    const reloaded = loadIslands(directory, B, load(A).history.state, false, "reload");
    expect(reloaded.history.replaceState).toHaveBeenCalledTimes(1);
    userEdit(reloaded, "title", "Edit 1");
    userEdit(reloaded, "title", "Edit 2");
    userEdit(reloaded, "title", "Edit 3");
    expect(reloaded.history.replaceState).toHaveBeenCalledTimes(2);
    expect(reloaded.history.state).toEqual({
      twoAdminSaveBaseline: { path: "/admin/featured/7", token: B, clean: false },
    });
  });

  it("reload over an entry without provenance keeps the old token instead of adopting the fresh one", () => {
    const legacy = loadIslands(
      directory,
      B,
      { twoAdminSaveBaseline: { path: "/admin/featured/7", token: A } },
      false,
      "reload",
    );
    expect(legacy.baseline.value).toBe(A);
    expect(legacy.attrs.has("data-event-draft")).toBe(true);
  });
});

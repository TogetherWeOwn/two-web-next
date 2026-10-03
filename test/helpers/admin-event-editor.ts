import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { URL as NodeURL } from "node:url";
import { expect, vi } from "vitest";

const binder = readFileSync(
  new NodeURL("../../public/islands/admin-event-editor.js", import.meta.url),
  "utf8",
);

export function eventEditorBrowser({
  missing = false,
  draft = false,
  initial = {},
}: {
  missing?: boolean;
  draft?: boolean;
  initial?: Record<string, string>;
} = {}) {
  const values = new Map([
    ["title", "Game night"],
    ["game", "Game"],
    ["description", "Bring friends"],
    ["starts_at", "2099-10-01 20:00"],
    ["ends_at", "2099-10-01 22:00"],
    ["timezone", "Europe/London"],
    ["location", "Discord"],
    ["capacity", ""],
    ...Object.entries(initial),
  ]);
  const listeners = new Map<string, () => void>();
  const editor = {
    addEventListener: (kind: string, fn: () => void) => listeners.set(kind, fn),
    hasAttribute: (name: string) => draft && name === "data-event-draft",
  };
  const search = { q: "", listeners: new Map<string, () => void>() };
  const windowListeners = new Map<
    string,
    (event: { preventDefault: () => void; returnValue?: string }) => void
  >();
  runInNewContext(binder, {
    document: {
      querySelector: (selector: string) =>
        !missing && selector === "[data-event-editor]" ? editor : null,
    },
    window: {
      addEventListener: (
        kind: string,
        fn: (event: { preventDefault: () => void; returnValue?: string }) => void,
      ) => windowListeners.set(kind, fn),
    },
    FormData: class {
      constructor(form: unknown) {
        expect(form).toBe(editor);
      }
      [Symbol.iterator]() {
        return values[Symbol.iterator]();
      }
    },
    URLSearchParams,
  });
  return {
    values,
    search,
    windowListeners,
    listeners,
    navigate(kind: "search" | "sort" | "save") {
      if (kind === "save") listeners.get("submit")?.();
      if (kind === "search") search.listeners.get("submit")?.();
      const event = { preventDefault: vi.fn(), returnValue: undefined as string | undefined };
      windowListeners.get("beforeunload")?.(event);
      return event;
    },
  };
}

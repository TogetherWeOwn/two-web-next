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
  type FakeElement = {
    tag: string;
    attrs: Record<string, string>;
    children: FakeElement[];
    textContent: string;
    href: string;
    focused: boolean;
    setAttribute: (k: string, v: string) => void;
    appendChild: (c: FakeElement) => void;
    focus: () => void;
    remove: () => void;
  };
  const created: FakeElement[] = [];
  const makeElement = (tag: string): FakeElement => {
    const el: FakeElement = {
      tag,
      attrs: {},
      children: [],
      textContent: "",
      href: "",
      focused: false,
      setAttribute: (k, v) => {
        el.attrs[k] = v;
      },
      appendChild: (c) => {
        el.children.push(c);
      },
      focus: () => {
        el.focused = true;
      },
      remove: () => {
        const i = created.indexOf(el);
        if (i >= 0) created.splice(i, 1);
      },
    };
    created.push(el);
    return el;
  };
  const inserted: { node: FakeElement; before: unknown }[] = [];
  const editor = {
    addEventListener: (kind: string, fn: () => void) => listeners.set(kind, fn),
    hasAttribute: (name: string) => draft && name === "data-event-draft",
    parentNode: {
      insertBefore: (node: FakeElement, before: unknown) => {
        inserted.push({ node, before });
      },
    },
  };
  const search = { q: "", listeners: new Map<string, () => void>() };
  const windowListeners = new Map<
    string,
    (event: { preventDefault: () => void; returnValue?: string; detail?: unknown }) => void
  >();
  runInNewContext(binder, {
    document: {
      querySelector: (selector: string) => {
        if (selector === "[data-event-editor]") return missing ? null : editor;
        const found = created.find(
          (el) => `[data-testid="${el.attrs["data-testid"]}"]` === selector,
        );
        return found ?? null;
      },
      createElement: makeElement,
    },
    window: {
      addEventListener: (
        kind: string,
        fn: (event: { preventDefault: () => void; returnValue?: string; detail?: unknown }) => void,
      ) => windowListeners.set(kind, fn),
      location: { pathname: "/admin/events/abc", search: "" },
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
    created,
    inserted,
    editor,
    navigate(kind: "search" | "sort" | "save") {
      if (kind === "save") listeners.get("submit")?.();
      if (kind === "search") search.listeners.get("submit")?.();
      const event = { preventDefault: vi.fn(), returnValue: undefined as string | undefined };
      windowListeners.get("beforeunload")?.(event);
      return event;
    },
    expireSession(recoveryUrl = "/auth/recover?next=%2Fadmin%2Fevents%2Fabc") {
      const event = { preventDefault: vi.fn(), detail: { recoveryUrl } };
      windowListeners.get("two:session-expired")?.(event);
      return event;
    },
  };
}

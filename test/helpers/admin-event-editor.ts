import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { URL as NodeURL } from "node:url";
import { expect, vi } from "vitest";

const binder = readFileSync(
  new NodeURL("../../public/islands/admin-event-editor.js", import.meta.url),
  "utf8",
);

type DomEvent = {
  defaultPrevented: boolean;
  preventDefault: ReturnType<typeof vi.fn>;
};

function domEvent(): DomEvent {
  const event: DomEvent = {
    defaultPrevented: false,
    preventDefault: vi.fn(() => {
      event.defaultPrevented = true;
    }),
  };
  return event;
}

export type ClickInit = {
  button?: number;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
};

export function eventEditorBrowser({
  missing = false,
  draft = false,
  initial = {},
  path = "/admin/events/abc",
  summary = null,
}: {
  missing?: boolean;
  draft?: boolean;
  initial?: Record<string, string>;
  path?: string;
  /** Which refusal notice the render carries, for the island's focus-on-load. */
  summary?: "validation" | "conflict" | null;
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
  const listeners = new Map<string, Array<(event: DomEvent) => void>>();
  const dispatch = (kind: string, event: DomEvent = domEvent()) => {
    for (const fn of listeners.get(kind) ?? []) fn(event);
    return event;
  };
  type ClickEvent = Required<ClickInit> & {
    target: FakeElement;
    currentTarget: FakeElement;
    defaultPrevented: boolean;
    preventDefault: () => void;
  };
  type FakeElement = {
    tag: string;
    attrs: Record<string, string>;
    children: FakeElement[];
    parent: FakeElement | null;
    textContent: string;
    href: string;
    focused: boolean;
    onclick: ((event: ClickEvent) => void) | null;
    setAttribute: (k: string, v: string) => void;
    appendChild: (c: FakeElement) => void;
    addEventListener: (kind: string, fn: (event: ClickEvent) => void) => void;
    querySelector: (selector: string) => FakeElement | null;
    click: (init?: ClickInit) => ClickEvent;
    focus: () => void;
    remove: () => void;
  };
  const created: FakeElement[] = [];
  const elementHandlers = new WeakMap<
    FakeElement,
    Map<string, Array<(event: ClickEvent) => void>>
  >();
  const makeElement = (tag: string): FakeElement => {
    const handlers = new Map<string, Array<(event: ClickEvent) => void>>();
    const el: FakeElement = {
      tag,
      attrs: {},
      children: [],
      parent: null,
      textContent: "",
      href: "",
      focused: false,
      onclick: null,
      setAttribute: (k, v) => {
        el.attrs[k] = v;
      },
      appendChild: (c) => {
        c.parent = el;
        el.children.push(c);
      },
      addEventListener: (kind, fn) => {
        handlers.set(kind, [...(handlers.get(kind) ?? []), fn]);
      },
      querySelector: (selector) =>
        el.children.find(
          (c) => c.tag === selector || `[data-testid="${c.attrs["data-testid"]}"]` === selector,
        ) ?? null,
      // Dispatch like a browser click: handlers on the element, then bubbling
      // through ancestors, with target fixed on the clicked element.
      click: (init = {}) => {
        const event: ClickEvent = {
          button: init.button ?? 0,
          ctrlKey: init.ctrlKey ?? false,
          metaKey: init.metaKey ?? false,
          shiftKey: init.shiftKey ?? false,
          altKey: init.altKey ?? false,
          target: el,
          currentTarget: el,
          defaultPrevented: false,
          preventDefault: () => {
            event.defaultPrevented = true;
          },
        };
        for (let node: FakeElement | null = el; node; node = node.parent) {
          event.currentTarget = node;
          node.onclick?.(event);
          for (const fn of elementHandlers.get(node)?.get("click") ?? []) fn(event);
        }
        return event;
      },
      focus: () => {
        el.focused = true;
      },
      remove: () => {
        const i = created.indexOf(el);
        if (i >= 0) created.splice(i, 1);
      },
    };
    elementHandlers.set(el, handlers);
    created.push(el);
    return el;
  };
  const inserted: { node: FakeElement; before: unknown }[] = [];
  const editorAttrs: Record<string, string> = {};
  const editor = {
    attrs: editorAttrs,
    addEventListener: (kind: string, fn: (event: DomEvent) => void) => {
      listeners.set(kind, [...(listeners.get(kind) ?? []), fn]);
    },
    hasAttribute: (name: string) => draft && name === "data-event-draft",
    setAttribute: (k: string, v: string) => {
      editorAttrs[k] = v;
    },
    removeAttribute: (k: string) => {
      delete editorAttrs[k];
    },
    parentNode: {
      insertBefore: (node: FakeElement, before: unknown) => {
        inserted.push({ node, before });
      },
    },
  };
  const search = { q: "", listeners: new Map<string, (event: DomEvent) => void>() };
  const windowListeners = new Map<
    string,
    (event: { preventDefault: () => void; returnValue?: string; detail?: unknown }) => void
  >();
  const timers = new Map<number, { fn: () => void; ms: number }>();
  let nextTimer = 1;
  const setTimer = (fn: () => void, ms: number) => {
    const id = nextTimer++;
    timers.set(id, { fn, ms });
    return id;
  };
  const clearTimer = (id: number) => {
    timers.delete(id);
  };
  const summaries: Record<string, FakeElement> = {};
  if (summary === "validation") summaries["[data-admin-validation-summary]"] = makeElement("div");
  if (summary === "conflict") summaries["[data-admin-conflict-summary]"] = makeElement("div");
  if (summary) summaries["[data-admin-save-summary]"] = Object.values(summaries)[0]!;
  runInNewContext(binder, {
    // The member-profile recovery pattern uses a bare setTimeout; island code
    // here uses window.setTimeout. Back both spellings with the same timers.
    setTimeout: setTimer,
    clearTimeout: clearTimer,
    document: {
      querySelector: (selector: string) => {
        if (selector === "[data-event-editor]") return missing ? null : editor;
        if (selector in summaries) return summaries[selector]!;
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
      setTimeout: setTimer,
      clearTimeout: clearTimer,
      location: { origin: "https://next.example", pathname: path, search: "" },
    },
    FormData: class {
      constructor(form: unknown) {
        expect(form).toBe(editor);
      }
      [Symbol.iterator]() {
        return values[Symbol.iterator]();
      }
    },
    URL: NodeURL,
    URLSearchParams,
  });
  return {
    values,
    summaries,
    search,
    windowListeners,
    listeners,
    created,
    inserted,
    editor,
    submit: () => dispatch("submit"),
    input: () => dispatch("input"),
    searchSubmit() {
      const event = domEvent();
      search.listeners.get("submit")?.(event);
      return event;
    },
    pendingTimers: () => [...timers.values()].map((t) => t.ms),
    fireTimers() {
      for (const [id, timer] of [...timers]) {
        timers.delete(id);
        timer.fn();
      }
    },
    /** Fire only timers due within `ms` (e.g. a 0 ms one-shot reset lapses). */
    advanceTimers(ms: number) {
      for (const [id, timer] of [...timers]) {
        if (timer.ms > ms) continue;
        timers.delete(id);
        timer.fn();
      }
    },
    /** The "Sign in again" anchor inside the expiry notice, if rendered. */
    recoveryLink() {
      const notice = created.find((el) => el.attrs["data-testid"] === "admin-session-expired");
      return notice?.children.find((c) => c.tag === "a") ?? null;
    },
    clickRecovery(init: ClickInit = {}) {
      const link = this.recoveryLink();
      expect(link, "expiry notice must render a recovery link first").not.toBeNull();
      return link!.click(init);
    },
    navigate(kind: "search" | "sort" | "save" | "reload" | "unrelated") {
      if (kind === "save") dispatch("submit");
      if (kind === "search") search.listeners.get("submit")?.(domEvent());
      const event = { preventDefault: vi.fn(), returnValue: undefined as string | undefined };
      windowListeners.get("beforeunload")?.(event);
      return event;
    },
    expireSession(recoveryUrl: unknown = "/auth/recover?next=%2Fadmin%2Fevents%2Fabc") {
      const event = { preventDefault: vi.fn(), detail: { recoveryUrl } };
      windowListeners.get("two:session-expired")?.(event);
      return event;
    },
  };
}

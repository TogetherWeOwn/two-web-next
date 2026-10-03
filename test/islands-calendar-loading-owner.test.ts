import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

const binder = readFileSync(
  new NodeURL("../public/islands/events-calendar.js", import.meta.url),
  "utf8",
);
const APP_URL = "https://calendar.example.test";
const MOUNT = '[data-island="events-calendar"]';
const LIVE_IDS = [
  "events-view-status",
  "events-search-status",
  "events-past-status",
  "calendar-month-status",
];

type IslandEvent = {
  preventDefault(): void;
  defaultPrevented?: boolean;
  button?: number;
  target?: { closest(): unknown };
};

class Node {
  hidden = false;
  textContent = "";
  value = "";
  href = "";
  focused = false;
  childNodes: string[] = [];
  dataset: Record<string, string> = {};
  attributes = new Map<string, string>();
  listeners = new Map<string, (event: IslandEvent) => void>();
  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }
  getAttribute(name: string) {
    return this.attributes.get(name) ?? null;
  }
  removeAttribute(name: string) {
    this.attributes.delete(name);
  }
  replaceChildren(...children: string[]) {
    this.childNodes = children;
  }
  focus() {
    this.focused = true;
  }
  addEventListener(type: string, listener: (event: IslandEvent) => void) {
    this.listeners.set(type, listener);
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

type Response = { ok: boolean; text(): Promise<string> };
type Action = "search" | "navigation";
type Outcome = "success" | "failure" | "abort";

function createZones(content: string) {
  return ["head", "actions", "miss", "content"].map((name) => {
    const zone = new Node();
    zone.setAttribute("data-cal-zone", name);
    zone.childNodes = [name === "content" ? content : name];
    return zone;
  });
}

// Execute the shipped binder in an isolated VM. Fetches deliberately ignore
// abort so obsolete completions exercise ownership rather than transport luck.
function browser() {
  const zones = createZones("last-good content");
  const content = zones[3]!;
  const skeleton = new Node();
  skeleton.hidden = true;
  skeleton.textContent = "Loading events";
  const feedback = new Node();
  const form = new Node();
  const input = Object.assign(new Node(), { closest: () => form });
  const live = Object.fromEntries(LIVE_IDS.map((id) => [id, new Node()]));
  const root = Object.assign(new Node(), {
    querySelector(selector: string) {
      if (selector === '[data-testid="events-loading"]') return skeleton;
      if (selector === '[data-testid="events-search"]') return input;
      if (selector === "[data-cal-feedback]") return feedback;
      if (selector === '[data-cal-zone="content"]') return content;
      const id = /data-testid="([^"]+)"/.exec(selector)?.[1];
      return id ? (live[id] ?? null) : null;
    },
    querySelectorAll: () => zones,
    contains: () => true,
  });
  root.dataset = {
    view: "list",
    month: "2026-10",
    past: "",
    loadError: "Calendar unavailable. Try again.",
  };
  const canonical = { href: APP_URL + "/events" };
  const og = { content: canonical.href };
  const history: string[] = [];
  const reloads: string[] = [];
  const location = {
    href: canonical.href,
    origin: APP_URL,
    assign: (href: string) => reloads.push(href),
  };
  const requests: {
    url: string;
    signal: AbortSignal;
    read: ReturnType<typeof deferred<Response>>;
  }[] = [];
  const pages = new Map<string, unknown>();
  const timers = new Map<number, () => void>();
  let nextTimer = 0;
  runInNewContext(
    binder,
    {
      URL,
      AbortController,
      setTimeout(callback: () => void, ms: number) {
        expect(ms).toBe(300);
        timers.set(++nextTimer, callback);
        return nextTimer;
      },
      clearTimeout: (id: number) => timers.delete(id),
      document: {
        querySelector: (selector: string) =>
          selector === MOUNT ? root : selector.startsWith("link") ? canonical : og,
        importNode: (node: string) => node,
      },
      window: {
        location,
        history: {
          pushState(_state: unknown, _title: string, url: string) {
            history.push(url);
            location.href = APP_URL + url;
          },
        },
        addEventListener() {},
      },
      DOMParser: class {
        parseFromString(html: string) {
          return pages.get(html);
        }
      },
      fetch(url: string, init: { signal: AbortSignal }) {
        const read = deferred<Response>();
        requests.push({ url, signal: init.signal, read });
        return read.promise;
      },
    },
    { filename: "public/islands/events-calendar.js" },
  );

  function navigate(url = "/events?view=calendar&month=2026-11") {
    const link = { href: APP_URL + url, target: "", hasAttribute: () => false };
    root.listeners.get("click")!({
      preventDefault() {},
      defaultPrevented: false,
      button: 0,
      target: { closest: () => link },
    });
  }

  function typeSearch() {
    input.value = "chess";
    input.focus();
    input.listeners.get("input")!({ preventDefault() {} });
  }

  function fireSearch() {
    const callbacks = [...timers.values()];
    timers.clear();
    callbacks.forEach((callback) => callback());
  }

  function page(index: number) {
    const token = `page-${index}`;
    const sourceZones = createZones(`response-${index}`);
    const next = { dataset: root.dataset, querySelectorAll: () => sourceZones };
    pages.set(token, {
      querySelector: (selector: string) =>
        selector === MOUNT
          ? next
          : selector.startsWith("link")
            ? { href: APP_URL + requests[index]!.url }
            : null,
    });
    return token;
  }

  function complete(index: number, outcome: Outcome) {
    const read = requests[index]!.read;
    if (outcome === "success") read.resolve({ ok: true, text: async () => page(index) });
    else
      read.reject(
        Object.assign(new Error("offline"), { name: outcome === "abort" ? "AbortError" : "Error" }),
      );
  }

  return {
    root,
    skeleton,
    content,
    feedback,
    input,
    history,
    reloads,
    requests,
    navigate,
    typeSearch,
    fireSearch,
    page,
    complete,
    start(action: Action) {
      if (action === "navigation") navigate();
      else {
        typeSearch();
        fireSearch();
      }
    },
  };
}

// One task boundary drains fetch -> text -> DOM and finally, including VM promises.
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
type Browser = ReturnType<typeof browser>;

function expectLoading(b: Browser, on: boolean) {
  expect(b.skeleton.hidden).toBe(!on);
  expect(b.content.hidden).toBe(on);
  expect(b.root.getAttribute("aria-busy")).toBe(on ? "true" : null);
  expect(b.skeleton.textContent).toBe("Loading events");
}

const pairs: [Action, Action][] = [
  ["navigation", "search"],
  ["search", "navigation"],
  ["navigation", "navigation"],
];
const races = pairs.flatMap(([first, current]) =>
  (["success", "failure", "abort"] as const).flatMap((obsoleteOutcome) =>
    (["success", "failure"] as const).flatMap((currentOutcome) =>
      ["before", "after"].map((order) => ({
        first,
        current,
        obsoleteOutcome,
        currentOutcome,
        order,
      })),
    ),
  ),
);

describe("EventsCalendar loading belongs to the current action", () => {
  it("clears inherited skeleton state when typing settles, before the search fetch resolves", async () => {
    const b = browser();
    b.navigate();
    expectLoading(b, true);
    b.typeSearch();
    expect(b.requests).toHaveLength(1);
    expectLoading(b, true); // Typing itself does not supersede the request.
    const input = b.input;
    b.fireSearch();
    expect(b.requests).toHaveLength(2);
    expect(b.requests[0]!.signal.aborted).toBe(true);
    expect(b.requests[1]!.url).toBe("/events?q=chess");
    expectLoading(b, false);
    expect(b.content.childNodes).toEqual(["last-good content"]);
    expect(b.input).toBe(input);
    expect(input.focused).toBe(true);
    b.complete(0, "abort");
    await settle();
    expectLoading(b, false);
    b.complete(1, "success");
    await settle();
    expectLoading(b, false);
    expect(b.content.childNodes).toEqual(["response-1"]);
  });

  it.each(races)(
    "$first -> $current: obsolete $obsoleteOutcome $order current $currentOutcome",
    async ({ first, current, obsoleteOutcome, currentOutcome, order }) => {
      const b = browser();
      b.start(first);
      expectLoading(b, first === "navigation");
      b.start(current);
      expect(b.requests[0]!.signal.aborted).toBe(true);
      expect(b.requests[1]!.signal.aborted).toBe(false);
      expectLoading(b, current === "navigation");
      if (order === "before") {
        b.complete(0, obsoleteOutcome);
        await settle();
        expectLoading(b, current === "navigation");
        expect(b.content.childNodes).toEqual(["last-good content"]);
        expect(b.feedback.textContent).toBe("");
        expect(b.history).toEqual([]);
      }
      b.complete(1, currentOutcome);
      await settle();
      if (order === "after") {
        b.complete(0, obsoleteOutcome);
        await settle();
      }
      expectLoading(b, false);
      expect(b.content.childNodes).toEqual([
        currentOutcome === "success" ? "response-1" : "last-good content",
      ]);
      expect(b.feedback.textContent).toBe(
        currentOutcome === "success" ? "" : b.root.dataset.loadError,
      );
      expect(b.history).toEqual(currentOutcome === "success" ? [b.requests[1]!.url] : []);
      expect(b.reloads).toEqual([]);
    },
  );

  it.each(pairs)(
    "checks ownership after a deferred response body: %s -> %s",
    async (first, current) => {
      const b = browser();
      const body = deferred<string>();
      b.start(first);
      b.requests[0]!.read.resolve({ ok: true, text: () => body.promise });
      await settle();
      b.start(current);
      body.resolve(b.page(0));
      await settle();
      expectLoading(b, current === "navigation");
      expect(b.content.childNodes).toEqual(["last-good content"]);
      b.complete(1, "success");
      await settle();
      expectLoading(b, false);
      expect(b.content.childNodes).toEqual(["response-1"]);
    },
  );
});

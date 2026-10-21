import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { EVENTS_CALENDAR_READ_DEADLINE_MS } from "../src/islands/contracts-calendar";

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
// entry sets the address the island renders at: Back/forward tests start from
// a search address so the popstate target differs from renderedAddress.
function browser(entry = "/events") {
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
    querySelectorAll: (selector: string) => (selector === "[data-cal-zone]" ? zones : []),
    contains: () => true,
  });
  root.dataset = {
    view: "list",
    month: "2026-10",
    past: "",
    loadError: "Calendar unavailable. Try again.",
  };
  const canonical = { href: APP_URL + entry };
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
  // Controlled timers: the search debounce (300ms) and the owned overall
  // read deadline. Firing is explicit per kind so a debounce flush can never
  // expire a pending read.
  const READ_DEADLINE_MS = EVENTS_CALENDAR_READ_DEADLINE_MS;
  const timers = new Map<number, { ms: number; callback: () => void }>();
  let nextTimer = 0;
  let popstate: () => void = () => {};
  runInNewContext(
    binder,
    {
      URL,
      AbortController,
      setTimeout(callback: () => void, ms: number) {
        expect([300, READ_DEADLINE_MS]).toContain(ms);
        timers.set(++nextTimer, { ms, callback });
        return nextTimer;
      },
      clearTimeout: (id: number) => timers.delete(id),
      document: {
        // The fixture mounts no header or hero auth links, so unknown selectors
        // match nothing — og:url only answers its own meta selector.
        querySelector: (selector: string) =>
          selector === MOUNT
            ? root
            : selector.startsWith("link")
              ? canonical
              : selector.startsWith("meta")
                ? og
                : null,
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
        addEventListener(_type: string, listener: () => void) {
          popstate = listener;
        },
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

  // Back/forward: the browser commits the address before the island's fetch.
  function back(path = "/events") {
    location.href = APP_URL + path;
    popstate();
  }

  function typeSearch() {
    input.value = "chess";
    input.focus();
    input.listeners.get("input")!({ preventDefault() {} });
  }

  function fireSearch() {
    const due = [...timers.entries()].filter(([, t]) => t.ms === 300);
    due.forEach(([id]) => timers.delete(id));
    due.forEach(([, t]) => t.callback());
  }

  // Fire the next pending read deadline (insertion order). Returns false when
  // no deadline is pending — a hung read without an armed deadline fails the
  // test instead of hanging the suite.
  function fireDeadline() {
    const next = [...timers.entries()].find(([, t]) => t.ms === READ_DEADLINE_MS);
    if (!next) return false;
    timers.delete(next[0]);
    next[1].callback();
    return true;
  }

  function page(index: number) {
    const token = `page-${index}`;
    const sourceZones = createZones(`response-${index}`);
    // The fragment carries zones only: any other selector (for example the
    // card sign-in links the island validates) matches nothing, as in a DOM.
    const next = {
      dataset: root.dataset,
      querySelectorAll: (selector: string) => (selector === "[data-cal-zone]" ? sourceZones : []),
    };
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

  // Headers settle but the body never does: the owned deadline must still
  // restore the last good view. Fetches ignore abort so the late body (if it
  // ever settles) exercises ownership rather than transport luck.
  function hangBody(index: number) {
    requests[index]!.read.resolve({ ok: true, text: () => new Promise<string>(() => {}) });
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
    canonical,
    og,
    location,
    navigate,
    back,
    typeSearch,
    fireSearch,
    fireDeadline,
    page,
    complete,
    hangBody,
    pendingDeadlines: () => [...timers.values()].filter((t) => t.ms === READ_DEADLINE_MS).length,
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

describe("EventsCalendar owned read deadline", () => {
  it("documents an overall read deadline of at most 10 seconds", () => {
    expect(EVENTS_CALENDAR_READ_DEADLINE_MS).toBeLessThanOrEqual(10_000);
    expect(EVENTS_CALENDAR_READ_DEADLINE_MS).toBeGreaterThan(0);
  });

  it("restores the last good view when hung headers never settle", async () => {
    const b = browser();
    const address = b.location.href;
    const canonical = b.canonical.href;
    b.navigate();
    expectLoading(b, true);
    expect(b.pendingDeadlines()).toBe(1);
    // Headers never settle: only the owned deadline can release loading.
    expect(b.fireDeadline()).toBe(true);
    await settle();
    expectLoading(b, false);
    expect(b.content.childNodes).toEqual(["last-good content"]);
    expect(b.feedback.textContent).toBe(b.root.dataset.loadError);
    expect(b.history).toEqual([]);
    expect(b.location.href).toBe(address);
    expect(b.canonical.href).toBe(canonical);
    expect(b.reloads).toEqual([]);
  });

  it("restores the last good view when the body never completes", async () => {
    const b = browser();
    b.navigate();
    expectLoading(b, true);
    b.hangBody(0);
    await settle();
    expectLoading(b, true);
    expect(b.fireDeadline()).toBe(true);
    await settle();
    expectLoading(b, false);
    expect(b.content.childNodes).toEqual(["last-good content"]);
    expect(b.feedback.textContent).toBe(b.root.dataset.loadError);
    expect(b.history).toEqual([]);
  });

  it("commits a timely response and disarms its deadline", async () => {
    const b = browser();
    b.navigate();
    b.complete(0, "success");
    await settle();
    expectLoading(b, false);
    expect(b.content.childNodes).toEqual(["response-0"]);
    expect(b.feedback.textContent).toBe("");
    expect(b.history).toEqual([b.requests[0]!.url]);
    // The settled request no longer owns a deadline: firing is a no-op.
    expect(b.fireDeadline()).toBe(false);
    await settle();
    expectLoading(b, false);
    expect(b.content.childNodes).toEqual(["response-0"]);
  });

  it("keeps a superseded request's deadline silent under newer loading", async () => {
    const b = browser();
    b.navigate();
    b.typeSearch();
    b.fireSearch();
    expect(b.requests).toHaveLength(2);
    expectLoading(b, false); // Search is untargeted: no skeleton while pending.
    // The obsolete navigation deadline fires first: it must stay silent and
    // cannot clear the newer search owner's pending state.
    expect(b.fireDeadline()).toBe(true);
    await settle();
    expect(b.feedback.textContent).toBe("");
    expect(b.content.childNodes).toEqual(["last-good content"]);
    expect(b.requests[1]!.signal.aborted).toBe(false);
    // The current search still owns its deadline and can time out itself.
    expect(b.fireDeadline()).toBe(true);
    await settle();
    expect(b.feedback.textContent).toBe(b.root.dataset.loadError);
    expect(b.content.childNodes).toEqual(["last-good content"]);
    expect(b.history).toEqual([]);
  });

  it("drops a late response after the owned timeout and lets a retry commit", async () => {
    const b = browser();
    b.navigate();
    expect(b.fireDeadline()).toBe(true);
    await settle();
    expect(b.feedback.textContent).toBe(b.root.dataset.loadError);
    // The timed-out fetch settles late (abort ignored): it stays silent and
    // cannot commit its URL, zones or feedback.
    b.complete(0, "success");
    await settle();
    expectLoading(b, false);
    expect(b.content.childNodes).toEqual(["last-good content"]);
    expect(b.feedback.textContent).toBe(b.root.dataset.loadError);
    expect(b.history).toEqual([]);
    // A new request after the timeout owns the zones again.
    b.navigate("/events?view=calendar&month=2026-12");
    expectLoading(b, true);
    b.complete(1, "success");
    await settle();
    expectLoading(b, false);
    expect(b.content.childNodes).toEqual(["response-1"]);
    expect(b.history).toEqual([b.requests[1]!.url]);
  });

  it("reconciles the address when a Back/forward read hits the deadline", async () => {
    const b = browser("/events?q=old");
    b.back("/events");
    expectLoading(b, true);
    expect(b.fireDeadline()).toBe(true);
    await settle();
    expectLoading(b, false);
    expect(b.content.childNodes).toEqual(["last-good content"]);
    expect(b.feedback.textContent).toBe(b.root.dataset.loadError);
    expect(b.reloads).toEqual([`${APP_URL}/events`]);
  });

  it("reconciles the address when a push supersedes a Back and then times out", async () => {
    const b = browser("/events?q=old");
    b.back("/events");
    b.navigate();
    expect(b.requests[0]!.signal.aborted).toBe(true);
    // The superseded Back deadline fires first and stays silent; the push
    // still owns its deadline and times out itself.
    expect(b.fireDeadline()).toBe(true);
    await settle();
    expectLoading(b, true);
    expect(b.fireDeadline()).toBe(true);
    await settle();
    expectLoading(b, false);
    expect(b.content.childNodes).toEqual(["last-good content"]);
    expect(b.feedback.textContent).toBe(b.root.dataset.loadError);
    expect(b.history).toEqual([]);
    expect(b.reloads).toEqual([`${APP_URL}/events`]);
  });
});

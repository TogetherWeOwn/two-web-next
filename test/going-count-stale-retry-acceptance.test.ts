// Acceptance-owned: stale going-count qualification + aggregate-only retry.
//
// The paired builder implements the stale/retry contract against this file and
// must never edit it; test corrections return to the test author. Each test
// pins binder-observable behavior of the served bundle
// (`public/islands/going-count.js`): after a refresh timeout, non-2xx, or
// malformed snapshot/capacity the badge keeps its last-good numbers but
// visibly qualifies them as stale, and one explicit keyboard-reachable retry
// re-issues the same keyed aggregate GET -- never an RSVP write.
//
// Pinned vocabulary mirrors the attendees-live stale/retry precedent:
// `event-going-count-stale` note (role=status, "could not refresh" copy) with
// a `Try again` button (`event-going-count-retry`, type=button). Focus
// ownership mirrors the attendee recovery contract: a focused retry hands to
// <main> when recovery removes the note, focus that moved away is never
// stolen, and superseded completions clear or refocus nothing.
import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";
import { createContext, runInContext } from "node:vm";
import { describe, expect, it } from "vitest";
import {
  GOING_COUNT_READ_DEADLINE_MS,
  goingRefreshRequest,
  rsvpUrl,
} from "../src/islands/contracts";

const binder = readFileSync(
  new NodeURL("../public/islands/going-count.js", import.meta.url),
  "utf8",
);
const EVENT = "going-count-updated";
const REFRESHED = "going-count-refreshed";
const staleSelector = '[data-testid="event-going-count-stale"]';
const retrySelector = '[data-testid="event-going-count-retry"]';

type Snapshot = {
  eventKey: string;
  goingCount: number;
  goingOccupancy: number;
  capacity: number | null;
};
class DOMCustomEvent {
  constructor(
    public type: string,
    public options: { detail: Snapshot },
  ) {}
  get detail() {
    return this.options.detail;
  }
}

function matches(node: FakeNode, selector: string): boolean {
  const attr = /^\[([\w-]+)(?:="([^"]*)")?\]$/.exec(selector);
  if (attr) {
    const value = node.getAttribute(attr[1]!);
    if (value === null) return false;
    return attr[2] === undefined || value === attr[2];
  }
  return node.tagName.toLowerCase() === selector.toLowerCase();
}

class FakeNode {
  tagName: string;
  children: FakeNode[] = [];
  parentNode: FakeNode | null = null;
  attributes = new Map<string, string>();
  listeners = new Map<string, (event: object) => void>();
  writes: string[] = [];
  private value = "";

  constructor(tag = "div") {
    this.tagName = tag.toUpperCase();
  }

  get textContent() {
    return this.value;
  }
  set textContent(value: string) {
    this.value = value;
    this.writes.push(value);
  }

  getAttribute(name: string) {
    return this.attributes.get(name) ?? null;
  }
  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }
  removeAttribute(name: string) {
    this.attributes.delete(name);
  }
  contains(node: FakeNode): boolean {
    return this === node || this.children.some((child) => child.contains(node));
  }
  querySelector(selector: string): FakeNode | null {
    for (const child of this.children) {
      if (matches(child, selector)) return child;
      const found = child.querySelector(selector);
      if (found) return found;
    }
    return null;
  }
  querySelectorAll(selector: string): FakeNode[] {
    const found: FakeNode[] = [];
    for (const child of this.children) {
      if (matches(child, selector)) found.push(child);
      found.push(...child.querySelectorAll(selector));
    }
    return found;
  }
  appendChild(node: FakeNode) {
    node.parentNode = this;
    this.children.push(node);
    return node;
  }
  removeChild(node: FakeNode) {
    if (node.contains(activeNode)) activeNode = bodyNode;
    this.children.splice(this.children.indexOf(node), 1);
    node.parentNode = null;
  }
  remove() {
    this.parentNode?.removeChild(this);
  }
  focus() {
    activeNode = this;
  }
  addEventListener(type: string, listener: (event: object) => void) {
    this.listeners.set(type, listener);
  }
  click() {
    this.listeners.get("click")?.({});
  }
}

// Focus scope is per fixture: the harness rebinds these before evaluating the
// bundle, so nodes resolve active/body against their own document.
let activeNode: FakeNode;
let bodyNode: FakeNode;

interface ReadResponse {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
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

type Detail = { eventKey?: string; viewerState?: string };
type PendingRead = ReturnType<typeof deferred<ReadResponse>>;

function makeBadge(key: string, capacity = "4", showSpots = false): FakeNode {
  const mount = new FakeNode("span");
  mount.setAttribute("data-island", "going-count");
  mount.setAttribute("data-event-key", key);
  mount.setAttribute("data-capacity", capacity);
  mount.setAttribute("role", "status");
  const announcement = new FakeNode("span");
  announcement.setAttribute("class", "sr-only");
  announcement.setAttribute("data-announcement", "");
  const count = new FakeNode("span");
  count.setAttribute("data-count", "");
  count.textContent = capacity ? `2 of ${capacity} going` : "2 going";
  // Construction writes are not binder patches.
  count.writes.length = 0;
  mount.appendChild(announcement);
  mount.appendChild(count);
  if (showSpots) {
    const spots = new FakeNode("span");
    spots.setAttribute("data-spots", "");
    spots.textContent = `${Number(capacity) - 2} of ${capacity} spots left`;
    spots.writes.length = 0;
    mount.appendChild(spots);
  }
  return mount;
}

function browser(...badges: FakeNode[]) {
  const body = new FakeNode("body");
  bodyNode = body;
  const main = new FakeNode("main");
  main.setAttribute("tabindex", "-1");
  body.appendChild(main);
  for (const badge of badges) main.appendChild(badge);
  const outside = new FakeNode("a");
  main.appendChild(outside);
  activeNode = body;

  const listeners: ((event: { detail: Detail }) => void)[] = [];
  const requests: {
    url: string;
    init: { method?: string; headers: Record<string, string>; signal?: AbortSignal };
    read: PendingRead;
  }[] = [];
  const refreshes: Snapshot[] = [];
  const timers = new Map<number, { ms: number; fn: () => void }>();
  let nextTimer = 0;
  runInContext(
    binder,
    createContext({
      CustomEvent: DOMCustomEvent,
      AbortController,
      setTimeout: (fn: () => void, ms = 0) => {
        const id = ++nextTimer;
        timers.set(id, { ms, fn });
        return id;
      },
      clearTimeout: (id: number) => {
        timers.delete(id);
      },
      document: {
        documentElement: new FakeNode("html"),
        body,
        get activeElement() {
          return activeNode;
        },
        querySelector: (selector: string) => body.querySelector(selector),
        querySelectorAll: (selector: string) => body.querySelectorAll(selector),
        createElement: (tag: string) => new FakeNode(tag),
        addEventListener(type: string, listener: (event: { detail: Detail }) => void) {
          // The refresh broadcast is the only listener the tests drive; the
          // binder may add lifecycle listeners (e.g. pagehide) freely.
          if (type === EVENT) listeners.push(listener);
        },
        dispatchEvent(event: DOMCustomEvent) {
          expect(event).toBeInstanceOf(DOMCustomEvent);
          if (event.type === REFRESHED) refreshes.push(event.detail);
          return true;
        },
      },
      fetch(
        url: string,
        init: { method?: string; headers: Record<string, string>; signal?: AbortSignal },
      ) {
        const read = deferred<ReadResponse>();
        requests.push({ url, init, read });
        const signal = init.signal;
        if (signal) {
          if (signal.aborted) read.reject(new DOMException("Aborted", "AbortError"));
          else
            signal.addEventListener(
              "abort",
              () => read.reject(new DOMException("Aborted", "AbortError")),
              {
                once: true,
              },
            );
        }
        return read.promise;
      },
    }),
    { filename: "public/islands/going-count.js" },
  );

  return {
    body,
    main,
    outside,
    requests,
    refreshes,
    timers,
    active: () => activeNode,
    query: (selector: string) => body.querySelector(selector),
    queryAll: (selector: string) => body.querySelectorAll(selector),
    broadcast(detail: Detail) {
      listeners.forEach((listener) => listener({ detail }));
    },
    async respond(index: number, responseBody: unknown) {
      requests[index]!.read.resolve(
        new Response(JSON.stringify(responseBody), {
          headers: { "content-type": "application/json" },
        }),
      );
      await settle();
    },
    async fail(index: number, failure: "network" | "http" | "json", status = 500) {
      const read = requests[index]!.read;
      if (failure === "network") read.reject(new Error("offline"));
      else if (failure === "http")
        read.resolve({
          ok: false,
          status,
          json: async () => [{ event_key: "a", going_count: 99 }],
        });
      else
        read.resolve({
          ok: true,
          status: 200,
          json: async () => {
            throw new Error("invalid JSON");
          },
        });
      await settle();
    },
    fireDeadline() {
      const expired = [...timers.entries()].filter(
        ([, t]) => t.ms === GOING_COUNT_READ_DEADLINE_MS,
      );
      expect(expired.length).toBeGreaterThan(0);
      for (const [id, t] of expired) {
        timers.delete(id);
        t.fn();
      }
    },
  };
}

type Harness = ReturnType<typeof browser>;

// A task boundary drains the fetch -> JSON -> DOM promise chain without sleeps.
async function settle() {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

const rows = (key: string, count: number) => [{ event_key: key, going_count: count }];

function countNode(badge: FakeNode) {
  return badge.querySelector("[data-count]")!;
}
function announcementNode(badge: FakeNode) {
  return badge.querySelector("[data-announcement]")!;
}
function spotsNode(badge: FakeNode) {
  return badge.querySelector("[data-spots]");
}

/** The visible stale signal: one note, polite role, qualifying copy, one retry. */
function expectStale(b: Harness) {
  const note = b.query(staleSelector);
  expect(note, "stale note renders on refresh failure").not.toBeNull();
  expect(note!.getAttribute("role")).toBe("status");
  expect(note!.textContent).toContain("could not refresh");
  expect(b.queryAll(staleSelector), "exactly one stale note per failure").toHaveLength(1);
  const retry = b.query(retrySelector);
  expect(retry, "stale note offers an explicit retry").not.toBeNull();
  expect(retry!.tagName, "retry is a keyboard-reachable native button").toBe("BUTTON");
  expect(retry!.getAttribute("type")).toBe("button");
  expect(retry!.getAttribute("disabled")).toBeNull();
  expect(retry!.textContent).toBe("Try again");
  expect(note!.contains(retry!), "retry belongs to the stale note").toBe(true);
  return { note: note!, retry: retry! };
}

function expectFresh(b: Harness) {
  expect(b.query(staleSelector), "recovery clears the stale note").toBeNull();
  expect(b.query(retrySelector), "recovery clears the retry control").toBeNull();
}

/** No leg of the failure path may present itself as an alert. */
function expectNoAlertRole(b: Harness) {
  const roles: string[] = [];
  const walk = (node: FakeNode) => {
    const role = node.getAttribute("role");
    if (role) roles.push(role);
    for (const child of node.children) walk(child);
  };
  walk(b.body);
  expect(roles).not.toContain("alert");
  expect(roles).toContain("status");
}

/** Every request the island issues is the keyed aggregate GET. */
function expectAggregateOnly(b: Harness, key: string) {
  expect(b.requests.length).toBeGreaterThan(0);
  for (const request of b.requests) {
    expect(request.init.method ?? "GET").toBe("GET");
    expect(request.url).toBe(goingRefreshRequest(key).url);
    expect(request.url).not.toContain("/rsvp");
  }
  expect(rsvpUrl(key)).toContain("/rsvp");
}

describe("going-count stale qualification acceptance", () => {
  it("shows one stale note with retry on refresh timeout, keeping last-good numbers", async () => {
    const badge = makeBadge("a");
    const b = browser(badge);
    b.broadcast({ eventKey: "a", viewerState: "going" });
    expect(b.requests).toHaveLength(1);
    b.fireDeadline();
    await settle();
    expect(b.requests[0]!.init.signal!.aborted).toBe(true);
    expectStale(b);
    expect(countNode(badge).textContent).toBe("2 of 4 going");
    expect(countNode(badge).writes).toEqual([]);
    expect(announcementNode(badge).writes, "timeout never retracts the announcement").toEqual([]);
    expect(b.refreshes).toEqual([]);
    expectNoAlertRole(b);
  });

  it.each([429, 500, 503])("qualifies retained numbers as stale on HTTP %s", async (status) => {
    const badge = makeBadge("a");
    const b = browser(badge);
    b.broadcast({ eventKey: "a", viewerState: "going" });
    await b.fail(0, "http", status);
    expectStale(b);
    expect(countNode(badge).textContent).toBe("2 of 4 going");
    expect(countNode(badge).writes).toEqual([]);
    expect(announcementNode(badge).writes).toEqual([]);
    expect(b.refreshes).toEqual([]);
    expectNoAlertRole(b);
  });

  it.each(["network", "json"] as const)(
    "qualifies retained numbers as stale on %s failure",
    async (failure) => {
      const badge = makeBadge("a");
      const b = browser(badge);
      b.broadcast({ eventKey: "a", viewerState: "going" });
      await b.fail(0, failure);
      expectStale(b);
      expect(countNode(badge).textContent).toBe("2 of 4 going");
      expect(b.refreshes).toEqual([]);
    },
  );

  it.each([
    ["missing row", { data: rows("other", 99) }],
    ["malformed going_count", [{ event_key: "a", going_count: "3", capacity: 4 }]],
    ["malformed occupancy", [{ event_key: "a", going_count: 3, going_occupancy: -1, capacity: 4 }]],
    ["malformed snapshot capacity", [{ event_key: "a", going_count: 3, capacity: "many" }]],
    ["malformed collection", { data: {} }],
  ] as const)("qualifies retained numbers as stale on %s", async (_label, responseBody) => {
    const badge = makeBadge("a");
    const b = browser(badge);
    b.broadcast({ eventKey: "a", viewerState: "going" });
    await b.respond(0, responseBody);
    expectStale(b);
    expect(countNode(badge).textContent).toBe("2 of 4 going");
    expect(countNode(badge).writes).toEqual([]);
    expect(announcementNode(badge).writes).toEqual([]);
    expect(b.refreshes).toEqual([]);
    expect(badge.getAttribute("data-capacity"), "SSR cap survives a malformed snapshot").toBe("4");
  });

  it("never retracts a confirmed RSVP state when the next refresh fails", async () => {
    const badge = makeBadge("a", "4", true);
    const b = browser(badge);
    b.broadcast({ eventKey: "a", viewerState: "going" });
    await b.respond(0, [{ event_key: "a", going_count: 3, capacity: 4 }]);
    expect(countNode(badge).textContent).toBe("3 of 4 going");
    expect(announcementNode(badge).textContent).toBe("You're going. ");
    b.broadcast({ eventKey: "a", viewerState: "none" });
    await b.fail(1, "http", 500);
    expectStale(b);
    expect(countNode(badge).textContent, "confirmed count is retained, not blanked").toBe(
      "3 of 4 going",
    );
    expect(spotsNode(badge)!.textContent).toBe("1 of 4 spots left");
    expect(announcementNode(badge).textContent, "confirmed state is never retracted").toBe(
      "You're going. ",
    );
    expect(announcementNode(badge).writes).toHaveLength(1);
    expectAggregateOnly(b, "a");
  });

  it("retry re-issues the same keyed GET and clears stale on success", async () => {
    const badge = makeBadge("a");
    const b = browser(badge);
    b.broadcast({ eventKey: "a", viewerState: "going" });
    await b.fail(0, "http", 500);
    const { retry } = expectStale(b);
    retry.click();
    await settle();
    expect(b.requests, "one explicit click issues one read").toHaveLength(2);
    expect(b.requests[1]!.url).toBe(goingRefreshRequest("a").url);
    expect(b.requests[1]!.init.method ?? "GET").toBe("GET");
    await b.respond(1, [{ event_key: "a", going_count: 5, capacity: 4 }]);
    expect(countNode(badge).textContent).toBe("5 of 4 going");
    expectFresh(b);
    expect(b.refreshes).toEqual([{ eventKey: "a", goingCount: 5, goingOccupancy: 5, capacity: 4 }]);
    expect(announcementNode(badge).writes, "count-only retry replays no viewer state").toEqual([]);
  });

  it("issues no RSVP write across failure and retry", async () => {
    const badge = makeBadge("a");
    const b = browser(badge);
    b.broadcast({ eventKey: "a", viewerState: "going" });
    await b.fail(0, "http", 429);
    expectStale(b).retry.click();
    await settle();
    await b.fail(1, "network");
    expectStale(b).retry.click();
    await settle();
    await b.respond(2, rows("a", 3));
    expect(countNode(badge).textContent).toBe("3 of 4 going");
    expectFresh(b);
    expect(b.requests).toHaveLength(3);
    expectAggregateOnly(b, "a");
  });

  it("does not auto-retry or poll after failure", async () => {
    const badge = makeBadge("a");
    const b = browser(badge);
    b.broadcast({ eventKey: "a", viewerState: "going" });
    await b.fail(0, "http", 500);
    expectStale(b);
    expect(b.timers.size, "failure schedules no automatic retry").toBe(0);
    expect(b.requests).toHaveLength(1);
    expect(binder).not.toMatch(/setInterval/);
  });

  it("fences a late retry completion behind a newer broadcast success", async () => {
    const badge = makeBadge("a");
    const b = browser(badge);
    b.broadcast({ eventKey: "a", viewerState: "going" });
    await b.fail(0, "http", 500);
    expectStale(b).retry.click();
    await settle();
    b.broadcast({ eventKey: "a", viewerState: "none" });
    expect(b.requests).toHaveLength(3);
    expect(b.requests[1]!.init.signal!.aborted, "newer broadcast aborts the retry read").toBe(true);
    await b.respond(1, rows("a", 9));
    expect(countNode(badge).textContent, "late retry completion patches nothing").toBe(
      "2 of 4 going",
    );
    expect(b.query(staleSelector), "stale stands until an authoritative success").not.toBeNull();
    expect(b.refreshes).toEqual([]);
    await b.respond(2, rows("a", 1));
    expect(countNode(badge).textContent).toBe("1 of 4 going");
    expectFresh(b);
    expect(b.refreshes).toEqual([{ eventKey: "a", goingCount: 1, goingOccupancy: 1, capacity: 4 }]);
  });

  it("keeps stale through a late body after the deadline until an explicit retry succeeds", async () => {
    const badge = makeBadge("a");
    const b = browser(badge);
    const body = deferred<unknown>();
    b.broadcast({ eventKey: "a", viewerState: "going" });
    b.requests[0]!.read.resolve({ ok: true, status: 200, json: () => body.promise });
    await settle();
    b.fireDeadline();
    await settle();
    expectStale(b);
    body.resolve(rows("a", 7));
    await settle();
    expect(countNode(badge).writes, "late body patches nothing").toEqual([]);
    expect(b.query(staleSelector), "late body clears nothing").not.toBeNull();
    expect(b.refreshes).toEqual([]);
    b.query(retrySelector)!.click();
    await settle();
    await b.respond(1, rows("a", 3));
    expect(countNode(badge).textContent).toBe("3 of 4 going");
    expectFresh(b);
  });

  it("clears stale on a newer broadcast success without a retry click", async () => {
    const badge = makeBadge("a");
    const b = browser(badge);
    b.broadcast({ eventKey: "a", viewerState: "going" });
    await b.respond(0, [{ event_key: "a", going_count: 3, capacity: "many" }]);
    expectStale(b);
    b.broadcast({ eventKey: "a", viewerState: "none" });
    await b.respond(1, rows("a", 1));
    expect(countNode(badge).textContent).toBe("1 of 4 going");
    expect(announcementNode(badge).textContent).toBe("RSVP removed. ");
    expectFresh(b);
    expect(b.refreshes).toEqual([{ eventKey: "a", goingCount: 1, goingOccupancy: 1, capacity: 4 }]);
  });

  it("retains retry focus when the retry read fails again", async () => {
    const badge = makeBadge("a");
    const b = browser(badge);
    b.broadcast({ eventKey: "a", viewerState: "going" });
    await b.fail(0, "http", 500);
    const { retry } = expectStale(b);
    retry.focus();
    retry.click();
    await settle();
    await b.fail(1, "http", 503);
    expect(b.query(retrySelector), "the same retry survives its own failure").toBe(retry);
    expect(b.active()).toBe(retry);
    expect(b.queryAll(staleSelector)).toHaveLength(1);
    expect(countNode(badge).textContent).toBe("2 of 4 going");
    expect(b.requests).toHaveLength(2);
  });

  it("hands a focused retry to main after recovery removes the note", async () => {
    const badge = makeBadge("a");
    const b = browser(badge);
    b.broadcast({ eventKey: "a", viewerState: "going" });
    await b.fail(0, "http", 500);
    const { retry } = expectStale(b);
    retry.focus();
    retry.click();
    await settle();
    await b.respond(1, rows("a", 3));
    expectFresh(b);
    expect(b.active(), "focus lands on main, never a removed node or body").toBe(b.main);
  });

  it("does not steal focus moved outside while retry is pending", async () => {
    const badge = makeBadge("a");
    const b = browser(badge);
    b.broadcast({ eventKey: "a", viewerState: "going" });
    await b.fail(0, "http", 500);
    const { retry } = expectStale(b);
    retry.focus();
    retry.click();
    await settle();
    b.outside.focus();
    await b.respond(1, rows("a", 3));
    expectFresh(b);
    expect(b.active()).toBe(b.outside);
  });

  it("does not clear or refocus from a superseded retry response", async () => {
    const badge = makeBadge("a");
    const b = browser(badge);
    b.broadcast({ eventKey: "a", viewerState: "going" });
    await b.fail(0, "http", 500);
    const { retry } = expectStale(b);
    retry.focus();
    retry.click();
    await settle();
    b.broadcast({ eventKey: "a", viewerState: "none" });
    await b.respond(1, rows("a", 9));
    expect(b.query(retrySelector)).toBe(retry);
    expect(b.active()).toBe(retry);
    b.outside.focus();
    await b.respond(2, rows("a", 1));
    expectFresh(b);
    expect(b.active()).toBe(b.outside);
  });

  it("shares one stale signal and one retry read across same-key badges", async () => {
    const first = makeBadge("a");
    const second = makeBadge("a", "8");
    const other = makeBadge("b");
    const b = browser(first, second, other);
    b.broadcast({ eventKey: "a", viewerState: "going" });
    await b.fail(0, "http", 500);
    expectStale(b);
    expect(countNode(other).writes, "other keys stay silent").toEqual([]);
    b.query(retrySelector)!.click();
    await settle();
    expect(b.requests, "one shared retry read per key").toHaveLength(2);
    await b.respond(1, {
      data: [
        { event_key: "b", going_count: 99, capacity: 100 },
        { event_key: "a", going_count: 3, capacity: 4 },
      ],
    });
    expect(countNode(first).textContent).toBe("3 of 4 going");
    expect(countNode(second).textContent).toBe("3 of 4 going");
    expect(countNode(other).writes).toEqual([]);
    expectFresh(b);
    expect(b.refreshes).toEqual([{ eventKey: "a", goingCount: 3, goingOccupancy: 3, capacity: 4 }]);
  });

  it("pins the retry read to the same 5s owned deadline", async () => {
    const badge = makeBadge("a");
    const b = browser(badge);
    b.broadcast({ eventKey: "a", viewerState: "going" });
    await b.fail(0, "http", 500);
    expectStale(b).retry.click();
    await settle();
    expect([...b.timers.values()].map((t) => t.ms)).toEqual([GOING_COUNT_READ_DEADLINE_MS]);
    b.fireDeadline();
    await settle();
    expect(b.requests[1]!.init.signal!.aborted).toBe(true);
    expect(b.query(staleSelector), "deadline keeps the stale signal").not.toBeNull();
    expect(b.queryAll(staleSelector)).toHaveLength(1);
    expect(countNode(badge).writes).toEqual([]);
    expect(b.refreshes).toEqual([]);
    // The key recovers on the next explicit retry.
    b.query(retrySelector)!.click();
    await settle();
    expect(b.requests).toHaveLength(3);
    await b.respond(2, rows("a", 3));
    expect(countNode(badge).textContent).toBe("3 of 4 going");
    expectFresh(b);
  });

  it("keeps the served bundle free of polling with the stale contract in place", () => {
    expect(binder).not.toMatch(/setInterval/);
    expect(binder).toMatch(/event-going-count-stale/);
    expect(binder).toMatch(/event-going-count-retry/);
  });
});

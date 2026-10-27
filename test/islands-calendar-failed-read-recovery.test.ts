// Failed calendar read recovery: truthful last-good labeling plus explicit retry.
//
// A failed search/month/view read keeps the last good zones but must say so:
// the attempted destination is named as not loaded, the kept zones keep their
// committed meaning, and an explicit keyboard-reachable retry re-issues the
// last failed GET intent (with a bounded 429 cooldown) while a safe clear
// drops it. Only a successful current read commits history, canonical,
// view/month state or auth destinations; stale completions change nothing.
//
// Specified recovery contract (the builder promotes these to the island
// contract; the literals here keep this file compiling before that lands):
//   events-read-retry  explicit retry of the last failed GET intent (button)
//   events-read-clear  safe return: drops the failed intent, restores the box
//   events-read-status polite status naming the attempted destination and the
//                      kept last-good view (never the generic failure copy)
// Cooldown bound: a 429 Retry-After is honored up to 60 seconds; a missing or
// unusable value leaves retry immediately available; nothing refetches alone.
//
// Shipped-binder execution in an isolated VM with a fixture DOM, controllable
// fetch/status/headers/body, header-link metadata and Vitest's fake clock. No
// server, database, real network or copied binder logic.
import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";
import { runInNewContext } from "node:vm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CALENDAR_MONTH_STATUS_TESTID,
  EVENTS_CALENDAR_READ_DEADLINE_MS,
  EVENTS_SEARCH_STATUS_TESTID,
  calendarMonthLabel,
  eventsSearchHitCopy,
  eventsSearchMissCopy,
} from "../src/islands/contracts";

const binder = readFileSync(
  new NodeURL("../public/islands/events-calendar.js", import.meta.url),
  "utf8",
);
const ORIGIN = "https://calendar.example.test";
const LIVE_IDS = [
  "events-view-status",
  "events-search-status",
  "events-past-status",
  "calendar-month-status",
];
// Specified stable recovery hooks (see header): literals until the builder
// promotes them to contract constants.
const RETRY_TESTID = "events-read-retry";
const CLEAR_TESTID = "events-read-clear";
const STATUS_TESTID = "events-read-status";
const LOAD_ERROR = "Calendar unavailable. Try again.";
const RETRY_COOLDOWN_CAP_MS = 60_000;

class Node {
  tag: string;
  childNodes: unknown[] = [];
  hidden = false;
  textContent = "";
  href = "";
  hash = "";
  target = "";
  content = "";
  value = "";
  disabled = false;
  dataset: Record<string, string> = {};
  attributes = new Map<string, string>();
  listeners = new Map<string, ((event: any) => void)[]>();
  swaps = 0;
  focused = false;
  onFocus: (() => void) | null = null;
  constructor(tag = "div") {
    this.tag = tag;
  }
  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }
  getAttribute(name: string) {
    return this.attributes.get(name) ?? null;
  }
  removeAttribute(name: string) {
    this.attributes.delete(name);
  }
  hasAttribute(name: string) {
    return this.attributes.has(name);
  }
  replaceChildren(...children: unknown[]) {
    this.childNodes = children;
    this.swaps++;
  }
  addEventListener(type: string, listener: (event: any) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  removeEventListener(type: string, listener: (event: any) => void) {
    this.listeners.set(
      type,
      (this.listeners.get(type) ?? []).filter((fn) => fn !== listener),
    );
  }
  focus() {
    this.focused = true;
    this.onFocus?.();
  }
  closest(selector: string): unknown {
    if (selector === "a") return this.tag === "a" ? this : null;
    return null;
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

type IslandHeaders = { get(name: string): string | null };
const islandHeaders = (entries: Record<string, string> = {}): IslandHeaders => ({
  get: (name: string) => {
    const key = Object.keys(entries).find((k) => k.toLowerCase() === name.toLowerCase());
    return key === undefined ? null : entries[key]!;
  },
});
type IslandResponse = {
  ok: boolean;
  status: number;
  headers: IslandHeaders;
  text: () => Promise<string>;
};
type Click = {
  defaultPrevented: boolean;
  button: number;
  detail?: number;
  target: { closest: (selector: string) => unknown };
  preventDefault: () => void;
};

// Drain the VM promise chain without advancing the fake clock.
const settle = async (turns = 5) => {
  for (let i = 0; i < turns; i++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
};

function browser(entry = "/events") {
  const entryUrl = new NodeURL(entry, ORIGIN);
  const form = new Node("form");
  const input = Object.assign(new Node("input"), { closest: () => form });
  input.value = entryUrl.searchParams.get("q") ?? "";
  const zones = ["head", "actions", "miss", "content"].map((name) => {
    const node = new Node();
    node.setAttribute("data-cal-zone", name);
    node.childNodes = [`initial ${name}`];
    return node;
  });
  const content = zones[3]!;
  const skeleton = new Node();
  skeleton.hidden = true;
  const feedback = new Node("p");
  feedback.textContent = "last-good feedback";
  feedback.setAttribute("data-cal-feedback", "");
  const live = LIVE_IDS.map((id) => {
    const node = new Node("p");
    node.setAttribute("data-testid", id);
    return node;
  });
  const searchStatus = live[LIVE_IDS.indexOf(EVENTS_SEARCH_STATUS_TESTID)]!;
  const monthStatus = live[LIVE_IDS.indexOf(CALENDAR_MONTH_STATUS_TESTID)]!;
  const committedQuery = entryUrl.searchParams.get("q") ?? "";
  searchStatus.textContent = committedQuery === "" ? "" : eventsSearchHitCopy(committedQuery);
  monthStatus.textContent =
    entryUrl.searchParams.get("view") === "calendar"
      ? calendarMonthLabel(entryUrl.searchParams.get("month") ?? "2026-10")
      : "";
  const heading = new Node("h1");
  heading.setAttribute("id", "events-heading");
  // Specified recovery controls (see header): modeled as the SSR screen will
  // render them — present, inert and hidden until a read fails.
  const recoveryHost = new Node();
  const retry = new Node("button");
  retry.setAttribute("data-testid", RETRY_TESTID);
  retry.setAttribute("type", "button");
  retry.hidden = true;
  const clear = new Node("button");
  clear.setAttribute("data-testid", CLEAR_TESTID);
  clear.setAttribute("type", "button");
  clear.hidden = true;
  const status = new Node("p");
  status.setAttribute("data-testid", STATUS_TESTID);
  status.setAttribute("role", "status");
  recoveryHost.replaceChildren(retry, clear, status);
  const canonical = Object.assign(new Node("link"), { href: ORIGIN + entry });
  const og = Object.assign(new Node("meta"), { content: canonical.href });
  const links: Node[] = [];
  let click!: (event: Click) => void;
  let popstate!: () => void;
  const focusListeners = new Set<(event: { target: unknown }) => void>();
  let activeElement: unknown = input;
  const body = new Node("body");
  input.onFocus = () => {
    activeElement = input;
  };
  const noteFocus = (node: Node) => {
    node.onFocus = () => {
      activeElement = node;
      focusListeners.forEach((fn) => fn({ target: node }));
    };
  };
  [retry, clear, heading, input].forEach(noteFocus);
  const root = Object.assign(new Node("section"), {
    dataset: {
      view: entryUrl.searchParams.get("view") ?? "list",
      month: entryUrl.searchParams.get("month") ?? "2026-10",
      past: entryUrl.searchParams.get("past") ?? "",
      loadError: LOAD_ERROR,
    },
    querySelector(selector: string) {
      if (selector === '[data-testid="events-loading"]') return skeleton;
      if (selector === "[data-cal-feedback]") return feedback;
      if (selector === '[data-testid="events-search"]') return input;
      if (selector === '[data-cal-zone="content"]') return content;
      if (selector === `[data-testid="${RETRY_TESTID}"]`) return retry;
      if (selector === `[data-testid="${CLEAR_TESTID}"]`) return clear;
      if (selector === `[data-testid="${STATUS_TESTID}"]`) return status;
      if (selector === "#events-heading") return heading;
      const id = /data-testid="([^"]+)"/.exec(selector)?.[1];
      return live[LIVE_IDS.indexOf(id ?? "")] ?? null;
    },
    querySelectorAll: (selector: string) =>
      selector === "[data-cal-zone]" ? zones : selector === "a" ? links : [],
    addEventListener(_type: string, listener: (event: Click) => void) {
      click = listener;
    },
    contains: (node: unknown) =>
      node === root ||
      node === input ||
      node === retry ||
      node === clear ||
      node === status ||
      links.includes(node as Node),
  });
  const history: string[] = [];
  const reloads: string[] = [];
  const location = {
    href: ORIGIN + entry,
    origin: ORIGIN,
    assign: (href: string) => reloads.push(href),
  };
  const requests: {
    url: string;
    method: string;
    headers: Record<string, string>;
    signal: AbortSignal;
    response: ReturnType<typeof deferred<IslandResponse>>;
  }[] = [];
  const pages = new Map<string, { querySelector: (selector: string) => unknown }>();
  runInNewContext(
    binder,
    {
      URL: NodeURL,
      AbortController,
      setTimeout,
      clearTimeout,
      document: {
        // The fixture mounts no header or hero auth links, so unknown selectors
        // match nothing — the island root only answers its own mount selector.
        querySelector: (selector: string) =>
          selector === '[data-island="events-calendar"]'
            ? root
            : selector.startsWith("link")
              ? canonical
              : selector.startsWith("meta")
                ? og
                : null,
        importNode: (node: unknown) => node,
        addEventListener: (type: string, listener: (event: { target: unknown }) => void) => {
          if (type === "focusin") focusListeners.add(listener);
        },
        removeEventListener: (type: string, listener: (event: { target: unknown }) => void) => {
          if (type === "focusin") focusListeners.delete(listener);
        },
        get activeElement() {
          return activeElement;
        },
        body,
      },
      window: {
        location,
        history: {
          pushState(_state: unknown, _title: string, path: string) {
            history.push(path);
            location.href = ORIGIN + path;
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
      fetch(
        url: string,
        init: { method: string; headers: Record<string, string>; signal: AbortSignal },
      ) {
        const response = deferred<IslandResponse>();
        requests.push({
          url,
          method: init.method,
          headers: init.headers,
          signal: init.signal,
          response,
        });
        return response.promise;
      },
    },
    { filename: "public/islands/events-calendar.js" },
  );

  function page(index: number) {
    const url = new NodeURL(requests[index]!.url, ORIGIN);
    const sourceZones = zones.map((target) => {
      const node = new Node();
      const name = target.getAttribute("data-cal-zone")!;
      node.setAttribute("data-cal-zone", name);
      node.childNodes = [`${url.search || "all"} ${name}`];
      return node;
    });
    const next = {
      dataset: {
        view: url.searchParams.get("view") ?? "list",
        month: url.searchParams.get("month") ?? "2026-10",
        past: url.searchParams.get("past") ?? "",
      },
      // The fragment carries zones only: any other selector (for example the
      // card sign-in links the island validates) matches nothing, as in a DOM.
      querySelectorAll: (selector: string) => (selector === "[data-cal-zone]" ? sourceZones : []),
    };
    const key = `page-${index}`;
    pages.set(key, {
      querySelector(selector: string) {
        if (selector === '[data-island="events-calendar"]') return next;
        if (selector.startsWith("link")) return { href: url.href };
        const id = /data-testid="([^"]+)"/.exec(selector)?.[1];
        if (id === "events-search") return { getAttribute: () => url.searchParams.get("q") ?? "" };
        if (LIVE_IDS.includes(id ?? "")) return { textContent: `${url.search || "all"} ${id}` };
        return null;
      },
    });
    return key;
  }

  function fireClick(target: unknown, detail?: number) {
    let prevented = false;
    const event: Click = {
      defaultPrevented: false,
      button: 0,
      target: { closest: (selector: string) => (target as Node).closest(selector) },
      preventDefault() {
        prevented = true;
      },
    };
    if (detail !== undefined) event.detail = detail;
    (target as Node).listeners.get("click")?.forEach((fn) => fn(event));
    click(event);
    return prevented;
  }

  return {
    input,
    zones,
    content,
    skeleton,
    root,
    feedback,
    live,
    searchStatus,
    monthStatus,
    retry,
    clear,
    status,
    canonical,
    og,
    heading,
    history,
    reloads,
    location,
    requests,
    active: () => activeElement,
    type(value: string) {
      input.value = value;
      input.listeners.get("input")?.forEach((fn) => fn({ preventDefault() {} }));
    },
    submit() {
      let prevented = false;
      form.listeners.get("submit")?.forEach((fn) =>
        fn({
          preventDefault() {
            prevented = true;
          },
        }),
      );
      return prevented;
    },
    navigate(path: string, opts: { keyboard?: boolean; jump?: boolean } = {}) {
      const url = new NodeURL(path, ORIGIN);
      const link = new Node("a");
      link.closest = (selector: string) =>
        selector === "a" ? link : selector === '[data-cal-zone="content"]' ? content : null;
      link.hasAttribute = (name: string) =>
        (opts.jump && name === "data-cal-jump") || name === "href";
      link.href = url.href;
      link.hash = url.hash;
      noteFocus(link);
      links.push(link);
      if (opts.keyboard) {
        activeElement = link;
      }
      fireClick(link, opts.keyboard ? 0 : undefined);
      // Hiding the content zone blurs a keyboard origin inside it to body,
      // which the binder's failure path is specified to restore.
      if (content.hidden && activeElement === link) activeElement = body;
      return link;
    },
    back(path: string) {
      location.href = ORIGIN + path;
      popstate();
    },
    activate(node: Node, keyboard = false) {
      if (keyboard) {
        activeElement = node;
        node.focused = true;
      }
      fireClick(node, keyboard ? 0 : undefined);
    },
    async respond(index: number) {
      const html = page(index);
      requests[index]!.response.resolve({
        ok: true,
        status: 200,
        headers: islandHeaders(),
        text: async () => html,
      });
      await settle();
    },
    async fail(index: number, kind: "transport" | "http" | "invalid" | "body", status = 500) {
      const response = requests[index]!.response;
      if (kind === "transport") {
        response.reject(new Error("offline"));
      } else if (kind === "http") {
        response.resolve({
          ok: false,
          status,
          headers: islandHeaders(),
          text: async () => "unavailable",
        });
      } else if (kind === "invalid") {
        response.resolve({
          ok: true,
          status: 200,
          headers: islandHeaders(),
          text: async () => "not-a-calendar-page",
        });
      } else {
        response.resolve({
          ok: true,
          status: 200,
          headers: islandHeaders(),
          text: async () => {
            throw new Error("broken body");
          },
        });
      }
      await settle();
    },
    async failRateLimited(index: number, retryAfter: string | null) {
      requests[index]!.response.resolve({
        ok: false,
        status: 429,
        headers: islandHeaders(retryAfter === null ? {} : { "retry-after": retryAfter }),
        text: async () => "rate limited",
      });
      await settle();
    },
    stallHeaders(_index: number) {
      // The fetch promise never settles: only the owned deadline can release it.
    },
    async stallBody(index: number) {
      const pending = deferred<string>();
      requests[index]!.response.resolve({
        ok: true,
        status: 200,
        headers: islandHeaders(),
        text: () => pending.promise,
      });
      await settle();
    },
  };
}

type Browser = ReturnType<typeof browser>;

function startSearch(b: Browser, value: string, submitted = false) {
  b.type(value);
  if (submitted) expect(b.submit()).toBe(true);
  else vi.advanceTimersByTime(300);
  expect(b.requests).toHaveLength(1);
  expect(b.requests[0]!.method).toBe("GET");
}

function expectLastGoodZones(b: Browser) {
  expect(b.zones.map((zone) => zone.childNodes)).toEqual([
    ["initial head"],
    ["initial actions"],
    ["initial miss"],
    ["initial content"],
  ]);
  expect(b.zones.every((zone) => zone.swaps === 0)).toBe(true);
}

function expectNoCommit(b: Browser, entry: string) {
  expect(b.history).toEqual([]);
  expect(b.canonical.href).toBe(ORIGIN + entry);
  expect(b.og.content).toBe(ORIGIN + entry);
  expect(b.reloads).toEqual([]);
}

function expectRecoveryShown(b: Browser) {
  expect(b.retry.hidden).toBe(false);
  expect(b.clear.hidden).toBe(false);
  expect(b.status.textContent).not.toBe("");
}

function expectRecoveryHidden(b: Browser) {
  expect(b.retry.hidden).toBe(true);
  expect(b.clear.hidden).toBe(true);
  expect(b.status.textContent).toBe("");
}

beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }));
afterEach(() => vi.useRealTimers());

describe("failed search reads stay truthful", () => {
  it.each(["transport", "http", "invalid", "body"] as const)(
    "failed search over last-good results keeps them and names the missed query (%s)",
    async (kind) => {
      const b = browser("/events?q=raid");
      startSearch(b, "tournament", true);
      await b.fail(0, kind);
      // Last good wins structurally: zones untouched, the committed live lines
      // still describe the rendered rows, and no miss block claims the new query.
      expectLastGoodZones(b);
      expect(b.input.value).toBe("tournament");
      expect(b.searchStatus.textContent).toBe(eventsSearchHitCopy("raid"));
      expect(b.searchStatus.textContent).not.toBe(eventsSearchHitCopy("tournament"));
      expect(b.searchStatus.textContent).not.toBe(eventsSearchMissCopy("tournament"));
      expect(b.skeleton.hidden).toBe(true);
      expectNoCommit(b, "/events?q=raid");
      // …and explicitly: the failed destination is named as not loaded, beside
      // the kept view — never the generic copy alone.
      expectRecoveryShown(b);
      expect(b.status.textContent).toContain("tournament");
      expect(b.status.textContent).toContain("raid");
      expect(b.status.textContent).not.toBe(LOAD_ERROR);
    },
  );

  it("failed first search over unfiltered rows names the missed query without claiming a match", async () => {
    const b = browser("/events");
    startSearch(b, "tournament", true);
    await b.fail(0, "transport");
    expectLastGoodZones(b);
    expect(b.input.value).toBe("tournament");
    expect(b.searchStatus.textContent).toBe("");
    expectNoCommit(b, "/events");
    expectRecoveryShown(b);
    expect(b.status.textContent).toContain("tournament");
    expect(b.status.textContent).not.toBe(LOAD_ERROR);
    expect(b.status.textContent.length).toBeGreaterThan("tournament".length + 10);
  });

  it.each(["transport", "http", "invalid", "body"] as const)(
    "failed month step keeps the rendered month and names the missed one (%s)",
    async (kind) => {
      const b = browser("/events?view=calendar&month=2026-10");
      b.navigate("/events?view=calendar&month=2026-11");
      expect(b.requests).toHaveLength(1);
      await b.fail(0, kind);
      expectLastGoodZones(b);
      expect(b.monthStatus.textContent).toBe(calendarMonthLabel("2026-10"));
      expect(b.searchStatus.textContent).toBe("");
      expect(b.skeleton.hidden).toBe(true);
      expectNoCommit(b, "/events?view=calendar&month=2026-10");
      expectRecoveryShown(b);
      expect(b.status.textContent).toContain(calendarMonthLabel("2026-11"));
      expect(b.status.textContent).toContain(calendarMonthLabel("2026-10"));
      expect(b.status.textContent).not.toBe(LOAD_ERROR);
    },
  );

  it("failed view toggle keeps the rendered view and offers its retry", async () => {
    const b = browser("/events");
    b.navigate("/events?view=calendar&month=2026-10");
    expect(b.requests).toHaveLength(1);
    await b.fail(0, "http");
    expectLastGoodZones(b);
    expect(b.root.dataset.view).toBe("list");
    expectNoCommit(b, "/events");
    expectRecoveryShown(b);
    expect(b.status.textContent).toContain(calendarMonthLabel("2026-10"));
  });

  it("header stall and body stall both surface recovery at the owned deadline", async () => {
    const headerStall = browser("/events?q=raid");
    startSearch(headerStall, "tournament", true);
    headerStall.stallHeaders(0);
    vi.advanceTimersByTime(EVENTS_CALENDAR_READ_DEADLINE_MS - 1);
    await settle();
    expectRecoveryHidden(headerStall);
    vi.advanceTimersByTime(1);
    await settle();
    expectLastGoodZones(headerStall);
    expectNoCommit(headerStall, "/events?q=raid");
    expectRecoveryShown(headerStall);
    expect(headerStall.status.textContent).toContain("tournament");

    const bodyStall = browser("/events?view=calendar&month=2026-10");
    bodyStall.navigate("/events?view=calendar&month=2026-11");
    await bodyStall.stallBody(0);
    vi.advanceTimersByTime(EVENTS_CALENDAR_READ_DEADLINE_MS);
    await settle();
    expectLastGoodZones(bodyStall);
    expectNoCommit(bodyStall, "/events?view=calendar&month=2026-10");
    expectRecoveryShown(bodyStall);
    expect(bodyStall.status.textContent).toContain(calendarMonthLabel("2026-11"));
  });
});

describe("explicit retry of the last failed GET intent", () => {
  it("retry is a keyboard-reachable control that re-issues exactly the failed read", async () => {
    const b = browser("/events?q=raid");
    startSearch(b, "tournament", true);
    await b.fail(0, "transport");
    expectRecoveryShown(b);
    expect(["button", "a"]).toContain(b.retry.tag);
    expect(b.retry.getAttribute("tabindex")).not.toBe("-1");
    const before = b.requests.length;
    b.activate(b.retry, true);
    await settle();
    expect(b.requests).toHaveLength(before + 1);
    expect(b.requests[before]!.url).toBe("/events?q=tournament");
    expect(b.requests[before]!.method).toBe("GET");
    expect(b.requests[before]!.headers).toMatchObject({
      accept: "text/html",
      "x-two-island": "events-calendar",
    });
    expect(b.requests.every((r) => r.method === "GET")).toBe(true);
  });

  it("successful retry commits the read and clears the recovery", async () => {
    const b = browser("/events?q=raid");
    startSearch(b, "tournament", true);
    await b.fail(0, "http");
    expectRecoveryShown(b);
    b.activate(b.retry, true);
    await settle();
    expect(b.requests).toHaveLength(2);
    await b.respond(1);
    expect(b.content.childNodes).toEqual(["?q=tournament content"]);
    expect(b.zones.every((zone) => zone.swaps === 1)).toBe(true);
    expect(b.history).toEqual(["/events?q=tournament"]);
    expect(b.canonical.href).toBe(ORIGIN + "/events?q=tournament");
    expect(b.og.content).toBe(b.canonical.href);
    expect(b.searchStatus.textContent).toBe(`?q=tournament ${EVENTS_SEARCH_STATUS_TESTID}`);
    expectRecoveryHidden(b);
    expect(b.feedback.textContent).toBe("");
  });

  it("successful month retry commits and restores the input contract", async () => {
    const b = browser("/events?view=calendar&month=2026-10");
    b.navigate("/events?view=calendar&month=2026-11");
    await b.fail(0, "transport");
    expectRecoveryShown(b);
    b.activate(b.retry);
    await settle();
    await b.respond(1);
    expect(b.history).toEqual(["/events?view=calendar&month=2026-11"]);
    expect(b.root.dataset.month).toBe("2026-11");
    expect(b.root.dataset.view).toBe("calendar");
    expectRecoveryHidden(b);
  });

  it("a retry that fails again keeps the same truthful recovery without committing", async () => {
    const b = browser("/events?q=raid");
    startSearch(b, "tournament", true);
    await b.fail(0, "transport");
    expectRecoveryShown(b);
    b.activate(b.retry);
    await settle();
    expect(b.requests).toHaveLength(2);
    await b.fail(1, "http");
    expectLastGoodZones(b);
    expectNoCommit(b, "/events?q=raid");
    expectRecoveryShown(b);
    expect(b.status.textContent).toContain("tournament");
    b.activate(b.retry);
    await settle();
    expect(b.requests).toHaveLength(3);
    expect(b.requests[2]!.url).toBe("/events?q=tournament");
    expect(b.requests[2]!.method).toBe("GET");
  });

  it("retry of a failed month targets the missed month, never the rendered one", async () => {
    const b = browser("/events?view=calendar&month=2026-10");
    b.navigate("/events?view=calendar&month=2026-11");
    await b.fail(0, "http");
    expectRecoveryShown(b);
    b.activate(b.retry);
    await settle();
    expect(b.requests).toHaveLength(2);
    expect(b.requests[1]!.url).toBe("/events?view=calendar&month=2026-11");
    expect(b.requests[1]!.method).toBe("GET");
  });
});

describe("429 backoff stays bounded and manual", () => {
  it.each([
    { header: "2", waitMs: 2000 },
    { header: "1.2", waitMs: 2000 },
  ])(
    "Retry-After $header disables retry for $waitMs ms without automatic refetch",
    async ({ header, waitMs }) => {
      const b = browser("/events?q=raid");
      startSearch(b, "tournament", true);
      await b.failRateLimited(0, header);
      expectRecoveryShown(b);
      expect(b.status.textContent).toContain("tournament");
      expect(b.retry.disabled || b.retry.getAttribute("aria-disabled") === "true").toBe(true);
      b.activate(b.retry);
      await settle();
      expect(b.requests).toHaveLength(1);
      vi.advanceTimersByTime(waitMs - 1);
      await settle();
      b.activate(b.retry);
      await settle();
      expect(b.requests).toHaveLength(1);
      vi.advanceTimersByTime(1);
      await settle();
      expect(b.retry.disabled || b.retry.getAttribute("aria-disabled") === "true").toBe(false);
      b.activate(b.retry);
      await settle();
      expect(b.requests).toHaveLength(2);
      expect(b.requests[1]!.url).toBe("/events?q=tournament");
      expect(b.requests[1]!.method).toBe("GET");
    },
  );

  it("a missing Retry-After leaves retry immediately available", async () => {
    const b = browser("/events?q=raid");
    startSearch(b, "tournament", true);
    await b.failRateLimited(0, null);
    expectRecoveryShown(b);
    expect(b.retry.disabled || b.retry.getAttribute("aria-disabled") === "true").toBe(false);
    b.activate(b.retry);
    await settle();
    expect(b.requests).toHaveLength(2);
    expect(b.requests[1]!.url).toBe("/events?q=tournament");
  });

  it.each(["-5", "0", "soon", "Wed, 21 Oct 2026 07:28:00 GMT", "1e3", "2; url=/events"])(
    "hostile Retry-After %j never blocks or storms: retry stays manual and immediate",
    async (header) => {
      const b = browser("/events?q=raid");
      startSearch(b, "tournament", true);
      await b.failRateLimited(0, header);
      expectRecoveryShown(b);
      expect(b.retry.disabled || b.retry.getAttribute("aria-disabled") === "true").toBe(false);
      vi.advanceTimersByTime(30_000);
      await settle();
      expect(b.requests).toHaveLength(1);
      b.activate(b.retry);
      await settle();
      expect(b.requests).toHaveLength(2);
      expect(b.requests[1]!.method).toBe("GET");
    },
  );

  it("an absurd Retry-After caps at sixty seconds instead of parking retry", async () => {
    const b = browser("/events?q=raid");
    startSearch(b, "tournament", true);
    await b.failRateLimited(0, "999999");
    expectRecoveryShown(b);
    expect(b.retry.disabled || b.retry.getAttribute("aria-disabled") === "true").toBe(true);
    vi.advanceTimersByTime(RETRY_COOLDOWN_CAP_MS - 1);
    await settle();
    expect(b.requests).toHaveLength(1);
    b.activate(b.retry);
    await settle();
    expect(b.requests).toHaveLength(1);
    vi.advanceTimersByTime(1);
    await settle();
    expect(b.retry.disabled || b.retry.getAttribute("aria-disabled") === "true").toBe(false);
    b.activate(b.retry);
    await settle();
    expect(b.requests).toHaveLength(2);
    expect(b.requests[1]!.url).toBe("/events?q=tournament");
  });
});

describe("safe return drops the failed intent", () => {
  it("clear restores the committed box, hides recovery and fetches nothing", async () => {
    const b = browser("/events?q=raid");
    startSearch(b, "tournament", true);
    await b.fail(0, "transport");
    expectRecoveryShown(b);
    expect(["button", "a"]).toContain(b.clear.tag);
    b.activate(b.clear, true);
    await settle();
    expect(b.input.value).toBe("raid");
    expectRecoveryHidden(b);
    expect(b.requests).toHaveLength(1);
    expectLastGoodZones(b);
    expectNoCommit(b, "/events?q=raid");
    vi.advanceTimersByTime(5000);
    await settle();
    expect(b.requests).toHaveLength(1);
  });

  it("clear over unfiltered rows empties the attempted draft without a read", async () => {
    const b = browser("/events");
    startSearch(b, "tournament", true);
    await b.fail(0, "http");
    expectRecoveryShown(b);
    b.activate(b.clear, true);
    await settle();
    expect(b.input.value).toBe("");
    expectRecoveryHidden(b);
    expect(b.requests).toHaveLength(1);
  });
});

describe("a newer action supersedes the failed intent", () => {
  it("typing after a failure drops the recovery before the new read resolves", async () => {
    const b = browser("/events?q=raid");
    startSearch(b, "tournament", true);
    await b.fail(0, "transport");
    expectRecoveryShown(b);
    b.type("festival");
    await settle();
    expectRecoveryHidden(b);
    expect(b.requests).toHaveLength(1);
    vi.advanceTimersByTime(300);
    await settle();
    expect(b.requests).toHaveLength(2);
    expect(b.requests[1]!.url).toBe("/events?q=festival");
    await b.respond(1);
    expect(b.history).toEqual(["/events?q=festival"]);
    expectRecoveryHidden(b);
  });

  it("navigation after a failure drops the old intent and commits only the new read", async () => {
    const b = browser("/events?q=raid");
    startSearch(b, "tournament", true);
    await b.fail(0, "transport");
    expectRecoveryShown(b);
    b.navigate("/events?past=1");
    await settle();
    expectRecoveryHidden(b);
    expect(b.requests).toHaveLength(2);
    await b.respond(1);
    expect(b.history).toEqual(["/events?past=1"]);
    expectRecoveryHidden(b);
  });

  it("a newer failure replaces the failed intent the retry targets", async () => {
    const b = browser("/events?q=raid");
    startSearch(b, "tournament", true);
    await b.fail(0, "transport");
    expectRecoveryShown(b);
    b.navigate("/events?view=calendar&month=2026-11");
    await settle();
    await b.fail(1, "http");
    expectRecoveryShown(b);
    expect(b.status.textContent).toContain(calendarMonthLabel("2026-11"));
    b.activate(b.retry);
    await settle();
    expect(b.requests).toHaveLength(3);
    expect(b.requests[2]!.url).toBe("/events?view=calendar&month=2026-11");
  });

  it("a stale success after a failure changes neither zones nor recovery", async () => {
    const b = browser("/events");
    startSearch(b, "alpha", true);
    b.type("beta");
    vi.advanceTimersByTime(300);
    expect(b.requests).toHaveLength(2);
    await b.fail(1, "transport");
    expectRecoveryShown(b);
    expect(b.status.textContent).toContain("beta");
    const statusCopy = b.status.textContent;
    // The superseded first read finishing late must stay silent: no zone swap,
    // no commit, and the newer failure keeps its recovery.
    await b.respond(0);
    expectLastGoodZones(b);
    expect(b.status.textContent).toBe(statusCopy);
    expectNoCommit(b, "/events");
  });
});

describe("preserved calendar invariants (controls)", () => {
  it("successful search commits zones, metadata, history and clears feedback", async () => {
    const b = browser("/events");
    startSearch(b, "raid", true);
    await b.respond(0);
    expect(b.content.childNodes).toEqual(["?q=raid content"]);
    expect(b.zones.every((zone) => zone.swaps === 1)).toBe(true);
    expect(b.history).toEqual(["/events?q=raid"]);
    expect(b.canonical.href).toBe(ORIGIN + "/events?q=raid");
    expect(b.og.content).toBe(b.canonical.href);
    expect(b.feedback.textContent).toBe("");
    expect(b.skeleton.hidden).toBe(true);
    expect(b.input.value).toBe("raid");
  });

  it("successful month navigation commits and synchronizes the untouched box", async () => {
    const b = browser("/events?view=calendar&month=2026-10");
    b.navigate("/events?view=calendar&month=2026-11");
    await b.respond(0);
    expect(b.history).toEqual(["/events?view=calendar&month=2026-11"]);
    expect(b.canonical.href).toBe(ORIGIN + "/events?view=calendar&month=2026-11");
    expect(b.input.value).toBe("");
    expect(b.skeleton.hidden).toBe(true);
  });

  it("failure preserves last-good zones, names the generic copy and commits nothing", async () => {
    const b = browser("/events?q=raid");
    startSearch(b, "tournament", true);
    await b.fail(0, "http");
    expectLastGoodZones(b);
    expect(b.feedback.textContent).toBe(LOAD_ERROR);
    expectNoCommit(b, "/events?q=raid");
    expect(b.skeleton.hidden).toBe(true);
  });

  it("an obsolete response after supersession changes nothing", async () => {
    const b = browser("/events");
    startSearch(b, "alpha", true);
    b.type("beta");
    await b.respond(0);
    expectLastGoodZones(b);
    expectNoCommit(b, "/events");
    vi.advanceTimersByTime(300);
    await b.respond(1);
    expect(b.history).toEqual(["/events?q=beta"]);
  });

  it("an expired owned read releases loading and feedback without committing", async () => {
    const b = browser("/events?q=raid");
    startSearch(b, "tournament", true);
    b.stallHeaders(0);
    vi.advanceTimersByTime(EVENTS_CALENDAR_READ_DEADLINE_MS);
    await settle();
    expectLastGoodZones(b);
    expect(b.feedback.textContent).toBe(LOAD_ERROR);
    expect(b.skeleton.hidden).toBe(true);
    expectNoCommit(b, "/events?q=raid");
  });

  it("keyboard origin of a failed navigation regains focus", async () => {
    const b = browser("/events?view=calendar&month=2026-10");
    const origin = b.navigate("/events?view=calendar&month=2026-11", { keyboard: true });
    expect(b.requests).toHaveLength(1);
    await b.fail(0, "transport");
    expect(b.active()).toBe(origin);
    expect(origin.focused).toBe(true);
  });

  it("failed Back/forward read reloads for server reconciliation", async () => {
    const b = browser("/events?q=raid");
    b.back("/events?q=tournament");
    expect(b.requests).toHaveLength(1);
    await b.fail(0, "http");
    expect(b.reloads).toEqual([ORIGIN + "/events?q=tournament"]);
    expect(b.history).toEqual([]);
  });

  it("a stale failure after a newer success changes nothing", async () => {
    const b = browser("/events");
    startSearch(b, "alpha", true);
    b.type("beta");
    vi.advanceTimersByTime(300);
    await b.respond(1);
    expect(b.history).toEqual(["/events?q=beta"]);
    await b.fail(0, "http");
    expect(b.content.childNodes).toEqual(["?q=beta content"]);
    expect(b.history).toEqual(["/events?q=beta"]);
    expect(b.feedback.textContent).toBe("");
  });

  it("nothing refetches on its own after a failure", async () => {
    const b = browser("/events?q=raid");
    startSearch(b, "tournament", true);
    await b.fail(0, "transport");
    vi.advanceTimersByTime(120_000);
    await settle();
    expect(b.requests).toHaveLength(1);
  });

  it("recovery stays hidden until a read actually fails", async () => {
    const b = browser("/events");
    expectRecoveryHidden(b);
    startSearch(b, "raid", true);
    expectRecoveryHidden(b);
    await b.respond(0);
    expectRecoveryHidden(b);
    expect(b.history).toEqual(["/events?q=raid"]);
  });
});

// Builder-owned review pins for failed calendar read recovery.
//
// Paperclip Review (round 1) on the recovery change proved four gaps against
// the shipped binder that the acceptance suite does not cover: pager/past
// failures read tautologically, Try again/Dismiss drop keyboard focus to
// body, Dismiss leaves the generic failure line up, and a day-jump retry
// loses its card hash. This file pins all four against the minified bytes.
//
// The Test Author's acceptance file
// (test/islands-calendar-failed-read-recovery.test.ts) is deliberately
// untouched: the Builder contract forbids editing it, so the pins live here
// in an identical shipped-binder harness plus three review-driven fixture
// upgrades: real search-limit dataset values, browser blur-on-hide for the
// recovery buttons, and mountable event cards for jump focus.
import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";
import { runInNewContext } from "node:vm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EVENTS_CALENDAR_FETCH_FAILED,
  EVENTS_SEARCH_MAX_LENGTH,
  EVENTS_SEARCH_TOO_LONG_COPY,
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
const RETRY_TESTID = "events-read-retry";
const CLEAR_TESTID = "events-read-clear";
const STATUS_TESTID = "events-read-status";

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
  const heading = new Node("h1");
  heading.setAttribute("id", "events-heading");
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
  const cards = new Map<string, Node>();
  let click!: (event: Click) => void;
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
  // The browser blurs a focused element when it hides: focus falls to body.
  // Without this the fixture would let a hidden recovery button keep focus,
  // hiding the focus loss the review proved.
  for (const control of [retry, clear]) {
    let isHidden = true;
    Object.defineProperty(control, "hidden", {
      get: () => isHidden,
      set: (value: boolean) => {
        isHidden = value;
        if (value && activeElement === control) activeElement = body;
      },
    });
  }
  const root = Object.assign(new Node("section"), {
    dataset: {
      view: entryUrl.searchParams.get("view") ?? "list",
      month: entryUrl.searchParams.get("month") ?? "2026-10",
      past: entryUrl.searchParams.get("past") ?? "",
      loadError: EVENTS_CALENDAR_FETCH_FAILED,
      searchMaxLength: String(EVENTS_SEARCH_MAX_LENGTH),
      searchTooLong: EVENTS_SEARCH_TOO_LONG_COPY,
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
      if (selector.startsWith("#event-")) return cards.get(selector) ?? null;
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
        addEventListener(_type: string, _listener: () => void) {
          // No history walk in these pins; the island only registers here.
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
    const event: Click = {
      defaultPrevented: false,
      button: 0,
      target: { closest: (selector: string) => (target as Node).closest(selector) },
      preventDefault() {},
    };
    if (detail !== undefined) event.detail = detail;
    (target as Node).listeners.get("click")?.forEach((fn) => fn(event));
    click(event);
    return false;
  }

  return {
    input,
    zones,
    content,
    skeleton,
    root,
    feedback,
    live,
    retry,
    clear,
    status,
    canonical,
    og,
    heading,
    body,
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
      form.listeners.get("submit")?.forEach((fn) =>
        fn({
          preventDefault() {},
        }),
      );
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
      if (content.hidden && activeElement === link) activeElement = body;
      return link;
    },
    activate(node: Node, keyboard = false) {
      if (keyboard) {
        activeElement = node;
        node.focused = true;
      }
      fireClick(node, keyboard ? 0 : undefined);
    },
    // The retry response carries the list page holding the jumped-to card.
    mountCard(key: string) {
      const card = new Node("article");
      card.setAttribute("id", `event-${key}`);
      noteFocus(card);
      cards.set(`#event-${key}`, card);
      return card;
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
    async fail(index: number) {
      requests[index]!.response.reject(new Error("offline"));
      await settle();
    },
  };
}

type Browser = ReturnType<typeof browser>;

function startSearch(b: Browser, value: string) {
  b.type(value);
  b.submit();
  expect(b.requests).toHaveLength(1);
  expect(b.requests[0]!.method).toBe("GET");
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

describe("failed pager and past reads name distinct destinations", () => {
  it("failed pager turn names the missed page beside the kept one", async () => {
    const b = browser("/events?q=raid");
    b.navigate("/events?q=raid&page=2");
    expect(b.requests).toHaveLength(1);
    await b.fail(0);
    expectRecoveryShown(b);
    expect(b.status.textContent).toBe(
      "Couldn't load page 2 of results for “raid”. Showing results for “raid”.",
    );
  });

  it("failed past toggle names the drawer beside the kept list", async () => {
    const b = browser("/events");
    b.navigate("/events?past=1");
    expect(b.requests).toHaveLength(1);
    await b.fail(0);
    expectRecoveryShown(b);
    expect(b.status.textContent).toBe(
      "Couldn't load the events list with past events. Showing the events list.",
    );
  });

  it("failed search with the drawer open keeps past on both sides but differs by query", async () => {
    const b = browser("/events?q=raid&past=1");
    startSearch(b, "tournament");
    expect(b.requests[0]!.url).toBe("/events?q=tournament&past=1");
    await b.fail(0);
    expectRecoveryShown(b);
    expect(b.status.textContent).toBe(
      "Couldn't load results for “tournament” with past events. Showing results for “raid” with past events.",
    );
  });
});

describe("recovery activation parks keyboard focus", () => {
  it("keyboard retry that succeeds parks focus on the heading, never body", async () => {
    const b = browser("/events?q=raid");
    startSearch(b, "tournament");
    await b.fail(0);
    expectRecoveryShown(b);
    b.activate(b.retry, true);
    await settle();
    expect(b.requests).toHaveLength(2);
    await b.respond(1);
    expectRecoveryHidden(b);
    expect(b.history).toEqual(["/events?q=tournament"]);
    expect(b.active()).toBe(b.heading);
    expect(b.heading.focused).toBe(true);
  });

  it("keyboard retry that fails again keeps focus on the heading", async () => {
    const b = browser("/events?q=raid");
    startSearch(b, "tournament");
    await b.fail(0);
    b.activate(b.retry, true);
    await settle();
    await b.fail(1);
    expectRecoveryShown(b);
    expect(b.status.textContent).toContain("tournament");
    expect(b.active()).toBe(b.heading);
    expect(b.active()).not.toBe(b.body);
  });

  it("keyboard dismiss parks focus on the heading", async () => {
    const b = browser("/events?q=raid");
    startSearch(b, "tournament");
    await b.fail(0);
    b.activate(b.clear, true);
    await settle();
    expectRecoveryHidden(b);
    expect(b.input.value).toBe("raid");
    expect(b.active()).toBe(b.heading);
    expect(b.active()).not.toBe(b.body);
  });

  it("pointer retry leaves focus where it was", async () => {
    const b = browser("/events?q=raid");
    startSearch(b, "tournament");
    await b.fail(0);
    expect(b.active()).toBe(b.input);
    b.activate(b.retry);
    await settle();
    expect(b.requests).toHaveLength(2);
    await b.respond(1);
    expect(b.active()).toBe(b.input);
  });
});

describe("dismiss reaches the successful-load steady state", () => {
  it("dismiss clears the generic failure line and fetches nothing", async () => {
    const b = browser("/events?q=raid");
    startSearch(b, "tournament");
    await b.fail(0);
    expect(b.feedback.textContent).toBe(EVENTS_CALENDAR_FETCH_FAILED);
    b.activate(b.clear, true);
    await settle();
    expect(b.input.value).toBe("raid");
    expect(b.feedback.textContent).toBe("");
    expectRecoveryHidden(b);
    expect(b.requests).toHaveLength(1);
  });
});

describe("failed day-jump retry completes the jump", () => {
  it("retry refetches the list read, commits the card hash and lands on the card", async () => {
    const b = browser("/events?view=calendar&month=2026-10");
    const origin = b.navigate("/events?event=ev1#event-ev1", { jump: true, keyboard: true });
    expect(b.requests).toHaveLength(1);
    expect(b.requests[0]!.url).toBe("/events?event=ev1");
    await b.fail(0);
    expectRecoveryShown(b);
    expect(b.status.textContent).toContain("October 2026");
    // The kept grid has no card: focus returns to the jump link itself.
    expect(b.active()).toBe(origin);
    b.activate(b.retry, true);
    await settle();
    expect(b.requests).toHaveLength(2);
    expect(b.requests[1]!.url).toBe("/events?event=ev1");
    const card = b.mountCard("ev1");
    await b.respond(1);
    expect(b.history).toEqual(["/events?event=ev1#event-ev1"]);
    expect(b.active()).toBe(card);
    expect(card.focused).toBe(true);
    expectRecoveryHidden(b);
  });
});

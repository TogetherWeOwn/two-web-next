// Acceptance: when an RSVP write ends in an unknown outcome, the
// "Refresh the event" recovery link must keep the attendee page the member
// was already on (?attendees=2) instead of dropping them back to page 1,
// while a bare event URL still recovers to the bare event.
//
// The harness carries the page consistently on every channel a fix may
// legitimately use: the browser location (pathname/search/href) and the
// SSR returnTo handed to RsvpButton (which already carries the query for
// the sign-in path). A fix may read either channel; it must not trust an
// arbitrary href planted in mount data, must stay on the same event, and
// must keep the unknown-outcome protections (locked controls, no replay,
// no broadcast, late completions ignored, focus not stolen).
//
// Hermetic: runs the shipped binder in a VM fake DOM. No browser, network
// or database, and no real RSVP writes.
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { URL as NodeURL } from "node:url";
import { describe, expect, it } from "vitest";
import { RsvpButton } from "../src/events/rsvp-button";
import type { PublicEvent } from "../src/events/reads";
import { RSVP_COPY, RSVP_UNKNOWN_TESTID, RSVP_REFRESH_TESTID } from "../src/islands/contracts";

const ORIGIN = "https://next.example.test";
const binder = readFileSync(
  new NodeURL("../public/islands/rsvp-button.js", import.meta.url),
  "utf8",
);
let focusSink: ((target: Node) => void) | null = null;
class Node {
  children: Node[] = [];
  parentNode: Node | null = null;
  attributes = new Map<string, string>();
  disabled = false;
  hidden = false;
  focused = false;
  href = "";
  private text = "";
  listeners = new Map<string, (e: { preventDefault: () => void }) => void>();
  get textContent(): string {
    return this.text + this.children.map((n) => n.textContent).join("");
  }
  set textContent(value: string) {
    this.text = value;
    this.children = [];
  }
  setAttribute(k: string, v: string) {
    this.attributes.set(k, String(v));
  }
  getAttribute(k: string) {
    return this.attributes.get(k) ?? null;
  }
  removeAttribute(k: string) {
    this.attributes.delete(k);
  }
  appendChild(n: Node) {
    n.parentNode = this;
    this.children.push(n);
    return n;
  }
  insertBefore(n: Node, anchor: Node) {
    if (n === anchor) return n;
    if (n.parentNode) n.parentNode.children = n.parentNode.children.filter((c) => c !== n);
    n.parentNode = this;
    this.children.splice(this.children.indexOf(anchor), 0, n);
    return n;
  }
  removeChild(n: Node) {
    this.children = this.children.filter((child) => child !== n);
    n.parentNode = null;
  }
  replaceChild(next: Node, old: Node) {
    this.children[this.children.indexOf(old)] = next;
    next.parentNode = this;
    old.parentNode = null;
  }
  remove() {
    this.parentNode?.removeChild(this);
  }
  focus() {
    this.focused = true;
    focusSink?.(this);
  }
  contains(node: Node | null): boolean {
    for (let n = node; n; n = n.parentNode) if (n === this) return true;
    return false;
  }
  addEventListener(type: string, fn: (e: { preventDefault: () => void }) => void) {
    this.listeners.set(type, fn);
  }
  click() {
    if (!this.disabled) this.listeners.get("click")?.({ preventDefault() {} });
  }
  querySelectorAll(selector: string): Node[] {
    const matches = (n: Node) =>
      selector.split(",").some((s) => {
        const m = /^\[([^=\]]+)(?:="([^"]*)")?\]$/.exec(s);
        return m
          ? m[2] === undefined
            ? n.attributes.has(m[1]!)
            : n.getAttribute(m[1]!) === m[2]
          : false;
      });
    return this.children.flatMap((n) => [
      ...(matches(n) ? [n] : []),
      ...n.querySelectorAll(selector),
    ]);
  }
  querySelector(selector: string) {
    return this.querySelectorAll(selector)[0] ?? null;
  }
}
function parse(html: string) {
  const page = new Node();
  const stack = [page];
  const decode = (s: string) =>
    s
      .replace(/&#39;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&");
  for (const token of html.match(/<[^>]*>|[^<]+/g) ?? []) {
    if (token.startsWith("</")) {
      stack.pop();
      continue;
    }
    if (token.startsWith("<!")) continue;
    const n = new Node();
    stack[stack.length - 1]!.appendChild(n);
    if (!token.startsWith("<")) {
      n.textContent = decode(token);
      continue;
    }
    for (const [, key, value] of token.matchAll(/\s([\w-]+)(?:="([^"]*)")?/g))
      n.setAttribute(key!, decode(value ?? ""));
    if (!/^<(?:meta|link|input|br)\b/.test(token)) stack.push(n);
  }
  return page;
}
const event: PublicEvent = {
  id: 42,
  eventKey: "raid/one",
  title: "Squad night",
  game: null,
  description: null,
  purpose: null,
  startsAt: new Date("2030-01-01T20:00:00Z"),
  endsAt: new Date("2030-01-01T22:00:00Z"),
  timezone: "Europe/London",
  location: null,
  capacity: 4,
  goingCount: 1,
  goingOccupancy: 1,
  status: "published",
  discordEventId: null,
  discordSyncFailedAt: null,
  discordSyncFailureCode: null,
  createdBy: null,
  rsvpOpen: true,
  recurrenceFrequency: null,
  recurrenceCount: null,
  recurrenceEndsOn: null,
  parentEventId: null,
  recurrenceIndex: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  icsSequence: 0n,
  syncRevision: 1,
  syncedRevision: 0,
  agentGrantId: null,
  proofMarker: null,
  agentVersion: 1,
};

type BrowserOptions = {
  // The URL the member is on when they RSVP.
  pageUrl?: string;
  // The SSR returnTo for this render. Defaults to pageUrl so every
  // legitimate channel agrees, as it does in production.
  returnTo?: string;
  // Mutate the island root's mount data before the binder runs.
  tamperMount?: (root: Node) => void;
};

function browser(options: BrowserOptions = {}) {
  const pageUrl = options.pageUrl ?? "/e/raid/one?attendees=2";
  const parsed = new NodeURL(pageUrl, ORIGIN);
  const html = String(
    RsvpButton({
      e: event,
      member: true,
      answer: null,
      returnTo: options.returnTo ?? pageUrl,
      now: new Date("2029-01-01"),
    }),
  );
  const page = parse(html);
  const root = page.querySelector('[data-island="rsvp-button"]')!;
  options.tamperMount?.(root);
  const requests: {
    url: string;
    init: RequestInit;
    resolve: (r: Response) => void;
    reject: (e: Error) => void;
  }[] = [];
  const broadcasts: { type: string; detail: unknown }[] = [];
  let reloads = 0;
  const timers: { callback: () => void; delay: number; cancelled: boolean }[] = [];
  const runTimers = (delay?: number) => {
    const due = timers.filter((timer) => delay === undefined || timer.delay === delay);
    due.forEach((timer) => {
      timers.splice(timers.indexOf(timer), 1);
      if (!timer.cancelled) timer.callback();
    });
  };
  const listeners = new Map<
    string,
    (event: { type: string; detail: unknown; target?: Node }) => void
  >();
  const location = {
    pathname: parsed.pathname,
    search: parsed.search,
    hash: parsed.hash,
    href: parsed.href,
    origin: ORIGIN,
    protocol: parsed.protocol,
    host: parsed.host,
    reload: () => {
      reloads++;
    },
  };
  const context: Record<string, unknown> = {
    document: {
      querySelector: (selector: string) => page.querySelector(selector),
      querySelectorAll: (selector: string) => page.querySelectorAll(selector),
      createElement: () => new Node(),
      createTextNode: (text: string) => {
        const n = new Node();
        n.textContent = text;
        return n;
      },
      addEventListener: (type: string, fn: (event: { type: string; detail: unknown }) => void) =>
        listeners.set(type, fn),
      dispatchEvent: (event: { type: string; detail: unknown }) => {
        broadcasts.push(event);
        listeners.get(event.type)?.(event);
      },
      location,
    },
    CustomEvent: class {
      constructor(
        public type: string,
        public options: { detail: unknown },
      ) {}
      get detail() {
        return this.options.detail;
      }
    },
    location,
    URL: NodeURL,
    URLSearchParams,
    fetch: (url: string, init: RequestInit) =>
      new Promise<Response>((resolve, reject) => requests.push({ url, init, resolve, reject })),
    setTimeout: (callback: () => void, delay = 0) => {
      const timer = { callback, delay, cancelled: false };
      timers.push(timer);
      return timer;
    },
    clearTimeout: (timer: { cancelled: boolean }) => {
      timer.cancelled = true;
      const index = timers.indexOf(timer as (typeof timers)[number]);
      if (index !== -1) timers.splice(index, 1);
    },
  };
  context.window = { location, document: context.document };
  focusSink = (target) =>
    listeners.get("focusin")?.({ type: "focusin", detail: undefined, target });
  runInNewContext(binder, context);
  const get = (id: string) => root.querySelector(`[data-testid="${id}"]`);
  const settle = async (flushTimers = true) => {
    await new Promise((resolve) => setImmediate(resolve));
    if (flushTimers) runTimers(0);
  };
  return { root, page, get, requests, broadcasts, settle, runTimers, reloads: () => reloads };
}

type Harness = ReturnType<typeof browser>;

// The recovery link must be a same-origin path for this event. Accept the
// shipped percent-encoded key ("/e/raid%2Fone") or a literal slash, but
// never another event, another origin, or a protocol-relative href.
function expectRefreshDestination(b: Harness, attendees: string | null) {
  const link = b.get(RSVP_REFRESH_TESTID);
  expect(link, "unknown-outcome recovery must offer a refresh link").not.toBeNull();
  const href = link!.href || link!.getAttribute("href") || "";
  expect(href.startsWith("/e/"), `refresh href must be a same-origin event path, got ${href}`).toBe(
    true,
  );
  expect(href).not.toContain("evil.example.test");
  const url = new NodeURL(href, ORIGIN);
  expect(url.origin).toBe(ORIGIN);
  expect(decodeURIComponent(url.pathname)).toBe("/e/raid/one");
  expect(url.searchParams.get("attendees")).toBe(attendees);
}

function expectUnknownLocked(b: Harness) {
  expect(b.get(RSVP_UNKNOWN_TESTID)?.getAttribute("role")).toBe("alert");
  expect(b.get(RSVP_UNKNOWN_TESTID)?.textContent).toBe(`${RSVP_COPY.unknown} ${RSVP_COPY.refresh}`);
  expect(b.root.getAttribute("data-outcome-unknown")).toBe("true");
  expect(b.root.getAttribute("aria-busy")).toBeNull();
  expect(b.get("rsvp-confirmed")).toBeNull();
  expect(b.root.querySelectorAll("[data-action]").every((n) => n.disabled)).toBe(true);
  // Locked controls must not replay the uncertain write, however prodded.
  b.root.querySelectorAll("[data-action]").forEach((n) => {
    n.click();
    n.listeners.get("click")?.({ preventDefault() {} });
  });
  b.root.querySelector("[data-rsvp-form]")!.listeners.get("submit")!({ preventDefault() {} });
  expect(b.requests).toHaveLength(1);
  expect(b.broadcasts.filter((e) => e.type === "going-count-updated")).toHaveLength(0);
  expect(b.reloads()).toBe(0);
}

// Plant an untrusted destination in every URL-shaped piece of mount data
// the island root carries (plus the names a fix might add for this), so a
// binder that echoes mount data into the recovery href is caught whatever
// attribute it chose. The event identity itself is left intact.
function tamperUrlMountData(evil: string) {
  return (root: Node) => {
    for (const key of [...root.attributes.keys()]) {
      if (key === "data-event-key" || key === "data-island") continue;
      const value = root.getAttribute(key) ?? "";
      if (
        /url|href|return|refresh|next|login|search|query|path|page/i.test(key) ||
        value.includes("/e/") ||
        value.includes("raid")
      )
        root.setAttribute(key, evil);
    }
    root.setAttribute("data-login-url", evil);
    root.setAttribute("data-return-to", evil);
    root.setAttribute("data-refresh-url", evil);
  };
}

describe("unknown-outcome refresh keeps the attendee page", () => {
  it("keeps ?attendees=2 after a transport rejection, with controls locked", async () => {
    const b = browser();
    b.get("rsvp-going")!.click();
    expect(b.requests).toHaveLength(1);
    b.requests[0]!.reject(new Error("response transport lost"));
    await b.settle();
    expectUnknownLocked(b);
    expectRefreshDestination(b, "2");
  });

  it("keeps ?attendees=2 after an unreadable successful body", async () => {
    const b = browser();
    b.get("rsvp-going")!.click();
    b.requests[0]!.resolve(new Response("not json", { status: 201 }));
    await b.settle();
    expectUnknownLocked(b);
    expectRefreshDestination(b, "2");
  });

  it("keeps ?attendees=2 after the deadline expires and ignores late completion", async () => {
    const b = browser();
    b.get("rsvp-going")!.click();
    await b.settle(false);
    b.runTimers(8000);
    expectUnknownLocked(b);
    expectRefreshDestination(b, "2");
    // A completion that arrives after the deadline must not revive the
    // write, repaint a confirmation, or change the recovery destination.
    b.requests[0]!.resolve(
      new Response(JSON.stringify({ data: { status: "going", synced_to_discord_at: null } }), {
        status: 201,
      }),
    );
    await b.settle();
    expect(b.get(RSVP_UNKNOWN_TESTID)).not.toBeNull();
    expect(b.get("rsvp-confirmed")).toBeNull();
    expect(b.requests).toHaveLength(1);
    expect(b.broadcasts.filter((e) => e.type === "going-count-updated")).toHaveLength(0);
    expectRefreshDestination(b, "2");
  });

  it("keeps ?attendees=2 without stealing focus after the member moved away", async () => {
    const b = browser();
    const field = new Node();
    b.page.appendChild(field);
    b.get("rsvp-going")!.click();
    field.focus();
    b.requests[0]!.reject(new Error("response transport lost"));
    await b.settle();
    expect(b.get(RSVP_UNKNOWN_TESTID)?.focused).toBe(false);
    expect(field.focused).toBe(true);
    expectRefreshDestination(b, "2");
  });

  it("still recovers to the bare event from a bare event URL", async () => {
    const b = browser({ pageUrl: "/e/raid/one" });
    b.get("rsvp-going")!.click();
    b.requests[0]!.reject(new Error("response transport lost"));
    await b.settle();
    expectUnknownLocked(b);
    expectRefreshDestination(b, null);
  });

  it("ignores an external destination planted in mount data", async () => {
    const b = browser({
      pageUrl: "/e/raid/one",
      tamperMount: tamperUrlMountData("https://evil.example.test/e/raid/one?attendees=2"),
    });
    b.get("rsvp-going")!.click();
    b.requests[0]!.reject(new Error("response transport lost"));
    await b.settle();
    expectUnknownLocked(b);
    expectRefreshDestination(b, null);
  });

  it("ignores a different-event destination planted in mount data", async () => {
    const b = browser({
      pageUrl: "/e/raid/one",
      tamperMount: tamperUrlMountData("/e/some/other?attendees=9"),
    });
    b.get("rsvp-going")!.click();
    b.requests[0]!.reject(new Error("response transport lost"));
    await b.settle();
    expectUnknownLocked(b);
    expectRefreshDestination(b, null);
  });

  it("does not carry a different event page's attendee page onto this event", async () => {
    const b = browser({ pageUrl: "/e/some/other?attendees=2", returnTo: "/e/raid/one" });
    b.get("rsvp-going")!.click();
    b.requests[0]!.reject(new Error("response transport lost"));
    await b.settle();
    expectUnknownLocked(b);
    expectRefreshDestination(b, null);
  });
});

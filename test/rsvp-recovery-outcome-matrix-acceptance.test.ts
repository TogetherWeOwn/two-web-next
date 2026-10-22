// Synthetic support matrix against real SSR + shipped JavaScript. No network,
// database, real member, replay or notification assertion. Fake DOM adapted from
// islands-rsvp-binder.test.ts without changing that suite's ownership.
import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { RsvpButton } from "../src/events/rsvp-button";
import type { PublicEvent } from "../src/events/reads";
import { guidanceFor, recoveryGuide } from "./helpers/rsvp-recovery-guide";

class Element {
  children: Element[] = [];
  parentNode: Element | null = null;
  attributes = new Map<string, string>();
  listeners = new Map<string, (event: { preventDefault(): void }) => void>();
  disabled = false;
  hidden = false;
  href = "";
  private text = "";
  get textContent(): string {
    return this.text + this.children.map((n) => n.textContent).join("");
  }
  set textContent(value: string) {
    this.text = value;
    this.children = [];
  }
  setAttribute(key: string, value: string) {
    this.attributes.set(key, String(value));
  }
  getAttribute(key: string) {
    return this.attributes.get(key) ?? null;
  }
  removeAttribute(key: string) {
    this.attributes.delete(key);
  }
  appendChild(node: Element) {
    node.parentNode = this;
    this.children.push(node);
    return node;
  }
  removeChild(node: Element) {
    this.children = this.children.filter((n) => n !== node);
    node.parentNode = null;
  }
  replaceChild(next: Element, old: Element) {
    this.children[this.children.indexOf(old)] = next;
    next.parentNode = this;
    old.parentNode = null;
  }
  remove() {
    this.parentNode?.removeChild(this);
  }
  focus() {
    /* Focus movement is covered by the existing binder/browser suites. */
  }
  contains(node: Element | null): boolean {
    return node === this || this.children.some((child) => child.contains(node));
  }
  addEventListener(type: string, fn: (event: { preventDefault(): void }) => void) {
    this.listeners.set(type, fn);
  }
  click() {
    if (!this.disabled) this.listeners.get("click")?.({ preventDefault() {} });
  }
  querySelectorAll(selector: string): Element[] {
    const matches = (node: Element) =>
      selector.split(",").some((part) => {
        const m = /^\[([^=\]]+)(?:="([^"]*)")?\]$/.exec(part.trim());
        return (
          !!m &&
          (m[2] === undefined ? node.attributes.has(m[1]!) : node.getAttribute(m[1]!) === m[2])
        );
      });
    return this.children.flatMap((node) => [
      ...(matches(node) ? [node] : []),
      ...node.querySelectorAll(selector),
    ]);
  }
  querySelector(selector: string) {
    return this.querySelectorAll(selector)[0] ?? null;
  }
}
function parse(html: string) {
  const page = new Element();
  const stack = [page];
  const decode = (s: string) =>
    s
      .replace(/&#39;|&#x27;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, "&");
  for (const token of html.match(/<[^>]*>|[^<]+/g) ?? []) {
    if (token.startsWith("</")) {
      stack.pop();
      continue;
    }
    if (token.startsWith("<!")) continue;
    const node = new Element();
    stack.at(-1)!.appendChild(node);
    if (!token.startsWith("<")) {
      node.textContent = decode(token);
      continue;
    }
    for (const [, key, value] of token.matchAll(/\s([\w-]+)(?:="([^"]*)")?/g))
      node.setAttribute(key!, decode(value ?? ""));
    if (!/^<(?:meta|link|input|br)\b/.test(token)) stack.push(node);
  }
  return page;
}
const event: PublicEvent = {
  id: 42,
  eventKey: "seed-squad-night",
  title: "Synthetic squad night",
  game: null,
  description: null,
  startsAt: new Date("2030-01-01T20:00:00Z"),
  endsAt: new Date("2030-01-01T22:00:00Z"),
  timezone: "UTC",
  location: null,
  capacity: 4,
  goingCount: 1,
  goingOccupancy: 1,
  status: "published",
  rsvpOpen: true,
  discordEventId: null,
  discordSyncFailedAt: null,
  discordSyncFailureCode: null,
  createdBy: null,
  recurrenceFrequency: null,
  recurrenceCount: null,
  recurrenceEndsOn: null,
  parentEventId: null,
  recurrenceIndex: null,
  createdAt: new Date("2029-01-01"),
  updatedAt: new Date("2029-01-01"),
  icsSequence: 0n,
  syncRevision: 1,
  syncedRevision: 0,
  agentGrantId: null,
  proofMarker: null,
  agentVersion: 1,
};
function fixture(
  overrides: Partial<PublicEvent> = {},
  answer: {
    status: string;
    syncedToDiscordAt: Date | null;
    waitlistPosition?: number;
  } | null = null,
) {
  const page = parse(
    String(
      RsvpButton({
        e: { ...event, ...overrides },
        member: true,
        answer,
        waitlistPosition: answer?.waitlistPosition ?? null,
        returnTo: "/e/seed-squad-night",
        now: new Date("2029-01-01"),
      }),
    ),
  );
  const root = page.querySelector('[data-island="rsvp-button"]')!;
  const requests: {
    url: string;
    init: RequestInit;
    resolve(value: Response): void;
    reject(error: Error): void;
  }[] = [];
  const broadcasts: { type: string; detail: unknown }[] = [];
  const timers: { callback(): void; delay: number }[] = [];
  let reloads = 0;
  const document = {
    querySelector: (s: string) => page.querySelector(s),
    querySelectorAll: (s: string) => page.querySelectorAll(s),
    createElement: () => new Element(),
    createTextNode: (text: string) => {
      const n = new Element();
      n.textContent = text;
      return n;
    },
    addEventListener() {},
    dispatchEvent: (ev: { type: string; detail: unknown }) => broadcasts.push(ev),
  };
  const context = {
    document,
    URL,
    AbortController,
    location: { pathname: "/e/seed-squad-night", reload: () => reloads++ },
    fetch: (url: string, init: RequestInit) =>
      new Promise<Response>((resolve, reject) => requests.push({ url, init, resolve, reject })),
    CustomEvent: class {
      constructor(
        public type: string,
        public options: { detail: unknown },
      ) {}
      get detail() {
        return this.options.detail;
      }
    },
    setTimeout: (callback: () => void, delay = 0) => {
      const timer = { callback, delay };
      timers.push(timer);
      return timer;
    },
    clearTimeout: (timer: (typeof timers)[number]) => {
      const i = timers.indexOf(timer);
      if (i !== -1) timers.splice(i, 1);
    },
  };
  runInNewContext(
    readFileSync(new URL("../public/islands/rsvp-button.js", import.meta.url), "utf8"),
    context,
  );
  return {
    root,
    requests,
    broadcasts,
    reloads: () => reloads,
    get: (id: string) => root.querySelector(`[data-testid="${id}"]`),
    settle: async () => {
      await new Promise((resolve) => setImmediate(resolve));
      for (const timer of timers.filter((t) => t.delay === 0)) timer.callback();
    },
  };
}

const outcomes = [
  {
    name: "Going saved with pending mirror",
    status: 201,
    body: { data: { status: "going", synced_to_discord_at: null, waitlist_position: null } },
    id: "rsvp-syncing",
    sentence: "Saved. Syncing to Discord.",
    branch: /Saved\. Syncing to Discord\./,
    advice: /not[^.]{0,90}fail|saved|held/i,
  },
  {
    name: "saved and mirrored",
    status: 200,
    body: {
      data: {
        status: "going",
        synced_to_discord_at: "2029-01-01T12:00:00Z",
        waitlist_position: null,
      },
    },
    id: "rsvp-synced",
    sentence: "Synced to Discord.",
    branch: /Synced to Discord\./,
    advice: /not[^.]{0,90}(?:attend|deliver|notif)|does not[^.]{0,90}(?:attend|deliver|notif)/i,
  },
  {
    name: "Waitlisted is not Going",
    status: 201,
    body: { data: { status: "waitlisted", synced_to_discord_at: null, waitlist_position: 2 } },
    id: "waitlist-position",
    sentence: "You're on the waitlist — #2 in line",
    branch: /waitlist/i,
    advice: /not[^.]{0,60}(?:seat|held|reserv)|no[^.]{0,60}(?:seat|reserv)/i,
  },
  {
    name: "session expiry",
    status: 401,
    body: { error: "unauthenticated" },
    id: "rsvp-session-expired",
    sentence: "Your session expired.",
    branch: /Your session expired\./,
    advice: /sign.?in|log.?in|troubleshooting-join/i,
  },
  {
    name: "shared throttle",
    status: 429,
    body: { error: "rate_limit_exceeded" },
    id: "rsvp-rate-limited",
    sentence: "Slow down — try again in 3 seconds. Nothing changed, just wait a moment.",
    branch: /Slow down|Retry-After/i,
    advice: /wait/i,
  },
] as const;

describe("source-backed synthetic RSVP recovery outcomes", () => {
  for (const outcome of outcomes) {
    it(`runtime control: ${outcome.name}`, async () => {
      const browser = fixture();
      browser.get("rsvp-going")!.click();
      browser.get("rsvp-going")!.click();
      expect(browser.requests).toHaveLength(1);
      expect(browser.requests[0]!.url).toBe("/events/seed-squad-night/rsvp");
      expect(browser.requests[0]!.init.method).toBe("PUT");
      browser.requests[0]!.resolve(
        new Response(JSON.stringify(outcome.body), {
          status: outcome.status,
          headers: { "Retry-After": "3" },
        }),
      );
      await browser.settle();
      expect(browser.get(outcome.id)?.textContent).toContain(outcome.sentence);
      expect(browser.get("rsvp-unknown")).toBeNull();
      if (outcome.status >= 400) expect(browser.broadcasts).toEqual([]);
      if (outcome.id === "waitlist-position") expect(browser.get("rsvp-confirmed")).toBeNull();
      expect(browser.requests).toHaveLength(1);
    });
    it(`guide decision: ${outcome.name}`, () => {
      const branch = guidanceFor(recoveryGuide().body, outcome.branch);
      expect(branch).toMatch(outcome.advice);
    });
  }

  for (const failure of ["transport rejection", "unreadable success"] as const) {
    it(`runtime control: ${failure} is unknown, never failed or automatically replayed`, async () => {
      const browser = fixture();
      browser.get("rsvp-going")!.click();
      if (failure === "transport rejection")
        browser.requests[0]!.reject(new Error("synthetic connection loss"));
      else browser.requests[0]!.resolve(new Response("unreadable", { status: 201 }));
      await browser.settle();
      expect(browser.get("rsvp-unknown")?.textContent).toContain(
        "We couldn't confirm your RSVP. Check the event before trying again.",
      );
      expect(browser.get("rsvp-refresh")?.href).toBe("/e/seed-squad-night");
      expect(browser.get("rsvp-failed")).toBeNull();
      expect(browser.get("rsvp-confirmed")).toBeNull();
      for (const control of browser.root.querySelectorAll("[data-action]")) {
        expect(control.disabled).toBe(true);
        control.click();
      }
      expect(browser.requests).toHaveLength(1);
      expect(browser.broadcasts).toEqual([]);
    });
  }

  it("runtime control: a promoted member reads Going on reload without submitting again", () => {
    const before = fixture(
      { goingCount: 4, goingOccupancy: 4 },
      { status: "waitlisted", syncedToDiscordAt: null, waitlistPosition: 1 },
    );
    const after = fixture({}, { status: "going", syncedToDiscordAt: null });
    expect(before.get("waitlist-position")?.textContent).toContain("#1 in line");
    expect(before.get("rsvp-confirmed")).toBeNull();
    expect(after.get("rsvp-confirmed")?.textContent).toContain("You're in");
    expect(after.get("waitlist-position")).toBeNull();
    expect(before.requests).toEqual([]);
    expect(after.requests).toEqual([]);
  });

  for (const [name, overrides, id, sentence] of [
    [
      "paused",
      { rsvpOpen: false },
      "rsvp-paused",
      "RSVPs are paused for this event — check back soon.",
    ],
    ["ended", { endsAt: new Date("2028-01-01") }, "rsvp-closed", "This one has been and gone"],
    ["cancelled", { status: "cancelled" }, "rsvp-closed", "Cancelled"],
  ] as const) {
    it(`runtime control: ${name} offers no new RSVP write`, () => {
      const browser = fixture(overrides);
      expect(browser.get(id)?.textContent).toContain(sentence);
      expect(browser.get("rsvp-going")).toBeNull();
      expect(browser.get("waitlist-join")).toBeNull();
      expect(browser.requests).toEqual([]);
    });
  }

  it("runtime control: a stale page's closed refusal reloads instead of retrying the write", async () => {
    const browser = fixture();
    browser.get("rsvp-going")!.click();
    browser.requests[0]!.resolve(
      new Response(
        JSON.stringify({
          reason: "event_not_open",
          why: "paused",
          message: "This event is not taking RSVPs.",
        }),
        { status: 403 },
      ),
    );
    await browser.settle();
    expect(browser.reloads()).toBe(1);
    expect(browser.requests).toHaveLength(1);
    expect(browser.broadcasts).toEqual([]);
  });
});

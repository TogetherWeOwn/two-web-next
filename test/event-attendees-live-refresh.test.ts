// Acceptance: after the member's own RSVP, the who's-going roster must
// refresh live and stay in agreement with the count badge, without a
// full page reload. A failed refresh must surface a stale/retry signal
// instead of leaving a silent contradiction.
//
// Hermetic fixture contract (no browser, network or database):
// - The real SSR EventPage HTML is parsed into the fake DOM below, and
//   every island script the page itself references is executed from
//   public/islands, in page order. An implementation may patch via the
//   existing islands or add its own page-referenced island.
// - The member's own RSVP is driven by clicking the shipped controls.
//   The write is answered with the existing success contract
//   (PUT -> 201 JSON, DELETE -> 204). No real RSVP write happens.
// - Every read after the write is answered from one post-write "server
//   truth": /events.json returns the aggregate row, a JSON read returns
//   the attendee list, and any other GET returns the event page
//   re-rendered with the post-write roster. In the failure case every
//   read returns 500 and timers are pumped so bounded retries can run.
// - Assertions read only the rendered DOM: roster member names, the
//   roster heading count, the badge count, reload count, and (for the
//   failure case) a newly surfaced stale/retry signal outside the RSVP
//   button island.
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { URL as NodeURL } from "node:url";
import { describe, expect, it } from "vitest";
import { EventPage } from "../src/events/pages";
import type { PublicEvent } from "../src/events/reads";

// ---------- fake DOM (extended from the islands-rsvp-binder pattern) ----------

type Listener = (event: FakeEvent) => void;
interface FakeEvent {
  type: string;
  detail?: unknown;
  target?: El;
  submitter?: El;
  preventDefault: () => void;
}

let focusSink: ((target: El) => void) | null = null;

const VOID_TAGS = new Set(["META", "LINK", "INPUT", "BR", "IMG", "HR"]);

function escapeText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}
function kebab(s: string): string {
  return s.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
}

function matchCompound(el: El, compound: string): boolean {
  if (el.tagName.startsWith("#")) return false;
  let rest = compound.trim();
  if (rest === "") return false;
  const tag = /^(\*|[a-zA-Z][\w-]*)/.exec(rest);
  if (tag) {
    if (tag[1] !== "*" && el.tagName !== tag[1]!.toUpperCase()) return false;
    rest = rest.slice(tag[1]!.length);
  }
  while (rest.length > 0) {
    let m: RegExpExecArray | null;
    if ((m = /^\.([\w-]+)/.exec(rest))) {
      const classes = (el.getAttribute("class") ?? "").split(/\s+/);
      if (!classes.includes(m[1]!)) return false;
    } else if ((m = /^#([\w-]+)/.exec(rest))) {
      if (el.getAttribute("id") !== m[1]) return false;
    } else if ((m = /^\[([\w-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\]]+)))?\]/.exec(rest))) {
      const value = m[2] ?? m[3] ?? m[4];
      if (value === undefined) {
        if (!el.attributes.has(m[1]!)) return false;
      } else if (el.getAttribute(m[1]!) !== value) return false;
    } else {
      return false;
    }
    rest = rest.slice(m[0].length);
  }
  return true;
}

class El {
  children: El[] = [];
  parentNode: El | null = null;
  attributes = new Map<string, string>();
  disabled = false;
  hidden = false;
  focused = false;
  href = "";
  style: Record<string, string> = {};
  private ownText = "";
  private listeners = new Map<string, Listener[]>();

  constructor(public tagName: string) {}

  get textContent(): string {
    if (this.tagName === "#text") return this.ownText;
    return this.children.map((n) => n.textContent).join("");
  }
  set textContent(value: string) {
    if (this.tagName === "#text") {
      this.ownText = value;
      return;
    }
    this.children = [];
    if (value !== "") {
      const t = new El("#text");
      t.ownText = value;
      t.parentNode = this;
      this.children.push(t);
    }
  }
  get innerHTML(): string {
    return this.children.map((n) => n.outerHTML).join("");
  }
  set innerHTML(value: string) {
    const frag = parseHtml(value);
    for (const child of this.children) child.parentNode = null;
    this.children = [];
    for (const child of [...frag.children]) this.appendChild(child);
  }
  get outerHTML(): string {
    if (this.tagName === "#text") return escapeText(this.ownText);
    if (this.tagName === "#document") return this.innerHTML;
    const attrs = [...this.attributes].map(([k, v]) => ` ${k}="${escapeAttr(v)}"`).join("");
    const tag = this.tagName.toLowerCase();
    if (VOID_TAGS.has(this.tagName)) return `<${tag}${attrs}>`;
    return `<${tag}${attrs}>${this.innerHTML}</${tag}>`;
  }
  get dataset(): Record<string, string | undefined> {
    const el = this;
    return new Proxy(
      {},
      {
        get: (_t, prop: string) => el.getAttribute(`data-${kebab(prop)}`) ?? undefined,
        set: (_t, prop: string, value: string) => {
          el.setAttribute(`data-${kebab(prop)}`, String(value));
          return true;
        },
        deleteProperty: (_t, prop: string) => {
          el.removeAttribute(`data-${kebab(prop)}`);
          return true;
        },
      },
    );
  }
  get classList() {
    const el = this;
    const read = () => (el.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);
    const write = (tokens: string[]) => el.setAttribute("class", tokens.join(" "));
    return {
      add: (...tokens: string[]) => write([...new Set([...read(), ...tokens])]),
      remove: (...tokens: string[]) => write(read().filter((t) => !tokens.includes(t))),
      contains: (token: string) => read().includes(token),
      toggle: (token: string) => {
        if (read().includes(token)) write(read().filter((t) => t !== token));
        else write([...read(), token]);
      },
    };
  }
  setAttribute(k: string, v: string) {
    this.attributes.set(k, String(v));
    if (k === "hidden") this.hidden = true;
    if (k === "disabled") this.disabled = true;
    if (k === "href") this.href = String(v);
  }
  getAttribute(k: string) {
    return this.attributes.get(k) ?? null;
  }
  hasAttribute(k: string) {
    return this.attributes.has(k);
  }
  removeAttribute(k: string) {
    this.attributes.delete(k);
    if (k === "hidden") this.hidden = false;
    if (k === "disabled") this.disabled = false;
  }
  appendChild(n: El) {
    if (n.parentNode) n.parentNode.children = n.parentNode.children.filter((c) => c !== n);
    n.parentNode = this;
    this.children.push(n);
    return n;
  }
  append(...nodes: (El | string)[]) {
    for (const n of nodes) {
      if (typeof n === "string") {
        const t = new El("#text");
        t.textContent = n;
        this.appendChild(t);
      } else this.appendChild(n);
    }
  }
  prepend(...nodes: El[]) {
    for (const n of [...nodes].reverse())
      if (this.children[0]) this.insertBefore(n, this.children[0]);
      else this.appendChild(n);
  }
  insertBefore(n: El, anchor: El | null) {
    if (!anchor) return this.appendChild(n);
    if (n === anchor) return n;
    if (n.parentNode) n.parentNode.children = n.parentNode.children.filter((c) => c !== n);
    n.parentNode = this;
    this.children.splice(this.children.indexOf(anchor), 0, n);
    return n;
  }
  removeChild(n: El) {
    this.children = this.children.filter((child) => child !== n);
    n.parentNode = null;
    return n;
  }
  replaceChild(next: El, old: El) {
    this.children[this.children.indexOf(old)] = next;
    next.parentNode = this;
    old.parentNode = null;
    return old;
  }
  replaceWith(...nodes: El[]) {
    const parent = this.parentNode;
    if (!parent) return;
    for (const n of nodes) parent.insertBefore(n, this);
    parent.removeChild(this);
  }
  remove() {
    this.parentNode?.removeChild(this);
  }
  cloneNode(deep = false): El {
    const copy = new El(this.tagName);
    copy.attributes = new Map(this.attributes);
    copy.ownText = this.ownText;
    copy.disabled = this.disabled;
    copy.hidden = this.hidden;
    copy.href = this.href;
    if (deep) for (const child of this.children) copy.appendChild(child.cloneNode(true));
    return copy;
  }
  focus() {
    this.focused = true;
    focusSink?.(this);
  }
  contains(node: El | null): boolean {
    for (let n = node; n; n = n.parentNode) if (n === this) return true;
    return false;
  }
  matches(selector: string): boolean {
    return selector.split(",").some((group) => {
      const parts = group.trim().split(/\s+/);
      return matchCompound(this, parts[parts.length - 1]!);
    });
  }
  closest(selector: string): El | null {
    for (let n: El | null = this; n; n = n.parentNode) if (n.matches(selector)) return n;
    return null;
  }
  addEventListener(type: string, fn: Listener) {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }
  removeEventListener(type: string, fn: Listener) {
    this.listeners.set(
      type,
      (this.listeners.get(type) ?? []).filter((f) => f !== fn),
    );
  }
  dispatchEvent(event: FakeEvent) {
    for (const fn of this.listeners.get(event.type) ?? []) fn(event);
    return true;
  }
  click() {
    if (this.disabled) return;
    this.dispatchEvent({ type: "click", target: this, preventDefault() {} });
  }
  private descendants(): El[] {
    return this.children.flatMap((n) => [n, ...n.descendants()]);
  }
  querySelectorAll(selector: string): El[] {
    const out: El[] = [];
    for (const group of selector.split(",")) {
      const parts = group.trim().split(/\s+/).filter(Boolean);
      if (parts.length === 0) continue;
      let current = this.descendants().filter((n) => matchCompound(n, parts[0]!));
      for (const part of parts.slice(1))
        current = current.flatMap((n) => n.descendants().filter((d) => matchCompound(d, part)));
      for (const n of current) if (!out.includes(n)) out.push(n);
    }
    return out;
  }
  querySelector(selector: string): El | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }
}

function parseHtml(html: string): El {
  const page = new El("#document");
  const stack: El[] = [page];
  const decode = (s: string) =>
    s
      .replace(/&#39;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&");
  for (const token of html.match(/<[^>]*>|[^<]+/g) ?? []) {
    if (token.startsWith("</")) {
      if (stack.length > 1) stack.pop();
      continue;
    }
    if (token.startsWith("<!")) continue;
    if (!token.startsWith("<")) {
      const text = new El("#text");
      text.textContent = decode(token);
      stack[stack.length - 1]!.appendChild(text);
      continue;
    }
    const tagMatch = /^<([a-zA-Z][\w-]*)/.exec(token);
    const n = new El(tagMatch ? tagMatch[1]!.toUpperCase() : "SPAN");
    stack[stack.length - 1]!.appendChild(n);
    for (const [, key, value] of token.matchAll(/\s([\w-]+)(?:="([^"]*)")?/g))
      n.setAttribute(key!, decode(value ?? ""));
    if (!VOID_TAGS.has(n.tagName) && !/\/>$/.test(token)) stack.push(n);
  }
  return page;
}

function walk(root: El, visit: (el: El) => void) {
  visit(root);
  for (const child of root.children) walk(child, visit);
}

// ---------- fixture ----------

const EVENT_KEY = "spring-social";
const HOST = { id: "member-host", name: "Riley Host" };
const VIEWER = { id: "member-viewer", name: "Vera Viewer" };
const CAPACITY = 4;

const baseEvent: PublicEvent = {
  id: 42,
  eventKey: EVENT_KEY,
  title: "Spring social",
  game: null,
  description: null,
  startsAt: new Date("2030-01-01T20:00:00Z"),
  endsAt: new Date("2030-01-01T22:00:00Z"),
  timezone: "Europe/London",
  location: null,
  capacity: CAPACITY,
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

type Attendee = { id: string; name: string };

function renderPage(attendees: Attendee[], viewerGoing: boolean): string {
  return String(
    EventPage({
      e: { ...baseEvent, goingCount: attendees.length },
      member: true,
      answer: viewerGoing ? { status: "going", syncedToDiscordAt: null } : null,
      returnTo: `/e/${EVENT_KEY}`,
      neighbors: { previous: null, next: null },
      related: [],
      attendees,
      appUrl: "https://next.example.test",
      jsonLd: "{}",
    }),
  );
}

interface PendingRequest {
  url: string;
  init: RequestInit;
  resolve: (r: Response) => void;
  answered: boolean;
}

function browser(opts: {
  before: Attendee[];
  after: Attendee[];
  viewerGoingBefore: boolean;
  failReads?: boolean;
}) {
  const html = renderPage(opts.before, opts.viewerGoingBefore);
  const page = parseHtml(html);
  const requests: PendingRequest[] = [];
  const broadcasts: { type: string; detail: unknown }[] = [];
  const docListeners = new Map<string, Listener[]>();
  const timers: { callback: () => void; delay: number; cancelled: boolean }[] = [];
  let reloads = 0;

  const runTimers = (onlyDelay?: number) => {
    const due = timers.filter((t) => onlyDelay === undefined || t.delay === onlyDelay);
    for (const timer of due) {
      timers.splice(timers.indexOf(timer), 1);
      if (!timer.cancelled) timer.callback();
    }
  };
  const notifyDocument = (type: string, target: El) => {
    for (const fn of docListeners.get(type) ?? []) fn({ type, target, preventDefault() {} });
  };

  const documentStub = {
    documentElement: page,
    body: page,
    querySelector: (selector: string) => page.querySelector(selector),
    querySelectorAll: (selector: string) => page.querySelectorAll(selector),
    getElementById: (id: string) => page.querySelector(`#${id}`),
    createElement: (tag: string) => new El(tag.toUpperCase()),
    createTextNode: (text: string) => {
      const n = new El("#text");
      n.textContent = text;
      return n;
    },
    addEventListener: (type: string, fn: Listener) => {
      const list = docListeners.get(type) ?? [];
      list.push(fn);
      docListeners.set(type, list);
    },
    removeEventListener: (type: string, fn: Listener) => {
      docListeners.set(
        type,
        (docListeners.get(type) ?? []).filter((f) => f !== fn),
      );
    },
    dispatchEvent: (event: { type: string; detail?: unknown }) => {
      broadcasts.push({ type: event.type, detail: event.detail });
      // Pass the event object through intact: spreading it would drop
      // the CustomEvent `detail` getter listeners key off.
      const ev = event as FakeEvent;
      if (typeof ev.preventDefault !== "function") ev.preventDefault = () => {};
      for (const fn of docListeners.get(event.type) ?? []) fn(ev);
      return true;
    },
  };

  const context: Record<string, unknown> = {
    document: documentStub,
    CustomEvent: class {
      constructor(
        public type: string,
        public options: { detail?: unknown } = {},
      ) {}
      get detail() {
        return this.options.detail;
      }
    },
    Event: class {
      constructor(public type: string) {}
    },
    DOMParser: class {
      parseFromString(markup: string) {
        const doc = parseHtml(markup);
        return {
          documentElement: doc,
          body: doc,
          querySelector: (selector: string) => doc.querySelector(selector),
          querySelectorAll: (selector: string) => doc.querySelectorAll(selector),
          getElementById: (id: string) => doc.querySelector(`#${id}`),
        };
      }
    },
    AbortController,
    URL: NodeURL,
    URLSearchParams,
    console,
    queueMicrotask,
    navigator: {},
    location: {
      pathname: `/e/${EVENT_KEY}`,
      href: `https://next.example.test/e/${EVENT_KEY}`,
      reload: () => {
        reloads++;
      },
    },
    fetch: (url: string, init: RequestInit = {}) =>
      new Promise<Response>((resolve) => {
        requests.push({ url: String(url), init, resolve, answered: false });
      }),
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
  context.window = context;
  context.self = context;
  context.globalThis = context;
  focusSink = (target) => notifyDocument("focusin", target);

  const rsvpRoot = page.querySelector('[data-island="rsvp-button"]');
  rsvpRoot?.setAttribute("data-login-url", `/join/discord?next=%2Fe%2F${EVENT_KEY}`);

  // Execute exactly the island scripts this page references, in order.
  const scriptSrcs = [...html.matchAll(/src="(\/islands\/[^"]+\.js)"/g)].map((m) => m[1]!);
  for (const src of [...new Set(scriptSrcs)])
    runInNewContext(readFileSync(new NodeURL(`../public${src}`, import.meta.url), "utf8"), context);

  const settle = async () => {
    await new Promise((resolve) => setImmediate(resolve));
    runTimers(0);
    await new Promise((resolve) => setImmediate(resolve));
  };

  const answerWrite = async () => {
    const write = requests.find((r) => !r.answered);
    expect(write, "the RSVP click must issue the write first").toBeDefined();
    write!.answered = true;
    const method = write!.init.method ?? "GET";
    if (method === "DELETE") write!.resolve(new Response(null, { status: 204 }));
    else
      write!.resolve(
        new Response(JSON.stringify({ data: { status: "going", synced_to_discord_at: null } }), {
          status: 201,
          headers: { "content-type": "application/json" },
        }),
      );
    await settle();
    return write!;
  };

  const readResponse = (req: PendingRequest): Response => {
    if (opts.failReads)
      return new Response("read failed", {
        status: 500,
        headers: { "content-type": "text/plain" },
      });
    if (req.url.includes("/events.json"))
      return new Response(
        JSON.stringify([
          { event_key: EVENT_KEY, going_count: opts.after.length, capacity: CAPACITY },
        ]),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    const accept = String((req.init.headers as Record<string, string> | undefined)?.accept ?? "");
    if (accept.includes("application/json"))
      return new Response(
        JSON.stringify({
          data: {
            attendees: opts.after,
            going_count: opts.after.length,
            capacity: CAPACITY,
          },
          attendees: opts.after,
          going_count: opts.after.length,
          capacity: CAPACITY,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    return new Response(renderPage(opts.after, !opts.viewerGoingBefore), {
      status: 200,
      headers: { "content-type": "text/html" },
    });
  };

  // Answer every read from the post-write truth until the page goes
  // quiet; in the failure case also pump all timers so bounded
  // retries can run their course.
  const answerReads = async () => {
    for (let round = 0; round < 10; round++) {
      await settle();
      const pending = requests.filter((r) => !r.answered);
      if (pending.length === 0) {
        if (!opts.failReads) return;
        if (timers.length === 0) return;
        runTimers();
        continue;
      }
      for (const req of pending) {
        req.answered = true;
        req.resolve(readResponse(req));
      }
      if (opts.failReads) runTimers();
    }
  };

  const byTestId = (id: string) => page.querySelector(`[data-testid="${id}"]`);

  return {
    page,
    html,
    requests,
    broadcasts,
    byTestId,
    answerWrite,
    answerReads,
    settle,
    reloads: () => reloads,
  };
}

// ---------- DOM readings (behavior-level, mechanism-agnostic) ----------

function rosterNames(b: ReturnType<typeof browser>): string[] {
  const section = b.byTestId("event-attendees");
  if (!section) return [];
  return section
    .querySelectorAll("a")
    .filter((a) => (a.getAttribute("href") ?? "").startsWith("/members/"))
    .map((a) => a.textContent.trim());
}

function rosterHeadingCount(b: ReturnType<typeof browser>): number | null {
  const section = b.byTestId("event-attendees");
  if (!section) return null;
  const m = /Who(?:'|’)s going \((\d+)\)/.exec(section.textContent);
  return m ? Number(m[1]) : null;
}

function badgeCount(b: ReturnType<typeof browser>): number | null {
  const badge = b.page.querySelector('[data-island="going-count"]');
  const text = badge?.querySelector("[data-count]")?.textContent ?? "";
  const m = /^(\d+)/.exec(text.trim());
  return m ? Number(m[1]) : null;
}

function expectRosterBadgeAgreement(b: ReturnType<typeof browser>, expected: number) {
  expect(badgeCount(b), "count badge").toBe(expected);
  expect(rosterNames(b), "roster entries").toHaveLength(expected);
  expect(rosterHeadingCount(b), "roster heading count").toBe(expected);
}

const STALE_SIGNAL =
  /out of date|stale|could ?n(?:'|’)t refresh|could not refresh|failed to refresh|unable to refresh|try again|refresh (?:the )?(?:page|attendees|list|roster)/i;

interface NodeSnap {
  directText: string;
  hidden: boolean;
  display: string | undefined;
}

function directText(el: El): string {
  return el.children
    .filter((c) => c.tagName === "#text")
    .map((c) => c.textContent)
    .join("");
}

function snapshotPage(b: ReturnType<typeof browser>): Map<El, NodeSnap> {
  const snap = new Map<El, NodeSnap>();
  walk(b.page, (el) =>
    snap.set(el, {
      directText: directText(el),
      hidden: el.hidden,
      display: el.style.display,
    }),
  );
  return snap;
}

// A stale/retry signal counts only if it newly surfaced after the write:
// a node outside the RSVP button island whose own text now carries
// stale/retry copy and which was added, reworded, or unhidden. The SSR
// "shown at page load. Refresh attendees." line is there from the
// start and unchanged, so it does not count; neither do ancestors,
// whose aggregate text always contains that line.
function hasSurfacedStaleSignal(b: ReturnType<typeof browser>, before: Map<El, NodeSnap>): boolean {
  const rsvpRoot = b.page.querySelector('[data-island="rsvp-button"]');
  let found = false;
  walk(b.page, (el) => {
    if (found || el.tagName.startsWith("#")) return;
    if (rsvpRoot?.contains(el)) return;
    const prev = before.get(el);
    const text = directText(el);
    const becameVisible =
      prev !== undefined &&
      ((prev.hidden && !el.hidden) || (prev.display === "none" && el.style.display !== "none"));
    const surfaced = prev === undefined || prev.directText !== text || becameVisible;
    if (!surfaced) return;
    if (STALE_SIGNAL.test(text)) found = true;
    const marker = `${el.getAttribute("data-testid") ?? ""} ${el.getAttribute("class") ?? ""}`;
    if (/stale|retry/i.test(marker) && el.textContent.trim() !== "") found = true;
  });
  return found;
}

// ---------- acceptance ----------

describe("who's-going roster live refresh", () => {
  it("keeps the SSR roster and full-page Refresh link as the no-JS fallback", () => {
    const html = renderPage([HOST], false);
    expect(html).toContain('data-testid="event-attendees"');
    expect(html).toMatch(/Who(?:&#39;|')s going \(1\)/);
    expect(html).toContain(`href="/members/${HOST.id}"`);
    expect(html).toContain('data-testid="event-attendees-refresh"');
    expect(html).toContain(`href="/e/${EVENT_KEY}"`);
    expect(html).toContain("1 of 4 going");
  });

  it("adds the member to the roster after their own going RSVP, badge and roster in agreement, no reload", async () => {
    const b = browser({
      before: [HOST],
      after: [HOST, VIEWER],
      viewerGoingBefore: false,
    });
    expectRosterBadgeAgreement(b, 1);
    expect(rosterNames(b)).not.toContain(VIEWER.name);

    b.byTestId("rsvp-going")!.click();
    const write = await b.answerWrite();
    expect(write.init.method).toBe("PUT");
    expect(write.url).toBe(`/events/${EVENT_KEY}/rsvp`);
    await b.answerReads();

    expect(b.reloads()).toBe(0);
    expect(rosterNames(b)).toContain(VIEWER.name);
    expect(rosterNames(b)).toContain(HOST.name);
    expectRosterBadgeAgreement(b, 2);
  });

  it("removes the member from the roster after withdrawal, badge and roster in agreement, no reload", async () => {
    const b = browser({
      before: [HOST, VIEWER],
      after: [HOST],
      viewerGoingBefore: true,
    });
    expectRosterBadgeAgreement(b, 2);
    expect(rosterNames(b)).toContain(VIEWER.name);

    b.byTestId("rsvp-withdraw")!.click();
    const write = await b.answerWrite();
    expect(write.init.method).toBe("DELETE");
    await b.answerReads();

    expect(b.reloads()).toBe(0);
    expect(rosterNames(b)).not.toContain(VIEWER.name);
    expect(rosterNames(b)).toContain(HOST.name);
    expectRosterBadgeAgreement(b, 1);
  });

  it("surfaces a stale signal instead of a silent contradiction when the refresh read fails", async () => {
    const b = browser({
      before: [HOST],
      after: [HOST, VIEWER],
      viewerGoingBefore: false,
      failReads: true,
    });
    expectRosterBadgeAgreement(b, 1);
    const before = snapshotPage(b);

    b.byTestId("rsvp-going")!.click();
    await b.answerWrite();
    await b.answerReads();

    expect(b.reloads()).toBe(0);
    // If the badge did move to the new count, the roster must have too.
    if (badgeCount(b) === 2) expect(rosterNames(b)).toHaveLength(2);
    else expect(badgeCount(b)).toBe(1);
    expect(
      hasSurfacedStaleSignal(b, before),
      "a failed refresh must surface a visible stale/retry signal",
    ).toBe(true);
  });
});

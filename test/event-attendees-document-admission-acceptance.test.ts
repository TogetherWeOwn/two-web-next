// Acceptance: the who's-going live refresh admits only authoritative
// documents for the page's own event before it mutates the roster.
//
// Pins (from the card spec, written blind to any implementation diff):
// - An HTTP-200 document that is not an authoritative response for the
//   requested event — an unrelated/error document, a roster-shaped
//   document with no same-event identity, or another event's page —
//   never replaces, inserts or erases the last-good roster. It follows
//   the existing bounded path instead: one retry after the existing
//   delay, then the existing stale/retry signal. Exactly two reads,
//   no polling, no RSVP-write replay.
// - A late or superseded invalid document changes nothing.
// - Legitimate same-event documents keep current behavior: a populated
//   page swaps in (and inserts on a first RSVP), an empty-roster page
//   removes the section, and a guest page for the same event commits
//   the same way it does today. The attendee-page query and the
//   server-rendered fallback are preserved.
// - Correction: when that same-event document is the authoritative
//   guest or members-only shell (the session downgraded between the
//   RSVP write and the fragment read), the refresh still removes every
//   private name AND mounts the returned audience shell — exactly one
//   shell, the visitor's own focus restored into it, no reload. The
//   populated/empty member swaps and foreign-document refusal controls
//   keep passing unchanged.
// - An invalid document does not tear down the live section node, so
//   focus living inside the roster is never dropped by a document that
//   was not admitted.
//
// Design contract (test-only slice; no visual change): audience is a
// signed-in member watching the roster after their own RSVP; the only
// user-visible states exercised are the existing roster and the
// existing "could not refresh" stale line, in local fixtures with fake
// names. No layout, copy or styling changes are proposed here, so
// desktop/mobile screenshot evidence belongs to the builder's PR if
// (and only if) their implementation changes anything rendered.
//
// Hermetic fixture: real SSR EventPage HTML in the fake DOM below,
// every island the page references executed from public/islands, fake
// timers recording each delay, and fetch promises the test settles by
// hand. Same-event and other-event incoming documents are real
// EventPage renders (they carry the page's canonical URL and island
// mounts for their own event key); unrelated documents are hand-made
// HTML carrying no identity for this page's event. Assertions read
// only the rendered roster, surfaced stale copy, issued requests and
// pending timer delays.
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

// ---------- fixture ----------

const EVENT_KEY = "spring-social";
const OTHER_KEY = "winter-social";
const HOST = { id: "member-host", name: "Riley Host" };
const VIEWER = { id: "member-viewer", name: "Vera Viewer" };
const STRANGER = { id: "member-stranger", name: "Wanda Winter" };
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

function renderPage(opts: {
  attendees: readonly Attendee[];
  viewerGoing: boolean;
  member?: boolean;
  signedIn?: boolean;
  eventKey?: string;
  title?: string;
}): string {
  const eventKey = opts.eventKey ?? EVENT_KEY;
  const signedIn = opts.signedIn ?? opts.member ?? true;
  return String(
    EventPage({
      e: {
        ...baseEvent,
        eventKey,
        title: opts.title ?? baseEvent.title,
        goingCount: opts.attendees.length,
        goingOccupancy: opts.attendees.length,
      },
      session: signedIn
        ? {
            id: VIEWER.id,
            username: opts.member === false ? "outsider" : "vera",
            avatar: null,
            member: opts.member ?? true,
            moderator: false,
          }
        : null,
      member: opts.member ?? true,
      answer: opts.viewerGoing ? { status: "going", syncedToDiscordAt: null } : null,
      returnTo: `/e/${eventKey}`,
      neighbors: { previous: null, next: null },
      related: [],
      attendees: [...opts.attendees],
      appUrl: "https://next.example.test",
      jsonLd: "{}",
    }),
  );
}

// An HTTP-200 error/maintenance document: a full page, but nothing in
// it identifies this page's event and it carries no roster section.
const ERROR_DOCUMENT =
  "<!doctype html><html><head><title>Something went wrong</title></head>" +
  "<body><main><h1>Something went wrong</h1>" +
  "<p>Please try again later.</p></main></body></html>";

// An unrelated HTTP-200 document that happens to contain a
// roster-shaped section, but no identity for this page's event.
const UNRELATED_ROSTER_DOCUMENT =
  "<!doctype html><html><head><title>Members</title></head><body><main>" +
  '<section aria-labelledby="event-attendees-heading" data-testid="event-attendees">' +
  '<h2 id="event-attendees-heading">Who\'s going (1)</h2>' +
  '<ul class="event-attendee-grid"><li>' +
  '<span class="event-attendee-mark" aria-hidden="true">M</span>' +
  '<a href="/members/member-intruder">Mallory Intruder</a>' +
  "</li></ul></section></main></body></html>";

interface PendingRequest {
  url: string;
  init: RequestInit;
  resolve: (r: any) => void;
  reject: (e: unknown) => void;
  answered: boolean;
}

function browser(opts: { before: Attendee[]; viewerGoingBefore: boolean; search?: string }) {
  const html = renderPage({ attendees: opts.before, viewerGoing: opts.viewerGoingBefore });
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
    activeElement: null as El | null,
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
      search: opts.search ?? "",
      href: `https://next.example.test/e/${EVENT_KEY}${opts.search ?? ""}`,
      reload: () => {
        reloads++;
      },
    },
    fetch: (url: string, init: RequestInit = {}) =>
      new Promise<any>((resolve, reject) => {
        requests.push({ url: String(url), init, resolve, reject, answered: false });
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
  focusSink = (target) => {
    documentStub.activeElement = target;
    notifyDocument("focusin", target);
  };

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

  const byTestId = (id: string) => page.querySelector(`[data-testid="${id}"]`);

  return {
    page,
    html,
    requests,
    broadcasts,
    byTestId,
    answerWrite,
    settle,
    dispatch: (type: string, detail: unknown) =>
      documentStub.dispatchEvent({ type, detail } as any),
    timers,
    runTimers,
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

// The existing stale/retry copy, read from the rendered roster section.
function staleShown(b: ReturnType<typeof browser>): boolean {
  return /could not refresh/i.test(b.byTestId("event-attendees")?.textContent ?? "");
}

describe("roster refresh admits only authoritative same-event documents", () => {
  const att = (b: ReturnType<typeof browser>) => b.requests.filter((r) => r.url.startsWith("/e/"));
  const writes = (b: ReturnType<typeof browser>) =>
    b.requests.filter((r) => (r.init.method ?? "GET") !== "GET");
  const ok = (html: string) =>
    new Response(html, { status: 200, headers: { "content-type": "text/html" } });
  const sameEvent = (list: Attendee[], going = true) =>
    ok(renderPage({ attendees: list, viewerGoing: going }));
  const otherEvent = (list: Attendee[]) =>
    ok(
      renderPage({
        attendees: list,
        viewerGoing: false,
        eventKey: OTHER_KEY,
        title: "Winter social",
      }),
    );
  const timerDelays = (b: ReturnType<typeof browser>) => b.timers.map((t) => t.delay);

  // Click the viewer's own RSVP control, answer the write, and answer
  // the going-count island's /events.json read so its timers do not
  // pollute the roster island's timer assertions.
  async function start(opts: { search?: string; withdraw?: boolean; before?: Attendee[] } = {}) {
    const b = browser({
      before: opts.before ?? (opts.withdraw ? [HOST, VIEWER] : [HOST]),
      viewerGoingBefore: !!opts.withdraw,
      search: opts.search,
    });
    b.byTestId(opts.withdraw ? "rsvp-withdraw" : "rsvp-going")!.click();
    await b.answerWrite();
    await b.settle();
    const gc = b.requests.find((r) => r.url.includes("/events.json") && !r.answered);
    if (gc) {
      gc.answered = true;
      gc.resolve(
        new Response(
          JSON.stringify([
            { event_key: EVENT_KEY, going_count: opts.withdraw ? 1 : 2, capacity: CAPACITY },
          ]),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
      await b.settle();
    }
    return { b };
  }

  function answer(b: ReturnType<typeof browser>, index: number, response: Response) {
    const req = att(b)[index];
    expect(req, `roster read attempt ${index + 1} must exist`).toBeDefined();
    req!.answered = true;
    req!.resolve(response);
  }

  // Answer attempt `index` with an invalid document, pump the existing
  // retry delay, and answer the retry the same way: the bounded path
  // must then be exhausted (stale shown, exactly two reads).
  async function exhaustWith(b: ReturnType<typeof browser>, makeResponse: () => Response) {
    answer(b, 0, makeResponse());
    await b.settle();
    expect(timerDelays(b), "an unadmitted document must schedule the existing retry").toContain(
      1000,
    );
    b.runTimers(1000);
    await b.settle();
    expect(att(b), "an unadmitted document must be retried exactly once").toHaveLength(2);
    answer(b, 1, makeResponse());
    await b.settle();
    b.runTimers();
    await b.settle();
  }

  // ---------- passing controls: legitimate same-event documents ----------

  it("commits a populated same-event document", async () => {
    const { b } = await start();
    expect(att(b)).toHaveLength(1);
    expect(att(b)[0]!.url).toBe(`/e/${EVENT_KEY}`);
    answer(b, 0, sameEvent([HOST, VIEWER]));
    await b.settle();
    expect(rosterNames(b)).toEqual([HOST.name, VIEWER.name]);
    expect(staleShown(b)).toBe(false);
    expect(att(b)).toHaveLength(1);
    expect(b.reloads()).toBe(0);
  });

  it("inserts the roster on a first RSVP from a populated same-event document", async () => {
    const { b } = await start({ before: [] });
    expect(b.byTestId("event-attendees")).toBeNull();
    expect(b.byTestId("event-roster-empty")).not.toBeNull();
    answer(b, 0, sameEvent([VIEWER]));
    await b.settle();
    expect(rosterNames(b)).toEqual([VIEWER.name]);
    // The swap consumes the empty placeholder: exactly one roster section.
    expect(b.byTestId("event-roster-empty")).toBeNull();
    expect(staleShown(b)).toBe(false);
  });

  it("removes the section for an authoritative empty-roster same-event document", async () => {
    const { b } = await start({ withdraw: true });
    answer(b, 0, sameEvent([], false));
    await b.settle();
    expect(b.byTestId("event-attendees"), "empty same-event roster still prunes").toBeNull();
    // A last withdrawal swaps the list for the honest empty state, not for
    // nothing: the placeholder arrives with the same refresh, no reload.
    expect(b.byTestId("event-roster-empty")).not.toBeNull();
    expect(att(b)).toHaveLength(1);
  });

  it.each([
    [
      "guest",
      "event-roster-guest-nudge",
      /sign in to see who's in/i,
      { attendees: [], viewerGoing: false, member: false, signedIn: false } as const,
    ],
    [
      "non-member",
      "event-roster-members-only",
      /members only/i,
      { attendees: [], viewerGoing: false, member: false, signedIn: true } as const,
    ],
  ])(
    "mounts the authoritative %s shell when the session downgrades before the refresh read",
    async (_label, shellTestid, shellCopy, incoming) => {
      const { b } = await start({ withdraw: true });
      // Focus inside the private roster while the fragment read is in
      // flight: the swap removes that element, so focus must travel into
      // the mounted shell instead of dropping.
      b.byTestId("event-attendees")!.querySelector("a")!.focus();
      answer(b, 0, ok(renderPage(incoming)));
      await b.settle();
      // Private names are still removed...
      expect(b.byTestId("event-attendees"), "same-event audience page still prunes").toBeNull();
      expect(rosterNames(b)).toEqual([]);
      expect(b.page.textContent).not.toContain(HOST.name);
      expect(b.page.textContent).not.toContain(VIEWER.name);
      // ...and the returned audience shell replaces them: exactly one,
      // with its explanation, no stale report and no reload.
      const shells = b.page.querySelectorAll(`[data-testid="${shellTestid}"]`);
      expect(shells, "exactly one audience shell").toHaveLength(1);
      expect(shells[0]!.textContent).toMatch(shellCopy);
      expect(b.page.textContent).not.toMatch(/could not refresh/i);
      expect(att(b)).toHaveLength(1);
      expect(b.reloads()).toBe(0);
      const heading = shells[0]!.querySelector("#event-roster-heading")!;
      expect(heading.focused, "focus restored into the mounted shell").toBe(true);
      expect(heading.getAttribute("tabindex")).toBe("-1");
    },
  );

  it("preserves the attendee-page query on the refresh read", async () => {
    const { b } = await start({ search: "?attendees=2" });
    expect(att(b)[0]!.url).toBe(`/e/${EVENT_KEY}?attendees=2`);
    answer(b, 0, sameEvent([HOST, VIEWER]));
    await b.settle();
    expect(rosterNames(b)).toEqual([HOST.name, VIEWER.name]);
  });

  it("fences a superseded other-event document while the newer valid read commits", async () => {
    const { b } = await start();
    expect(att(b)).toHaveLength(1);
    b.dispatch("going-count-updated", { eventKey: EVENT_KEY, viewerState: "going" });
    await b.settle();
    for (const req of b.requests.filter((r) => r.url.includes("/events.json") && !r.answered)) {
      req.answered = true;
      req.resolve(
        new Response(
          JSON.stringify([{ event_key: EVENT_KEY, going_count: 2, capacity: CAPACITY }]),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    }
    await b.settle();
    expect(att(b), "the newer broadcast must start its own read").toHaveLength(2);

    answer(b, 0, otherEvent([STRANGER]));
    await b.settle();
    expect(rosterNames(b), "superseded document must not mutate the roster").toEqual([HOST.name]);

    answer(b, 1, sameEvent([HOST, VIEWER]));
    await b.settle();
    expect(rosterNames(b)).toEqual([HOST.name, VIEWER.name]);
    expect(staleShown(b)).toBe(false);
  });

  // ---------- RED pins: unadmitted documents keep the last-good roster ----------

  it("keeps the last-good roster when a 200 error document has no roster section", async () => {
    const { b } = await start();
    const sectionBefore = b.byTestId("event-attendees");
    expect(sectionBefore).not.toBeNull();

    await exhaustWith(b, () => ok(ERROR_DOCUMENT));

    expect(rosterNames(b), "an unrelated 200 must not erase last-good attendees").toEqual([
      HOST.name,
    ]);
    expect(
      b.byTestId("event-attendees"),
      "an unadmitted document must not tear down the live section (focus stays put)",
    ).toBe(sectionBefore);
    expect(staleShown(b)).toBe(true);
    expect(att(b)).toHaveLength(2);
    expect(writes(b)).toHaveLength(1);
    expect(b.reloads()).toBe(0);
  });

  it("keeps the last-good roster when an unrelated 200 carries a roster-shaped section", async () => {
    const { b } = await start();
    await exhaustWith(b, () => ok(UNRELATED_ROSTER_DOCUMENT));

    expect(rosterNames(b), "a roster-shaped stranger document must not replace attendees").toEqual([
      HOST.name,
    ]);
    expect(b.page.textContent).not.toContain("Mallory Intruder");
    expect(staleShown(b)).toBe(true);
    expect(att(b)).toHaveLength(2);
    expect(writes(b)).toHaveLength(1);
  });

  it("keeps the last-good roster when another event's populated page answers 200", async () => {
    const { b } = await start();
    await exhaustWith(b, () => otherEvent([STRANGER]));

    expect(rosterNames(b), "another event's roster must not replace this event's").toEqual([
      HOST.name,
    ]);
    expect(b.page.textContent).not.toContain(STRANGER.name);
    expect(staleShown(b)).toBe(true);
    expect(att(b)).toHaveLength(2);
    expect(writes(b)).toHaveLength(1);
  });

  it("keeps the last-good roster when another event's empty page answers 200", async () => {
    const { b } = await start();
    await exhaustWith(b, () => otherEvent([]));

    expect(rosterNames(b), "another event's empty page must not erase attendees").toEqual([
      HOST.name,
    ]);
    expect(b.byTestId("event-attendees")).not.toBeNull();
    expect(staleShown(b)).toBe(true);
    expect(att(b)).toHaveLength(2);
  });

  it("does not insert a roster from an unadmitted document on a first RSVP", async () => {
    const { b } = await start({ before: [] });
    expect(b.byTestId("event-attendees")).toBeNull();

    await exhaustWith(b, () => otherEvent([STRANGER]));

    expect(rosterNames(b), "another event's roster must not appear on this page").toEqual([]);
    expect(b.page.textContent).not.toContain(STRANGER.name);
    expect(att(b)).toHaveLength(2);
    expect(writes(b)).toHaveLength(1);
  });

  it("recovers on the bounded retry when only the first document is unadmitted", async () => {
    const { b } = await start();
    answer(b, 0, ok(ERROR_DOCUMENT));
    await b.settle();
    expect(rosterNames(b)).toEqual([HOST.name]);
    expect(timerDelays(b)).toContain(1000);

    b.runTimers(1000);
    await b.settle();
    expect(att(b)).toHaveLength(2);
    expect(att(b)[1]!.url).toBe(att(b)[0]!.url);

    answer(b, 1, sameEvent([HOST, VIEWER]));
    await b.settle();
    expect(rosterNames(b)).toEqual([HOST.name, VIEWER.name]);
    expect(staleShown(b)).toBe(false);
    expect(att(b)).toHaveLength(2);
    expect(writes(b)).toHaveLength(1);
  });

  it("recovers through the manual retry after unadmitted documents exhaust the bounded path", async () => {
    const { b } = await start();
    await exhaustWith(b, () => otherEvent([STRANGER]));
    expect(rosterNames(b)).toEqual([HOST.name]);
    expect(staleShown(b)).toBe(true);

    const retry = b.byTestId("event-attendees-retry");
    expect(retry, "the stale signal must offer the existing manual retry").not.toBeNull();
    retry!.click();
    await b.settle();
    expect(att(b)).toHaveLength(3);

    answer(b, 2, sameEvent([HOST, VIEWER]));
    await b.settle();
    expect(rosterNames(b)).toEqual([HOST.name, VIEWER.name]);
    expect(staleShown(b), "a recovered refresh clears the stale signal").toBe(false);
    expect(writes(b)).toHaveLength(1);
  });
});

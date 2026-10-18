// Acceptance: every who's-going roster read attempt settles at its own
// five-second deadline and is fenced once it times out or is superseded.
//
// Pins (from the card spec, written blind to any implementation diff):
// - Each read attempt has independent ownership and exactly-once
//   settlement. At the existing five-second deadline the attempt is
//   invalidated and recovery advances whether or not abort causes a
//   rejection; abort stays best effort (missing or throwing
//   AbortController included).
// - At most two reads, the existing retry delay, the same same-origin
//   read URL/headers on every attempt, no polling and no RSVP-write
//   replay. Exhaustion shows the existing stale/retry message.
// - Late headers, bodies and rejections from timed-out or superseded
//   attempts cannot change the roster, clear a newer timer, add
//   retries or clear stale feedback. A newer RSVP broadcast supersedes
//   every old attempt.
// - Successful add/remove, attendee page selection, session-loss
//   privacy and the server-rendered fallback are preserved.
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
// hand. The fake fetch deliberately ignores AbortSignal. Assertions
// read only the rendered roster, surfaced stale copy, issued requests
// and pending timer delays.
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
  resolve: (r: any) => void;
  reject: (e: unknown) => void;
  answered: boolean;
}

function browser(opts: {
  before: Attendee[];
  after: Attendee[];
  viewerGoingBefore: boolean;
  failReads?: boolean;
  abortMode?: string;
  search?: string;
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
    AbortController:
      opts.abortMode === "missing"
        ? undefined
        : opts.abortMode === "throwing"
          ? class {
              constructor() {
                throw new Error("no ac");
              }
            }
          : AbortController,
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

describe("roster read attempts settle at their deadline and stay fenced", () => {
  const LATE = { id: "member-late", name: "Larry Late" };
  const att = (b: ReturnType<typeof browser>) => b.requests.filter((r) => r.url.startsWith("/e/"));
  const writes = (b: ReturnType<typeof browser>) =>
    b.requests.filter((r) => (r.init.method ?? "GET") !== "GET");
  const okHtml = (list: Attendee[], going = true) =>
    new Response(renderPage(list, going), {
      status: 200,
      headers: { "content-type": "text/html" },
    });
  const fail500 = () => new Response("read failed", { status: 500 });
  const timerDelays = (b: ReturnType<typeof browser>) => b.timers.map((t) => t.delay);

  // Click the viewer's own RSVP control, answer the write, and answer
  // the going-count island's /events.json read so its timers do not
  // pollute the roster island's timer assertions.
  async function start(opts: { abortMode?: string; search?: string; withdraw?: boolean } = {}) {
    const b = browser({
      before: opts.withdraw ? [HOST, VIEWER] : [HOST],
      after: opts.withdraw ? [HOST] : [HOST, VIEWER],
      viewerGoingBefore: !!opts.withdraw,
      abortMode: opts.abortMode,
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

  function answer(
    b: ReturnType<typeof browser>,
    index: number,
    response: Response | Record<string, unknown>,
  ) {
    const req = att(b)[index];
    expect(req, `roster read attempt ${index + 1} must exist`).toBeDefined();
    req!.answered = true;
    req!.resolve(response as Response);
  }

  // ---------- passing controls: existing behavior to preserve ----------

  it("applies a first-attempt success with the existing same-origin read shape, one read, one write", async () => {
    const { b } = await start();
    expect(att(b)).toHaveLength(1);
    expect(att(b)[0]!.url).toBe(`/e/${EVENT_KEY}`);
    expect(att(b)[0]!.init.method ?? "GET").toBe("GET");
    const headers = att(b)[0]!.init.headers as Record<string, string>;
    expect(headers.accept).toContain("text/html");
    expect(headers["x-two-island"]).toBe("attendees-live");
    expect(timerDelays(b)).toContain(5000);

    answer(b, 0, okHtml([HOST, VIEWER]));
    await b.settle();
    b.runTimers();
    await b.settle();

    expect(rosterNames(b)).toEqual([HOST.name, VIEWER.name]);
    expect(att(b)).toHaveLength(1);
    expect(writes(b)).toHaveLength(1);
    expect(staleShown(b)).toBe(false);
    expect(b.reloads()).toBe(0);
  });

  it("removes the viewer after withdrawal when the read succeeds", async () => {
    const { b } = await start({ withdraw: true });
    answer(b, 0, okHtml([HOST], false));
    await b.settle();
    expect(rosterNames(b)).toEqual([HOST.name]);
    expect(writes(b)).toHaveLength(1);
    expect(writes(b)[0]!.init.method).toBe("DELETE");
  });

  it("retries once after the existing delay with identical read shape, then applies the retry success", async () => {
    const { b } = await start();
    answer(b, 0, fail500());
    await b.settle();
    expect(att(b)).toHaveLength(1);
    expect(timerDelays(b)).toContain(1000);

    b.runTimers(1000);
    await b.settle();
    expect(att(b)).toHaveLength(2);
    expect(att(b)[1]!.url).toBe(att(b)[0]!.url);
    expect(att(b)[1]!.init.headers).toEqual(att(b)[0]!.init.headers);

    answer(b, 1, okHtml([HOST, VIEWER]));
    await b.settle();
    b.runTimers();
    await b.settle();
    expect(rosterNames(b)).toEqual([HOST.name, VIEWER.name]);
    expect(att(b)).toHaveLength(2);
    expect(writes(b)).toHaveLength(1);
    expect(staleShown(b)).toBe(false);
  });

  it("shows the existing stale message after exactly two failed reads and never polls or replays the write", async () => {
    const { b } = await start();
    answer(b, 0, fail500());
    await b.settle();
    b.runTimers(1000);
    await b.settle();
    answer(b, 1, fail500());
    await b.settle();
    b.runTimers();
    await b.settle();
    b.runTimers();
    await b.settle();

    expect(att(b)).toHaveLength(2);
    expect(writes(b)).toHaveLength(1);
    expect(rosterNames(b)).toEqual([HOST.name]);
    expect(staleShown(b)).toBe(true);
    expect(b.byTestId("event-attendees")?.textContent).toContain("could not refresh");
  });

  it("preserves the attendee page selection on every attempt", async () => {
    const { b } = await start({ search: "?attendees=2" });
    expect(att(b)[0]!.url).toBe(`/e/${EVENT_KEY}?attendees=2`);
    answer(b, 0, fail500());
    await b.settle();
    b.runTimers(1000);
    await b.settle();
    expect(att(b)[1]!.url).toBe(`/e/${EVENT_KEY}?attendees=2`);
    answer(b, 1, okHtml([HOST, VIEWER]));
    await b.settle();
    expect(rosterNames(b)).toEqual([HOST.name, VIEWER.name]);
  });

  it("never applies a session-loss response body as roster data", async () => {
    const { b } = await start();
    const denied = () =>
      new Response(renderPage([HOST, LATE], true), {
        status: 401,
        headers: { "content-type": "text/html" },
      });
    answer(b, 0, denied());
    await b.settle();
    b.runTimers(1000);
    await b.settle();
    answer(b, 1, denied());
    await b.settle();
    expect(rosterNames(b)).toEqual([HOST.name]);
    expect(staleShown(b)).toBe(true);
  });

  it("still refreshes normally when AbortController is unavailable", async () => {
    const { b } = await start({ abortMode: "missing" });
    expect(att(b)).toHaveLength(1);
    answer(b, 0, okHtml([HOST, VIEWER]));
    await b.settle();
    expect(rosterNames(b)).toEqual([HOST.name, VIEWER.name]);
  });

  // ---------- RED pins: deadline settlement and per-attempt fencing ----------

  it("advances to the retry at five seconds even when the transport ignores abort", async () => {
    const { b } = await start();
    expect(att(b)).toHaveLength(1);
    // Nothing settles the fetch; the fake transport ignores abort.
    b.runTimers(5000);
    await b.settle();
    expect(timerDelays(b), "deadline must schedule the existing retry delay").toContain(1000);
    b.runTimers(1000);
    await b.settle();
    expect(att(b), "a second read attempt must be issued").toHaveLength(2);

    b.runTimers(5000);
    await b.settle();
    b.runTimers();
    await b.settle();
    expect(att(b)).toHaveLength(2);
    expect(rosterNames(b)).toEqual([HOST.name]);
    expect(staleShown(b)).toBe(true);
  });

  it("fences a late success from a timed-out attempt while the retry is pending", async () => {
    const { b } = await start({ abortMode: "missing" });
    b.runTimers(5000);
    await b.settle();
    b.runTimers(1000);
    await b.settle();
    expect(att(b)).toHaveLength(2);
    expect(timerDelays(b)).toContain(5000);

    answer(b, 0, okHtml([HOST, LATE]));
    await b.settle();
    expect(rosterNames(b), "timed-out attempt must not mutate the roster").toEqual([HOST.name]);
    expect(timerDelays(b), "timed-out attempt must not clear the newer deadline").toContain(5000);
    expect(att(b)).toHaveLength(2);

    answer(b, 1, okHtml([HOST, VIEWER]));
    await b.settle();
    expect(rosterNames(b)).toEqual([HOST.name, VIEWER.name]);
  });

  it("fences a late rejection from a timed-out attempt: no extra retry, no premature stale", async () => {
    const { b } = await start({ abortMode: "missing" });
    b.runTimers(5000);
    await b.settle();
    b.runTimers(1000);
    await b.settle();
    expect(att(b)).toHaveLength(2);

    att(b)[0]!.answered = true;
    att(b)[0]!.reject(new Error("late transport failure"));
    await b.settle();
    expect(att(b)).toHaveLength(2);
    expect(timerDelays(b)).not.toContain(1000);
    expect(timerDelays(b)).toContain(5000);
    expect(rosterNames(b)).toEqual([HOST.name]);
    expect(staleShown(b)).toBe(false);

    answer(b, 1, okHtml([HOST, VIEWER]));
    await b.settle();
    expect(rosterNames(b)).toEqual([HOST.name, VIEWER.name]);
    expect(staleShown(b)).toBe(false);
  });

  it("settles at the deadline while the response body is still pending, and fences the late body", async () => {
    const { b } = await start();
    let resolveBody: (html: string) => void = () => {};
    const body = new Promise<string>((resolve) => {
      resolveBody = resolve;
    });
    const fake = {
      ok: true,
      status: 200,
      statusText: "OK",
      headers: {
        get: (name: string) => (name.toLowerCase() === "content-type" ? "text/html" : null),
        has: (name: string) => name.toLowerCase() === "content-type",
      },
      text: () => body,
      json: async () => ({}),
      clone() {
        return this;
      },
    };
    answer(b, 0, fake);
    await b.settle();
    expect(rosterNames(b)).toEqual([HOST.name]);

    b.runTimers(5000);
    await b.settle();
    expect(timerDelays(b), "a pending body must not hang recovery past the deadline").toContain(
      1000,
    );
    b.runTimers(1000);
    await b.settle();
    expect(att(b)).toHaveLength(2);

    resolveBody(renderPage([HOST, LATE], true));
    await b.settle();
    expect(rosterNames(b), "late body must not mutate the roster").toEqual([HOST.name]);
    expect(timerDelays(b)).toContain(5000);

    answer(b, 1, okHtml([HOST, VIEWER]));
    await b.settle();
    expect(rosterNames(b)).toEqual([HOST.name, VIEWER.name]);
  });

  it("still issues and settles reads when AbortController construction throws", async () => {
    const { b } = await start({ abortMode: "throwing" });
    expect(att(b), "a throwing AbortController must not suppress the read").toHaveLength(1);
    answer(b, 0, okHtml([HOST, VIEWER]));
    await b.settle();
    expect(rosterNames(b)).toEqual([HOST.name, VIEWER.name]);
  });

  it("keeps exhausted stale feedback when timed-out attempts complete late", async () => {
    const { b } = await start({ abortMode: "missing" });
    b.runTimers(5000);
    await b.settle();
    b.runTimers(1000);
    await b.settle();
    expect(att(b)).toHaveLength(2);
    b.runTimers(5000);
    await b.settle();
    expect(staleShown(b)).toBe(true);

    answer(b, 0, okHtml([HOST, LATE]));
    answer(b, 1, okHtml([HOST, VIEWER]));
    await b.settle();
    b.runTimers();
    await b.settle();
    expect(rosterNames(b), "late completions must not resurrect a settled refresh").toEqual([
      HOST.name,
    ]);
    expect(staleShown(b)).toBe(true);
    expect(att(b)).toHaveLength(2);
  });

  it("fences a late body rejection after the deadline: retry still runs, no premature stale", async () => {
    const { b } = await start();
    let rejectBody: (e: unknown) => void = () => {};
    const body = new Promise<string>((_resolve, reject) => {
      rejectBody = reject;
    });
    const fake = {
      ok: true,
      status: 200,
      statusText: "OK",
      headers: {
        get: (name: string) => (name.toLowerCase() === "content-type" ? "text/html" : null),
        has: (name: string) => name.toLowerCase() === "content-type",
      },
      text: () => body,
      json: async () => ({}),
      clone() {
        return this;
      },
    };
    answer(b, 0, fake);
    await b.settle();
    b.runTimers(5000);
    await b.settle();
    expect(timerDelays(b), "deadline must schedule the existing retry delay").toContain(1000);
    const abort = new Error("aborted");
    abort.name = "AbortError";
    rejectBody(abort);
    await b.settle();
    expect(staleShown(b), "late body rejection must not surface stale early").toBe(false);
    expect(att(b)).toHaveLength(1);
    b.runTimers(1000);
    await b.settle();
    expect(att(b), "the retry must still run after a late body rejection").toHaveLength(2);
    answer(b, 1, okHtml([HOST, VIEWER]));
    await b.settle();
    expect(rosterNames(b)).toEqual([HOST.name, VIEWER.name]);
    expect(staleShown(b)).toBe(false);
  });

  it("fences late headers from a timed-out attempt while the retry is pending", async () => {
    const { b } = await start({ abortMode: "missing" });
    b.runTimers(5000);
    await b.settle();
    b.runTimers(1000);
    await b.settle();
    expect(att(b)).toHaveLength(2);
    answer(b, 0, fail500());
    await b.settle();
    expect(staleShown(b), "late 500 must not surface stale while the retry is pending").toBe(false);
    expect(timerDelays(b), "late 500 must not clear the newer deadline").toContain(5000);
    expect(att(b)).toHaveLength(2);
    answer(b, 1, okHtml([HOST, VIEWER]));
    await b.settle();
    expect(rosterNames(b)).toEqual([HOST.name, VIEWER.name]);
    expect(staleShown(b)).toBe(false);
  });

  it("fences attempts superseded by a newer RSVP broadcast", async () => {
    const { b } = await start();
    expect(att(b)).toHaveLength(1);
    b.dispatch("going-count-updated", { eventKey: EVENT_KEY, viewerState: "going" });
    await b.settle();
    // Answer any extra going-count read the second broadcast caused so
    // only roster timers remain under assertion below.
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

    answer(b, 0, okHtml([HOST, LATE]));
    await b.settle();
    expect(rosterNames(b), "superseded attempt must not mutate the roster").toEqual([HOST.name]);

    answer(b, 1, okHtml([HOST, VIEWER]));
    await b.settle();
    expect(rosterNames(b)).toEqual([HOST.name, VIEWER.name]);
  });
});

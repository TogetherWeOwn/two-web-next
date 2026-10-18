// route-inventory: GET /e/:key
// Acceptance: the SvelteKit event detail must mount the existing
// attendees-live island exactly as the Hono page does
// (src/events/pages-detail.tsx): the who's-going section carries
// data-island="attendees-live" and the page emits one deferred
// /islands/attendees-live.js script tag, unconditionally (the Hono tag
// sits outside the roster conditional, so a first RSVP on an empty
// roster can still create the section). Zero island-logic changes are
// required: the shipped island already refreshes the roster from the
// non-rotating fragment read on the going-count-updated broadcast and
// surfaces a stale/retry signal when that read fails.
//
// Hermetic fixture contract (no browser, network or database):
// - The real Kit EventDetail presentation is SSR-compiled with the web
//   workspace's svelte/compiler (same bundle shape as
//   kit-event-detail.test.ts) from a model resolved through
//   resolveKitEventDetail with in-memory store fakes.
// - For the live-refresh pins the rendered HTML is parsed into the fake
//   DOM below and every island script the page itself references is
//   executed from public/islands, in page order (same harness as
//   event-attendees-live-refresh.test.ts, driven by Kit HTML instead
//   of Hono HTML). The member's own RSVP is driven by clicking the
//   shipped controls; writes are answered with the existing success
//   contract and every later read from one post-write server truth:
//   /events.json returns the aggregate row, JSON reads return the
//   attendee list, and any other GET returns the Kit page re-rendered
//   with the post-write roster. In the failure case every read is 500
//   and timers are pumped so bounded retries can run.
// - Assertions read only the rendered DOM / HTML: the mount attribute,
//   script tags, roster names, heading + badge counts, reload count,
//   the fragment request header, and a newly surfaced stale signal.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL, URL as NodeURL } from "node:url";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";
import type { Db } from "../src/db/index";
import { events } from "../src/db/admin-schema";
import type { Env } from "../src/env";
import type { KitRequestSession } from "../src/kit-session";
import { resolveKitEventDetail, type KitEventDetailStore } from "../src/events/kit-detail";
import type { EventAttendee, PublicEvent, ViewerRsvp } from "../src/events/reads";

// ---------- Kit model + SSR render (from kit-event-detail.test.ts) ----------

const APP_URL = "https://next.example.test";
const KEY = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const MEMBER_ID = "100000000000000001";
const HOST: EventAttendee = { id: "100000000000000003", name: "Riley Host" };
const VIEWER: EventAttendee = { id: MEMBER_ID, name: "Vera Viewer" };
const CAPACITY = 10;

function row(over: Partial<typeof events.$inferSelect> = {}): typeof events.$inferSelect {
  const start = new Date("2030-01-10T20:00:00Z");
  return {
    id: 7,
    icsSequence: 4n,
    eventKey: KEY,
    title: "Chess night",
    game: "Chess",
    description: "Bring a friend & a board.",
    startsAt: start,
    endsAt: new Date("2030-01-10T22:00:00Z"),
    timezone: "UTC",
    location: "The lobby",
    capacity: CAPACITY,
    status: "published",
    rsvpOpen: true,
    discordEventId: null,
    discordSyncFailedAt: null,
    discordSyncFailureCode: null,
    syncRevision: 1,
    syncedRevision: 0,
    agentGrantId: null,
    proofMarker: null,
    agentVersion: 1,
    createdBy: null,
    recurrenceFrequency: null,
    recurrenceCount: null,
    recurrenceEndsOn: null,
    parentEventId: null,
    recurrenceIndex: null,
    createdAt: start,
    updatedAt: start,
    ...over,
  };
}

const GUEST: KitRequestSession = { status: "guest", session: null };
const MEMBER: KitRequestSession = {
  status: "authenticated",
  session: { userId: MEMBER_ID, username: "vera", avatar: null, member: true, moderator: false },
};

const env = { APP_URL } as unknown as Env;

function fakeStore(opts: {
  attendees: EventAttendee[];
  answer: ViewerRsvp | null;
  eventOver?: Partial<typeof events.$inferSelect>;
}): KitEventDetailStore {
  const event = { ...row(opts.eventOver), goingCount: opts.attendees.length } as PublicEvent;
  return {
    dbForFn: async () => ({}) as Db,
    getEventFn: async () => event,
    neighborsFn: async () => ({ previous: null, next: null }),
    relatedFn: async () => [],
    attendeesFn: async () => opts.attendees,
    viewerRsvpFn: async () => opts.answer,
    waitlistFn: async () => null,
    suggestionsFn: async () => [],
  };
}

const webRequire = createRequire(new NodeURL("../web/package.json", import.meta.url));
const { compile } = webRequire("svelte/compiler") as {
  compile: (
    source: string,
    options: { generate: string; dev: boolean; filename: string },
  ) => { js: { code: string } };
};

interface KitBundle {
  renderDetail: (model: Record<string, unknown>) => string;
  renderGone: (model: Record<string, unknown>) => string;
}

let bundlePromise: Promise<KitBundle> | undefined;
function kitBundle(): Promise<KitBundle> {
  bundlePromise ??= buildBundle();
  return bundlePromise;
}

async function buildBundle(): Promise<KitBundle> {
  const worktree = fileURLToPath(new NodeURL("../", import.meta.url));
  const scratch = mkdtempSync(join(tmpdir(), "kit-attendees-live-"));
  try {
    const entry = join(scratch, "entry.mjs");
    writeFileSync(
      entry,
      `
import { render } from "svelte/server";
import Detail from ${JSON.stringify(join(worktree, "web/src/lib/EventDetail.svelte"))};
import Gone from ${JSON.stringify(join(worktree, "web/src/lib/EventGone.svelte"))};
export function renderDetail(model) {
  const { head, body } = render(Detail, { props: { model } });
  return "<head>" + head + "</head><body>" + body + "</body>";
}
export function renderGone(model) {
  const { head, body } = render(Gone, { props: { model } });
  return "<head>" + head + "</head><body>" + body + "</body>";
}
`,
    );
    const outfile = join(scratch, "bundle.mjs");
    await build({
      entryPoints: [entry],
      bundle: true,
      platform: "node",
      format: "esm",
      outfile,
      logLevel: "warning",
      absWorkingDir: worktree,
      nodePaths: [join(worktree, "web/node_modules"), join(worktree, "node_modules")],
      alias: { "#lib": fileURLToPath(new NodeURL("../web/src/lib/", import.meta.url)) },
      plugins: [
        {
          name: "kit-attendees-live-svelte-ssr",
          setup(plugin) {
            plugin.onLoad({ filter: /\.svelte$/ }, (args) => {
              const source = readFileSync(args.path, "utf8");
              const { js } = compile(source, {
                generate: "server",
                dev: false,
                filename: args.path,
              });
              return { contents: js.code, loader: "js", resolveDir: dirname(args.path) };
            });
          },
        },
      ],
    });
    return (await import(pathToFileURL(outfile).href)) as KitBundle;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

async function kitHtml(opts: {
  attendees: EventAttendee[];
  answer?: ViewerRsvp | null;
  session?: KitRequestSession;
  search?: string;
  eventOver?: Partial<typeof events.$inferSelect>;
}): Promise<string> {
  const outcome = await resolveKitEventDetail({
    key: KEY,
    search: opts.search ?? "",
    path: `/e/${KEY}`,
    env,
    session: opts.session ?? MEMBER,
    joinResult: null,
    setHeaders: () => {},
    store: fakeStore({
      attendees: opts.attendees,
      answer: opts.answer ?? null,
      eventOver: opts.eventOver,
    }),
  });
  const bundle = await kitBundle();
  if (outcome.kind === "ok")
    return bundle.renderDetail(outcome.model as unknown as Record<string, unknown>);
  if (outcome.kind === "gone")
    return bundle.renderGone(outcome.model as unknown as Record<string, unknown>);
  throw new Error(`unexpected outcome ${outcome.kind}`);
}

const goingAnswer: ViewerRsvp = { status: "going", syncedToDiscordAt: null };

// ---------- fake DOM (from event-attendees-live-refresh.test.ts) ----------

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
      .replace(/&apos;/g, "'")
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

// ---------- browser fixture over Kit HTML ----------

interface PendingRequest {
  url: string;
  init: RequestInit;
  resolve: (r: Response) => void;
  answered: boolean;
}

async function browser(opts: {
  before: EventAttendee[];
  after: EventAttendee[];
  viewerGoingBefore: boolean;
  failReads?: boolean;
}) {
  const html = await kitHtml({
    attendees: opts.before,
    answer: opts.viewerGoingBefore ? goingAnswer : null,
  });
  const afterHtml = await kitHtml({
    attendees: opts.after,
    answer: opts.viewerGoingBefore ? null : goingAnswer,
  });
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
      pathname: `/e/${KEY}`,
      search: "",
      href: `https://next.example.test/e/${KEY}`,
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
        JSON.stringify([{ event_key: KEY, going_count: opts.after.length, capacity: CAPACITY }]),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    const accept = String((req.init.headers as Record<string, string> | undefined)?.accept ?? "");
    if (accept.includes("application/json"))
      return new Response(
        JSON.stringify({
          data: { attendees: opts.after, going_count: opts.after.length, capacity: CAPACITY },
          attendees: opts.after,
          going_count: opts.after.length,
          capacity: CAPACITY,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    return new Response(afterHtml, {
      status: 200,
      headers: { "content-type": "text/html" },
    });
  };

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

type Browser = Awaited<ReturnType<typeof browser>>;

function rosterNames(b: Browser): string[] {
  const section = b.byTestId("event-attendees");
  if (!section) return [];
  return section
    .querySelectorAll("a")
    .filter((a) => (a.getAttribute("href") ?? "").startsWith("/members/"))
    .map((a) => a.textContent.trim());
}

function rosterHeadingCount(b: Browser): number | null {
  const section = b.byTestId("event-attendees");
  if (!section) return null;
  const m = /Who(?:'|’)s going \((\d+)\)/.exec(section.textContent);
  return m ? Number(m[1]) : null;
}

function badgeCount(b: Browser): number | null {
  const badge = b.page.querySelector('[data-island="going-count"]');
  const text = badge?.querySelector("[data-count]")?.textContent ?? "";
  const m = /^(\d+)/.exec(text.trim());
  return m ? Number(m[1]) : null;
}

function expectRosterBadgeAgreement(b: Browser, expected: number) {
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

function snapshotPage(b: Browser): Map<El, NodeSnap> {
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
// "shown at page load. Refresh attendees." line does not count.
function hasSurfacedStaleSignal(b: Browser, before: Map<El, NodeSnap>): boolean {
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

// ---------- static mount pins ----------

const MOUNT = 'data-island="attendees-live"';
const SCRIPT_SRC = "/islands/attendees-live.js";

function islandScriptTags(html: string): string[] {
  return [...html.matchAll(/<script\b[^>]*>/gi)]
    .map((m) => m[0])
    .filter((tag) => tag.includes(`src="${SCRIPT_SRC}"`));
}

function attendeesSectionTag(html: string): string | null {
  const tags = [...html.matchAll(/<section\b[^>]*>/g)].map((m) => m[0]);
  return tags.find((tag) => tag.includes('data-testid="event-attendees"')) ?? null;
}

describe("Kit event detail attendees-live mount", () => {
  it("mounts attendees-live on the roster section and emits one deferred script tag", async () => {
    const html = await kitHtml({ attendees: [HOST] });
    const section = attendeesSectionTag(html);
    expect(section, "roster section").not.toBeNull();
    expect(section).toContain(MOUNT);
    expect(html.split(MOUNT)).toHaveLength(2);
    const scripts = islandScriptTags(html);
    expect(scripts).toHaveLength(1);
    expect(scripts[0]).toContain("defer");
  });

  it("keeps the neighbouring islands exactly once each", async () => {
    const html = await kitHtml({ attendees: [HOST] });
    for (const src of [
      "/islands/rsvp-button.js",
      "/islands/copy-link.js",
      "/islands/going-count.js",
    ])
      expect(html.split(`src="${src}"`), src).toHaveLength(2);
  });

  it("emits no mount and no roster section for a guest with no disclosed roster", async () => {
    const html = await kitHtml({ attendees: [HOST], session: GUEST });
    expect(html).not.toContain('data-testid="event-attendees"');
    expect(html).not.toContain(MOUNT);
  });

  it("emits the script but no mount when a member roster is empty on page one", async () => {
    // Hono parity: the script tag is unconditional so the member's
    // first RSVP can create the section live; the mount exists only
    // on a rendered section.
    const html = await kitHtml({ attendees: [] });
    expect(html).not.toContain('data-testid="event-attendees"');
    expect(html).not.toContain(MOUNT);
    expect(islandScriptTags(html)).toHaveLength(1);
  });

  it("mounts the section rendered for a member past page one of the roster", async () => {
    const html = await kitHtml({ attendees: [], search: "?attendees=2" });
    const section = attendeesSectionTag(html);
    expect(section, "roster section on page two").not.toBeNull();
    expect(section).toContain(MOUNT);
    expect(islandScriptTags(html)).toHaveLength(1);
  });

  it("emits no mount or script on the cancelled-event page", async () => {
    const html = await kitHtml({
      attendees: [HOST],
      eventOver: { status: "cancelled" },
    });
    expect(html).not.toContain('data-testid="event-attendees"');
    expect(html).not.toContain(MOUNT);
    expect(html).not.toContain(SCRIPT_SRC);
  });
});

// ---------- live-refresh pins over Kit HTML ----------

describe("Kit who's-going roster live refresh", () => {
  it("adds the member to the roster after their own going RSVP, badge and roster in agreement, no reload", async () => {
    const b = await browser({
      before: [HOST],
      after: [HOST, VIEWER],
      viewerGoingBefore: false,
    });
    expectRosterBadgeAgreement(b, 1);
    expect(rosterNames(b)).not.toContain(VIEWER.name);

    b.byTestId("rsvp-going")!.click();
    const write = await b.answerWrite();
    expect(write.init.method).toBe("PUT");
    expect(write.url).toBe(`/events/${KEY}/rsvp`);
    await b.answerReads();

    expect(b.reloads()).toBe(0);
    expect(rosterNames(b)).toContain(VIEWER.name);
    expect(rosterNames(b)).toContain(HOST.name);
    expectRosterBadgeAgreement(b, 2);
    // The refresh goes through the non-rotating fragment read.
    const fragment = b.requests.find(
      (r) => r.url === `/e/${KEY}` || r.url.startsWith(`/e/${KEY}?`),
    );
    expect(fragment, "fragment refresh request").toBeDefined();
    expect((fragment!.init.headers as Record<string, string>)["x-two-island"]).toBe(
      "attendees-live",
    );
  });

  it("removes the member from the roster after withdrawal, badge and roster in agreement, no reload", async () => {
    const b = await browser({
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

  it("creates the roster after the first going RSVP on an empty roster", async () => {
    const b = await browser({
      before: [],
      after: [VIEWER],
      viewerGoingBefore: false,
    });
    expect(b.byTestId("event-attendees")).toBeNull();
    expect(badgeCount(b)).toBe(0);

    b.byTestId("rsvp-going")!.click();
    await b.answerWrite();
    await b.answerReads();

    expect(b.reloads()).toBe(0);
    expect(rosterNames(b)).toEqual([VIEWER.name]);
    expectRosterBadgeAgreement(b, 1);
  });

  it("surfaces a stale signal instead of a silent contradiction when the refresh read fails", async () => {
    const b = await browser({
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
    if (badgeCount(b) === 2) expect(rosterNames(b)).toHaveLength(2);
    else expect(badgeCount(b)).toBe(1);
    expect(
      hasSurfacedStaleSignal(b, before),
      "a failed refresh must surface a visible stale/retry signal",
    ).toBe(true);
  });
});

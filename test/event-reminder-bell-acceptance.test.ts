// route-inventory: GET /notifications
// route-inventory: GET /api/notifications
// route-inventory: POST /api/notifications/:id/read
//
// Acceptance contract: event-reminder notification bell + list UI.
//
// This is slice 4 of the event-reminders design spec (close the
// RSVP-to-show-up gap with automatic T-24h/T-1h nudges to members who RSVP
// going/maybe). Tests-first: this file DEFINES the slice-4 contract and the
// Builder implements until it is green. The Builder must never edit this file;
// a wrong pin goes back to the test owner for correction.
//
// What this pins (must hold):
// - Routes, all session-authed with the user id taken from the session only:
//   GET /notifications renders the HTML list page (guests bounce 302 to
//   /auth/discord, the member-page convention); GET /api/notifications answers
//   200 { notifications, unreadCount, subscriptionUrl } (401
//   { error: "unauthenticated" } without a session); POST
//   /api/notifications/:id/read answers 200 { id, readAt }, is idempotent, and
//   answers 404 { error: "not_found" } for unknown AND foreign ids alike (no
//   existence oracle), ignoring any user id in the request body.
// - List payload shape per item: { id, kind ("event_reminder"), title, body,
//   url (event page path), startsAt (ISO instant), readAt (ISO or null),
//   createdAt (ISO) }. Extra fields are allowed; missing pinned fields fail.
// - subscriptionUrl is the EXISTING events ICS feed, APP_URL + "/events.ics"
//   (trailing-slash safe): notifications reuse the feed, never a new export.
// - The site header bell: an authenticated SiteHeader renders
//   a[data-testid="notifications-bell"][href="/notifications"] whose accessible
//   name contains "Notifications", with an empty hidden
//   span[data-testid="notifications-unread-count"] inside. The SSR chrome
//   carries no count (shared chrome never reads account persistence); the
//   island paints it. Guest chrome renders no bell and no count (control).
// - The list page renders one [data-testid="notification-item"] per row with
//   the title, an anchor to the row url, a <time datetime=ISO> event-local
//   time, a [data-testid="notifications-countdown"] phrase matching
//   /in N minutes|hours/ (the spec's "in 24 hours" shape), a per-item
//   button[data-testid="notifications-mark-read"][data-notification-id], the
//   subscription anchor, and [data-testid="notifications-empty"] when empty.
// - The shipped island binder: reviewed source
//   assets/islands/notifications-bell.js, deterministic minified output
//   public/islands/notifications-bell.js (via `npm run build:assets`), and a
//   fitting ci/bundle-budget.json entry for the public asset. Executed without
//   a browser, the binder GETs /api/notifications once (no polling), paints
//   the badge, wires mark-read controls to POST the pinned read route, sets
//   aria-busy on the mount while fetching, and surfaces
//   [data-testid="notifications-error"] on transport failure.
// - Auth scoping: a member's list/read sees own rows only.
//
// Builder's choices (NOT pinned here): exact copy (the owner wordsmiths it,
// see below), badge placement and styling, list ordering, dropdown vs page
// emphasis (the page is the required surface; a dropdown preview is an
// optional upgrade reusing the same testids), the id column type (tests treat
// ids opaquely), and the server DB access path (ADMIN_DB or request client).
//
// Slice boundaries: DB tests seed the spec's notifications table
// (user_id, kind, event_id, title, body, url, read_at, created_at) directly,
// so they need the data-model slice's migration but NOT the sweep: re-sweep
// idempotency and skip statuses belong to the sweep slice's file. Event time
// and links resolve from the joined events row (single source of truth).
//
// RED on base: the route pins 404 (page route may instead hit a catch-all,
// still not the pinned status), the bell markup is absent, the binder files
// and budget entry are missing, and the DB seeds fail with "relation
// notifications does not exist". Every failure names the missing feature.
//
// Wordsmith boundary: the countdown pin is the SHAPE /in N minutes|hours/,
// not exact copy. If the owner picks phrasing outside that shape, the test
// owner updates the pin; the Builder never edits this file to match.
//
// NOT in this file (Builder-run gates with human eyes): author-opened
// before/after screenshots at 1280x800 and 390x844, `npm run a11y`,
// `npm run lighthouse` (+ quality), the visual specs, and `npm run budget`
// (which already fails an unbudgeted island without any new test).
import { existsSync, readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { URL as NodeURL } from "node:url";
import { runInNewContext, Script } from "node:vm";
import { randomUUID } from "node:crypto";
import { serializeSigned } from "hono/utils/cookie";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import app from "./app";
import { events } from "../src/db/admin-schema";
import type { Env } from "../src/env";
import { SiteHeader } from "../src/page-shell";
import { SESSION_COOKIE } from "../src/session-cookie";
import {
  createMemorySessionStore,
  hashToken,
  newSessionToken,
  type SessionStore,
} from "../src/sessions";
import {
  createMemberDataFixture,
  testDatabaseUrl,
  type MemberDataFixture,
} from "./helpers/member-data-db";

// Keep the tracked producer real; only its native pools are pinned to the test
// schema (same harness as the RSVP suites: the slice-4 routes may read through
// ADMIN_DB or a request client, and both must land in the fixture schema).
vi.mock("postgres", async () => {
  const actual = await vi.importActual<{ default: typeof postgres }>("postgres");
  return { ...actual, default: vi.fn(actual.default) };
});

const APP_URL = "https://next.example.test";
const SESSION_SECRET = "test-session-secret-at-least-32-bytes-long";
const FEED_URL = `${APP_URL}/events.ics`;

const LIST_PATH = "/api/notifications";
const PAGE_PATH = "/notifications";
const readPath = (id: string) => `/api/notifications/${encodeURIComponent(id)}/read`;

const BELL = "notifications-bell";
const BADGE = "notifications-unread-count";
const LIST = "notifications-list";
const ITEM = "notification-item";
const MARK_READ = "notifications-mark-read";
const EMPTY = "notifications-empty";
const ERROR = "notifications-error";
const SUBSCRIPTION = "notifications-subscription";
const COUNTDOWN = "notifications-countdown";
const ISLAND = "notifications-bell";

const COUNTDOWN_SHAPE = /in \d+ (minutes?|hours?)/i;

const baseEnv = {
  APP_URL,
  DISCORD_CLIENT_ID: "client-id",
  DISCORD_CLIENT_SECRET: "client-secret",
  DISCORD_GUILD_ID: "326474832151838730",
  DISCORD_INVITE_URL: "https://discord.gg/invite",
  DISCORD_BOT_TOKEN: "bot-token",
  SESSION_SECRET,
};

async function cookieFor(store: SessionStore, userId: string, username: string): Promise<string> {
  const token = newSessionToken();
  await store.create({
    tokenHash: await hashToken(token),
    userId,
    username,
    avatar: null,
    member: true,
    moderator: false,
    expiresAt: new Date(Date.now() + 3600_000),
  });
  const signed = await serializeSigned(SESSION_COOKIE, token, SESSION_SECRET, {
    path: "/",
    secure: true,
    httpOnly: true,
    sameSite: "Lax",
  });
  return signed.split(";")[0]!;
}

describe("reminder bell routes exist (hermetic, no DB)", () => {
  const store = createMemorySessionStore();
  const env = { ...baseEnv, SESSION_STORE: store } as unknown as Env;

  it("GET /api/notifications without a session is 401, not 404", async () => {
    const res = await app.request(LIST_PATH, {}, env);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthenticated" });
  });

  it("POST /api/notifications/:id/read without a session is 401, not 404", async () => {
    // Same-origin header: the global guard 403s unsafe verbs before routing,
    // so the pin carries the page's Origin to reach the route's session check.
    const res = await app.request(
      readPath("1"),
      { method: "POST", headers: { origin: APP_URL } },
      env,
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthenticated" });
  });

  it("GET /notifications as a guest bounces to sign-in, not 404", async () => {
    const res = await app.request(PAGE_PATH, {}, env);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toMatch(/^\/auth\/discord/);
  });
});

describe("header bell SSR (hermetic, no DB)", () => {
  const session = {
    id: "10000000000000101",
    username: "rem",
    avatar: null,
    member: true,
    moderator: false,
  };

  it("authenticated chrome renders the bell mount linking to the list page", () => {
    const html = String(SiteHeader({ session }));
    expect(html).toContain(`data-testid="${BELL}"`);
    expect(html).toContain(`href="${PAGE_PATH}"`);
    // Accessible name carries the inbox; the count arrives via the island.
    expect(html).toMatch(/aria-label="[^"]*Notifications[^"]*"/);
    // Badge mount only: shared chrome never reads account persistence, so the
    // SSR pass paints no digits.
    expect(html).toContain(`data-testid="${BADGE}"`);
    const badge = html.match(new RegExp(`<span[^>]*data-testid="${BADGE}"[^>]*>(.*?)</span>`));
    expect(badge, "badge mount is an empty span").not.toBeNull();
    expect(badge![0]).toContain("hidden");
    expect(badge![1]).not.toMatch(/\d/);
  });

  it("guest chrome renders no bell and no unread count (control)", () => {
    const html = String(SiteHeader({ session: null }));
    expect(html).not.toContain(BELL);
    expect(html).not.toContain(BADGE);
  });
});

describe("bell island ships through the asset pipeline (hermetic, no DB)", () => {
  const srcUrl = new NodeURL("../assets/islands/notifications-bell.js", import.meta.url);
  const outUrl = new NodeURL("../public/islands/notifications-bell.js", import.meta.url);
  const outEntry = "public/islands/notifications-bell.js";

  it("reviewed binder source exists in assets/islands", () => {
    expect(existsSync(srcUrl), "assets/islands/notifications-bell.js").toBe(true);
  });

  it("minified binder output exists in public/islands and parses as JS", () => {
    expect(existsSync(outUrl), "public/islands/notifications-bell.js").toBe(true);
    const code = readFileSync(outUrl, "utf8");
    expect(() => new Script(code), "binder parses").not.toThrow();
    expect(code).toContain(ISLAND);
  });

  it("binder output is covered by the client bundle budget and fits", () => {
    const budgets = (
      JSON.parse(
        readFileSync(new NodeURL("../ci/bundle-budget.json", import.meta.url), "utf8"),
      ) as { budgets: Record<string, { maxRawBytes: number; maxGzipBytes: number }> }
    ).budgets;
    const ceiling = budgets[outEntry];
    expect(ceiling, `budget entry for ${outEntry}`).toBeDefined();
    const bytes = readFileSync(outUrl);
    expect(bytes.byteLength).toBeLessThanOrEqual(ceiling!.maxRawBytes);
    expect(gzipSync(bytes).byteLength).toBeLessThanOrEqual(ceiling!.maxGzipBytes);
  });
});

// Small fake DOM for the shipped binder: trusted mount markup in, standard DOM
// APIs only, so a binder written against real DOM calls just works. The binder
// may build nodes via createElement or innerHTML; innerHTML assignments are
// parsed back into nodes with the same small parser as the fixture.
class FakeNode {
  tagName: string;
  children: FakeNode[] = [];
  parentNode: FakeNode | null = null;
  attributes = new Map<string, string>();
  disabled = false;
  hidden = false;
  focused = false;
  private text = "";
  listeners = new Map<string, (e: { preventDefault: () => void }) => void>();
  constructor(tag = "div") {
    this.tagName = tag.toUpperCase();
  }
  get textContent(): string {
    return this.text + this.children.map((n) => n.textContent).join("");
  }
  set textContent(value: string) {
    this.text = value;
    this.children = [];
  }
  get innerHTML(): string {
    return this.children.map((n) => n.outerHTML()).join("");
  }
  set innerHTML(markup: string) {
    this.children = [];
    this.text = "";
    if (markup !== "") parseInto(this, markup);
  }
  outerHTML(): string {
    const attrs = [...this.attributes.entries()].map(([k, v]) => ` ${k}="${v}"`).join("");
    return `<${this.tagName.toLowerCase()}${attrs}>${this.text}${this.innerHTML}</${this.tagName.toLowerCase()}>`;
  }
  get dataset(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of this.attributes) {
      if (!k.startsWith("data-")) continue;
      const key = k
        .slice("data-".length)
        .split("-")
        .map((part, i) => (i === 0 ? part : part[0]!.toUpperCase() + part.slice(1)))
        .join("");
      out[key] = v;
    }
    return out;
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
  appendChild(n: FakeNode) {
    n.parentNode = this;
    this.children.push(n);
    return n;
  }
  remove() {
    this.parentNode?.removeChild(this);
  }
  removeChild(n: FakeNode) {
    this.children = this.children.filter((child) => child !== n);
    n.parentNode = null;
  }
  addEventListener(type: string, fn: (e: { preventDefault: () => void }) => void) {
    this.listeners.set(type, fn);
  }
  click() {
    if (!this.disabled) this.listeners.get("click")?.({ preventDefault() {} });
  }
  focus() {
    this.focused = true;
  }
  querySelectorAll(selector: string): FakeNode[] {
    const matches = (n: FakeNode) =>
      selector.split(",").some((raw) => {
        const s = raw.trim();
        const m =
          /^(?:([a-zA-Z][a-zA-Z0-9]*)?\[([^=\]]+)(?:="([^"]*)")?\]|([a-zA-Z][a-zA-Z0-9]*))$/.exec(
            s,
          );
        if (!m) return false;
        const tag = (m[1] ?? m[4] ?? "").toUpperCase();
        if (tag && n.tagName !== tag) return false;
        const attr = m[2];
        if (!attr) return true;
        return m[3] === undefined ? n.attributes.has(attr) : n.getAttribute(attr) === m[3];
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

const VOID_TAGS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

function parseInto(root: FakeNode, html: string) {
  const stack = [root];
  const decode = (s: string) =>
    s
      .replace(/&#39;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">");
  for (const token of html.match(/<[^>]*>|[^<]+/g) ?? []) {
    if (token.startsWith("</")) {
      stack.pop();
      continue;
    }
    if (token.startsWith("<!")) continue;
    const parent = stack[stack.length - 1]!;
    if (!token.startsWith("<")) {
      const n = new FakeNode("#text");
      n.textContent = decode(token);
      parent.appendChild(n);
      continue;
    }
    const tag = /^<\s*([a-zA-Z][a-zA-Z0-9]*)/.exec(token)?.[1] ?? "div";
    const n = new FakeNode(tag);
    for (const [, k, v] of token.matchAll(/([a-zA-Z-]+)(?:="([^"]*)")?/g)) {
      if (k!.toLowerCase() === tag.toLowerCase()) continue;
      n.setAttribute(k!, v ?? "");
      if (k === "hidden") n.hidden = true;
      if (k === "disabled") n.disabled = true;
    }
    parent.appendChild(n);
    if (!token.endsWith("/>") && !VOID_TAGS.has(tag.toLowerCase())) stack.push(n);
  }
}

type RecordedRequest = {
  url: string;
  method: string;
  resolve: (res: Response) => void;
  reject: (err: unknown) => void;
};

function mountBinder(mountHtml: string) {
  const page = new FakeNode("#document");
  parseInto(page, mountHtml);
  const requests: RecordedRequest[] = [];
  const intervals: unknown[] = [];
  const context: Record<string, unknown> = {
    document: {
      querySelector: (selector: string) => page.querySelector(selector),
      querySelectorAll: (selector: string) => page.querySelectorAll(selector),
      createElement: (tag: string) => new FakeNode(tag),
      createTextNode: (text: string) => {
        const n = new FakeNode("#text");
        n.textContent = text;
        return n;
      },
      addEventListener: () => {},
      dispatchEvent: () => true,
    },
    CustomEvent: class {
      type: string;
      detail: unknown;
      constructor(type: string, options: { detail: unknown } = { detail: undefined }) {
        this.type = type;
        this.detail = options.detail;
      }
    },
    location: { pathname: "/" },
    fetch: (url: string, init: { method?: string } = {}) =>
      new Promise<Response>((resolve, reject) => {
        requests.push({ url: String(url), method: init.method ?? "GET", resolve, reject });
      }),
    setTimeout: ((callback: () => void) => 0) as unknown as typeof setTimeout,
    clearTimeout: (() => {}) as unknown as typeof clearTimeout,
    setInterval: (() => {
      intervals.push(true);
      return 0;
    }) as unknown as typeof setInterval,
    clearInterval: (() => {}) as unknown as typeof clearInterval,
    console,
  };
  context.window = context;
  context.globalThis = context;
  const binder = readFileSync(
    new NodeURL("../public/islands/notifications-bell.js", import.meta.url),
    "utf8",
  );
  runInNewContext(binder, context);
  const settle = async () => {
    for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
  };
  const answer = (i: number, status: number, body: unknown) =>
    requests[i]!.resolve(
      new Response(status === 204 ? null : JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
    );
  return {
    page,
    requests,
    intervals,
    settle,
    answer,
    get: (testid: string) => page.querySelector(`[data-testid="${testid}"]`),
    all: (testid: string) => page.querySelectorAll(`[data-testid="${testid}"]`),
  };
}

const BELL_MOUNT = `<header><a data-island="${ISLAND}" data-testid="${BELL}" href="${PAGE_PATH}" aria-label="Notifications">Notifications<span data-testid="${BADGE}" hidden></span></a><p data-testid="${ERROR}" hidden></p></header>`;
const PAGE_LIST_MOUNT = `<main><ul data-testid="${LIST}"><li data-testid="${ITEM}" data-notification-id="n-1"><a href="/e/ev-one">Roster night</a><button type="button" data-testid="${MARK_READ}" data-notification-id="n-1">Mark read</button></li><li data-testid="${ITEM}" data-notification-id="n-2"><a href="/e/ev-two">Kit night</a><button type="button" data-testid="${MARK_READ}" data-notification-id="n-2">Mark read</button></li></ul></main>`;

const reminderPayload = (overrides: Record<string, unknown> = {}) => ({
  notifications: [
    {
      id: "n-1",
      kind: "event_reminder",
      title: "Roster night",
      body: "Roster night starts in 24 hours.",
      url: "/e/ev-one",
      startsAt: new Date(Date.now() + 24 * 3600_000).toISOString(),
      readAt: null,
      createdAt: new Date().toISOString(),
    },
    {
      id: "n-2",
      kind: "event_reminder",
      title: "Kit night",
      body: "Kit night starts in 1 hour.",
      url: "/e/ev-two",
      startsAt: new Date(Date.now() + 3600_000).toISOString(),
      readAt: null,
      createdAt: new Date().toISOString(),
    },
  ],
  unreadCount: 2,
  subscriptionUrl: FEED_URL,
  ...overrides,
});

describe("shipped bell binder behavior (hermetic vm, no DB)", () => {
  it("GETs the list once on load and paints the unread badge", async () => {
    const t = mountBinder(BELL_MOUNT);
    await t.settle();
    expect(t.requests).toHaveLength(1);
    expect(t.requests[0]!.url).toBe(LIST_PATH);
    expect(t.requests[0]!.method).toBe("GET");
    t.answer(0, 200, reminderPayload());
    await t.settle();
    const badge = t.get(BADGE);
    expect(badge, "badge node").not.toBeNull();
    expect(badge!.hidden).toBe(false);
    expect(badge!.textContent).toContain("2");
    const bell = t.get(BELL);
    expect(bell!.getAttribute("aria-label")).toMatch(/2[^"]*unread/i);
    // No polling: no interval scheduled and no follow-up fetch after settle.
    expect(t.intervals).toHaveLength(0);
    expect(t.requests).toHaveLength(1);
  });

  it("marks the mount busy while fetching and hides the badge at zero unread", async () => {
    const t = mountBinder(BELL_MOUNT);
    await t.settle();
    const bell = t.get(BELL);
    expect(bell!.getAttribute("aria-busy")).toBe("true");
    t.answer(0, 200, reminderPayload({ notifications: [], unreadCount: 0 }));
    await t.settle();
    expect(bell!.getAttribute("aria-busy")).not.toBe("true");
    expect(t.get(BADGE)!.hidden).toBe(true);
    expect(t.get(BADGE)!.textContent).not.toMatch(/\d/);
  });

  it("surfaces the error state when the list fetch fails", async () => {
    const t = mountBinder(BELL_MOUNT);
    await t.settle();
    t.requests[0]!.reject(new TypeError("network down"));
    await t.settle();
    const error = t.get(ERROR);
    expect(error, "error node").not.toBeNull();
    expect(error!.hidden).toBe(false);
    expect(error!.textContent.length).toBeGreaterThan(0);
  });

  it("mark-read controls POST the pinned read route and update the badge", async () => {
    const t = mountBinder(`${BELL_MOUNT}${PAGE_LIST_MOUNT}`);
    await t.settle();
    t.answer(0, 200, reminderPayload());
    await t.settle();
    const controls = t.all(MARK_READ);
    expect(controls).toHaveLength(2);
    controls[0]!.click();
    await t.settle();
    expect(t.requests).toHaveLength(2);
    expect(t.requests[1]!.url).toBe(readPath("n-1"));
    expect(t.requests[1]!.method).toBe("POST");
    t.answer(1, 200, { id: "n-1", readAt: new Date().toISOString() });
    await t.settle();
    expect(t.get(BADGE)!.textContent).toContain("1");
    const control = t.page.querySelector(
      `[data-testid="${MARK_READ}"][data-notification-id="n-1"]`,
    );
    expect(control === null || control.disabled, "read control gone or disabled").toBe(true);
  });

  it("a failing mark-read keeps the control enabled for retry", async () => {
    const t = mountBinder(`${BELL_MOUNT}${PAGE_LIST_MOUNT}`);
    await t.settle();
    t.answer(0, 200, reminderPayload());
    await t.settle();
    t.all(MARK_READ)[1]!.click();
    await t.settle();
    t.answer(1, 500, { error: "internal" });
    await t.settle();
    const control = t.page.querySelector(
      `[data-testid="${MARK_READ}"][data-notification-id="n-2"]`,
    );
    expect(control, "failed control stays").not.toBeNull();
    expect(control!.disabled).toBe(false);
    expect(t.get(BADGE)!.textContent).toContain("2");
  });
});

describe.skipIf(!process.env.DATABASE_URL)("reminder bell API + page (agent-testdb)", () => {
  let fixture: MemberDataFixture;
  let db: MemberDataFixture["db"];
  let client: MemberDataFixture["client"];
  let realPostgres: typeof postgres;
  const store = createMemorySessionStore();
  const sent: unknown[] = [];
  const env = {
    ...baseEnv,
    SESSION_STORE: store,
    get ADMIN_DB() {
      return db;
    },
    get DB() {
      return { connectionString: testDatabaseUrl(process.env.DATABASE_URL!).href };
    },
    SYNC_EVENT_QUEUE: {
      send: async (body: unknown) => {
        sent.push(body);
      },
    },
  } as unknown as Env;

  const userA = "10000000000000101";
  const userB = "10000000000000102";
  let cookieA = "";
  let cookieB = "";
  let eventCounter = 0;

  type SeededEvent = { id: number; eventKey: string; startsAt: Date };

  async function seedEvent(hoursOut: number): Promise<SeededEvent> {
    eventCounter += 1;
    const startsAt = new Date(Date.now() + hoursOut * 3600_000);
    const [ev] = await db
      .insert(events)
      .values({
        eventKey: `01K000000000000000${String(eventCounter).padStart(8, "0")}`,
        title: `Seeded event ${eventCounter}`,
        startsAt,
        endsAt: new Date(startsAt.getTime() + 2 * 3600_000),
        status: "published",
      })
      .returning();
    return { id: ev!.id, eventKey: ev!.eventKey, startsAt };
  }

  async function seedReminder(row: {
    userId: string;
    eventId: number | null;
    title: string;
    url: string;
    read?: boolean;
  }): Promise<string> {
    const now = new Date();
    const inserted = await client`
      insert into notifications (user_id, kind, event_id, title, body, url, read_at, created_at)
      values (${row.userId}, 'event_reminder', ${row.eventId}, ${row.title}, ${`${row.title} body.`}, ${row.url}, ${row.read ? now : null}, ${now})
      returning id
    `;
    return String(inserted[0]!.id);
  }

  const unknownIdFor = (id: string): string =>
    /^\d+$/.test(id) ? String(BigInt(id) + 999999999n) : randomUUID();

  beforeAll(async () => {
    realPostgres = (await vi.importActual<{ default: typeof postgres }>("postgres")).default;
    vi.mocked(postgres).mockImplementation(realPostgres);
    fixture = await createMemberDataFixture(process.env.DATABASE_URL!, { max: 20 });
    db = fixture.db;
    client = fixture.client;
    vi.mocked(postgres).mockImplementation(((raw: string, opts: postgres.Options<{}> = {}) => {
      const safe = testDatabaseUrl(raw);
      return realPostgres(safe.href, {
        ...opts,
        password: () => safe.password,
        connection: { ...opts.connection, search_path: fixture.schemaName },
      });
    }) as typeof postgres);
  });

  beforeEach(async () => {
    await fixture.reset();
    await client`delete from notifications`;
    sent.length = 0;
    cookieA = await cookieFor(store, userA, "alice");
    cookieB = await cookieFor(store, userB, "bob");
    vi.clearAllMocks();
  });

  afterAll(async () => {
    if (realPostgres) vi.mocked(postgres).mockImplementation(realPostgres);
    await fixture?.dispose();
  });

  const get = (path: string, cookie: string) => app.request(path, { headers: { cookie } }, env);
  const postRead = (id: string, cookie: string, body?: unknown) =>
    app.request(
      readPath(id),
      {
        method: "POST",
        headers: {
          cookie,
          origin: APP_URL,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
      env,
    );

  it("list returns own rows with the pinned shape plus feed subscription URL", async () => {
    const ev = await seedEvent(24);
    const unreadId = await seedReminder({
      userId: userA,
      eventId: ev.id,
      title: "Roster night reminder",
      url: `/e/${ev.eventKey}`,
    });
    await seedReminder({
      userId: userA,
      eventId: ev.id,
      title: "Already read reminder",
      url: `/e/${ev.eventKey}`,
      read: true,
    });
    const res = await get(LIST_PATH, cookieA);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      notifications: Record<string, unknown>[];
      unreadCount: number;
      subscriptionUrl: string;
    };
    expect(body.unreadCount).toBe(1);
    expect(body.subscriptionUrl).toBe(FEED_URL);
    expect(body.notifications).toHaveLength(2);
    const row = body.notifications.find((n) => String(n.id) === unreadId)!;
    expect(row, "seeded unread row present").toBeDefined();
    expect(row.kind).toBe("event_reminder");
    expect(row.title).toBe("Roster night reminder");
    expect(row.url).toBe(`/e/${ev.eventKey}`);
    expect(new Date(row.startsAt as string).getTime()).toBe(ev.startsAt.getTime());
    expect(row.readAt).toBeNull();
    expect(new Date(row.createdAt as string).getTime()).not.toBeNaN();
  });

  it("list isolates members: no foreign rows, zero unread for a stranger", async () => {
    const ev = await seedEvent(24);
    await seedReminder({
      userId: userA,
      eventId: ev.id,
      title: "Alice only",
      url: `/e/${ev.eventKey}`,
    });
    const res = await get(LIST_PATH, cookieB);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      notifications: unknown[];
      unreadCount: number;
    };
    expect(body.notifications).toEqual([]);
    expect(body.unreadCount).toBe(0);
  });

  it("mark-read round-trips and a second POST is idempotent", async () => {
    const ev = await seedEvent(1);
    const id = await seedReminder({
      userId: userA,
      eventId: ev.id,
      title: "Kit night reminder",
      url: `/e/${ev.eventKey}`,
    });
    const before = Date.now();
    const res = await postRead(id, cookieA);
    expect(res.status).toBe(200);
    const done = (await res.json()) as { id: unknown; readAt: string };
    expect(String(done.id)).toBe(id);
    const readAt = new Date(done.readAt).getTime();
    expect(readAt).toBeGreaterThanOrEqual(before - 1000);
    expect(readAt).toBeLessThanOrEqual(Date.now() + 1000);
    const again = await postRead(id, cookieA);
    expect(again.status).toBe(200);
    const list = (await (await get(LIST_PATH, cookieA)).json()) as {
      notifications: Record<string, unknown>[];
      unreadCount: number;
    };
    expect(list.unreadCount).toBe(0);
    const row = list.notifications.find((n) => String(n.id) === id)!;
    expect(new Date(row.readAt as string).getTime()).not.toBeNaN();
  });

  it("unknown and foreign ids 404 identically; forged body user ids are ignored", async () => {
    const ev = await seedEvent(24);
    const id = await seedReminder({
      userId: userA,
      eventId: ev.id,
      title: "Alice only",
      url: `/e/${ev.eventKey}`,
    });
    const unknown = await postRead(unknownIdFor(id), cookieA);
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({ error: "not_found" });
    const foreign = await postRead(id, cookieB);
    expect(foreign.status).toBe(404);
    expect(await foreign.json()).toEqual({ error: "not_found" });
    // user_id comes from the session, never the request body.
    const forged = await postRead(id, cookieB, { user_id: userA, userId: userA });
    expect(forged.status).toBe(404);
    expect(await forged.json()).toEqual({ error: "not_found" });
  });

  it("page lists own reminders with title, link, local time, countdown and feed link", async () => {
    const ev = await seedEvent(24);
    await seedReminder({
      userId: userA,
      eventId: ev.id,
      title: "Roster night page reminder",
      url: `/e/${ev.eventKey}`,
    });
    const res = await get(PAGE_PATH, cookieA);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(`data-testid="${BELL}"`);
    expect(html).toContain(`data-testid="${ITEM}"`);
    expect(html).toContain("Roster night page reminder");
    expect(html).toContain(`href="/e/${ev.eventKey}"`);
    const datetimes = [...html.matchAll(/<time[^>]*datetime="([^"]+)"[^>]*>/g)].map((m) =>
      new Date(m[1]!).getTime(),
    );
    expect(datetimes).toContain(ev.startsAt.getTime());
    const countdowns = [
      ...html.matchAll(new RegExp(`data-testid="${COUNTDOWN}"[^>]*>([^<]*)<`, "g")),
    ].map((m) => m[1]);
    expect(countdowns.length).toBeGreaterThan(0);
    for (const copy of countdowns) expect(copy).toMatch(COUNTDOWN_SHAPE);
    expect(html).toContain(`href="${FEED_URL}"`);
    expect(html).toContain(`data-testid="${SUBSCRIPTION}"`);
    expect(html).toContain(`data-testid="${MARK_READ}"`);
    expect(html).not.toContain(`data-testid="${EMPTY}"`);
  });

  it("page shows the empty state for a member with no reminders", async () => {
    const ev = await seedEvent(24);
    await seedReminder({
      userId: userA,
      eventId: ev.id,
      title: "Alice only",
      url: `/e/${ev.eventKey}`,
    });
    const res = await get(PAGE_PATH, cookieB);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(`data-testid="${EMPTY}"`);
    expect(html).not.toContain("Alice only");
  });
});

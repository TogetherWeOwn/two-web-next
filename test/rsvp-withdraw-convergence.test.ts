// route-inventory: PUT /events/:key/rsvp
// route-inventory: DELETE /events/:key/rsvp
// route-inventory: POST /e/:key/rsvp
// An honest DELETE 404 must never surface as a failure.
//
// Since the honest-404 change, a DELETE that deletes no caller row answers
// 404 not_found. Two convergence branches keep that truthful answer from
// looking like a failure on a double-withdraw (two tabs, a retry after a
// lost 204, a withdraw that races another tab's withdrawal):
//
// (a) the no-JS HTML adapter: POST /e/:key/rsvp with status=withdraw whose
// DELETE answers 404 now 303s back to the event page — the event page's own
// 404 still covers unknown or forged keys — instead of rendering the
// refusal page. Every other failure keeps the refusal page.
// (b) the RSVP island: a withdraw whose DELETE answers 404 paints the same
// withdrawn end state as a 204 (join control back, no failure alert) and
// broadcasts viewerState "none", instead of the failure alert.
//
// Removing either branch regresses the double-withdraw to a failure message
// or refusal page, so both branches are pinned here. The adapter pin lives
// against the disposable Postgres fixture (skipped without DATABASE_URL,
// like test/rsvp.test.ts); the island pin executes the shipped binder
// without a browser, network or database.
// Live against the disposable Postgres fixture (skipped without
// DATABASE_URL, like test/rsvp.test.ts). Never point this at anything
// but a test container.
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { URL as NodeURL } from "node:url";
import { serializeSigned } from "hono/utils/cookie";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import app from "./app";
import { events, rsvps } from "../src/db/admin-schema";
import type { Env } from "../src/env";
import type { QueueMessage } from "../src/jobs/types";

// RSVP route tests isolate dispatch; other suites prove the real producer.
vi.mock("../src/jobs/worker", () => ({
  enqueueSyncEvent: async (env: Env, message: QueueMessage) => {
    await env.SYNC_EVENT_QUEUE!.send(message, { delaySeconds: 10 });
    return true;
  },
}));
import {
  createMemorySessionStore,
  hashToken,
  newSessionToken,
  type SessionStore,
} from "../src/sessions";
import { RsvpButton } from "../src/events/rsvp-button";
import type { PublicEvent } from "../src/events/reads";
import { createMemberDataFixture, type MemberDataFixture } from "./helpers/member-data-db";

const SESSION_SECRET = "test-session-secret-at-least-32-bytes-long";
const APP_URL = "https://next.example.test";

async function cookieFor(store: SessionStore, userId: string): Promise<string> {
  const token = newSessionToken();
  await store.create({
    tokenHash: await hashToken(token),
    userId,
    username: userId,
    avatar: null,
    member: true,
    moderator: false,
    expiresAt: new Date(Date.now() + 3600_000),
  });
  return (
    await serializeSigned("__Host-two_session", token, SESSION_SECRET, {
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "Lax",
    })
  ).split(";")[0]!;
}

describe.skipIf(!process.env.DATABASE_URL)(
  "rsvp already-withdrawn HTML adapter (agent-testdb)",
  () => {
    let fixture: MemberDataFixture;
    let db: MemberDataFixture["db"];
    let client: MemberDataFixture["client"];
    const store = createMemorySessionStore();
    const sent: QueueMessage[] = [];
    const env = {
      APP_URL,
      DISCORD_CLIENT_ID: "client-id",
      DISCORD_GUILD_ID: "326474832151838730",
      DISCORD_INVITE_URL: "https://discord.gg/invite",
      DISCORD_CLIENT_SECRET: "client-secret",
      DISCORD_BOT_TOKEN: "bot-token",
      SESSION_SECRET,
      get ADMIN_DB() {
        return db;
      },
      SESSION_STORE: store,
      SYNC_EVENT_QUEUE: { send: async (m: QueueMessage) => void sent.push(m) },
    } as unknown as Env;

    beforeAll(async () => {
      fixture = await createMemberDataFixture(process.env.DATABASE_URL!, { max: 4 });
      db = fixture.db;
      client = fixture.client;
    });
    beforeEach(async () => {
      await fixture.reset();
      await client`delete from web_throttle_hits`;
      sent.length = 0;
    });
    afterAll(async () => {
      await fixture?.dispose();
    });

    async function seed(
      over: Partial<typeof events.$inferInsert> = {},
    ): Promise<{ id: number; key: string }> {
      const key = `01W9${Math.random().toString(36).slice(2, 14).toUpperCase()}`
        .padEnd(26, "0")
        .slice(0, 26)
        .replace(/[ILOU]/g, "7");
      const [row] = await db
        .insert(events)
        .values({
          eventKey: key,
          title: "Withdraw convergence night",
          startsAt: new Date(Date.now() + 3600_000),
          endsAt: new Date(Date.now() + 2 * 3600_000),
          timezone: "UTC",
          location: "Voice",
          status: "published",
          ...over,
        })
        .returning();
      return { id: row!.id, key };
    }

    const rows = (eventId: number) => db.select().from(rsvps).where(eq(rsvps.eventId, eventId));

    // Sessions rotate on each authenticated view, so every request mints a
    // fresh cookie, as in test/rsvp.test.ts. `as: null` sends no cookie.
    const submitWithdraw = async (key: string, as: string | null) =>
      app.request(
        `/e/${key}/rsvp`,
        {
          method: "POST",
          headers: {
            ...(as ? { cookie: await cookieFor(store, as) } : {}),
            origin: APP_URL,
            "content-type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({ status: "withdraw" }),
        },
        env,
      );

    const put = async (key: string, as: string, status: unknown = "going") =>
      app.request(
        `/events/${key}/rsvp`,
        {
          method: "PUT",
          headers: {
            cookie: await cookieFor(store, as),
            origin: APP_URL,
            accept: "application/json",
            "content-type": "application/json",
          },
          body: JSON.stringify({ status }),
        },
        env,
      );

    it("a no-JS withdraw with no caller row 303s back to the event page, not the refusal page", async () => {
      const ev = await seed();
      const res = await submitWithdraw(ev.key, "never-answered");
      // Without the already-withdrawn branch this renders the refusal page
      // with a 404 status; the converged answer is a redirect home.
      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe(`/e/${ev.key}`);
      expect(await rows(ev.id)).toHaveLength(0);
    });

    it("a guest withdraw still 303s to login, never the event page (401 control)", async () => {
      const ev = await seed();
      const res = await submitWithdraw(ev.key, null);
      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe(
        `/join/discord?next=${encodeURIComponent(`/e/${ev.key}`)}`,
      );
    });

    it("a no-JS withdraw with a real row 303s back with the row gone (real-row control)", async () => {
      const ev = await seed();
      expect((await put(ev.key, "holder")).status).toBe(201);
      const res = await submitWithdraw(ev.key, "holder");
      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe(`/e/${ev.key}`);
      expect(await rows(ev.id)).toHaveLength(0);
    });
  },
);

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
  onTextChange?: (value: string) => void;
  listeners = new Map<string, (e: { preventDefault: () => void }) => void>();
  get textContent(): string {
    return this.text + this.children.map((n) => n.textContent).join("");
  }
  set textContent(value: string) {
    this.onTextChange?.(value);
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
// Small parser for trusted JSX fixture markup, not a second hand-written action set.
function parse(html: string) {
  const page = new Node();
  const stack = [page];
  // Single-pass entity decode: resolving "&amp;" in its own chained pass
  // would double-unescape "&amp;lt;" to "<" instead of one level to "&lt;".
  const entities: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    "#39": "'",
  };
  const decode = (s: string) =>
    s.replace(/&(amp|lt|gt|quot|#39);/g, (m, name: string) => entities[name] ?? m);
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
function browser() {
  const e = { ...event };
  const props = {
    e,
    member: true,
    answer: { status: "going" as const, syncedToDiscordAt: null },
    returnTo: "/e/raid/one",
    now: new Date("2029-01-01"),
  };
  const html = String(RsvpButton(props));
  const page = parse(html);
  const root = page.querySelector('[data-island="rsvp-button"]')!;
  root.setAttribute("data-login-url", "/join/discord?next=%2Fe%2Fraid%2Fone");
  const requests: {
    url: string;
    init: RequestInit;
    resolve: (r: Response) => void;
    reject: (e: Error) => void;
  }[] = [];
  const broadcasts: { type: string; detail: unknown }[] = [];
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
  const notifyDocument = (type: string, target: Node) =>
    listeners.get(type)?.({ type, detail: undefined, target });
  const context = {
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
    location: {
      pathname: "/e/raid/one",
      reload: () => {},
    },
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
  focusSink = (target) => notifyDocument("focusin", target);
  runInNewContext(binder, context);
  const get = (id: string) => root.querySelector(`[data-testid="${id}"]`);
  const finish = (i: number, status: number, body: unknown = { error: "not_found" }) =>
    requests[i]!.resolve(new Response(JSON.stringify(body), { status }));
  const settle = async (flushTimers = true) => {
    await new Promise((resolve) => setImmediate(resolve));
    if (flushTimers) runTimers(0);
  };
  return { root, get, requests, broadcasts, finish, settle };
}

describe("rsvp withdraw-404 island convergence", () => {
  it("paints the withdrawn end state on a withdraw 404, with no failure alert and a none broadcast", async () => {
    const b = browser();
    b.get("rsvp-withdraw")!.click();
    expect(b.requests[0]!.init.method).toBe("DELETE");
    expect(b.requests[0]!.init.body).toBeUndefined();
    // Second tab already withdrew (or a retry after a lost 204): the honest
    // 404 converges to the withdrawn state, exactly like a 204.
    b.finish(0, 404, { error: "not_found" });
    await b.settle();
    // Without the withdraw-404 branch this lands on the failure alert with no
    // broadcast; the converged answer restores the join control instead.
    expect(b.get("rsvp-confirmed")).toBeNull();
    expect(b.get("rsvp-withdraw")).toBeNull();
    expect(b.get("rsvp-going")).not.toBeNull();
    expect(b.get("rsvp-going")?.focused).toBe(true);
    expect(b.get("rsvp-failed")).toBeNull();
    expect(b.root.querySelectorAll('[role="alert"]')).toHaveLength(0);
    expect(b.broadcasts.map(({ type, detail }) => ({ type, detail }))).toEqual([
      { type: "going-count-updated", detail: { eventKey: "raid/one", viewerState: "none" } },
    ]);
    expect(b.requests).toHaveLength(1);
  });
});

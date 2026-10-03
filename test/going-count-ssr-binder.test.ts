import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { URL as NodeURL } from "node:url";
import { getTableColumns } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pg-proxy";
import { serializeSigned } from "hono/utils/cookie";
import { describe, expect, it } from "vitest";
import app from "./app";
import { events } from "../src/db/admin-schema";
import type { Db } from "../src/db/index";
import type { Env } from "../src/env";
import { createMemorySessionStore, hashToken, newSessionToken } from "../src/sessions";

/**
 * TOG-11227: the event page's going-count badge must mount the shipped
 * `public/islands/going-count.js` binder. The contract tests pin the pure
 * functions; this file executes the real binder source against the real SSR
 * markup so a markup/binder drift fails here instead of in the browser.
 */

const APP_URL = "https://next.example.test";
const KEY = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const PATH = `/e/${KEY}`;
const SECRET = "test-session-secret-at-least-32-bytes-long";

const binder = readFileSync(
  new NodeURL("../public/islands/going-count.js", import.meta.url),
  "utf8",
);

// Real Drizzle queries and Hono rendering; all data is local, no DB connection.
function fixture(over: Partial<typeof events.$inferSelect> = {}, earlierEvents = 0) {
  const start = new Date("2030-01-10T20:00:00Z");
  const row: typeof events.$inferSelect = {
    id: 1,
    eventKey: KEY,
    title: "Chess night",
    game: "Chess",
    description: "Bring a friend & a board.",
    startsAt: start,
    endsAt: new Date("2030-01-10T22:00:00Z"),
    timezone: "UTC",
    location: "The lobby & voice channel",
    capacity: 10,
    status: "published",
    rsvpOpen: true,
    discordEventId: null,
    discordSyncFailedAt: null,
    discordSyncFailureCode: null,
    agentGrantId: null,
    proofMarker: null,
    agentVersion: 1,
    createdBy: null,
    icsSequence: 0n,
    syncRevision: 1,
    syncedRevision: 0,
    recurrenceFrequency: null,
    recurrenceCount: null,
    recurrenceEndsOn: null,
    parentEventId: null,
    recurrenceIndex: null,
    createdAt: start,
    updatedAt: start,
    ...over,
  };
  const columns = Object.keys(getTableColumns(events)) as (keyof typeof row)[];
  const encode = (event: typeof row) =>
    columns.map((key) =>
      event[key] instanceof Date ? (event[key] as Date).toISOString() : event[key],
    );
  const earlier = Array.from({ length: earlierEvents }, (_, i) => ({
    ...row,
    id: i + 2,
    eventKey: String(i + 2).padStart(26, "0"),
    startsAt: new Date(start.getTime() - (i + 1) * 86400_000),
  })).reverse();
  const queries: string[] = [];
  let going = 3;
  const db = drizzle(async (sql, params) => {
    queries.push(sql);
    if (sql.includes('from "rsvps"') && sql.includes('inner join "users"')) return { rows: [] };
    if (sql.includes('from "rsvps"')) return { rows: [[row.id, going]] };
    if (
      sql.includes('from "events"') &&
      (sql.startsWith("select count(*)") ||
        sql.includes('order by "events"."starts_at" asc, "events"."id" asc limit'))
    ) {
      // Model the same WHERE for the total and rows, before LIMIT/OFFSET.
      let selected = [...earlier, row];
      if (params.includes("published"))
        selected = selected.filter((event) => event.status !== "draft");
      const keyParameter = sql.match(/"event_key" = \$(\d+)/)?.[1];
      if (keyParameter)
        selected = selected.filter((event) => event.eventKey === params[Number(keyParameter) - 1]);
      if (sql.startsWith("select count(*)")) return { rows: [[selected.length]] };
      const limitParameter = sql.match(/limit \$(\d+)/)?.[1];
      const offsetParameter = sql.match(/offset \$(\d+)/)?.[1];
      const offset = offsetParameter ? Number(params[Number(offsetParameter) - 1]) : 0;
      if (limitParameter)
        selected = selected.slice(offset, offset + Number(params[Number(limitParameter) - 1]));
      return { rows: selected.map(encode) };
    }
    if (sql.includes('"event_key" =')) return { rows: [encode(row)] };
    return { rows: [] };
  });
  const store = createMemorySessionStore();
  const env = {
    APP_URL: `${APP_URL}/`,
    SESSION_SECRET: SECRET,
    SESSION_STORE: store,
    ADMIN_DB: db as unknown as Db,
  } as unknown as Env;
  return {
    queries,
    setGoing: (value: number) => {
      going = value;
    },
    async cookie(moderator = false) {
      const token = newSessionToken();
      await store.create({
        tokenHash: await hashToken(token),
        userId: "member",
        username: "member",
        avatar: null,
        member: true,
        moderator,
        expiresAt: new Date(Date.now() + 3600_000),
      });
      return (
        await serializeSigned("__Host-two_session", token, SECRET, {
          path: "/",
          secure: true,
          httpOnly: true,
          sameSite: "Lax",
        })
      ).split(";")[0]!;
    },
    request(cookie?: string, path = PATH) {
      return app.request(path, cookie ? { headers: { cookie } } : {}, env);
    },
  };
}

describe("Event page going-count SSR wiring", () => {
  it("renders the contract badge markup and loads the shipped binder", async () => {
    const response = await fixture().request();
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).toContain('src="/islands/going-count.js" defer');
    expect(html).toContain('data-island="going-count"');
    expect(html).toContain(`data-event-key="${KEY}"`);
    expect(html).toContain('data-capacity="10"');
    expect(html).toContain('role="status" data-testid="event-going-count"');
    expect(html).toContain("<span data-count>3 of 10 going</span>");
    expect(html).toContain("data-spots>7 of 10 spots left</span>");
    const badge = html.match(/<span data-count>[\s\S]*?<\/p>/)?.[0];
    expect(badge?.replace(/<[^>]*>/g, "")).toBe("3 of 10 going · 7 of 10 spots left");
    // Silent on first render: the announcement node exists but is empty.
    expect(html).toContain("data-announcement></span>");
  });

  it("renders the uncapped badge without a spots line", async () => {
    const html = await (await fixture({ capacity: null }).request()).text();
    expect(html).toContain('data-capacity=""');
    expect(html).toContain("<span data-count>3 going</span>");
    expect(html).not.toContain("data-spots");
  });
});

/* ---- shipped binder, executed against the markup the page actually emits */

class Node {
  attributes = new Map<string, string>();
  textContent = "";
  private targets = new Map<string, Node>();
  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }
  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }
  removeAttribute(name: string) {
    this.attributes.delete(name);
  }
  querySelector(selector: string): Node | null {
    return this.targets.get(selector) ?? null;
  }
  addTarget(selector: string): Node {
    const node = new Node();
    this.targets.set(selector, node);
    return node;
  }
}

interface PendingRequest {
  url: string;
  init: { headers?: Record<string, string> };
  resolve: (response: { ok: boolean; status?: number; json: () => Promise<unknown> }) => void;
  reject: (error: Error) => void;
}

type Broadcast = (eventKey: string, viewerState?: string) => void;

// Builds the stub mount from the real SSR HTML so attribute-name drift fails.
function mountFromSsr(html: string) {
  const tag = html.match(/<span role="status" data-testid="event-going-count"[^>]*>/)?.[0];
  expect(tag, "SSR must emit the going-count mount span").toBeTruthy();
  const mount = new Node();
  for (const name of ["data-event-key", "data-capacity"]) {
    const value = tag!.match(new RegExp(`${name}="([^"]*)"`))?.[1];
    if (value !== undefined) mount.setAttribute(name, value);
  }
  const count = mount.addTarget("[data-count]");
  count.textContent = html.match(/<span data-count>([^<]*)<\/span>/)?.[1] ?? "";
  const announcement = mount.addTarget("[data-announcement]");
  const spots = html.includes("data-spots") ? mount.addTarget("[data-spots]") : null;
  if (spots) spots.textContent = html.match(/data-spots>([^<]*)<\/span>/)?.[1] ?? "";
  return { mount, count, announcement, spots };
}

function browser(html: string, ...additionalHtml: string[]) {
  const badges = [mountFromSsr(html), ...additionalHtml.map(mountFromSsr)];
  const { mount, count, announcement, spots } = badges[0]!;
  const listeners: ((event: { detail: { eventKey?: string; viewerState?: string } }) => void)[] =
    [];
  const requests: PendingRequest[] = [];
  const documentEl = new Node();
  const documentStub = {
    documentElement: documentEl,
    addEventListener: (
      type: string,
      listener: (event: { detail: { eventKey?: string; viewerState?: string } }) => void,
    ) => {
      if (type === "going-count-updated") listeners.push(listener);
    },
    querySelectorAll: (selector: string) =>
      selector === '[data-island="going-count"]' ? badges.map((badge) => badge.mount) : [],
  };
  // The merged binder restores the refreshed broadcast the rsvp-button
  // island consumes; single-badge refreshes reach it, so the stub covers
  // that path without asserting it here.
  const evalBinder = () =>
    runInNewContext(binder, {
      CustomEvent: class {
        constructor(
          public type: string,
          public options: { detail: unknown },
        ) {}
        get detail() {
          return this.options.detail;
        }
      },
      document: {
        ...documentStub,
        dispatchEvent() {
          return true;
        },
      },
      fetch: (url: string, init: PendingRequest["init"]) =>
        new Promise((resolve, reject) => requests.push({ url, init, resolve, reject })),
    });
  evalBinder();
  const broadcast: Broadcast = (eventKey, viewerState) => {
    for (const listener of listeners) listener({ detail: { eventKey, viewerState } });
  };
  const settle = async () => {
    for (let i = 0; i < 6; i++) await new Promise((resolve) => setImmediate(resolve));
  };
  const okJson = (rows: { event_key: string; going_count: number }[]) => ({
    ok: true,
    json: async () => rows,
  });
  return {
    mount,
    count,
    announcement,
    spots,
    badges,
    listeners,
    requests,
    broadcast,
    settle,
    evalBinder,
    okJson,
    documentEl,
  };
}

describe("GoingCount shipped binder over real SSR markup", () => {
  it("mounts without fetching and registers exactly one document listener", async () => {
    const html = await (await fixture().request()).text();
    const b = browser(html);
    expect(b.requests).toHaveLength(0);
    expect(b.listeners).toHaveLength(1);
    expect(b.count.textContent).toBe("3 of 10 going");
    expect(b.spots?.textContent).toBe("7 of 10 spots left");
    expect(b.announcement.textContent).toBe("");
  });

  it("fires one GET per matching broadcast and patches count, spots and outcome", async () => {
    const html = await (await fixture().request()).text();
    const b = browser(html);
    b.broadcast(KEY, "going");
    expect(b.requests).toHaveLength(1);
    expect(b.requests[0]!.url).toBe(`/events.json?event_key=${KEY}`);
    expect(b.requests[0]!.init.headers).toEqual({ accept: "application/json" });
    b.requests[0]!.resolve(b.okJson([{ event_key: KEY, going_count: 4 }]));
    await b.settle();
    expect(b.count.textContent).toBe("4 of 10 going");
    expect(b.spots?.textContent).toBe("6 of 10 spots left");
    expect(b.announcement.textContent).toContain("You're going.");
    expect(b.mount.getAttribute("data-pending-announcement")).toBeNull();
    // A second write (here: waitlisted) refreshes again with the new outcome.
    b.broadcast(KEY, "waitlisted");
    b.requests[1]!.resolve(b.okJson([{ event_key: KEY, going_count: 10 }]));
    await b.settle();
    expect(b.count.textContent).toBe("10 of 10 going");
    expect(b.spots?.textContent).toBe("Full");
    expect(b.announcement.textContent).toContain("waitlist");
  });

  it("shares one keyed read and ignores stale updates across same-key SSR badges", async () => {
    const html = await (await fixture().request()).text();
    const smaller = await (await fixture({ capacity: 4 }).request()).text();
    const b = browser(html, smaller);
    b.broadcast(KEY, "going");
    b.broadcast(KEY, "none");
    expect(b.requests).toHaveLength(2);
    expect(b.requests.map((request) => request.url)).toEqual([
      `/events.json?event_key=${KEY}`,
      `/events.json?event_key=${KEY}`,
    ]);
    b.requests[1]!.resolve(b.okJson([{ event_key: KEY, going_count: 2 }]));
    await b.settle();
    const values = () =>
      b.badges.map((badge) => ({
        count: badge.count.textContent,
        spots: badge.spots?.textContent,
        announcement: badge.announcement.textContent,
      }));
    const newest = [
      { count: "2 of 10 going", spots: "8 of 10 spots left", announcement: "RSVP removed. " },
      { count: "2 of 4 going", spots: "2 of 4 spots left", announcement: "RSVP removed. " },
    ];
    expect(values()).toEqual(newest);
    b.requests[0]!.resolve(b.okJson([{ event_key: KEY, going_count: 10 }]));
    await b.settle();
    expect(values()).toEqual(newest);
  });

  it("refreshes an event beyond page one with one GET through the real JSON route", async () => {
    const source = fixture({}, 25);
    const cookie = await source.cookie();
    const firstPage = await source.request(cookie, "/events.json");
    const firstBody = (await firstPage.json()) as {
      data: { event_key: string }[];
      meta: { total: number };
    };
    expect(firstBody.data).toHaveLength(20);
    expect(firstBody.data.some((row) => row.event_key === KEY)).toBe(false);
    expect(firstBody.meta.total).toBe(26);
    const b = browser(await (await source.request()).text());
    source.setGoing(4);
    b.broadcast(KEY, "going");
    expect(b.requests).toHaveLength(1);
    const response = await source.request(cookie, b.requests[0]!.url);
    expect(response.status).toBe(200);
    expect(source.queries.some((sql) => /"event_key" = \$\d+\) order by .* limit/.test(sql))).toBe(
      true,
    );
    b.requests[0]!.resolve({ ok: response.ok, json: () => response.json() });
    await b.settle();
    expect(b.count.textContent).toBe("4 of 10 going");
    expect(b.spots?.textContent).toBe("6 of 10 spots left");
    expect(b.announcement.textContent).toContain("You're going.");
  });

  it("preserves session, draft visibility and aggregate-only JSON controls for keyed reads", async () => {
    const source = fixture({ status: "draft" });
    const url = `/events.json?event_key=${KEY}`;
    expect((await source.request(undefined, url)).status).toBe(401);
    const member = await source.cookie();
    const hidden = await source.request(member, url);
    expect(hidden.status).toBe(200);
    const hiddenBody = (await hidden.json()) as { data: unknown[]; meta: { total: number } };
    expect(hiddenBody.data).toEqual([]);
    expect(hiddenBody.meta.total).toBe(0);
    const shown = await source.request(await source.cookie(true), url);
    expect(shown.status).toBe(200);
    expect(shown.headers.get("cache-control")).toBe("private, no-cache");
    expect(shown.headers.get("etag")).toBeTruthy();
    const body = (await shown.json()) as {
      data: Record<string, unknown>[];
      meta: { total: number };
    };
    expect(body.data).toHaveLength(1);
    expect(body.meta.total).toBe(1);
    expect(body.data[0]).toMatchObject({ event_key: KEY, going_count: 3 });
    for (const privateField of ["attendees", "user_id", "session", "token"]) {
      expect(body.data[0]).not.toHaveProperty(privateField);
    }
    expect((await source.request(member, "/events.json?event_key=invalid")).status).toBe(422);
    const missing = await source.request(member, `/events.json?event_key=${"0".repeat(26)}`);
    expect(missing.status).toBe(200);
    expect(((await missing.json()) as { data: unknown[] }).data).toEqual([]);
  });

  it("ignores broadcasts for other event keys without a request", async () => {
    const html = await (await fixture().request()).text();
    const b = browser(html);
    b.broadcast("01ARZ3NDEKTSV4RRFFQ69G5FAX", "going");
    expect(b.requests).toHaveLength(0);
    expect(b.count.textContent).toBe("3 of 10 going");
  });

  it("keeps the last SSR values when the row is missing or the read fails", async () => {
    const html = await (await fixture().request()).text();
    const b = browser(html);
    b.broadcast(KEY, "going");
    b.requests[0]!.resolve(b.okJson([{ event_key: "OTHER", going_count: 9 }]));
    await b.settle();
    expect(b.count.textContent).toBe("3 of 10 going");
    expect(b.spots?.textContent).toBe("7 of 10 spots left");
    b.broadcast(KEY, "going");
    b.requests[1]!.resolve({ ok: false, status: 500, json: async () => ({}) });
    await b.settle();
    b.broadcast(KEY, "going");
    b.requests[2]!.reject(new Error("offline"));
    await b.settle();
    expect(b.count.textContent).toBe("3 of 10 going");
    expect(b.spots?.textContent).toBe("7 of 10 spots left");
  });

  it("does not stack a second listener when the script evaluates twice", async () => {
    const html = await (await fixture().request()).text();
    const b = browser(html);
    b.evalBinder();
    expect(b.listeners).toHaveLength(1);
    b.broadcast(KEY, "going");
    expect(b.requests).toHaveLength(1);
    expect(b.documentEl.getAttribute("data-going-count-ready")).toBe("1");
  });

  it("refreshes an uncapped badge as a bare count, never inventing seats", async () => {
    const html = await (await fixture({ capacity: null }).request()).text();
    const b = browser(html);
    expect(b.spots).toBeNull();
    b.broadcast(KEY, "going");
    b.requests[0]!.resolve(b.okJson([{ event_key: KEY, going_count: 6 }]));
    await b.settle();
    expect(b.count.textContent).toBe("6 going");
  });
});

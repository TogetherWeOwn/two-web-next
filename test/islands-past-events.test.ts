import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { URL as NodeURL } from "node:url";
import { getTableColumns } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pg-proxy";
import { describe, expect, it } from "vitest";
import app from "./app";
import { events } from "../src/db/admin-schema";
import type { Db } from "../src/db/index";
import type { Env } from "../src/env";
import { JSON_DEFAULT_LIMIT, listPast, PAGE_SIZE } from "../src/events/reads";
import {
  PAST_EVENTS_COPY,
  PAST_EVENTS_EMPTY_TESTID,
  PAST_EVENTS_OUT_OF_RANGE_TESTID,
  PAST_EVENTS_PAGE_SIZE,
  POLLING,
  pastEventsOutOfRangeCopy,
  pastEventsRequest,
  pastEventsUrl,
} from "../src/islands/contracts";

const APP_URL = "https://next.example.test";
const binder = readFileSync(new NodeURL("../public/islands/past-events.js", import.meta.url), "utf8");

function eventRow(n: number): typeof events.$inferSelect {
  const date = new Date(Date.UTC(2020, 0, n + 1));
  return {
    id: n, icsSequence: 1n, eventKey: `archive-${n}`, title: `Past game ${n}`, game: "Chess", description: null,
    startsAt: date, endsAt: date, timezone: "UTC", location: null, capacity: 10, status: "past",
    discordEventId: null, discordSyncFailedAt: null, discordSyncFailureCode: null,
    syncRevision: 1, syncedRevision: 0, createdBy: null, rsvpOpen: true, recurrenceFrequency: null,
    recurrenceCount: null, recurrenceEndsOn: null, parentEventId: null, recurrenceIndex: null,
    createdAt: date, updatedAt: date,
  };
}

// Execute the real Drizzle selects and Hono route, but never connect to a database.
function archive(total: number) {
  const queries: { sql: string; params: unknown[] }[] = [];
  const rows = Array.from({ length: total }, (_, i) => eventRow(total - i));
  const db = drizzle(async (sql, params) => {
    queries.push({ sql, params });
    if (sql.startsWith('select count(*) from "events"')) return { rows: [[total]] };
    if (sql.includes('from "rsvps"')) return { rows: [] };
    const hasOffset = sql.includes(" offset ");
    const offset = hasOffset ? Number(params.at(-1)) : 0;
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("Invalid archive SQL offset");
    const limit = Number(params.at(hasOffset ? -2 : -1));
    const columns = Object.keys(getTableColumns(events)) as (keyof typeof events.$inferSelect)[];
    return { rows: rows.slice(offset, offset + limit).map((row) => columns.map((k) => {
      const value = row[k];
      return value instanceof Date ? value.toISOString() : value;
    })) };
  });
  const env = { APP_URL, ADMIN_DB: db as unknown as Db } as unknown as Env;
  return { db: db as unknown as Db, queries, request: (path: string) => app.request(path, {}, env) };
}

const keys = (html: string) => [...html.matchAll(/data-event-key="([^"]+)"/g)].map((m) => m[1]);

describe("PastEvents contract and SSR drift", () => {
  it("reads only on page turns and shares the twenty-row archive/JSON budget", () => {
    expect(POLLING["past-events"].pollMs).toBeNull();
    expect(PAST_EVENTS_PAGE_SIZE).toBe(20);
    expect(PAGE_SIZE).toBe(PAST_EVENTS_PAGE_SIZE);
    expect(JSON_DEFAULT_LIMIT).toBe(PAST_EVENTS_PAGE_SIZE);
    expect(pastEventsRequest(1)).toEqual({ method: "GET", url: "/events/past" });
    expect(pastEventsRequest(2)).toEqual({ method: "GET", url: "/events/past?page=2" });
    expect(pastEventsUrl(12)).toBe("/events/past?page=12");
  });

  it("mounts SSR with twenty newest-first cards, canonical and no RSVP controls", async () => {
    const source = archive(25);
    const response = await source.request("/events/past?page=1");
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("public, max-age=300");
    expect(keys(html)).toEqual(Array.from({ length: 20 }, (_, i) => `archive-${25 - i}`));
    expect(html).toContain('data-island="past-events"');
    expect(html).toContain('data-total-pages="2"');
    expect(html).toContain('src="/islands/past-events.js"');
    expect(html).toContain(`rel="canonical" href="${APP_URL}/events/past"`);
    expect(html).toContain('href="/events/past?page=2"');
    expect(html).not.toMatch(/data-island="rsvp-button"|data-testid="(?:rsvp-|waitlist-)|<button|<form/);
  });

  it("renders page two, bare page-one navigation and page-N canonical/share URL", async () => {
    const html = await (await archive(25).request("/events/past?page=2")).text();
    expect(keys(html)).toEqual(["archive-5", "archive-4", "archive-3", "archive-2", "archive-1"]);
    expect(html).toContain(`rel="canonical" href="${APP_URL}/events/past?page=2"`);
    expect(html).toContain(`property="og:url" content="${APP_URL}/events/past?page=2"`);
    expect(html).toContain('data-archive-page="true" href="/events/past">Newer');
    expect(html).not.toContain(">Older</a>");
  });

  it("distinguishes the never-run archive with join pitch and back link", async () => {
    const source = archive(0);
    const html = await (await source.request("/events/past")).text();
    expect(html).toContain(`data-testid="${PAST_EVENTS_EMPTY_TESTID}"`);
    expect(html).toContain(PAST_EVENTS_COPY.empty);
    expect(html).toContain(`<a href="/join">${PAST_EVENTS_COPY.join}</a>`);
    expect(html).toContain('href="/events">Back to upcoming events');
    expect(html).not.toContain(`data-testid="${PAST_EVENTS_OUT_OF_RANGE_TESTID}"`);
    expect(source.queries).toHaveLength(1); // count only: no row or aggregate read
  });

  it.each(["9", String(Math.floor(Number.MAX_SAFE_INTEGER / PAGE_SIZE) + 1)])("recovers out-of-range page %s without a row or offset query", async (page) => {
    const source = archive(25);
    const response = await source.request(`/events/past?page=${page}`);
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).toContain(pastEventsOutOfRangeCopy(Number(page), 2));
    expect(html).toContain(`rel="canonical" href="${APP_URL}/events/past?page=${page}"`);
    expect(keys(html)).toEqual([]);
    expect(source.queries).toHaveLength(1);
    expect(source.queries[0]!.sql).toMatch(/^select count\(\*\)/);
  });

  it.each(["9".repeat(400), String(Number.MAX_SAFE_INTEGER + 1), String(Number.MAX_SAFE_INTEGER),
    String(Math.floor(Number.MAX_SAFE_INTEGER / PAGE_SIZE) + 2), "0", "-1", "invalid", "",
  ])("falls back to page one for invalid page/offset input %s", async (page) => {
    const source = archive(25);
    const response = await source.request(`/events/past?page=${page}`);
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(keys(html)).toEqual(Array.from({ length: 20 }, (_, i) => `archive-${25 - i}`));
    expect(html).toContain('data-page="1"');
    expect(html).toContain(`rel="canonical" href="${APP_URL}/events/past"`);
    expect(source.queries).toHaveLength(3);
    expect(source.queries[1]!.sql).not.toContain(" offset "); // Drizzle elides zero
  });

  it.each([NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1, Number.MAX_SAFE_INTEGER, 0, -1, 1.5])("guards direct archive reads for invalid numeric page %s", async (page) => {
    const source = archive(25);
    const result = await listPast(source.db, page);
    expect(result.rows.map((row) => row.eventKey)).toEqual(Array.from({ length: 20 }, (_, i) => `archive-${25 - i}`));
    expect(result).toMatchObject({ hasMore: true, totalPages: 2 });
    expect(source.queries[1]!.sql).not.toContain(" offset ");
  });

  it.each(["02", "2.5", "2suffix"])("retains parseInt page-two behavior for %s", async (page) => {
    const html = await (await archive(25).request(`/events/past?page=${page}`)).text();
    expect(keys(html)).toEqual(["archive-5", "archive-4", "archive-3", "archive-2", "archive-1"]);
    expect(html).toContain(`rel="canonical" href="${APP_URL}/events/past?page=2"`);
  });

  it("names the page count on an out-of-range status and links back to the archive", async () => {
    const html = await (await archive(25).request("/events/past?page=9")).text();
    expect(html).toContain(`role="status" data-testid="${PAST_EVENTS_OUT_OF_RANGE_TESTID}"`);
    expect(html).toContain(pastEventsOutOfRangeCopy(9, 2));
    expect(html).toContain('data-archive-page="true" href="/events/past?page=2">Newer');
    expect(html).not.toContain(`data-testid="${PAST_EVENTS_EMPTY_TESTID}"`);
    expect(keys(html)).toEqual([]);
    expect(pastEventsOutOfRangeCopy(2, 1)).toContain("There is 1 page.");
  });

  it("uses one predicate for count/rows, stable newest-first paging and one grouped aggregate, never viewer answers", async () => {
    const source = archive(25);
    await source.request("/events/past?page=2");
    expect(source.queries).toHaveLength(3);
    const [count, rows, aggregate] = source.queries;
    expect(count!.sql.split(" where ")[1]).toBe(rows!.sql.split(" where ")[1]!.split(" order by ")[0]);
    expect(rows!.params.slice(0, 2)).toEqual(["past", "published"]);
    expect(rows!.params.slice(-2)).toEqual([21, 20]);
    expect(rows!.sql).toContain('order by "events"."starts_at" desc, "events"."id" desc');
    expect(aggregate!.sql).toContain('group by "rsvps"."event_id"');
    expect(aggregate!.sql).not.toMatch(/user_id|member_id|join/i);
    expect(source.queries.every((q) => !/join|user_id|member_id/i.test(q.sql))).toBe(true);
  });
});

type Click = {
  defaultPrevented: boolean; button: number; ctrlKey?: boolean; metaKey?: boolean;
  shiftKey?: boolean; altKey?: boolean; target: { closest: () => Link | null };
  preventDefault: () => void;
};
type Link = { href: string; target: string; hasAttribute: (name: string) => boolean };

class Node {
  childNodes: string[] = [];
  hidden = false;
  textContent = "";
  href = "";
  content = "";
  dataset: Record<string, string> = {};
  attributes = new Map<string, string>();
  focused = false;
  setAttribute(k: string, v: string) { this.attributes.set(k, v); }
  removeAttribute(k: string) { this.attributes.delete(k); }
  replaceChildren(...children: string[]) { this.childNodes = children; }
  focus() { this.focused = true; }
}

function browser(entry = "/events/past") {
  const selectors = ["[data-archive-state]", "[data-archive-list]", "[data-archive-pager]"];
  const targets = selectors.map(() => new Node());
  targets[1]!.childNodes = ["original cards"];
  const heading = new Node();
  const feedback = new Node();
  const canonical = new Node();
  canonical.href = `${APP_URL}/events/past`;
  const og = new Node();
  og.content = canonical.href;
  const root = new Node();
  root.dataset = { page: "1", totalPages: "2", loadError: PAST_EVENTS_COPY.failed };
  let click: (event: Click) => void = () => {};
  let popstate: () => void = () => {};
  const mount = Object.assign(root, {
    querySelector: (selector: string) => selector === "h1" ? heading : selector === "[data-archive-feedback]" ? feedback : targets[selectors.indexOf(selector)] ?? null,
    addEventListener: (_type: string, listener: typeof click) => { click = listener; },
    contains: () => true,
  });
  const history: string[] = [];
  const reloads: string[] = [];
  const location = { href: new URL(entry, APP_URL).href, origin: APP_URL, assign: (href: string) => reloads.push(href) };
  const requests: { url: string; init: RequestInit; resolve: (r: { ok: boolean; text: () => Promise<string> }) => void; reject: (e: Error) => void }[] = [];
  const parsedPages = new Map<string, { querySelector: (selector: string) => unknown }>();
  runInNewContext(binder, {
    URL, AbortController,
    document: {
      querySelector: (s: string) => s === '[data-island="past-events"]' ? mount : s.startsWith("link") ? canonical : og,
      importNode: (n: string) => n,
    },
    window: {
      location,
      history: { pushState: (_state: unknown, _title: string, url: string) => { history.push(url); location.href = APP_URL + url; } },
      addEventListener: (_type: string, listener: () => void) => { popstate = listener; },
    },
    DOMParser: class { parseFromString(html: string) { return parsedPages.get(html); } },
    fetch: (url: string, init: RequestInit) => new Promise((resolve, reject) => requests.push({ url, init, resolve, reject })),
  });

  function turn(page: number, modifiers: Partial<Click> = {}, href = pastEventsUrl(page)) {
    const link: Link = { href: new URL(href, APP_URL).href, target: "", hasAttribute: () => false };
    let prevented = false;
    click({ defaultPrevented: false, button: 0, target: { closest: () => link }, preventDefault: () => { prevented = true; }, ...modifiers });
    return prevented;
  }

  function finish(i: number, page: number, state = "", cards = "new cards") {
    const sources = selectors.map(() => new Node());
    sources[0]!.childNodes = [state];
    sources[1]!.childNodes = [cards];
    sources[1]!.hidden = cards === "";
    sources[2]!.childNodes = ["page links"];
    const next = { dataset: { page: String(page), totalPages: "2" }, querySelector: (s: string) => sources[selectors.indexOf(s)] };
    parsedPages.set(`page-${page}`, { querySelector: (s: string) => s.startsWith("link") ? { href: APP_URL + pastEventsUrl(page) } : next });
    requests[i]!.resolve({ ok: true, text: async () => `page-${page}` });
  }
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  return { root, targets, heading, feedback, canonical, og, requests, history, reloads, location, turn, finish, settle, popstate: () => popstate() };
}

describe("PastEvents shipped binder request/state drift", () => {
  it("fires no load/poll request, then exactly one GET per page turn and patches stable nodes", async () => {
    const b = browser();
    expect(b.requests).toHaveLength(0);
    expect(binder).not.toMatch(/setInterval|setTimeout|events\.json|\/rsvp/);
    expect(b.turn(2)).toBe(true);
    expect(b.requests).toHaveLength(1);
    expect(b.requests[0]).toMatchObject({ url: pastEventsRequest(2).url, init: { method: "GET", headers: { accept: "text/html" } } });
    expect(b.root.attributes.get("aria-busy")).toBe("true");
    b.finish(0, 2);
    await b.settle();
    expect(b.targets[1]!.childNodes).toEqual(["new cards"]);
    expect(b.canonical.href).toBe(`${APP_URL}/events/past?page=2`);
    expect(b.og.content).toBe(b.canonical.href);
    expect(b.history).toEqual(["/events/past?page=2"]);
    expect(b.heading.focused).toBe(true);
    expect(b.root.attributes.has("aria-busy")).toBe(false);
    b.turn(1);
    expect(b.requests[1]!.url).toBe("/events/past");
    b.finish(1, 1);
    await b.settle();
    expect(b.canonical.href).toBe(`${APP_URL}/events/past`);
  });

  it.each(["empty", "out-of-range"])("patches the %s SSR state without inventing client copy", async (state) => {
    const b = browser();
    b.turn(9);
    const copy = state === "empty" ? PAST_EVENTS_COPY.empty : pastEventsOutOfRangeCopy(9, 2);
    b.finish(0, 9, copy, "");
    await b.settle();
    expect(b.targets[0]!.childNodes).toEqual([copy]);
    expect(b.targets[1]!.hidden).toBe(true);
  });

  it("aborts superseded reads and ignores stale responses even if fetch ignores abort", async () => {
    const b = browser();
    b.turn(2);
    b.turn(3);
    expect(b.requests[0]!.init.signal!.aborted).toBe(true);
    b.finish(1, 3, "", "latest cards");
    await b.settle();
    b.finish(0, 2, "", "stale cards");
    await b.settle();
    expect(b.targets[1]!.childNodes).toEqual(["latest cards"]);
    expect(b.history).toEqual(["/events/past?page=3"]);
  });

  it("preserves current cards and address after a failed read, and lets the same link retry", async () => {
    const b = browser();
    b.turn(2);
    b.requests[0]!.resolve({ ok: false, text: async () => "unavailable" });
    await b.settle();
    expect(b.targets[1]!.childNodes).toEqual(["original cards"]);
    expect(b.feedback.textContent).toBe(PAST_EVENTS_COPY.failed);
    expect(b.history).toEqual([]);
    expect(b.root.attributes.has("aria-busy")).toBe(false);
    b.turn(2);
    expect(b.requests).toHaveLength(2);
  });

  it("leaves modified clicks and unrelated or external URLs to normal navigation", () => {
    const b = browser();
    expect(b.turn(2, { ctrlKey: true })).toBe(false);
    expect(b.turn(2, { metaKey: true })).toBe(false);
    expect(b.turn(2, { button: 1 })).toBe(false);
    expect(b.turn(2, {}, "/events")).toBe(false);
    expect(b.turn(2, {}, "https://elsewhere.example/events/past?page=2")).toBe(false);
    expect(b.requests).toHaveLength(0);
  });

  it.each([
    "/events/past?utm_source=discord",
    "/events/past?page=01",
    "/events/past#archive",
    "/events/past?page=0",
    "/events/past?page=invalid",
  ])("restores cards and canonical on Back to the server-valid entry %s", async (entry) => {
    const b = browser(entry);
    b.turn(2);
    b.finish(0, 2, "", "page two cards");
    await b.settle();
    b.location.href = new URL(entry, APP_URL).href;
    b.popstate();
    expect(b.requests).toHaveLength(2);
    const url = new URL(entry, APP_URL);
    expect(b.requests[1]!.url).toBe(url.pathname + url.search);
    b.finish(1, 1, "", "page one cards");
    await b.settle();
    expect(b.targets[1]!.childNodes).toEqual(["page one cards"]);
    expect(b.root.dataset.page).toBe("1");
    expect(b.canonical.href).toBe(`${APP_URL}/events/past`);
    expect(b.og.content).toBe(b.canonical.href);
    expect(b.location.href).toBe(url.href);
    expect(b.history).toEqual(["/events/past?page=2"]);
  });

  it("reloads the current address when a failed click supersedes a pending Back read", async () => {
    const b = browser();
    b.turn(2);
    b.finish(0, 2, "", "page two cards");
    await b.settle();
    b.location.href = `${APP_URL}/events/past`;
    b.popstate();
    b.turn(3);
    expect(b.requests[1]!.init.signal!.aborted).toBe(true);
    b.requests[2]!.reject(new Error("offline"));
    await b.settle();
    expect(b.reloads).toEqual([`${APP_URL}/events/past`]);
    expect(b.feedback.textContent).toBe(PAST_EVENTS_COPY.failed);
    expect(b.root.attributes.has("aria-busy")).toBe(false);
    b.finish(1, 1, "", "late page one cards");
    await b.settle();
    expect(b.targets[1]!.childNodes).toEqual(["page two cards"]);
    expect(b.canonical.href).toBe(`${APP_URL}/events/past?page=2`);
    expect(b.location.href).toBe(`${APP_URL}/events/past`);
    expect(b.history).toEqual(["/events/past?page=2"]);
  });

  it("keeps inline retry when a failed click follows a completed page turn or Back read", async () => {
    const b = browser();
    b.turn(2);
    b.finish(0, 2, "", "page two cards");
    await b.settle();
    b.turn(3);
    b.requests[1]!.reject(new Error("offline"));
    await b.settle();
    expect(b.reloads).toEqual([]);
    expect(b.location.href).toBe(`${APP_URL}/events/past?page=2`);
    b.location.href = `${APP_URL}/events/past`;
    b.popstate();
    b.finish(2, 1, "", "page one cards");
    await b.settle();
    b.turn(2);
    b.requests[3]!.reject(new Error("offline"));
    await b.settle();
    expect(b.reloads).toEqual([]);
    expect(b.targets[1]!.childNodes).toEqual(["page one cards"]);
    expect(b.location.href).toBe(`${APP_URL}/events/past`);
    expect(b.canonical.href).toBe(b.location.href);
  });

  it("handles back/forward without a second history entry and reloads SSR on history-read failure", async () => {
    const b = browser();
    b.location.href = `${APP_URL}/events/past?page=2`;
    b.popstate();
    b.finish(0, 2);
    await b.settle();
    expect(b.requests[0]!.url).toBe("/events/past?page=2");
    expect(b.history).toEqual([]);
    b.location.href = `${APP_URL}/events/past`;
    b.popstate();
    b.requests[1]!.reject(new Error("offline"));
    await b.settle();
    expect(b.reloads).toEqual([`${APP_URL}/events/past`]);
  });
});

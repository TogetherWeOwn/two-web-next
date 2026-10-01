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
import { createMemorySessionStore } from "../src/sessions";

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

const binder = readFileSync(new NodeURL("../public/islands/going-count.js", import.meta.url), "utf8");

// Real Drizzle queries and Hono rendering; all data is local, no DB connection.
function fixture(over: Partial<typeof events.$inferSelect> = {}) {
  const start = new Date("2030-01-10T20:00:00Z");
  const row: typeof events.$inferSelect = {
    id: 1, eventKey: KEY, title: "Chess night", game: "Chess", description: "Bring a friend & a board.",
    startsAt: start, endsAt: new Date("2030-01-10T22:00:00Z"), timezone: "UTC",
    location: "The lobby & voice channel", capacity: 10, status: "published", rsvpOpen: true,
    discordEventId: null, discordSyncFailedAt: null, discordSyncFailureCode: null,
    createdBy: null, recurrenceFrequency: null, recurrenceCount: null,
    recurrenceEndsOn: null, parentEventId: null, recurrenceIndex: null, createdAt: start, updatedAt: start,
    ...over,
  };
  const columns = Object.keys(getTableColumns(events)) as (keyof typeof row)[];
  const db = drizzle(async (sql) => {
    if (sql.includes('from "rsvps"') && sql.includes('inner join "users"')) return { rows: [] };
    if (sql.includes('from "rsvps"')) return { rows: [[row.id, 3]] };
    if (sql.includes('"event_key" =')) {
      return { rows: [columns.map((key) => row[key] instanceof Date ? (row[key] as Date).toISOString() : row[key])] };
    }
    return { rows: [] };
  });
  const env = {
    APP_URL: `${APP_URL}/`,
    SESSION_SECRET: SECRET,
    SESSION_STORE: createMemorySessionStore(),
    ADMIN_DB: db as unknown as Db,
  } as unknown as Env;
  return { request: () => app.request(PATH, {}, env) };
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
    expect(html).toContain('data-spots>7 of 10 spots left</span>');
    // Silent on first render: the announcement node exists but is empty.
    expect(html).toContain('data-announcement></span>');
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

function browser(html: string) {
  const { mount, count, announcement, spots } = mountFromSsr(html);
  const listeners: ((event: { detail: { eventKey?: string; viewerState?: string } }) => void)[] = [];
  const requests: PendingRequest[] = [];
  const documentEl = new Node();
  const documentStub = {
    documentElement: documentEl,
    addEventListener: (type: string, listener: (event: { detail: { eventKey?: string; viewerState?: string } }) => void) => {
      if (type === "going-count-updated") listeners.push(listener);
    },
    querySelectorAll: (selector: string) => (selector === '[data-island="going-count"]' ? [mount] : []),
  };
  const evalBinder = () =>
    runInNewContext(binder, {
      document: documentStub,
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
  return { mount, count, announcement, spots, listeners, requests, broadcast, settle, evalBinder, okJson, documentEl };
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
    expect(b.requests[0]!.url).toBe("/events.json");
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

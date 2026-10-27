// Failing-first acceptance: Happening-soon suggestions on unknown-member 404s.
//
// T6 from the roadmap (M193): both profile-404 arms (bad snowflake + unknown
// member) render a bare <NotFoundPage /> while events exist. The build fills
// the Happening-soon slot via the cached session-free suggestions pattern
// proven in the same boundary (src/events/routes-detail.tsx): one fill per
// TTL, never one transaction per probe.
//
// Test files only: the sibling build card builds on this branch and never
// edits this file. The slot/cache tests below fail on current code (bare 404,
// no suggestions) and pass once the build threads cachedNotFoundSuggestions
// through both arms. Controls pin what must not change: 404 status/headers,
// empty-calendar fallback, DB-failure fail-open, no access-log row for
// unknown ids, live profiles still 200.
//
// Hermetic (pg-proxy doubles), following test/event-detail-not-found-cache:
// the proxy driver has no transactions, so a cold in-boundary fill cannot
// return rows here. Instead an ordinary 404 warms the shared per-isolate
// snapshot outside the boundary (where the proxy works), and the profile
// arms must serve that same snapshot with no fresh suggestion read while it
// is valid. Row rendering through the boundary is covered DB-backed by the
// existing event-detail suite; local fixtures only, no network.
import { drizzle } from "drizzle-orm/pg-proxy";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EnvWithAdminDb } from "../src/admin/db";
import type { Db } from "../src/db/index";
import * as suggestions from "../src/events/suggestions";
import { NOT_FOUND_SUGGESTIONS_TTL_MS } from "../src/not-found-suggestions";
import { profilesApp } from "../src/profiles/routes";
import { createMemoryProfileStore } from "../src/profiles/store";
import { createMemorySessionStore } from "../src/sessions";
import warmApp from "./app";
import { cookieFor, env, MEMBER, MODERATOR } from "./helpers/member-data";

const T0 = Date.parse("2026-10-02T12:00:00Z");

const BAD_SNOWFLAKE = "/members/not-a-snowflake";
const UNKNOWN_MEMBER = "/members/999999999999999999";

type Row = { key: string; title: string };
const row = (key: string): Row => ({ key, title: `Event ${key}` });

// Each test gets its own binding, so the per-isolate cache never carries rows
// between tests: it is keyed on the DB source.
function suggestionsDb(initial: Row[]) {
  const state = { rows: initial };
  const query = vi.fn(async (sql: string) => ({
    rows: sql.includes('from "events"')
      ? state.rows.map((r) => [r.key, r.title, "2026-10-03T18:00:00Z", null])
      : [],
  }));
  const db = drizzle(query);
  const transaction = vi.fn(async (fn: (tx: Db) => Promise<unknown>) => fn(db as unknown as Db));
  Object.assign(db, { transaction });
  return { db: db as unknown as Db, state, transaction, query };
}

function harness(suggestions: Row[]) {
  const sessions = createMemorySessionStore();
  const store = createMemoryProfileStore([
    {
      id: MEMBER.userId,
      username: MEMBER.username,
      avatar: null,
      bio: null,
      games: [],
      timezone: null,
    },
  ]);
  const accessLog = vi.fn(async () => false);
  const app = profilesApp({
    sessionStore: sessions,
    store,
    stats: async () => null,
    accessLog,
  });
  const { db, state, transaction, query } = suggestionsDb(suggestions);
  const envWithDb = { ...env, ADMIN_DB: db } as EnvWithAdminDb;
  return { app, sessions, accessLog, envWithDb, state, transaction, query };
}

// Ordinary 404 warms the shared snapshot outside the member-read boundary,
// where the proxy double supports transactions. Returns the warmed rows.
async function warmSnapshot(envWithDb: EnvWithAdminDb): Promise<string[]> {
  const res = await warmApp.request("/lost/link", {}, envWithDb);
  expect(res.status).toBe(404);
  const html = await res.text();
  expect(html).toContain("We cannot find that page");
  return suggested(html);
}

async function member404(
  app: ReturnType<typeof profilesApp>,
  path: string,
  cookie: string,
  envWithDb: EnvWithAdminDb,
) {
  const res = await app.request(path, { headers: { cookie } }, envWithDb);
  const html = await res.text();
  expect(res.status, path).toBe(404);
  expect(res.headers.get("cache-control"), path).toBe("private, no-store");
  expect(html, path).toContain("We cannot find that page");
  expect(html, path).toContain('content="noindex, nofollow"');
  expect(html, path).toContain('action="/events" method="get" role="search"');
  return html;
}

const suggested = (html: string): string[] =>
  [...html.matchAll(/href="\/e\/([^"]+)" data-testid="error-event-suggestion"/g)].map((m) => m[1]!);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("unknown-member 404s fill the Happening-soon slot (failing-first)", () => {
  it("bad snowflake arm serves the shared snapshot with no fresh suggestion read", async () => {
    const { app, sessions, accessLog, envWithDb } = harness([row("game-night"), row("quiz")]);
    const fills = vi.spyOn(suggestions, "notFoundSuggestions");
    expect(await warmSnapshot(envWithDb)).toEqual(["game-night", "quiz"]);
    expect(fills).toHaveBeenCalledOnce();
    const html = await member404(app, BAD_SNOWFLAKE, await cookieFor(sessions, MEMBER), envWithDb);
    expect(html).toContain("Happening soon");
    expect(suggested(html)).toEqual(["game-night", "quiz"]);
    expect(html).not.toContain('data-testid="error-events-empty"');
    expect(html).toContain('href="/events" data-testid="error-all-events"');
    expect(fills).toHaveBeenCalledOnce();
    expect(accessLog).not.toHaveBeenCalled();
  });

  it("unknown member arm serves the shared snapshot with no fresh suggestion read", async () => {
    const { app, sessions, accessLog, envWithDb } = harness([row("game-night"), row("quiz")]);
    const fills = vi.spyOn(suggestions, "notFoundSuggestions");
    expect(await warmSnapshot(envWithDb)).toEqual(["game-night", "quiz"]);
    expect(fills).toHaveBeenCalledOnce();
    const html = await member404(app, UNKNOWN_MEMBER, await cookieFor(sessions, MEMBER), envWithDb);
    expect(html).toContain("Happening soon");
    expect(suggested(html)).toEqual(["game-night", "quiz"]);
    expect(html).not.toContain('data-testid="error-events-empty"');
    expect(html).toContain('href="/events" data-testid="error-all-events"');
    expect(fills).toHaveBeenCalledOnce();
    expect(accessLog).not.toHaveBeenCalled();
  });

  it("one fill per TTL across both arms and both viewers, never one transaction per probe", async () => {
    const { app, sessions, envWithDb } = harness([row("game-night")]);
    const fills = vi.spyOn(suggestions, "notFoundSuggestions");
    expect(await warmSnapshot(envWithDb)).toEqual(["game-night"]);
    const alice = await cookieFor(sessions, MEMBER);
    const bob = await cookieFor(sessions, MODERATOR);
    // Mix arms and viewers within the TTL: every 404 serves the same slot.
    const paths = [BAD_SNOWFLAKE, UNKNOWN_MEMBER, BAD_SNOWFLAKE, UNKNOWN_MEMBER];
    const cookies = [alice, bob, bob, alice];
    for (let i = 0; i < paths.length; i++) {
      vi.setSystemTime(T0 + (i + 1) * 1_000);
      expect(suggested(await member404(app, paths[i]!, cookies[i]!, envWithDb))).toEqual([
        "game-night",
      ]);
    }
    // Session-free snapshot: one fill serves every viewer and every arm.
    expect(fills).toHaveBeenCalledOnce();
  });

  it("tracks the shared snapshot refresh after the TTL", async () => {
    const { app, sessions, envWithDb, state } = harness([row("before")]);
    const fills = vi.spyOn(suggestions, "notFoundSuggestions");
    expect(await warmSnapshot(envWithDb)).toEqual(["before"]);
    const cookie = await cookieFor(sessions, MEMBER);
    expect(suggested(await member404(app, BAD_SNOWFLAKE, cookie, envWithDb))).toEqual(["before"]);
    expect(fills).toHaveBeenCalledOnce();
    // Past the TTL the snapshot refreshes once; both arms track the new rows.
    state.rows = [row("after")];
    vi.setSystemTime(T0 + NOT_FOUND_SUGGESTIONS_TTL_MS);
    expect(await warmSnapshot(envWithDb)).toEqual(["after"]);
    expect(fills).toHaveBeenCalledTimes(2);
    // A fresh login past the jump: the first view rotated the original
    // bearer, whose 10s grace cannot span the TTL.
    const fresh = await cookieFor(sessions, MEMBER);
    expect(suggested(await member404(app, UNKNOWN_MEMBER, fresh, envWithDb))).toEqual(["after"]);
    expect(suggested(await member404(app, BAD_SNOWFLAKE, fresh, envWithDb))).toEqual(["after"]);
    expect(fills).toHaveBeenCalledTimes(2);
  });
});

describe("profile 404 fallback the build must not change", () => {
  it.each([BAD_SNOWFLAKE, UNKNOWN_MEMBER])(
    "%s renders the empty-calendar fallback when no events exist",
    async (path) => {
      const { app, sessions, envWithDb } = harness([]);
      expect(await warmSnapshot(envWithDb)).toEqual([]);
      const html = await member404(app, path, await cookieFor(sessions, MEMBER), envWithDb);
      expect(suggested(html)).toEqual([]);
      expect(html).toContain('data-testid="error-events-empty"');
      expect(html).toContain("Nothing is on the calendar right now — check back soon.");
      expect(html).toContain('href="/events" data-testid="error-all-events"');
    },
  );

  it.each([BAD_SNOWFLAKE, UNKNOWN_MEMBER])(
    "%s keeps a fail-open 404 with the search form when the snapshot fill fails",
    async (path) => {
      const { app, sessions, envWithDb, transaction } = harness([row("game-night")]);
      transaction.mockRejectedValueOnce(new Error("private database failure"));
      expect(await warmSnapshot(envWithDb)).toEqual([]);
      const html = await member404(app, path, await cookieFor(sessions, MEMBER), envWithDb);
      expect(suggested(html)).toEqual([]);
      expect(html).toContain('data-testid="error-events-empty"');
      expect(html).toContain('action="/events" method="get" role="search"');
      expect(html).not.toContain("private database failure");
    },
  );

  it("live profiles still render 200 with no error shell", async () => {
    const { app, sessions, envWithDb } = harness([row("game-night")]);
    const res = await app.request(
      `/members/${MEMBER.userId}`,
      { headers: { cookie: await cookieFor(sessions, MEMBER) } },
      envWithDb,
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(MEMBER.username);
    expect(html).not.toContain("We cannot find that page");
    expect(html).not.toContain('data-testid="error-events-search"');
  });
});

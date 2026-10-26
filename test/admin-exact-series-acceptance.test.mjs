// Independent acceptance handoff. RED cases name missing exact saved-series
// behavior; CONTROLs protect existing classification, privacy and bounded reads.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { events } from "../src/db/admin-schema.ts";
import { adminSchema, schema } from "../src/db/index.ts";
import { validateNonSensitiveRead } from "../src/db/read-classification.ts";
import { MemberReadRefused } from "../src/member-reads.ts";
import { getEventSeriesContext } from "../src/events/reads.ts";
import {
  compileSeriesKit,
  createSeriesFixture,
  key,
  links,
  nextLink,
  reviewLink,
  rowKeys,
  scopeUrl,
  stripTags,
} from "./helpers/admin-exact-series.mjs";

let f;
let kit;
beforeAll(async () => {
  kit = await compileSeriesKit();
  f = await createSeriesFixture();
});
afterAll(async () => {
  await f?.dispose();
  kit?.dispose();
});
const ids = (values) => values.map(key);
const privateResponse = (r) => {
  expect(r.headers["cache-control"]).toMatch(/private/);
  expect(r.headers["cache-control"]).toMatch(/no-store/);
};
const allEvents = (html) => links(html).find((a) => /^All events$/i.test(a.text));

for (const twin of ["Hono", "Kit"]) {
  describe(`${twin} executed editor and exact inventory`, () => {
    const request = (path, actor, db) => f.request(twin, kit, path, actor, db);
    for (const id of [100, 101, 102, 103, 104]) {
      it(`RED: saved ${id === 100 ? "parent" : "child"} ${id} exposes a persisted-key series action`, async () => {
        const r = await request(`/admin/events/${key(id)}`);
        expect(r.status).toBe(200);
        privateResponse(r);
        const link = reviewLink(r.html);
        expect(link, "saved editor needs the named series review action").toBeDefined();
        const url = new URL(link.href, "https://next.example.test");
        expect(url.pathname).toBe("/admin/events");
        // A child key or a canonical parent key is valid: both must resolve the
        // same persisted recurrence. Class-only/title-search links are not.
        expect([key(100), key(id)]).toContain(url.searchParams.get("series_event"));
        expect(url.searchParams.has("q")).toBe(false);
        expect(url.searchParams.has("series")).toBe(false);
        const inventory = await request(url.pathname + url.search);
        expect(rowKeys(inventory.html)).toEqual(ids(Array.from({ length: 25 }, (_, i) => 100 + i)));
      });
    }
    it("CONTROL: standalone saved editor never advertises a series", async () => {
      const r = await request(`/admin/events/${key(300)}`);
      expect(r.status).toBe(200);
      expect(reviewLink(r.html)).toBeUndefined();
    });
    it("RED: submitted-looking URL fields cannot redirect the saved action to another series", async () => {
      const r = await request(
        `/admin/events/${key(101)}?title=Unsaved&game=Other&parent_event_id=200&recurrence_frequency=weekly&series_event=${key(200)}`,
      );
      const link = reviewLink(r.html);
      expect(link).toBeDefined();
      expect([key(100), key(101)]).toContain(
        new URL(link.href, "https://next.example.test").searchParams.get("series_event"),
      );
      expect(link.href).not.toContain("Unsaved");
    });
    it("RED: exact scope includes every stored status, renamed siblings, but not same-title decoys", async () => {
      const r = await request(scopeUrl());
      expect(r.status).toBe(200);
      privateResponse(r);
      expect(rowKeys(r.html)).toEqual(ids(Array.from({ length: 25 }, (_, i) => i + 100)));
      expect(r.html).toContain("Renamed occurrence");
      for (const status of ["draft", "published", "cancelled", "past"])
        expect(r.html).toMatch(new RegExp(`data-testid="event-status-[^"]+">${status}<`));
      const captured = /<h1\b[^>]*>([\s\S]*?)<\/h1>/.exec(r.html)?.[1];
      const heading = captured === undefined ? captured : stripTags(captured);
      expect(heading).toMatch(/series/i);
      expect(heading).toContain("Saved &lt;night&gt; &amp; friends");
      expect(r.html).not.toMatch(/audited (?:before|change)|all affected changes/i);
    });
    it("RED: child entry resolves its stored parent, not its different title/game", async () => {
      const parent = await request(scopeUrl(100));
      const child = await request(scopeUrl(101));
      expect(rowKeys(child.html)).toEqual(ids(Array.from({ length: 25 }, (_, i) => i + 100)));
      expect(rowKeys(child.html)).toEqual(rowKeys(parent.html));
    });
    it("RED: ascending default, stable ties, 25-row pages and explicit All events escape", async () => {
      const first = await request(scopeUrl());
      expect(rowKeys(first.html)).toHaveLength(25);
      expect(first.html).toMatch(/aria-sort="ascending"/);
      const next = nextLink(first.html);
      expect(next).toBeDefined();
      const url = new URL(next.href, "https://next.example.test");
      expect(url.searchParams.get("series_event")).toBe(key(100));
      expect(url.searchParams.get("page")).toBe("2");
      const second = await request(url.pathname + url.search);
      expect(rowKeys(second.html)).toEqual(ids([125, 126, 127, 128, 129]));
      expect(new Set([...rowKeys(first.html), ...rowKeys(second.html)]).size).toBe(30);
      expect(nextLink(second.html)).toBeUndefined();
      const escape = allEvents(second.html);
      expect(escape).toBeDefined();
      const escaped = new URL(escape.href, "https://next.example.test");
      expect(escaped.pathname).toBe("/admin/events");
      expect(escaped.searchParams.has("series_event")).toBe(false);
      const unscoped = await request(escaped.pathname + escaped.search);
      expect(unscoped.status).toBe(200);
      const unscopedNext = nextLink(unscoped.html);
      expect(unscopedNext).toBeDefined();
      const remaining = await request(unscopedNext.href);
      expect([...rowKeys(unscoped.html), ...rowKeys(remaining.html)]).toContain(key(200));
      expect([...rowKeys(unscoped.html), ...rowKeys(remaining.html)]).toContain(key(300));
    });
    for (const [status, expected] of [
      ["draft", [100, 101, 105, 109, 113, 117, 121, 125, 129]],
      ["published", [102, 106, 110, 114, 118, 122, 126]],
      ["cancelled", [103, 107, 111, 115, 119, 123, 127]],
      ["past", [104, 108, 112, 116, 120, 124, 128]],
    ]) {
      it(`RED: status=${status} intersects exact scope instead of hiding stored siblings by default`, async () => {
        const r = await request(scopeUrl(100, `status=${status}&order=asc`));
        expect(r.status).toBe(200);
        expect(rowKeys(r.html)).toEqual(ids(expected));
      });
    }
    it("RED: search/class/fill/RSVP filters intersect scope and the GET form/sorts retain it", async () => {
      const path = scopeUrl(
        100,
        "q=Saved&status=draft&series=child&fill=has_seats&rsvp_open=1&sort=title&order=asc&page=1",
      );
      const r = await request(path);
      // 101 matches only its saved game, not its renamed title. Ascending title
      // puts Renamed before Saved; toggling that sort puts it after the ties.
      expect(rowKeys(r.html)).toEqual(ids([101, 105, 109, 113, 117, 121, 125, 129]));
      expect(r.html).toMatch(new RegExp(`name="series_event"[^>]*value="${key(100)}"`));
      const sortedIds = {
        title: [105, 109, 113, 117, 121, 125, 129, 101],
        status: [101, 105, 109, 113, 117, 121, 125, 129],
        starts_at: [101, 105, 109, 113, 117, 121, 125, 129],
      };
      const sorts = links(r.html).filter((a) => /aria-label="Sort by/.test(a.attrs));
      expect(sorts).toHaveLength(3);
      for (const link of sorts) {
        const url = new URL(link.href, "https://next.example.test");
        for (const [k, v] of Object.entries({
          series_event: key(100),
          q: "Saved",
          status: "draft",
          series: "child",
          fill: "has_seats",
          rsvp_open: "1",
        }))
          expect(url.searchParams.get(k)).toBe(v);
        expect(url.searchParams.has("page")).toBe(false);
        expect(rowKeys((await request(url.pathname + url.search)).html)).toEqual(
          ids(sortedIds[url.searchParams.get("sort")]),
        );
      }
    });
    it("CONTROL: a game-only search still intersects saved scope and status", async () => {
      const query = "q=Different%20saved%20game&series=child&fill=has_seats&rsvp_open=1";
      const matching = await request(scopeUrl(100, `${query}&status=draft`));
      expect(matching.status).toBe(200);
      expect(rowKeys(matching.html)).toEqual(ids([101]));
      const excluded = await request(scopeUrl(100, `${query}&status=published`));
      expect(excluded.status).toBe(200);
      expect(rowKeys(excluded.html)).toEqual([]);
      const otherSeries = await request(scopeUrl(200, query));
      expect(otherSeries.status).toBe(200);
      expect(rowKeys(otherSeries.html)).toEqual([]);
    });
    it("RED: clearing a filter is not clearing the series; impossible class intersection stays scoped", async () => {
      const noMatches = await request(scopeUrl(100, "series=standalone"));
      expect(noMatches.status).toBe(200);
      expect(rowKeys(noMatches.html)).toEqual([]);
      expect(noMatches.html).toMatch(/series/i);
      const cleared = await request(scopeUrl(100));
      expect(rowKeys(cleared.html)).not.toContain(key(300));
    });
    for (const raw of ["", "invalid", "100", key(999), key(300), "%3Cscript%3E", "x".repeat(300)]) {
      it(`RED: unavailable/invalid exact scope ${JSON.stringify(raw.slice(0, 30))} never silently lists All events`, async () => {
        const r = await request(`/admin/events?series_event=${raw}`);
        expect(
          rowKeys(r.html),
          "an invalid requested series must not become an unscoped success",
        ).toEqual([]);
        expect([200, 400, 404, 422]).toContain(r.status);
        privateResponse(r);
        expect(r.html.replace(/<[^>]*>/g, " ")).toMatch(
          /series.*(?:unavailable|not found|invalid|cannot|could not|not part)|(?:unavailable|not found|invalid).*series/i,
        );
        expect(allEvents(r.html)).toBeDefined();
        expect(r.html).not.toContain("<script>");
      });
    }
    it("RED: stored scope resolution outage refuses safely instead of returning an unscoped list", async () => {
      let failedScopeReads = 0;
      const failureDb = drizzle(f.client, {
        schema: { ...schema, ...adminSchema },
        logger: {
          logQuery(sql) {
            if (/\bwhere\b[\s\S]*\"(?:event_key|parent_event_id)\"\s*=/i.test(sql)) {
              failedScopeReads++;
              throw Object.assign(new Error("synthetic scope read unavailable"), {
                code: "ECONNREFUSED",
              });
            }
          },
        },
      });
      const r = await request(scopeUrl(), "moderator", failureDb);
      expect(r.status).toBe(503);
      expect(failedScopeReads).toBe(1);
      expect(rowKeys(r.html)).toEqual([]);
      privateResponse(r);
      expect(r.html).not.toContain("synthetic scope read");
    });
    it("CONTROL: class Parent remains independent, not a synonym for one recurrence", async () => {
      const r = await request("/admin/events?series=parent&order=asc");
      expect(r.status).toBe(200);
      expect(rowKeys(r.html)).toEqual(ids([100, 200]));
    });
    it("CONTROL: unscoped inventory still defaults descending and preserves all classes", async () => {
      const r = await request("/admin/events");
      expect(r.status).toBe(200);
      expect(r.html).toMatch(/aria-sort="descending"/);
      const second = await request("/admin/events?page=2");
      expect([...rowKeys(r.html), ...rowKeys(second.html)]).toContain(key(200));
      expect([...rowKeys(r.html), ...rowKeys(second.html)]).toContain(key(300));
    });
    it("CONTROL: no member projection, event mutation, audit write or queue dispatch in scoped inventory", async () => {
      const r = await request(scopeUrl());
      expect(r.status).toBe(200);
      expect(f.queries.length).toBeGreaterThan(0);
      for (const q of f.queries) {
        expect(q.sql).not.toMatch(/\b(?:insert|update|delete|truncate)\b/i);
        expect(q.sql).not.toMatch(/\b(?:users|profiles|member_data_access_logs|activity_log)\b/i);
        // Going-only aggregate is allowed; identities/roster data are not.
        expect(q.sql).not.toMatch(/\b(?:user_id|username|discord_id)\b/i);
      }
      expect(r.html).not.toContain("100000000000000103");
      if (r.audit) expect(r.audit).toEqual([]);
    });
    it("CONTROL: inventory transport retains transaction-local bounds and at most 26 event rows", async () => {
      const r = await request(scopeUrl());
      expect(r.status).toBe(200);
      const queries = [...f.queries];
      const timeoutIndex = queries.findIndex((q) => q.sql.includes("set_config('lock_timeout'"));
      const inventoryIndex = queries.findIndex((q) => /from "events"[\s\S]*order by/i.test(q.sql));
      expect(timeoutIndex).toBeGreaterThanOrEqual(0);
      expect(inventoryIndex).toBeGreaterThan(timeoutIndex);
      // The new persisted-scope lookup must not precede the bound either;
      // bounding only the eventual page query leaves a stalled resolver open.
      const firstEventRead = queries.findIndex((q) => /from "events"/i.test(q.sql));
      expect(firstEventRead).toBeGreaterThan(timeoutIndex);
      expect(queries[timeoutIndex].params).toEqual(["2000ms", "2000ms"]);
      const q = queries[inventoryIndex];
      const limit = /\blimit \$(\d+)/i.exec(q.sql);
      expect(limit).not.toBeNull();
      expect(q.params[Number(limit[1]) - 1]).toBe(26);
      expect(q.sql).toMatch(/"events"\."id" asc/);
      expect(queries.filter((q) => /from "events"/i.test(q.sql)).length).toBeLessThanOrEqual(3);
    });
    it("CONTROL: non-moderator cannot obtain exact-scope contents", async () => {
      const r = await request(scopeUrl(), "member");
      expect(r.status).toBe(403);
      expect(rowKeys(r.html)).toEqual([]);
      expect(f.queries).toEqual([]);
    });
  });
}

it("CONTROL: fixture replays rotated authentication beyond predecessor grace", async () => {
  let now = Date.now();
  const rotating = await createSeriesFixture({ clock: () => now });
  try {
    const first = await rotating.request("Hono", kit, `/admin/events/${key(101)}`);
    expect(first.status).toBe(200);
    expect(first.headers["set-cookie"]).toBeDefined();
    // Only the session store's existing clock seam advances. Real route auth,
    // cookie signing, rotation, expiry and PostgreSQL reads stay in place.
    now += 10_001;
    const second = await rotating.request("Hono", kit, scopeUrl());
    expect(second.status).toBe(200);
    expect(rowKeys(second.html)).toHaveLength(25);
    expect(second.headers["set-cookie"]).toBeDefined();
    now += 10_001;
    const rejected = await rotating.rejectedDraft(101);
    expect(rejected.status).toBe(422);
    expect(rejected.html).toContain("UNSAVED other series");
    expect(reviewLink(rejected.html)).toBeDefined();
    const denied = await rotating.request("Hono", kit, scopeUrl(), "member");
    expect(denied.status).toBe(403);
    expect(rowKeys(denied.html)).toEqual([]);
    const guest = await rotating.request("Hono", kit, scopeUrl(), "guest");
    expect(guest.status).toBe(302);
    expect(rowKeys(guest.html)).toEqual([]);
  } finally {
    await rotating.dispose();
  }
});

it("RED: a native rejected draft keeps the saved series action, never its submitted parent/title", async () => {
  const r = await f.rejectedDraft(101);
  expect(r.status).toBe(422);
  expect(r.html).toContain("UNSAVED other series");
  const link = reviewLink(r.html);
  expect(link).toBeDefined();
  expect([key(100), key(101)]).toContain(
    new URL(link.href, "https://next.example.test").searchParams.get("series_event"),
  );
  expect(link.href).not.toContain("UNSAVED");
  expect(f.queries.some((q) => /\b(?:insert|update|delete)\b/i.test(q.sql))).toBe(false);
});

it("CONTROL: unsaved create form with recurrence-looking fields has no saved-series action", async () => {
  const r = await f.request(
    "Hono",
    kit,
    `/admin/events/new?recurrence_frequency=weekly&series_event=${key(100)}`,
  );
  expect(r.status).toBe(200);
  expect(reviewLink(r.html)).toBeUndefined();
});

it("CONTROL: public series context still excludes drafts/cancelled and keeps its independent 53-row bound", async () => {
  f.queries.length = 0;
  const context = await getEventSeriesContext(f.db, {
    id: 102,
    parentEventId: 100,
    recurrenceIndex: 3,
    recurrenceFrequency: null,
    organizer_name: null,
  });
  expect(context.previous).toBeNull();
  expect(context.next.eventKey).toBe(key(104));
  const sql = f.queries.find((q) => q.sql.includes("isfinite"));
  expect(sql).toBeDefined();
  expect(sql.params).toContain("published");
  expect(sql.params).toContain("past");
  expect(sql.params).not.toContain("draft");
  expect(sql.params).not.toContain("cancelled");
  expect(sql.params.at(-1)).toBe(53);
});

const eventFields = [{ path: ["eventKey"], field: events.eventKey }];
for (const [name, statement] of [
  [
    "member join",
    'select "events"."event_key" from "events" inner join "users" on true where "events"."parent_event_id" = $1 limit $2',
  ],
  [
    "member scalar",
    'select "event_key", (select "username" from "users" limit 1) from "events" where "parent_event_id" = $1 limit $2',
  ],
  [
    "roster identity",
    'select "events"."event_key" from "events" inner join "rsvps" on "rsvps"."event_id" = "events"."id" where "events"."parent_event_id" = $1 limit $2',
  ],
  [
    "profile probe",
    'select "event_key" from "events" where "parent_event_id" = $1 and exists (select 1 from "profiles") limit $2',
  ],
]) {
  it(`CONTROL: series extension cannot admit ${name} as a non-sensitive event read`, () => {
    expect(() => validateNonSensitiveRead("events", statement, eventFields)).toThrow(
      MemberReadRefused,
    );
  });
}

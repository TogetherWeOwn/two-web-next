// Regression coverage for the exact saved-series review findings: admitted
// seed scopes on demo bindings, empty/overlong scope retention through the
// rendered GET form, and pre-database admission/canonicalization. Seed
// inventory resolution is the expected-red product gap on the reviewed head;
// every other case protects behavior that already ships. Fixture bindings
// only: APP_URL values are local strings, never live hosts.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { adminSchema, schema } from "../src/db/index.ts";
import { STAGING_APP_URL } from "../src/qa.ts";
import { listEvents, listSeriesEvents } from "../src/admin/store-event-reads.ts";
import {
  compileSeriesKit,
  createSeriesFixture,
  decode,
  key,
  links,
  reviewLink,
  rowKeys,
} from "./helpers/admin-exact-series.mjs";

const PROD_APP_URL = "https://togetherweown.com";
const LOCAL_APP_URL = "http://localhost:8787";
const SEED_PARENT = "seed-calendar-05";
const SEED_CHILD = "seed-calendar-06";
const SEED_FAMILY = [SEED_PARENT, SEED_CHILD, "seed-calendar-07"];
const LETTER_PARENT = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const LETTER_CHILD = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
const ULID_FAMILY = Array.from({ length: 25 }, (_, i) => key(100 + i));
const BASE = "https://next.example.test";

const extraRow = (over) => ({
  title: "Seed saved series",
  game: "Chess",
  description: "Synthetic event description",
  timezone: "UTC",
  capacity: 8,
  rsvpOpen: true,
  startsAt: new Date("2099-11-01T20:00:00Z"),
  endsAt: new Date("2099-11-01T22:00:00Z"),
  ...over,
});
const extraRows = [
  extraRow({
    id: 500,
    eventKey: SEED_PARENT,
    status: "published",
    recurrenceFrequency: "weekly",
    recurrenceCount: 3,
    recurrenceIndex: 1,
  }),
  extraRow({
    id: 501,
    eventKey: SEED_CHILD,
    status: "draft",
    parentEventId: 500,
    recurrenceIndex: 2,
  }),
  extraRow({
    id: 502,
    eventKey: "seed-calendar-07",
    status: "cancelled",
    parentEventId: 500,
    recurrenceIndex: 3,
  }),
  // Same-title/same-game seed decoy: saved, but not a recurrence member.
  extraRow({ id: 503, eventKey: "seed-calendar-08", status: "published" }),
  extraRow({
    id: 600,
    eventKey: LETTER_PARENT,
    title: "Letter saved series",
    status: "draft",
    recurrenceFrequency: "weekly",
    recurrenceCount: 2,
    recurrenceIndex: 1,
  }),
  extraRow({
    id: 601,
    eventKey: LETTER_CHILD,
    title: "Letter saved series",
    status: "published",
    parentEventId: 600,
    recurrenceIndex: 2,
  }),
];

const ENVS = [
  ["production", PROD_APP_URL],
  ["staging", STAGING_APP_URL],
  ["local", LOCAL_APP_URL],
];
let envs;
beforeAll(async () => {
  envs = [];
  for (const [name, appUrl] of ENVS) {
    const kit = await compileSeriesKit({ appUrl });
    try {
      const fixture = await createSeriesFixture({ appUrl, extraRows });
      envs.push({ name, appUrl, kit, fixture });
    } catch (e) {
      kit.dispose();
      throw e;
    }
  }
});
afterAll(async () => {
  for (const entry of envs ?? []) {
    await entry.fixture.dispose();
    entry.kit.dispose();
  }
});
const envNamed = (name) => envs.find((e) => e.name === name);
const request = (entry, twin, path, actor, db) =>
  entry.fixture.request(twin, entry.kit, path, actor, db);
const privateResponse = (r) => {
  expect(r.headers["cache-control"]).toMatch(/private/);
  expect(r.headers["cache-control"]).toMatch(/no-store/);
};
const allEvents = (html) => links(html).find((a) => /^All events$/i.test(a.text));
// Genuinely mixed case: alphabetic characters alternate lower/upper by
// alphabetic position, so the result matches neither uniform spelling.
const mixedCase = (value) => {
  let letterIndex = 0;
  return [...value]
    .map((c) => (/[A-Z]/i.test(c) ? (letterIndex++ % 2 ? c.toUpperCase() : c.toLowerCase()) : c))
    .join("");
};

// Real drizzle over the fixture pool, counting every logged statement and
// every session transaction. Positive controls below prove both counters
// move on an admitted read, so a zero reading cannot pass vacuously.
function countingDb(client) {
  const queries = [];
  let transactions = 0;
  const db = drizzle(client, {
    schema: { ...schema, ...adminSchema },
    logger: {
      logQuery(sql, params) {
        queries.push({ sql, params });
      },
    },
  });
  const session = db.session;
  if (!session || typeof session.transaction !== "function")
    throw new Error("countingDb requires the postgres-js session transaction seam");
  const original = session.transaction.bind(session);
  session.transaction = (...args) => {
    transactions++;
    return original(...args);
  };
  return {
    db,
    queries,
    get transactions() {
      return transactions;
    },
    reset() {
      queries.length = 0;
      transactions = 0;
    },
  };
}

// Faithful successful-control serialization of the rendered filters form:
// DOM order, disabled controls dropped, selects submit their selected (or
// first) option, and the unnamed submit button contributes nothing.
const attrValue = (attrs, name) => {
  const match = new RegExp(`\\b${name}="([^"]*)"`).exec(attrs);
  return match === null ? undefined : decode(match[1]);
};
const hasAttr = (attrs, name) =>
  new RegExp(`\\b${name}(?:\\s|=|/|$)`).test(attrs) && attrValue(attrs, name) !== "false";
function filtersForm(html) {
  for (const match of html.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/g)) {
    if (
      attrValue(match[1], "method")?.toLowerCase() === "get" &&
      attrValue(match[1], "action") === "/admin/events" &&
      (attrValue(match[1], "class") ?? "").split(/\s+/).includes("filters")
    )
      return match[2];
  }
  return undefined;
}
function serializeFiltersForm(html) {
  const body = filtersForm(html);
  if (body === undefined) return undefined;
  const params = new URLSearchParams();
  const controls = /<input\b([^>]*)>|<select\b([^>]*)>([\s\S]*?)<\/select>/g;
  for (const match of body.matchAll(controls)) {
    if (match[1] !== undefined) {
      const attrs = match[1];
      const name = attrValue(attrs, "name");
      if (!name || hasAttr(attrs, "disabled")) continue;
      const type = (attrValue(attrs, "type") ?? "text").toLowerCase();
      if (["submit", "button", "image", "reset", "file"].includes(type)) continue;
      if ((type === "checkbox" || type === "radio") && !hasAttr(attrs, "checked")) continue;
      params.append(name, attrValue(attrs, "value") ?? "on");
    } else {
      const attrs = match[2];
      const name = attrValue(attrs, "name");
      if (!name || hasAttr(attrs, "disabled")) continue;
      const options = [...match[3].matchAll(/<option\b([^>]*)>([\s\S]*?)<\/option>/g)]
        .filter((o) => !hasAttr(o[1], "disabled"))
        .map((o) => ({
          value: attrValue(o[1], "value") ?? decode(o[2].trim()),
          selected: hasAttr(o[1], "selected"),
        }));
      const chosen = options.find((o) => o.selected) ?? options[0];
      if (chosen) params.append(name, chosen.value);
    }
  }
  return params;
}
function hiddenSeriesCarriers(html) {
  const body = filtersForm(html);
  if (body === undefined) return undefined;
  return [...body.matchAll(/<input\b([^>]*)>/g)]
    .filter(
      (m) =>
        attrValue(m[1], "type")?.toLowerCase() === "hidden" &&
        attrValue(m[1], "name") === "series_event",
    )
    .map((m) => attrValue(m[1], "value") ?? "");
}

for (const envName of ["staging", "local"]) {
  describe(`${envName} binding admits the persisted seed series`, () => {
    for (const twin of ["Hono", "Kit"]) {
      for (const entryKey of [SEED_PARENT, SEED_CHILD]) {
        it(`${twin}: RED seed editor ${entryKey} reviews its exact saved family`, async () => {
          const entry = envNamed(envName);
          const editor = await request(entry, twin, `/admin/events/${entryKey}`);
          expect(editor.status).toBe(200);
          privateResponse(editor);
          const link = reviewLink(editor.html);
          expect(link, "saved seed editor needs the named series review action").toBeDefined();
          const url = new URL(link.href, BASE);
          expect(url.pathname).toBe("/admin/events");
          expect([SEED_PARENT, entryKey]).toContain(url.searchParams.get("series_event"));
          expect(url.searchParams.has("q")).toBe(false);
          expect(url.searchParams.has("series")).toBe(false);
          const inventory = await request(entry, twin, url.pathname + url.search);
          expect(inventory.status).toBe(200);
          privateResponse(inventory);
          expect(rowKeys(inventory.html)).toEqual(SEED_FAMILY);
          expect(inventory.html).toContain("Events in this series: Seed saved series");
        });
      }
      it(`${twin}: RED seed parent and child scopes resolve the same saved membership`, async () => {
        const entry = envNamed(envName);
        const parent = await request(entry, twin, `/admin/events?series_event=${SEED_PARENT}`);
        const child = await request(entry, twin, `/admin/events?series_event=${SEED_CHILD}`);
        expect(rowKeys(parent.html)).toEqual(SEED_FAMILY);
        expect(rowKeys(child.html)).toEqual(SEED_FAMILY);
        expect(rowKeys(parent.html)).not.toContain("seed-calendar-08");
        expect(rowKeys(parent.html)).not.toContain(key(100));
      });
      it(`${twin}: standalone seed editor advertises no series`, async () => {
        const entry = envNamed(envName);
        const editor = await request(entry, twin, "/admin/events/seed-calendar-08");
        expect(editor.status).toBe(200);
        expect(reviewLink(editor.html)).toBeUndefined();
      });
      it(`${twin}: outside-range and lookalike seed scopes refuse before any database work`, async () => {
        const entry = envNamed(envName);
        const counter = countingDb(entry.fixture.client);
        for (const raw of [
          "seed-calendar-00",
          "seed-calendar-51",
          "seed-calendar-5",
          "seed-calendar-005",
          "seed-calendar-05x",
          "Seed-Calendar-05",
        ]) {
          counter.reset();
          const r = await request(
            entry,
            twin,
            `/admin/events?series_event=${encodeURIComponent(raw)}`,
            "moderator",
            counter.db,
          );
          expect(r.status, raw).toBe(200);
          expect(r.html, raw).toContain('data-testid="series-scope-recovery"');
          expect(rowKeys(r.html), raw).toEqual([]);
          expect(counter.queries, raw).toEqual([]);
          expect(counter.transactions, raw).toBe(0);
        }
        counter.reset();
        const control = await request(
          entry,
          twin,
          `/admin/events?series_event=${key(100)}`,
          "moderator",
          counter.db,
        );
        expect(rowKeys(control.html)).toEqual(ULID_FAMILY);
        expect(counter.transactions).toBeGreaterThanOrEqual(1);
        expect(counter.queries.length).toBeGreaterThan(0);
      });
      it(`${twin}: outside-range seed editors 404`, async () => {
        const entry = envNamed(envName);
        for (const raw of ["seed-calendar-00", "seed-calendar-51", "seed-calendar-5"]) {
          const editor = await request(entry, twin, `/admin/events/${raw}`);
          expect(editor.status, raw).toBe(404);
          expect(reviewLink(editor.html), raw).toBeUndefined();
        }
      });
    }
  });
}

describe("production binding refuses seed scopes", () => {
  for (const twin of ["Hono", "Kit"]) {
    it(`${twin}: seed editor 404s and inventory refuses with no scoped database work`, async () => {
      const entry = envNamed("production");
      const editor = await request(entry, twin, `/admin/events/${SEED_PARENT}`);
      expect(editor.status).toBe(404);
      expect(reviewLink(editor.html)).toBeUndefined();
      const counter = countingDb(entry.fixture.client);
      for (const raw of [SEED_PARENT, SEED_CHILD]) {
        counter.reset();
        const r = await request(
          entry,
          twin,
          `/admin/events?series_event=${raw}`,
          "moderator",
          counter.db,
        );
        expect(r.status, raw).toBe(200);
        privateResponse(r);
        expect(r.html, raw).toContain('data-testid="series-scope-recovery"');
        expect(rowKeys(r.html), raw).toEqual([]);
        expect(counter.queries, raw).toEqual([]);
        expect(counter.transactions, raw).toBe(0);
      }
      counter.reset();
      const control = await request(
        entry,
        twin,
        `/admin/events?series_event=${key(100)}`,
        "moderator",
        counter.db,
      );
      expect(rowKeys(control.html)).toEqual(ULID_FAMILY);
      expect(counter.transactions).toBeGreaterThanOrEqual(1);
      expect(counter.queries.length).toBeGreaterThan(0);
    });
  }
});

describe("empty and overlong scopes survive the rendered GET form", () => {
  for (const twin of ["Hono", "Kit"]) {
    for (const [label, raw] of [
      ["empty", ""],
      ["overlong normalized to empty", "x".repeat(300)],
    ]) {
      it(`${twin}: ${label} scope stays present and scoped after submission`, async () => {
        const entry = envNamed("production");
        const first = await request(
          entry,
          twin,
          `/admin/events?series_event=${encodeURIComponent(raw)}`,
        );
        expect(first.status).toBe(200);
        privateResponse(first);
        expect(first.html).toContain('data-testid="series-scope-recovery"');
        expect(rowKeys(first.html)).toEqual([]);
        expect(hiddenSeriesCarriers(first.html)).toEqual([""]);
        const submitted = serializeFiltersForm(first.html);
        expect(submitted, "rendered filters form must serialize").toBeDefined();
        expect(submitted.has("series_event")).toBe(true);
        expect(submitted.get("series_event")).toBe("");
        const second = await request(entry, twin, `/admin/events?${submitted}`);
        expect(second.status).toBe(200);
        privateResponse(second);
        expect(second.html).toContain('data-testid="series-scope-recovery"');
        expect(rowKeys(second.html)).toEqual([]);
        expect(allEvents(second.html)).toBeDefined();
        expect(hiddenSeriesCarriers(second.html)).toEqual([""]);
        const resubmitted = serializeFiltersForm(second.html);
        expect(resubmitted?.get("series_event")).toBe("");
      });
    }
  }
});

describe("pre-database admission and ULID canonicalization", () => {
  for (const twin of ["Hono", "Kit"]) {
    it(`${twin}: malformed, empty and overlong scopes do zero database work`, async () => {
      const entry = envNamed("production");
      const counter = countingDb(entry.fixture.client);
      for (const raw of ["", "malformed-scope!", "<script>", "x".repeat(300)]) {
        counter.reset();
        const r = await request(
          entry,
          twin,
          `/admin/events?series_event=${encodeURIComponent(raw)}`,
          "moderator",
          counter.db,
        );
        expect(r.status, JSON.stringify(raw.slice(0, 20))).toBe(200);
        privateResponse(r);
        expect(r.html).toContain('data-testid="series-scope-recovery"');
        expect(r.html).not.toContain("<script>");
        expect(rowKeys(r.html)).toEqual([]);
        expect(allEvents(r.html)).toBeDefined();
        expect(counter.queries).toEqual([]);
        expect(counter.transactions).toBe(0);
      }
      counter.reset();
      const control = await request(
        entry,
        twin,
        `/admin/events?series_event=${key(100)}`,
        "moderator",
        counter.db,
      );
      expect(rowKeys(control.html)).toEqual(ULID_FAMILY);
      expect(counter.transactions).toBeGreaterThanOrEqual(1);
      expect(counter.queries.length).toBeGreaterThan(0);
    });
    it(`${twin}: lowercase ULID scope returns the exact stored uppercase family`, async () => {
      const entry = envNamed("production");
      const parent = await request(
        entry,
        twin,
        `/admin/events?series_event=${key(100).toLowerCase()}`,
      );
      expect(parent.status).toBe(200);
      expect(rowKeys(parent.html)).toEqual(ULID_FAMILY);
      const child = await request(
        entry,
        twin,
        `/admin/events?series_event=${LETTER_CHILD.toLowerCase()}`,
      );
      expect(rowKeys(child.html)).toEqual([LETTER_PARENT, LETTER_CHILD]);
    });
    it(`${twin}: mixed-case ULID scope returns the exact stored uppercase family`, async () => {
      const entry = envNamed("production");
      for (const raw of [mixedCase(LETTER_PARENT), mixedCase(LETTER_CHILD)]) {
        expect(raw).not.toBe(raw.toLowerCase());
        expect(raw).not.toBe(raw.toUpperCase());
        const r = await request(entry, twin, `/admin/events?series_event=${raw}`);
        expect(r.status, raw).toBe(200);
        expect(rowKeys(r.html), raw).toEqual([LETTER_PARENT, LETTER_CHILD]);
        expect(r.html, raw).toContain("Events in this series: Letter saved series");
      }
    });
  }
});

describe("store contract for the builder seed fix", () => {
  it("RED: explicit demo bindings resolve seeds; production and default stay invalid", async () => {
    const staging = envNamed("staging");
    for (const appUrl of [STAGING_APP_URL, LOCAL_APP_URL]) {
      const scoped = await listSeriesEvents(
        staging.fixture.db,
        { series_event: SEED_CHILD },
        appUrl,
      );
      expect(
        scoped.rows.map((r) => r.eventKey),
        appUrl,
      ).toEqual(SEED_FAMILY);
      expect(scoped.scope, appUrl).toEqual({
        status: "ok",
        parentKey: SEED_PARENT,
        parentTitle: "Seed saved series",
      });
    }
    const production = await listSeriesEvents(
      staging.fixture.db,
      { series_event: SEED_PARENT },
      PROD_APP_URL,
    );
    expect(production).toEqual({ rows: [], scope: { status: "invalid" } });
  });
  it("CONTROL: no-appUrl store calls and the rows-only wrapper fail closed", async () => {
    const staging = envNamed("staging");
    const scoped = await listSeriesEvents(staging.fixture.db, { series_event: SEED_PARENT });
    expect(scoped).toEqual({ rows: [], scope: { status: "invalid" } });
    expect(await listEvents(staging.fixture.db, { series_event: SEED_PARENT })).toEqual([]);
  });
});

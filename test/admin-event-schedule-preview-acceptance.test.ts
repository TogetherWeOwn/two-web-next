// route-inventory: POST /admin/events
// Acceptance: preview a new weekly series before creating drafts.
//
// A moderator posts the new-event form with `preview=schedule` and gets the
// bounded date expansion back as a Not-saved panel on a 200 — same Hono-owned
// POST /admin/events admission as create, validated by the existing parsers,
// writing nothing. Every displayed instant equals the existing occurrences()
// enumerator. Cases PV (valid), PE (invalid), PC (already-passing controls).
// Run: DATABASE_URL=postgres://agent_test@agent-testdb:5432/postgres npx vitest run
//   test/admin-event-schedule-preview-acceptance.test.ts
//
// On the pre-preview implementation the PV cases fail (the post creates a
// draft 303 instead of rendering a 200 panel); PE/PC pass and constrain the
// Builder to keep today's validation, error shape and create behavior.
import { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { adminApp } from "../src/admin/routes";
import { activityLog, events } from "../src/db/admin-schema";
import type { Env } from "../src/env";
import { sameOrigin } from "../src/same-origin";
import { createMemorySessionStore } from "../src/sessions";
import { createMemberDataFixture, type MemberDataFixture } from "./helpers/member-data-db";
import { cookieFor, env as baseEnv, MODERATOR } from "./helpers/member-data";
import {
  escapeHtml,
  expectCreateFormIntact,
  expectPreviewPanel,
  previewSection,
  previewValues,
  SCHEDULE_PREVIEW_BASE_FORM,
} from "./helpers/schedule-preview-contract";

// Reused literals already in the repo (no new secret-shaped strings).
const DRAFT_KEY = "01K00000000000000000000021";
const PUBLISHED_KEY = "01J0000000000000000000ABCD";

const VALID_CASES: { id: string; label: string; values: Record<string, string> }[] = [
  { id: "PV01", label: "one-off previews its single meeting", values: {} },
  {
    id: "PV02",
    label: "weekly count-only holds wall time across the BST->GMT change",
    values: { recurrence_frequency: "weekly", recurrence_count: "4" },
  },
  {
    id: "PV03",
    label: "weekly until-only expands to the bound",
    values: { recurrence_frequency: "weekly", recurrence_ends_on: "2026-10-18" },
  },
  {
    id: "PV04",
    label: "the tighter of count and until wins",
    values: {
      recurrence_frequency: "weekly",
      recurrence_count: "10",
      recurrence_ends_on: "2026-10-11",
    },
  },
  {
    id: "PV05",
    label: "count 1 previews a single occurrence",
    values: { recurrence_frequency: "weekly", recurrence_count: "1" },
  },
  {
    id: "PV06",
    label: "count 52 previews the full bounded list",
    values: { recurrence_frequency: "weekly", recurrence_count: "52" },
  },
  {
    id: "PV07",
    label: "a far-future until-only preview caps at 52",
    values: { recurrence_frequency: "weekly", recurrence_ends_on: "2028-01-01" },
  },
  {
    id: "PV08",
    label: "a spring-gap week moves forward instead of vanishing",
    values: {
      starts_at: "2027-03-21 01:30",
      ends_at: "2027-03-21 02:30",
      recurrence_frequency: "weekly",
      recurrence_count: "2",
    },
  },
  {
    id: "PV09",
    label: "a series across the autumn fold previews every week",
    values: {
      starts_at: "2026-10-18 01:30",
      ends_at: "2026-10-18 02:30",
      recurrence_frequency: "weekly",
      recurrence_count: "3",
    },
  },
  {
    id: "PV10",
    label: "an overnight slot previews across midnight",
    values: {
      starts_at: "2026-11-04 22:00",
      ends_at: "2026-11-05 01:00",
      recurrence_frequency: "weekly",
      recurrence_count: "2",
    },
  },
  {
    id: "PV11",
    label: "a series across the year boundary previews into January",
    values: {
      starts_at: "2026-12-28 20:00",
      ends_at: "2026-12-28 21:00",
      recurrence_frequency: "weekly",
      recurrence_count: "3",
    },
  },
  {
    id: "PV12",
    label: "a zone ahead of UTC previews host walls with UTC instants",
    values: {
      starts_at: "2026-10-04 08:00",
      ends_at: "2026-10-04 09:00",
      timezone: "Pacific/Auckland",
      recurrence_frequency: "weekly",
      recurrence_count: "2",
    },
  },
];

const INVALID_CASES: {
  id: string;
  label: string;
  values: Record<string, string>;
  errors: string[];
}[] = [
  {
    id: "PE01",
    label: "invalid start",
    values: { starts_at: "not-a-time" },
    errors: ["starts_at"],
  },
  {
    id: "PE02",
    label: "unknown timezone",
    values: { timezone: "Unknown/Zone" },
    errors: ["timezone"],
  },
  {
    id: "PE03",
    label: "count 53",
    values: { recurrence_frequency: "weekly", recurrence_count: "53" },
    errors: ["recurrence_count"],
  },
  {
    id: "PE04",
    label: "count 0",
    values: { recurrence_frequency: "weekly", recurrence_count: "0" },
    errors: ["recurrence_count"],
  },
  {
    id: "PE05",
    label: "repeat-until before the first meeting",
    values: { recurrence_frequency: "weekly", recurrence_ends_on: "2026-10-01" },
    errors: ["recurrence_ends_on"],
  },
  {
    id: "PE06",
    label: "weekly with neither bound",
    values: { recurrence_frequency: "weekly" },
    errors: ["recurrence_count"],
  },
  {
    id: "PE07",
    label: "unknown repeat frequency",
    values: { recurrence_frequency: "daily", recurrence_count: "3" },
    errors: ["recurrence_frequency"],
  },
  {
    id: "PE08",
    label: "end before start",
    values: { ends_at: "2026-10-04 19:00" },
    errors: ["ends_at"],
  },
  {
    id: "PE09",
    label: "repeat-until that is not a date",
    values: { recurrence_frequency: "weekly", recurrence_ends_on: "soon" },
    errors: ["recurrence_ends_on"],
  },
  {
    id: "PE10",
    label: "a start inside the spring gap",
    values: { starts_at: "2026-03-29 01:30", ends_at: "2026-03-29 02:30" },
    errors: ["starts_at"],
  },
];

describe.skipIf(!process.env.DATABASE_URL)("schedule preview acceptance (isolated test DB)", () => {
  let fixture: MemberDataFixture;
  let modCookie: string;
  let env: Env;
  let app: Hono<{ Bindings: Env }>;

  beforeAll(async () => {
    fixture = await createMemberDataFixture(process.env.DATABASE_URL!);
    const store = createMemorySessionStore();
    modCookie = await cookieFor(store, MODERATOR);
    env = { ...baseEnv, ADMIN_DB: fixture.db } as Env;
    app = new Hono<{ Bindings: Env }>()
      .use("*", sameOrigin)
      .route("/admin", adminApp({ sessionStore: store, db: fixture.db }));
  });
  afterAll(async () => {
    await fixture?.dispose();
  });
  beforeEach(async () => {
    await fixture.reset();
    await fixture.db.insert(events).values([
      {
        eventKey: DRAFT_KEY,
        title: "Seeded draft",
        timezone: SCHEDULE_PREVIEW_BASE_FORM.timezone!,
        status: "draft",
        startsAt: new Date("2026-11-04T20:00:00Z"),
        endsAt: new Date("2026-11-04T22:00:00Z"),
      },
      {
        eventKey: PUBLISHED_KEY,
        title: "Seeded live night",
        timezone: SCHEDULE_PREVIEW_BASE_FORM.timezone!,
        status: "published",
        startsAt: new Date("2026-11-11T20:00:00Z"),
        endsAt: new Date("2026-11-11T22:00:00Z"),
      },
    ]);
  });

  const post = (values: Record<string, string>) =>
    app.request(
      baseEnv.APP_URL + "/admin/events",
      {
        method: "POST",
        headers: { cookie: modCookie, origin: baseEnv.APP_URL },
        body: new URLSearchParams(values),
      },
      env,
    );

  const snapshotEvents = () => fixture.db.select().from(events).orderBy(events.id);

  for (const { id, label, values } of VALID_CASES) {
    it(`${id}: ${label}, writing nothing`, async () => {
      const before = await snapshotEvents();
      const submitted = previewValues(values);
      const res = await post(submitted);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
      expect(res.headers.get("cache-control")).toContain("no-store");
      const html = await res.text();
      expect(html).toContain('data-testid="save-event"');
      expectPreviewPanel(html, submitted);
      expectCreateFormIntact(html, submitted);
      // Zero writes: not even the seeded published row is touched, no audits.
      expect(await snapshotEvents()).toEqual(before);
      expect(await fixture.db.select().from(activityLog)).toEqual([]);
    });
  }

  for (const { id, label, values, errors } of INVALID_CASES) {
    it(`${id}: invalid preview (${label}) is a 422 with errors and no panel`, async () => {
      const before = await snapshotEvents();
      const submitted = previewValues(values);
      const res = await post(submitted);
      expect(res.status).toBe(422);
      expect(res.headers.get("content-type")).toContain("text/html");
      expect(res.headers.get("cache-control")).toContain("no-store");
      const html = await res.text();
      expect(html).toContain('data-testid="form-errors"');
      expect(html).toContain("Check the highlighted fields and try again.");
      for (const field of errors) {
        expect(html, `accessible ${field} error`).toContain(`data-testid="error-${field}"`);
      }
      expect(html).toContain('action="/admin/events"');
      expect(html).toContain("Create draft");
      expect(html).toContain("data-event-draft");
      expect(html).toContain(`value="${escapeHtml(submitted.title!)}"`);
      expect(previewSection(html), "no stale successful output").toBeNull();
      expect(await snapshotEvents()).toEqual(before);
      expect(await fixture.db.select().from(activityLog)).toEqual([]);
    });
  }

  it("PE01-association: the failing input owns its accessible error wiring", async () => {
    const submitted = previewValues({ starts_at: "not-a-time" });
    const html = await (await post(submitted)).text();
    const field = [...html.matchAll(/<div class="field">([\s\S]*?)<\/div>/g)].find((m) =>
      m[1]!.includes('name="starts_at"'),
    )?.[1];
    expect(field).toBeDefined();
    const input = field!.match(/<input\b[^>]*>/)?.[0];
    expect(input).toContain('id="f-starts-at"');
    expect(input).toContain('aria-invalid="true"');
    expect(input).toContain('aria-describedby="f-starts-at-error"');
    expect(field).toMatch(/<p[^>]*id="f-starts-at-error"[^>]*role="alert"/);
  });

  it("PC01: ordinary create still materializes a weekly series exactly once", async () => {
    const before = await snapshotEvents();
    const res = await post({
      ...SCHEDULE_PREVIEW_BASE_FORM,
      recurrence_frequency: "weekly",
      recurrence_count: "4",
    });
    expect(res.status).toBe(303);
    const after = await snapshotEvents();
    expect(after).toHaveLength(before.length + 4);
    const created = after.filter(
      (row) => row.eventKey !== DRAFT_KEY && row.eventKey !== PUBLISHED_KEY,
    );
    expect(created.map((row) => row.recurrenceIndex).sort()).toEqual([1, 2, 3, 4]);
    expect(created.every((row) => row.status === "draft")).toBe(true);
    const parent = created.find((row) => row.recurrenceIndex === 1)!;
    expect(parent.parentEventId).toBeNull();
    for (const child of created.filter((row) => row.recurrenceIndex !== 1)) {
      expect(child.parentEventId).toBe(parent.id);
    }
    expect(new Set(created.map((row) => row.eventKey)).size).toBe(4);
    expect(await fixture.db.select().from(activityLog)).toHaveLength(4);
    // The seeds are untouched by the create.
    for (const seed of before) {
      expect(after.find((row) => row.eventKey === seed.eventKey)).toEqual(seed);
    }
  });

  it("PC02: ordinary invalid create is still a 422 with no writes", async () => {
    const before = await snapshotEvents();
    const res = await post({ ...SCHEDULE_PREVIEW_BASE_FORM, starts_at: "not-a-time" });
    expect(res.status).toBe(422);
    const html = await res.text();
    expect(html).toContain('data-testid="form-errors"');
    expect(html).toContain('data-testid="error-starts_at"');
    expect(previewSection(html)).toBeNull();
    expect(await snapshotEvents()).toEqual(before);
    expect(await fixture.db.select().from(activityLog)).toEqual([]);
  });
});

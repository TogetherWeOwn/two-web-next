// route-inventory: GET /admin/activity-log
// route-inventory: GET /admin/events/:key
// route-inventory: GET /admin/events/new
//
// Acceptance: activity log opens recorded changes for exactly one saved event.
//
// OWNERSHIP: This file is owned by the acceptance author. The Builder
// incorporates this file unchanged and never edits it; justified corrections
// return through the acceptance author.
//
// CONTRACT PINS (the Builder implements exactly these):
// - Scope param: `event` on GET /admin/activity-log (Hono + Kit). One bounded,
//   validated exact event key in the shared query authority
//   (parseActivityLogQuery / activityLogUrl / listActivityLog). Reads apply
//   subjectType = Event AND subjectId = exact eventKey BEFORE paging. Generic
//   subject substring search keeps its semantics.
// - Editor link copy: "Recorded changes for this event", href
//   /admin/activity-log?event=<persisted-key> (page 1 bare, no page param), on
//   both saved-event editor twins. New/unsaved forms emit no history action.
// - Absent-or-blank scope (`event` missing, empty, or whitespace-only) renders
//   the existing unscoped viewer with NO scope UI. Present-but-malformed,
//   overlong, or duplicated scope fails explicitly: HTTP 400 or 422,
//   private no-store, copy naming the invalid scope, zero activity rows, never
//   unrestricted rows presented as scoped. A well-formed but unknown key
//   renders the scoped viewer with zero rows (a filter, not a 404).
// - The scoped viewer shows the active scope (the key), describes results as
//   recorded changes (never "complete history" / "audit diff" / raw
//   before/after payloads), preserves scope through causer/subject filters and
//   paging, resets to page 1 when scope changes, and offers explicit scope
//   removal that keeps unrelated valid filters.
// - Kit resolveKitEventEdit exposes the scoped activity-log URL in its
//   serializable view (field name free; the URL must be present); the Kit
//   viewer load forwards the scope to the shared list read.
// - Deliberately NOT pinned (Builder's choice, either side satisfies the
//   card): seed-shaped scope on a production APP_URL, lowercase-ULID scope,
//   the exact 400-vs-422 code, and error-page markup beyond the `invalid`
//   marker. No time-window filter exists at this HEAD; when one lands the same
//   shared authority must preserve scope through it.
//
// EVIDENCE KEY: tests named RED fail at the acceptance HEAD because the
// feature is missing (each reaches the named gap, not an import/setup
// failure); tests named CONTROL pass at the acceptance HEAD and prove the
// harness plus the preserved behavior they guard. HTTP-level tests execute
// with no JavaScript by construction (raw GET, no browser). Kit template
// behavior is proven by server-rendering the real .svelte pages.

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pg-proxy";
import { build } from "esbuild";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { loadActivityLogPage } from "../src/admin/kit-activity-log";
import type { ActivityLogLoadArgs } from "../src/admin/kit-activity-log";
import { buildEventCreateView } from "../src/admin/kit-event-create";
import {
  resolveKitEventEdit,
  type KitEventEditDeps,
  type KitEventEditRow,
} from "../src/admin/kit-event-edit";
import { adminApp } from "../src/admin/routes";
import {
  ACTIVITY_LOG_PAGE_SIZE,
  activityLogUrl,
  parseActivityLogQuery,
} from "../src/admin/table-list";
import { activityLog, events, memberDataAccessLogs } from "../src/db/admin-schema";
import type { Db } from "../src/db/index";
import type { Env } from "../src/env";
import { createMemorySessionStore } from "../src/sessions";
import { createMemberDataFixture, type MemberDataFixture } from "./helpers/member-data-db";
import {
  cookieFor,
  env,
  MEMBER,
  MODERATOR,
  PERSONAL_STRINGS,
  SUBJECT,
} from "./helpers/member-data";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const readSource = (p: string): string => readFileSync(join(root, p), "utf8");

const SCOPE_KEY = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const OTHER_KEY = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
const UNKNOWN_KEY = "01ARZ3NDEKTSV4RRFFQ69G5FAC";
const LINK_COPY = "Recorded changes for this event";
// Malformed scope values: each is present-but-not-key-shaped and must fail
// explicitly rather than render unscoped rows.
const MALFORMED = [
  "not a key",
  "x".repeat(200),
  "01ARZ3NDEKTSV4RRFFQ69G5FA",
  "01ARZ3NDEKTSV4RRFFQ69G5FAVX",
  "<script>alert(1)</script>",
  "42",
];

const unescapeHtml = (html: string): string =>
  html.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");

/** Every /admin/activity-log href in rendered HTML, entities unescaped. */
function activityHrefs(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/href="([^"]*\/admin\/activity-log[^"]*)"/g)) {
    out.push(unescapeHtml(m[1]!));
  }
  return out;
}

function queryOf(href: string): URLSearchParams {
  return new URL(href, "https://local.test").searchParams;
}

/** Hrefs of anchors whose visible text contains `text` (attribute-order free). */
function anchorHrefsByText(html: string, text: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)) {
    if (unescapeHtml(m[2]!).includes(text)) {
      const href = m[1]!.match(/href="([^"]*)"/);
      if (href) out.push(unescapeHtml(href[1]!));
    }
  }
  return out;
}

describe("exact-event scope: shared query authority (hermetic)", () => {
  it("CONTROL: existing subject/causer/page parsing is unchanged", () => {
    expect(parseActivityLogQuery({})).toEqual({ subject: "", causer: "", page: 1 });
    expect(parseActivityLogQuery({ subject: "  Event  ", causer: "  123  ", page: "2" })).toEqual({
      subject: "Event",
      causer: "123",
      page: 2,
    });
    for (const page of ["0", "-1", "abc", "9007199254740993"]) {
      expect(parseActivityLogQuery({ page }).page, page).toBe(1);
    }
    expect(parseActivityLogQuery({ subject: "x".repeat(200) }).subject).toBe("");
  });

  it("CONTROL: unscoped paging URLs keep their shape", () => {
    const query = parseActivityLogQuery({ subject: "Alpha", causer: "42", page: "2" });
    expect(queryOf(activityLogUrl(query, 1)).get("page")).toBe("1");
    expect(queryOf(activityLogUrl(query, 3)).get("subject")).toBe("Alpha");
    expect(queryOf(activityLogUrl(query, 3)).get("causer")).toBe("42");
    expect(queryOf(activityLogUrl(query, 3)).get("event")).toBeNull();
  });

  it("RED: the shared parser admits one bounded exact-event scope", () => {
    const query = parseActivityLogQuery({ event: SCOPE_KEY, page: "2" });
    expect((query as unknown as Record<string, unknown>).event).toBe(SCOPE_KEY);
    expect(query.page).toBe(2);
    expect(
      (parseActivityLogQuery({ event: `  ${SCOPE_KEY}  ` }) as unknown as Record<string, unknown>)
        .event,
    ).toBe(SCOPE_KEY);
  });

  it("RED: scoped paging URLs preserve the scope across pages", () => {
    const query = {
      ...parseActivityLogQuery({ subject: "Alpha", causer: "42", page: "2" }),
      event: SCOPE_KEY,
    };
    for (const page of [1, 2, 3]) {
      const params = queryOf(activityLogUrl(query, page));
      expect(params.get("event"), `page ${page}`).toBe(SCOPE_KEY);
      expect(params.get("page"), `page ${page}`).toBe(String(page));
      expect(params.get("subject"), `page ${page}`).toBe("Alpha");
      expect(params.get("causer"), `page ${page}`).toBe("42");
    }
  });
});

describe("exact-event scope: Hono guards (hermetic, memory sessions)", () => {
  // Guards and routing precede every store read, so a pg-proxy stub that
  // answers no rows is sufficient here. Scope validation itself is pinned
  // against the disposable DB below: the stub cannot execute the classified
  // read path, so a stub-backed scope test would fail for setup reasons
  // rather than the named gap.
  const stub = async (_sql: string, _params: unknown[]) => ({ rows: [] as unknown[][] });
  const db = drizzle(stub) as unknown as Db;
  (db as { transaction: unknown }).transaction = async (cb: (tx: Db) => Promise<unknown>) => cb(db);
  const sessions = createMemorySessionStore();
  let modCookie = "";
  let memberCookie = "";
  const app = () => adminApp({ sessionStore: sessions, db });
  const bindings = () => ({ ...env, ADMIN_DB: db });

  beforeAll(async () => {
    modCookie = await cookieFor(sessions, MODERATOR);
    memberCookie = await cookieFor(sessions, MEMBER);
  });

  it("CONTROL: guests bounce and members forbid on scoped URLs before any scope handling", async () => {
    for (const path of [
      `/activity-log?event=${SCOPE_KEY}`,
      `/activity-log?event=${encodeURIComponent(MALFORMED[0]!)}`,
      `/activity-log?event=${SCOPE_KEY}&event=${OTHER_KEY}`,
    ]) {
      const guest = await app().request(path, {}, env);
      expect(guest.status, `guest ${path}`).toBe(302);
      expect(guest.headers.get("location")).toBe("/auth/discord");
      const member = await app().request(path, { headers: { cookie: memberCookie } }, bindings());
      expect(member.status, `member ${path}`).toBe(403);
    }
  });

  it("CONTROL: the scope adds no route or mutation surface", async () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const res = await app().request(
        `/activity-log?event=${SCOPE_KEY}`,
        { method, headers: { cookie: modCookie, origin: env.APP_URL } },
        bindings(),
      );
      expect(res.status, method).toBe(404);
    }
  });
});

describe("exact-event scope: Kit viewer load (hermetic)", () => {
  const kitEnv = { APP_URL: "https://example.test" } as unknown as Env;
  const db = {} as unknown as Db;
  const headersSpy = () => vi.fn() as unknown as (headers: Record<string, string>) => void;

  it("CONTROL: unscoped load forwards shared filters with one private no-store set", async () => {
    const seen: unknown[] = [];
    const listFn = vi.fn(async (_db: Db, opts: unknown) => {
      seen.push(opts);
      return [];
    });
    const setHeaders = headersSpy();
    const out = await loadActivityLogPage({
      env: kitEnv,
      subjectParam: "Alpha",
      causerParam: null,
      pageParam: "2",
      setHeaders,
      dbForFn: async () => db,
      listFn,
    });
    expect(seen).toEqual([{ subject: "Alpha", causer: "", page: 2 }]);
    expect(out.query).toEqual({ subject: "Alpha", causer: "", page: 2 });
    expect(out.hasNext).toBe(false);
    expect(setHeaders).toHaveBeenCalledTimes(1);
    expect(setHeaders).toHaveBeenCalledWith({ "cache-control": "private, no-store" });
  });

  it("RED: scoped load forwards the exact-event scope to the shared read", async () => {
    const seen: unknown[] = [];
    const listFn = vi.fn(async (_db: Db, opts: unknown) => {
      seen.push(opts);
      return [];
    });
    const out = await loadActivityLogPage({
      env: kitEnv,
      subjectParam: null,
      causerParam: null,
      pageParam: null,
      eventParam: SCOPE_KEY,
      setHeaders: headersSpy(),
      dbForFn: async () => db,
      listFn,
    } as unknown as ActivityLogLoadArgs);
    expect(seen).toHaveLength(1);
    expect((seen[0] as Record<string, unknown>).event).toBe(SCOPE_KEY);
    expect((out.query as unknown as Record<string, unknown>).event).toBe(SCOPE_KEY);
  });

  it("RED: malformed scope never reaches the shared read and never renders rows", async () => {
    const listFn = vi.fn(async () => []);
    let outcome: unknown;
    let thrown: unknown;
    try {
      outcome = await loadActivityLogPage({
        env: kitEnv,
        subjectParam: null,
        causerParam: null,
        pageParam: null,
        eventParam: MALFORMED[0]!,
        setHeaders: headersSpy(),
        dbForFn: async () => db,
        listFn,
      } as unknown as ActivityLogLoadArgs);
    } catch (err) {
      thrown = err;
    }
    expect(listFn).not.toHaveBeenCalled();
    if (thrown) {
      // Explicit failure, never the branded-outage 503 and never silent rows.
      expect([400, 422]).toContain((thrown as { status?: number }).status);
    } else {
      expect(outcome).not.toHaveProperty("rows");
    }
  });
});

describe("exact-event scope: Kit editor resolvers (hermetic)", () => {
  const editRow: KitEventEditRow = {
    eventKey: SCOPE_KEY,
    title: "Friday games",
    game: "Zxq",
    description: "desc",
    startsAt: new Date("2026-11-06T19:00:00.000Z"),
    endsAt: new Date("2026-11-06T21:00:00.000Z"),
    timezone: "Europe/London",
    location: "Hall",
    capacity: 10,
    status: "published",
    rsvpOpen: true,
    recurrenceFrequency: null,
  };
  const deps: KitEventEditDeps = {
    db: {} as unknown as Db,
    get: async () => editRow,
    list: async () => ({ rows: [], total: 0 }),
  };

  it("CONTROL: the saved-event resolver answers ok with key, title, status, roster", async () => {
    const outcome = await resolveKitEventEdit(SCOPE_KEY, {}, deps);
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;
    expect(outcome.view.key).toBe(SCOPE_KEY);
    expect(outcome.view.title).toBe("Friday games");
    expect(outcome.view.status).toBe("published");
    expect(outcome.view.roster.total).toBe(0);
  });

  it("RED: the saved-event view exposes the recorded-changes URL for its key", async () => {
    const outcome = await resolveKitEventEdit(SCOPE_KEY, {}, deps);
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;
    expect(JSON.stringify(outcome.view)).toContain(`/admin/activity-log?event=${SCOPE_KEY}`);
  });

  it("CONTROL: the new-event view emits no history action", () => {
    const view = buildEventCreateView();
    expect(JSON.stringify(view)).not.toContain("activity-log");
    expect(JSON.stringify(view)).not.toContain(LINK_COPY);
  });
});

describe("exact-event scope: Kit server-rendered twins (hermetic SSR)", () => {
  const webRequire = createRequire(join(root, "web/package.json"));
  const { compile } = webRequire("svelte/compiler");
  let renderActivity: (data: unknown) => string;
  let renderEdit: (data: unknown) => string;

  async function bundle(entry: string, exportName: string): Promise<(data: unknown) => string> {
    const { outputFiles } = await build({
      stdin: {
        contents: `
          import { render } from "svelte/server";
          import Page from "./${entry}";
          export function ${exportName}(data) {
            return render(Page, { props: { data } }).body;
          }
        `,
        resolveDir: root,
        loader: "js",
      },
      absWorkingDir: root,
      bundle: true,
      platform: "node",
      format: "esm",
      write: false,
      tsconfigRaw: { compilerOptions: {} },
      nodePaths: [join(root, "web/node_modules"), join(root, "node_modules")],
      alias: { "#lib": join(root, "web/src/lib") },
      plugins: [
        {
          name: "kit-exact-scope-ssr",
          setup(plugin) {
            plugin.onLoad({ filter: /\.svelte$/ }, ({ path }) => {
              const { js } = compile(readFileSync(path, "utf8"), {
                generate: "server",
                dev: false,
                filename: path,
              });
              return { contents: js.code, loader: "js", resolveDir: dirname(path) };
            });
          },
        },
      ],
    });
    const bundled = `data:text/javascript;base64,${Buffer.from(outputFiles[0]!.text).toString("base64")}`;
    return (await import(bundled))[exportName] as (data: unknown) => string;
  }

  beforeAll(async () => {
    renderActivity = await bundle("web/src/routes/admin/activity-log/+page.svelte", "renderPage");
    renderEdit = await bundle("web/src/routes/admin/events/[key]/+page.svelte", "renderEdit");
  }, 120_000);

  const scopedRow = {
    id: 7,
    description: "updated event Friday games",
    subjectType: "Event",
    subjectId: SCOPE_KEY,
    causerId: SUBJECT.userId,
    event: "updated",
    createdAt: "2026-10-01T12:00:00.000Z",
  };

  it("CONTROL: the unscoped viewer renders its contract without scope UI", () => {
    const html = renderActivity({
      rows: [scopedRow],
      query: { subject: "", causer: "", page: 1 },
      hasNext: false,
    });
    expect(html).toContain("Activity log");
    expect(html).toContain("updated event Friday games");
    expect(html).toContain('name="subject"');
    expect(html).not.toContain('name="event"');
  });

  it("RED: the scoped viewer shows the active scope as recorded changes", () => {
    const html = renderActivity({
      rows: [scopedRow],
      query: { subject: "", causer: "", event: SCOPE_KEY, page: 1 },
      hasNext: false,
    });
    expect(html).toContain(SCOPE_KEY);
    expect(html).toMatch(/recorded changes/i);
    expect(html).not.toMatch(/complete history/i);
    expect(html).not.toMatch(/audit diff/i);
  });

  it("RED: the scoped filter form keeps the scope and resets to page one", () => {
    const html = renderActivity({
      rows: [],
      query: { subject: "Alpha", causer: "", event: SCOPE_KEY, page: 3 },
      hasNext: false,
    });
    const form = html.match(
      /<form[^>]*action="\/admin\/activity-log"[^>]*>([\s\S]*?)<\/form>/,
    )?.[1];
    expect(form).toBeDefined();
    expect(form).toMatch(/<input[^>]*name="event"[^>]*>/);
    expect(form).toContain(`value="${SCOPE_KEY}"`);
    expect(form).not.toMatch(/name="page"/);
  });

  it("RED: scoped paging keeps the scope and removal drops only the scope", () => {
    const html = renderActivity({
      rows: [scopedRow],
      query: { subject: "", causer: SUBJECT.userId, event: SCOPE_KEY, page: 2 },
      hasNext: true,
    });
    for (const rel of ["Previous", "Next"]) {
      const hrefs = anchorHrefsByText(html, rel);
      expect(hrefs.length, rel).toBeGreaterThan(0);
      for (const href of hrefs) {
        expect(queryOf(href).get("event"), `${rel} ${href}`).toBe(SCOPE_KEY);
        expect(queryOf(href).get("causer"), `${rel} ${href}`).toBe(SUBJECT.userId);
      }
    }
    const removals = activityHrefs(html).filter((href) => {
      const params = queryOf(href);
      return params.get("event") === null && params.get("causer") === SUBJECT.userId;
    });
    expect(removals.length).toBeGreaterThan(0);
  });

  it("CONTROL: the saved editor renders its contract", async () => {
    const outcome = await resolveKitEventEdit(
      SCOPE_KEY,
      {},
      {
        db: {} as unknown as Db,
        get: async () => ({
          eventKey: SCOPE_KEY,
          title: "Friday games",
          game: null,
          description: null,
          startsAt: new Date("2026-11-06T19:00:00.000Z"),
          endsAt: new Date("2026-11-06T21:00:00.000Z"),
          timezone: "Europe/London",
          location: null,
          capacity: null,
          status: "published",
          rsvpOpen: true,
          recurrenceFrequency: null,
        }),
        list: async () => ({ rows: [], total: 0 }),
      },
    );
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;
    const html = renderEdit({ view: outcome.view });
    expect(html).toContain("Edit Friday games");
    expect(html).toContain(">Save<");
    expect(html).toContain('data-event-editor=""');
  });

  it("RED: the saved Kit editor links its recorded changes outside the form", async () => {
    const outcome = await resolveKitEventEdit(
      SCOPE_KEY,
      {},
      {
        db: {} as unknown as Db,
        get: async () => ({
          eventKey: SCOPE_KEY,
          title: "Friday games",
          game: null,
          description: null,
          startsAt: new Date("2026-11-06T19:00:00.000Z"),
          endsAt: new Date("2026-11-06T21:00:00.000Z"),
          timezone: "Europe/London",
          location: null,
          capacity: null,
          status: "published",
          rsvpOpen: true,
          recurrenceFrequency: null,
        }),
        list: async () => ({ rows: [], total: 0 }),
      },
    );
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;
    const html = renderEdit({ view: outcome.view });
    expect(html).toContain(LINK_COPY);
    const history = anchorHrefsByText(html, LINK_COPY);
    expect(history).toHaveLength(1);
    const params = queryOf(history[0]!);
    expect(params.get("event")).toBe(SCOPE_KEY);
    expect(params.get("page")).toBeNull();
    // A plain GET anchor beside the form: no-JS works, dirty-editor departure
    // protection stays armed on the untouched editor form.
    const form = html.match(/<form[^>]*data-event-editor=""[^>]*>([\s\S]*?)<\/form>/)?.[1];
    expect(form).toBeDefined();
    expect(form).not.toContain(LINK_COPY);
    expect(html).toContain("/islands/admin-event-editor.js");
  });

  it("CONTROL: the new-event Kit source emits no history action", () => {
    const source = readSource("web/src/routes/admin/events/new/+page.svelte");
    expect(source).not.toContain(LINK_COPY);
    expect(source).not.toContain("activity-log?event");
  });
});

describe("exact-event scope: moderator guide and Kit binding (hermetic source pins)", () => {
  it("RED: the moderator guide documents the per-event recorded changes", () => {
    const guide = readSource("docs/moderator-admin-guide.md");
    expect(guide).toContain(LINK_COPY);
    expect(guide).toContain("?event=");
  });

  it("RED: the Kit activity-log binding forwards the scope param", () => {
    const binding = readSource("web/src/routes/admin/activity-log/+page.server.ts");
    expect(binding).toContain('get("event")');
  });

  it("CONTROL: the Kit binding keeps its no-client-takeover, delegated-headers contract", () => {
    const binding = readSource("web/src/routes/admin/activity-log/+page.server.ts");
    expect(binding).toContain("csr = false");
    expect(binding).toContain("loadActivityLogPage");
    expect(binding).toContain("setHeaders");
    expect(binding).toContain("await parent()");
  });
});

describe.skipIf(!process.env.DATABASE_URL)(
  "exact-event scope: Hono editors and scoped viewer (isolated agent-testdb)",
  () => {
    let fixture: MemberDataFixture;
    let sessions = createMemorySessionStore();
    let cookie = "";
    const app = () => adminApp({ sessionStore: sessions, db: fixture.db });
    const bindings = () => ({ ...env, ADMIN_DB: fixture.db });
    const read = (qs = "") =>
      app().request(`/activity-log${qs}`, { headers: { cookie } }, bindings());
    const edit = (key: string) =>
      app().request(`/events/${key}`, { headers: { cookie } }, bindings());
    const logs = () => fixture.db.select().from(memberDataAccessLogs);

    const EXACT_MARKER = "scoped exact update 8f3a";
    const PREFIX_MARKER = "prefix decoy 8f3a";
    const SUFFIX_MARKER = "suffix decoy 8f3a";
    const TYPE_MARKER = "other-type decoy 8f3a";
    const NUMERIC_MARKER = "numeric-id decoy 8f3a";
    const PROPS_MARKER = "props marker 8f3a";
    const PROPS_SENTINEL = "props-before-sentinel-8f3a-never-rendered";
    const DECOY_MARKERS = [PREFIX_MARKER, SUFFIX_MARKER, TYPE_MARKER, NUMERIC_MARKER];

    const seedRow = (overrides: Partial<typeof activityLog.$inferInsert> = {}) =>
      fixture.db
        .insert(activityLog)
        .values({
          description: EXACT_MARKER,
          subjectType: "Event",
          subjectId: SCOPE_KEY,
          causerId: SUBJECT.userId,
          event: "updated",
          ...overrides,
        })
        .returning()
        .then((rows) => rows[0]!);

    beforeAll(async () => {
      fixture = await createMemberDataFixture(process.env.DATABASE_URL!);
    });
    beforeEach(async () => {
      await fixture.reset();
      sessions = createMemorySessionStore();
      cookie = await cookieFor(sessions, MODERATOR);
      const [eventRow] = await fixture.db
        .insert(events)
        .values({
          eventKey: SCOPE_KEY,
          title: "Friday games",
          status: "published",
          timezone: "Europe/London",
          startsAt: new Date("2026-11-06T19:00:00.000Z"),
          endsAt: new Date("2026-11-06T21:00:00.000Z"),
        })
        .returning();
      await seedRow({ description: EXACT_MARKER });
      await seedRow({
        description: PREFIX_MARKER,
        subjectId: `${SCOPE_KEY}A`,
        causerId: MEMBER.userId,
      });
      await seedRow({
        description: SUFFIX_MARKER,
        subjectId: `A${SCOPE_KEY}`,
        causerId: MEMBER.userId,
      });
      await seedRow({
        description: TYPE_MARKER,
        subjectType: "FeaturedContent",
        causerId: MEMBER.userId,
      });
      await seedRow({
        description: `mentions the key ${SCOPE_KEY} in prose`,
        subjectType: "Event",
        subjectId: OTHER_KEY,
        causerId: MEMBER.userId,
      });
      await seedRow({
        description: NUMERIC_MARKER,
        subjectType: "Event",
        subjectId: String(eventRow!.id),
        causerId: MEMBER.userId,
      });
      await seedRow({
        description: PROPS_MARKER,
        properties: { title: { before: PROPS_SENTINEL, after: "new" } },
      });
    });
    afterAll(() => fixture?.dispose());

    it("RED: the saved Hono editor links its recorded changes outside the form", async () => {
      const res = await edit(SCOPE_KEY);
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain(LINK_COPY);
      const history = anchorHrefsByText(html, LINK_COPY);
      expect(history).toHaveLength(1);
      const params = queryOf(history[0]!);
      expect(params.get("event")).toBe(SCOPE_KEY);
      expect(params.get("page")).toBeNull();
      const form = html.match(/<form[^>]*data-event-editor=""[^>]*>([\s\S]*?)<\/form>/)?.[1];
      expect(form).toBeDefined();
      expect(form).not.toContain(LINK_COPY);
      expect(html).toContain('data-event-editor=""');
      expect(html).toContain("/islands/admin-event-editor.js");
    });

    it("CONTROL: the new Hono form emits no history action", async () => {
      const res = await app().request("/events/new", { headers: { cookie } }, bindings());
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).not.toContain(LINK_COPY);
      for (const href of activityHrefs(html)) {
        expect(queryOf(href).get("event"), href).toBeNull();
      }
    });

    it("CONTROL: generic Subject search keeps substring semantics", async () => {
      const html = await (await read(`?subject=${SCOPE_KEY.slice(0, 8)}`)).text();
      expect(html).toContain(EXACT_MARKER);
      expect(html).toContain(PREFIX_MARKER);
      expect(html).toContain(SUFFIX_MARKER);
      expect(html).toContain(`mentions the key ${SCOPE_KEY} in prose`);
    });

    it("RED: the scoped viewer shows exactly the key's recorded changes", async () => {
      const res = await read(`?event=${SCOPE_KEY}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("private, no-store");
      const html = await res.text();
      expect(html).toContain(EXACT_MARKER);
      expect(html).toContain(PROPS_MARKER);
      for (const marker of [...DECOY_MARKERS, `mentions the key ${SCOPE_KEY} in prose`]) {
        expect(html, marker).not.toContain(marker);
      }
      expect(html).toContain(SCOPE_KEY);
      expect(html).toMatch(/recorded changes/i);
      expect(html).not.toMatch(/complete history/i);
      expect(html).not.toMatch(/audit diff/i);
      expect(html).not.toContain('method="post"');
      const form = html.match(
        /<form[^>]*action="\/admin\/activity-log"[^>]*>([\s\S]*?)<\/form>/,
      )?.[1];
      expect(form).toBeDefined();
      expect(form).toMatch(/<input[^>]*name="event"[^>]*>/);
      expect(form).toContain(`value="${SCOPE_KEY}"`);
      expect(form).not.toMatch(/name="page"/);
    });

    it("RED: scoped paging applies the scope before the 50+1 newest-first page", async () => {
      for (let i = 0; i < ACTIVITY_LOG_PAGE_SIZE + 1; i++) {
        await seedRow({ description: `PAGE_ROW_${String(i).padStart(2, "0")} 8f3a` });
      }
      const first = await read(`?event=${SCOPE_KEY}`);
      expect(first.status).toBe(200);
      const firstHtml = await first.text();
      expect(firstHtml).toContain("PAGE_ROW_50 8f3a");
      expect(firstHtml).toContain("PAGE_ROW_01 8f3a");
      expect(firstHtml).not.toContain("PAGE_ROW_00 8f3a");
      for (const marker of DECOY_MARKERS) {
        expect(firstHtml, `page 1 ${marker}`).not.toContain(marker);
      }
      const next = anchorHrefsByText(firstHtml, "Next");
      expect(next).toHaveLength(1);
      expect(queryOf(next[0]!).get("event")).toBe(SCOPE_KEY);
      const second = await read(`?event=${SCOPE_KEY}&page=2`);
      expect(second.status).toBe(200);
      const secondHtml = await second.text();
      expect(secondHtml).toContain("PAGE_ROW_00 8f3a");
      expect(secondHtml).not.toContain("PAGE_ROW_50 8f3a");
      for (const marker of DECOY_MARKERS) {
        expect(secondHtml, `page 2 ${marker}`).not.toContain(marker);
      }
      const prev = anchorHrefsByText(secondHtml, "Previous");
      expect(prev).toHaveLength(1);
      expect(queryOf(prev[0]!).get("event")).toBe(SCOPE_KEY);
    });

    it("RED: scoped causer filter intersects and removal drops only the scope", async () => {
      const res = await read(`?event=${SCOPE_KEY}&causer=${MEMBER.userId}`);
      expect(res.status).toBe(200);
      const html = await res.text();
      // The MEMBER-caused decoys stay excluded by the scope; the SUBJECT-caused
      // exact rows stay excluded by the causer filter: zero rows, scope shown.
      for (const marker of [EXACT_MARKER, PROPS_MARKER, ...DECOY_MARKERS]) {
        expect(html, marker).not.toContain(marker);
      }
      expect(html).toContain(SCOPE_KEY);
      expect(html).toMatch(/recorded changes/i);
      const removals = activityHrefs(html).filter((href) => {
        const params = queryOf(href);
        return params.get("event") === null && params.get("causer") === MEMBER.userId;
      });
      expect(removals.length).toBeGreaterThan(0);
    });

    it.each(MALFORMED)(
      "RED: malformed scope %s fails without scoped or unscoped rows",
      async (scope) => {
        const res = await read(`?event=${encodeURIComponent(scope)}`);
        expect([400, 422], scope).toContain(res.status);
        expect(res.headers.get("cache-control")).toBe("private, no-store");
        const html = await res.text();
        expect(html).toMatch(/invalid/i);
        for (const marker of [EXACT_MARKER, ...DECOY_MARKERS]) {
          expect(html, `${scope} ${marker}`).not.toContain(marker);
        }
        // Refused before any member is named: no phantom access subjects.
        expect(await logs()).toHaveLength(0);
      },
    );

    it("RED: duplicate scope fails without rows", async () => {
      for (const qs of [
        `event=${SCOPE_KEY}&event=${OTHER_KEY}`,
        `event=${SCOPE_KEY}&event=${SCOPE_KEY}`,
      ]) {
        const res = await read(`?${qs}`);
        expect([400, 422], qs).toContain(res.status);
        const html = await res.text();
        expect(html).toMatch(/invalid/i);
        expect(html, qs).not.toContain(EXACT_MARKER);
        expect(await logs(), qs).toHaveLength(0);
      }
    });

    it("CONTROL: blank scope renders the unscoped viewer with no scope UI", async () => {
      for (const qs of ["event=", "event=%20%20"]) {
        const res = await read(`?${qs}`);
        expect(res.status, qs).toBe(200);
        const html = await res.text();
        expect(html, qs).toContain(EXACT_MARKER);
        expect(html, qs).not.toContain('name="event"');
        for (const href of activityHrefs(html)) {
          expect(queryOf(href).get("event"), `${qs} -> ${href}`).toBeNull();
        }
      }
    });

    it("RED: well-formed unknown scope renders an explicit scoped empty state", async () => {
      const res = await read(`?event=${UNKNOWN_KEY}`);
      expect(res.status).toBe(200);
      const html = await res.text();
      for (const marker of [EXACT_MARKER, ...DECOY_MARKERS]) {
        expect(html, marker).not.toContain(marker);
      }
      expect(html).toContain(UNKNOWN_KEY);
      expect(html).toMatch(/recorded changes/i);
      expect(html).not.toContain("No activity yet.");
    });

    it("RED: scoped access subjects name only the scoped causers", async () => {
      const res = await read(`?event=${SCOPE_KEY}`);
      expect(res.status).toBe(200);
      const entries = await logs();
      expect(entries).toHaveLength(1);
      const subjects = entries[0]!.subjectUserIds as unknown[];
      expect(subjects.length).toBeGreaterThan(0);
      for (const subject of subjects) {
        expect(subject).toBe(SUBJECT.userId);
      }
    });

    it("CONTROL: the scoped viewer keeps minimal projection", async () => {
      const html = await (await read(`?event=${SCOPE_KEY}`)).text();
      expect(html).toContain(PROPS_MARKER);
      expect(html).not.toContain(PROPS_SENTINEL);
      for (const personal of PERSONAL_STRINGS) {
        expect(html, personal).not.toContain(personal);
      }
    });

    it("CONTROL: scoped failed audit still fails closed without contents", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        await fixture.db.execute(
          sql`ALTER TABLE member_data_access_logs RENAME TO unavailable_access_logs`,
        );
        const res = await read(`?event=${SCOPE_KEY}`);
        expect(res.status).toBe(503);
        expect(res.headers.get("cache-control")).toBe("private, no-store");
        const html = await res.text();
        expect(html).not.toContain(EXACT_MARKER);
        expect(html).not.toContain(SCOPE_KEY);
      } finally {
        await fixture.db.execute(
          sql`ALTER TABLE unavailable_access_logs RENAME TO member_data_access_logs`,
        );
        vi.restoreAllMocks();
      }
      expect(await logs()).toHaveLength(0);
    });
  },
);

// route-inventory: GET /e/:key
// Acceptance: member attendee identity reads are bounded at SQL (100 named
// rows + one sensitive lookahead per request) with native prev/next paging.
// A removed SQL LIMIT must fail here even if the render is sliced: every
// retrieved identity — lookahead included — is audited before release, so an
// unbounded read shows up as extra audit subjects even when HTML hides it.
//
// Locked contract (paired builder must satisfy without editing this file):
// - Query param: ?attendees=<page> (1-based). Missing/malformed/nonpositive/
//   unsafe arithmetic falls back to page 1, mirroring normalizePastPage.
// - Page size 100, order by rsvps.createdAt asc, rsvps.id asc; ties are stable
//   across page boundaries (no duplicates, no gaps).
// - Page 1 retrieves rows 1..100 + lookahead 101; page N retrieves its page
//   plus the first row of page N+1 when present. Lookaheads are never rendered
//   but their owners are audited (docs/w15-member-data-parity.md:214-219).
// - Hono renders native links data-testid="event-attendees-next" / "-prev"
//   with hrefs /e/<key>?attendees=<n> and accessible names mentioning
//   attendees; first page has no prev, last page has no next. A past-end page
//   keeps a working prev/return link. Kit model/render mirror this via
//   `attendeesPaging` and the same testids.
// - The section header no longer labels a partial page as the total; the
//   aggregate Going count (getPublicEvent.goingCount) is named-only and
//   excludes unnamed/nonmatching going users, so it equals the roster length.
// - Malformed/missing lookahead attribution or audit failure refuses the
//   whole response (503, no identities, no partial audit row), including when
//   the malformed row is only the lookahead. Guest/nonmember exclusion,
//   escaping, private/no-store and Vary: Cookie are preserved.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import { sql } from "drizzle-orm";
import { build } from "esbuild";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import app from "./app";
import { events, memberDataAccessLogs, rsvps } from "../src/db/admin-schema";
import { users } from "../src/db/schema";
import { getPublicEvent, listGoingAttendees } from "../src/events/reads";
import * as reads from "../src/events/reads";
import {
  kitEventDetailStore,
  resolveKitEventDetail,
  type KitEventDetailStore,
} from "../src/events/kit-detail";
import type { KitRequestSession } from "../src/kit-session";
import { createMemorySessionStore } from "../src/sessions";
import { cookieFor, env, EVENT_KEY, MEMBER, OUTSIDER, SUBJECT, seed } from "./helpers/member-data";
import { createMemberDataFixture, type MemberDataFixture } from "./helpers/member-data-db";

const PAGE = 100;
// More than two pages of synthetic attendees: 250 named going rows.
const TOTAL_NAMED = 250;
const pad = (n: number) => String(n).padStart(3, "0");
const synthId = (i: number) => `400000000000000${pad(i)}`; // 18-digit snowflake-shaped
const synthName = (i: number) => `paging-attendee-${pad(i)}`;
const sorted = (ids: string[]) => [...ids].sort();
const pageIds = (page: number) => {
  const ids: string[] = [];
  for (let i = (page - 1) * PAGE; i < Math.min(page * PAGE, TOTAL_NAMED); i++) ids.push(synthId(i));
  return ids;
};
// Audit expectation: rendered page + lookahead (first row of next page), self excluded.
const auditedIds = (page: number) => {
  const ids = pageIds(page);
  const lookahead = page * PAGE;
  if (lookahead < TOTAL_NAMED) ids.push(synthId(lookahead));
  return sorted(ids.filter((id) => id !== MEMBER.userId));
};
const link = (i: number) => `<a href="/members/${synthId(i)}">${synthName(i)}</a>`;

describe.skipIf(!process.env.DATABASE_URL)(
  "member attendee paging acceptance (isolated agent-testdb schema)",
  () => {
    let fixture: MemberDataFixture;
    let sessions = createMemorySessionStore();
    const request = (path = `/e/${EVENT_KEY}`, init: RequestInit = {}) =>
      app.request(path, init, {
        ...env,
        ADMIN_DB: fixture.db,
        SESSION_STORE: sessions,
      });
    const headers = async (actor = MEMBER) => ({ cookie: await cookieFor(sessions, actor) });
    const logs = () => fixture.db.select().from(memberDataAccessLogs);
    const withPage = (raw: string) => `/e/${EVENT_KEY}?attendees=${encodeURIComponent(raw)}`;

    // Viewer is MEMBER (not among synthetic attendees). SUBJECT's seeded RSVP
    // is removed so the 250 synthetic rows are the whole named population.
    // createdAt deliberately ties in groups of 25 so stability across the
    // page boundary depends on the id tiebreak, not insertion luck.
    async function seedPaging() {
      await fixture.db.delete(rsvps);
      const [event] = await fixture.db.select().from(events);
      const userRows = [];
      const rsvpRows = [];
      for (let i = 0; i < TOTAL_NAMED; i++) {
        userRows.push({ id: synthId(i), username: synthName(i) });
        rsvpRows.push({
          eventId: event!.id,
          userId: synthId(i),
          status: "going",
          createdAt: new Date(Date.UTC(2026, 0, 1 + Math.floor(i / 25))),
          updatedAt: new Date(Date.UTC(2026, 0, 1)),
        });
      }
      await fixture.db.insert(users).values(userRows);
      await fixture.db.insert(rsvps).values(rsvpRows);
      // Unnamed + nonmatching going users: excluded from the aggregate, never named.
      await fixture.db.insert(users).values({ id: "400000000000000900", username: "" });
      await fixture.db.insert(rsvps).values([
        { eventId: event!.id, userId: "400000000000000900", status: "going" },
        { eventId: event!.id, userId: "400000000000000901", status: "going" },
        { eventId: event!.id, userId: "400000000000000902", status: "waitlisted" },
      ]);
      return event!;
    }

    beforeAll(async () => {
      fixture = await createMemberDataFixture(process.env.DATABASE_URL!);
    });
    beforeEach(async () => {
      await fixture.reset();
      await seed(fixture.db);
      sessions = createMemorySessionStore();
    });
    afterEach(async () => {
      vi.restoreAllMocks();
      await fixture?.reset();
    });
    afterAll(() => fixture?.dispose());

    it("bounds the attendee read itself to one page plus lookahead (removed LIMIT fails)", async () => {
      const event = await seedPaging();
      // The route calls the read with (db, eventId, page); a bare two-arg call
      // must also be bounded (page 1). Returning all 250 here, even with a
      // sliced render, is the unbounded defect this suite exists to catch.
      const first = await (listGoingAttendees as (...args: unknown[]) => Promise<unknown[]>)(
        fixture.db,
        event.id,
      );
      expect(first.length).toBeLessThanOrEqual(PAGE + 1);
      const p2 = await (listGoingAttendees as (...args: unknown[]) => Promise<{ id: string }[]>)(
        fixture.db,
        event.id,
        2,
      );
      expect(p2.length).toBeLessThanOrEqual(PAGE + 1);
      // Continuity across the boundary: page 2 starts where page 1 ended.
      expect(p2[0]?.id).toBe(synthId(PAGE));
    });

    it("renders page 1 only, audits the 101st lookahead, links natively to page 2", async () => {
      await seedPaging();
      const res = await request(undefined, { headers: await headers() });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain(link(0));
      expect(html).toContain(link(PAGE - 1));
      expect(html).not.toContain(synthName(PAGE)); // lookahead retrieved, never rendered
      expect(html).not.toContain(synthName(TOTAL_NAMED - 1));
      expect(html).toContain('data-testid="event-attendees-next"');
      expect(html).toContain(`href="/e/${EVENT_KEY}?attendees=2"`);
      expect(html).not.toContain('data-testid="event-attendees-prev"');
      expect(html).not.toContain("Who's going (100)"); // partial page is not the total
      expect(res.headers.get("cache-control")).toBe("private, no-store");
      expect(res.headers.get("vary")).toBe("Cookie");
      expect(await logs()).toMatchObject([
        { subjectUserIds: auditedIds(1), subjectCount: PAGE + 1, route: "events.page" },
      ]);
    });

    it("walks pages 2 and 3 with stable tie order, no duplicates or gaps, and honest ends", async () => {
      await seedPaging();
      const seen = new Set<string>();
      for (const page of [1, 2, 3]) {
        const res = await request(withPage(String(page)), { headers: await headers() });
        expect(res.status).toBe(200);
        const html = await res.text();
        for (const id of pageIds(page)) {
          expect(seen.has(id)).toBe(false);
          seen.add(id);
          expect(html).toContain(`href="/members/${id}"`);
        }
        for (const id of [0, 1, 2, 3].flatMap((p) => (p === page ? [] : pageIds(p))))
          expect(html).not.toContain(`href="/members/${id}"`);
        if (page < 3) expect(html).toContain(`href="/e/${EVENT_KEY}?attendees=${page + 1}"`);
        if (page > 1) {
          expect(html).toContain('data-testid="event-attendees-prev"');
          expect(html).toContain(
            page === 2 ? `href="/e/${EVENT_KEY}"` : `href="/e/${EVENT_KEY}?attendees=${page - 1}"`,
          );
        }
        if (page === 3) expect(html).not.toContain('data-testid="event-attendees-next"');
      }
      expect(seen.size).toBe(TOTAL_NAMED);
      const allLogs = await logs();
      expect(allLogs).toHaveLength(3);
      for (const [i, page] of [1, 2, 3].entries())
        expect(allLogs[i]).toMatchObject({ subjectUserIds: auditedIds(page) });
    });

    it("serves a past-end page with no identities, a working return link, and no audit row", async () => {
      await seedPaging();
      const res = await request(withPage("4"), { headers: await headers() });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).not.toContain(synthName(0));
      expect(html).not.toContain(synthName(TOTAL_NAMED - 1));
      expect(html).toContain('data-testid="event-attendees-prev"');
      expect(html).toMatch(
        new RegExp(
          `href="/e/${EVENT_KEY}(\\?attendees=[13])?"[^>]*data-testid="event-attendees-prev"`,
        ),
      );
      expect(html).not.toContain('data-testid="event-attendees-next"');
      expect(await logs()).toHaveLength(0);
    });

    it.each(["0", "-1", "abc", "1.5", "999999999999999999999", " 2", "2x", ""])(
      "safely falls back to page 1 for attendees=%j",
      async (raw) => {
        await seedPaging();
        const res = await request(withPage(raw), { headers: await headers() });
        expect(res.status).toBe(200);
        const html = await res.text();
        expect(html).toContain(link(0));
        expect(html).not.toContain(synthName(PAGE));
        expect(await logs()).toMatchObject([{ subjectUserIds: auditedIds(1) }]);
      },
    );

    it("keeps the aggregate Going count named-only, independent of paging (excludes unnamed/missing)", async () => {
      await seedPaging();
      const pub = await getPublicEvent(fixture.db, EVENT_KEY);
      expect(pub?.goingCount).toBe(TOTAL_NAMED);
      for (const path of [undefined, withPage("3")]) {
        const html = await (await request(path, { headers: await headers() })).text();
        expect(html).toContain(`${TOTAL_NAMED} going`);
      }
    });

    it("refuses the whole response when only the lookahead key is malformed", async () => {
      const event = await seedPaging();
      // The malformed row sorts after all valid rows, so scale the valid set
      // to exactly one page: the bad row is then page 1's 101st lookahead.
      await fixture.db.delete(rsvps);
      await fixture.db.insert(rsvps).values([
        ...Array.from({ length: PAGE }, (_, i) => ({
          eventId: event.id,
          userId: synthId(i),
          status: "going",
          createdAt: new Date(Date.UTC(2026, 0, 1 + Math.floor(i / 25))),
        })),
        {
          eventId: event.id,
          userId: "123",
          status: "going",
          createdAt: new Date(Date.UTC(2027, 0, 1)),
        },
      ]);
      await fixture.db.insert(users).values({ id: "123", username: "lookahead-private-name" });
      const res = await request(undefined, { headers: await headers() });
      expect(res.status).toBe(503);
      const body = await res.text();
      expect(body).not.toContain(synthName(0));
      expect(body).not.toContain("lookahead-private-name");
      expect(await logs()).toHaveLength(0);
    });

    it("refuses the whole paged response for malformed attribution inside a later page", async () => {
      const event = await seedPaging();
      await fixture.db.insert(users).values({ id: "456", username: "page2-private-name" });
      await fixture.db.insert(rsvps).values({
        eventId: event.id,
        userId: "456",
        status: "going",
        createdAt: new Date(Date.UTC(2026, 0, 5)), // inside page 2's range
      });
      const res = await request(withPage("2"), { headers: await headers() });
      expect(res.status).toBe(503);
      const body = await res.text();
      expect(body).not.toContain(synthName(PAGE));
      expect(body).not.toContain("page2-private-name");
      expect(await logs()).toHaveLength(0);
    });

    it("refuses the whole response when the audit insert fails on a paged read", async () => {
      await seedPaging();
      vi.spyOn(console, "error").mockImplementation(() => {});
      await fixture.db.execute(
        sql`ALTER TABLE member_data_access_logs ADD CONSTRAINT reject_paging_access CHECK (false)`,
      );
      try {
        const res = await request(withPage("2"), { headers: await headers() });
        expect(res.status).toBe(503);
        expect(await res.text()).not.toContain(synthName(PAGE));
        expect(res.headers.get("cache-control")).toBe("private, no-store");
        expect(await logs()).toHaveLength(0);
      } finally {
        await fixture.db.execute(
          sql`ALTER TABLE member_data_access_logs DROP CONSTRAINT reject_paging_access`,
        );
      }
    });

    it.each(["guest", "non-member"])(
      "%s never sees attendee paging, identities, or an audit row",
      async (role) => {
        await seedPaging();
        const res = await request(withPage("2"), {
          headers: role === "guest" ? {} : await headers(OUTSIDER),
        });
        expect(res.status).toBe(200);
        const html = await res.text();
        expect(html).toContain(`${TOTAL_NAMED} going`);
        for (const value of [
          synthName(0),
          synthName(PAGE),
          "event-attendees",
          'id="event-attendees-heading"',
          "attendees=2",
        ])
          expect(html).not.toContain(value);
        expect(await logs()).toHaveLength(0);
      },
    );

    it("escapes a hostile name on its page and audits exactly that page+lookahead", async () => {
      await seedPaging();
      await fixture.db
        .update(users)
        .set({ username: '<img src=x onerror="paging(1)">' })
        .where(sql`${users.id} = ${synthId(PAGE)}`);
      const html = await (await request(withPage("2"), { headers: await headers() })).text();
      expect(html).toContain("&lt;img");
      expect(html).not.toContain("<img src=x");
      expect(await logs()).toMatchObject([{ subjectUserIds: auditedIds(2) }]);
    });

    it("keeps empty and single-page lists free of paging links (control)", async () => {
      // Seeded single attendee (SUBJECT) only — no paging UI, one subject.
      const res = await request(undefined, { headers: await headers() });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain(`<a href="/members/${SUBJECT.userId}">${SUBJECT.username}</a>`);
      expect(html).not.toContain('data-testid="event-attendees-next"');
      expect(html).not.toContain('data-testid="event-attendees-prev"');
      expect(await logs()).toMatchObject([{ subjectUserIds: [SUBJECT.userId] }]);
    });

    it("a mutated read returning every identity fails the paging assertions (self-check)", async () => {
      // Proves this suite detects the unbounded shape rather than a sliced
      // render: force the route's read to return all rows (ignoring page)
      // and the boundary must reject or the audit/subject assertions must
      // diverge from the page contract — never a clean 200 page 1.
      const event = await seedPaging();
      const original = reads.listGoingAttendees;
      vi.spyOn(reads, "listGoingAttendees").mockImplementation(async (...args: unknown[]) => {
        const all = await (original as (...a: unknown[]) => Promise<unknown[]>)(
          ...args.slice(0, 2),
        );
        return all as never;
      });
      void event;
      const res = await request(undefined, { headers: await headers() });
      const html = await res.text();
      const boundaryRefused = res.status === 503;
      const overRetrieved = (await logs())[0]?.subjectCount !== PAGE + 1;
      const overRendered = html.includes(synthName(TOTAL_NAMED - 1));
      expect(boundaryRefused || overRetrieved || overRendered).toBe(true);
    });
  },
);

// Kit parity: the framework-free resolver must page identically through the
// same real store/read. Markup parity is pinned with the Svelte SSR bundle
// (same recipe as test/kit-event-detail.test.ts). Kit route ownership stays
// disabled; this proves model/render alignment only, not Postgres audit
// storage (covered by the mounted Hono suite above).
const webRequire = createRequire(new URL("../web/package.json", import.meta.url));
const { compile } = webRequire("svelte/compiler") as {
  compile: (
    source: string,
    options: { generate: string; dev: boolean; filename: string },
  ) => { js: { code: string } };
};

async function buildKitBundle() {
  const worktree = fileURLToPath(new URL("../", import.meta.url));
  const scratch = mkdtempSync(join(tmpdir(), "kit-attendee-paging-"));
  try {
    const entry = join(scratch, "entry.mjs");
    writeFileSync(
      entry,
      `
import { render } from "svelte/server";
import Detail from ${JSON.stringify(join(worktree, "web/src/lib/EventDetail.svelte"))};
export function renderDetail(model) {
  const { head, body } = render(Detail, { props: { model } });
  return "<head>" + head + "</head><body>" + body + "</body>";
}
`,
    );
    const outfile = join(scratch, "bundle.mjs");
    await build({
      entryPoints: [entry],
      bundle: true,
      platform: "node",
      format: "esm",
      outfile,
      logLevel: "warning",
      absWorkingDir: worktree,
      nodePaths: [join(worktree, "web/node_modules"), join(worktree, "node_modules")],
      alias: { "#lib": fileURLToPath(new URL("../web/src/lib/", import.meta.url)) },
      plugins: [
        {
          name: "kit-attendee-paging-ssr",
          setup(plugin) {
            plugin.onLoad({ filter: /\.svelte$/ }, (args) => {
              const source = readFileSync(args.path, "utf8");
              const { js } = compile(source, {
                generate: "server",
                dev: false,
                filename: args.path,
              });
              return { contents: js.code, loader: "js", resolveDir: dirname(args.path) };
            });
          },
        },
      ],
    });
    return (await import(pathToFileURL(outfile).href)) as {
      renderDetail: (model: Record<string, unknown>) => string;
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

describe.skipIf(!process.env.DATABASE_URL)("Kit attendee paging parity (real store)", () => {
  let fixture: MemberDataFixture;
  const kitSession: KitRequestSession = {
    status: "authenticated",
    session: {
      userId: MEMBER.userId,
      username: MEMBER.username,
      avatar: null,
      member: true,
      moderator: false,
    },
  };
  async function resolveKit(search: string, store?: KitEventDetailStore) {
    return resolveKitEventDetail({
      key: EVENT_KEY,
      search,
      path: `/e/${EVENT_KEY}`,
      env,
      session: kitSession,
      joinResult: null,
      setHeaders: () => {},
      store: store ?? { ...kitEventDetailStore(env), dbForFn: async () => fixture.db },
    });
  }

  beforeAll(async () => {
    fixture = await createMemberDataFixture(process.env.DATABASE_URL!);
  });
  beforeEach(async () => {
    await fixture.reset();
    await seed(fixture.db);
    await fixture.db.delete(rsvps);
    const [event] = await fixture.db.select().from(events);
    const userRows = [];
    const rsvpRows = [];
    for (let i = 0; i < TOTAL_NAMED; i++) {
      userRows.push({ id: synthId(i), username: synthName(i) });
      rsvpRows.push({
        eventId: event!.id,
        userId: synthId(i),
        status: "going",
        createdAt: new Date(Date.UTC(2026, 0, 1 + Math.floor(i / 25))),
        updatedAt: new Date(Date.UTC(2026, 0, 1)),
      });
    }
    await fixture.db.insert(users).values(userRows);
    await fixture.db.insert(rsvps).values(rsvpRows);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await fixture?.reset();
  });
  afterAll(() => fixture?.dispose());

  it("resolves the same page 2 identities and paging state as Hono", async () => {
    const outcome = await resolveKit("?attendees=2");
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") throw new Error("unreachable");
    const model = outcome.model as unknown as Record<string, unknown>;
    const attendees = model.attendees as { id: string; name: string }[];
    expect(attendees.map((a) => a.id)).toEqual(pageIds(2));
    expect(model.attendeesPaging).toMatchObject({
      page: 2,
      prevHref: `/e/${EVENT_KEY}`,
      nextHref: `/e/${EVENT_KEY}?attendees=3`,
    });
    expect(model.goingCount).toBe(TOTAL_NAMED);
  });

  it.each(["?attendees=0", "?attendees=abc", "?attendees=999999999999999999999", ""])(
    "safely resolves page 1 for search %j",
    async (search) => {
      const outcome = await resolveKit(search);
      expect(outcome.kind).toBe("ok");
      if (outcome.kind !== "ok") throw new Error("unreachable");
      const model = outcome.model as unknown as Record<string, unknown>;
      expect((model.attendees as { id: string }[]).map((a) => a.id)).toEqual(pageIds(1));
      expect(model.attendeesPaging).toMatchObject({ page: 1, prevHref: null });
    },
  );

  it("renders native prev/next links and the same names as Hono page 2", async () => {
    const outcome = await resolveKit("?attendees=2");
    if (outcome.kind !== "ok") throw new Error("unreachable");
    const { renderDetail } = await buildKitBundle();
    const html = renderDetail(outcome.model as unknown as Record<string, unknown>);
    expect(html).toContain('data-testid="event-attendees"');
    expect(html).toContain(`href="/members/${synthId(PAGE)}"`);
    expect(html).toContain(`>${synthName(PAGE)}<`);
    expect(html).not.toContain(synthName(0));
    expect(html).not.toContain(synthName(2 * PAGE)); // lookahead not rendered
    expect(html).toContain('data-testid="event-attendees-prev"');
    expect(html).toContain('data-testid="event-attendees-next"');
    expect(html).toContain(`href="/e/${EVENT_KEY}?attendees=3"`);
    expect(html).not.toContain("Who's going (100)");
  });

  it("renders a past-end page with a working return link and no identities", async () => {
    const outcome = await resolveKit("?attendees=4");
    if (outcome.kind !== "ok") throw new Error("unreachable");
    const { renderDetail } = await buildKitBundle();
    const html = renderDetail(outcome.model as unknown as Record<string, unknown>);
    expect(html).not.toContain(synthName(0));
    expect(html).toContain('data-testid="event-attendees-prev"');
    expect(html).not.toContain('data-testid="event-attendees-next"');
  });
});

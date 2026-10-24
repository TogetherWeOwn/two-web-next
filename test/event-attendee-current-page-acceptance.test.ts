// route-inventory: GET /e/:key
// Acceptance: when native attendee paging is present, both renderers show
// the viewer which attendee page they are on. Today the models already carry
// attendeesPaging.page but neither renderer prints it, so a middle or
// past-end page offers only Previous/Next links with no position.
//
// Locked contract (paired builder must satisfy without editing this file):
// - Inside the existing <nav aria-label="Attendee pages">, exactly one
//   element carries data-testid="event-attendees-current-page",
//   aria-current="page", no hidden/aria-hidden treatment, and its own
//   visible text is exactly "Page <n>" where <n> is the model's existing
//   attendeesPaging.page (the normalized page, never the raw query value).
// - The label sits between the Previous and Next links when both exist,
//   after Previous on a last/past-end page, and before Next on page 1.
// - No total is ever shown: never "Page <n> of <m>", and no page count is
//   derived from the aggregate Going count (named-only: it excludes unnamed
//   and nonmatching going users, so it equals the roster length).
// - No extra identity or count read is added: the audit subjects per request
//   stay exactly the rendered page plus its one lookahead, and the aggregate
//   Going count keeps that named-only rule.
// - Preserved behavior: single-page lists render no pager and no label,
//   guests/nonmembers get no attendee section at all, previous/next hrefs
//   are unchanged, and a past-end page keeps its bare-URL return link with
//   its own (past-end) page number shown and no audit row.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import { build } from "esbuild";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import app from "./app";
import { events, memberDataAccessLogs, rsvps } from "../src/db/admin-schema";
import { users } from "../src/db/schema";
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
// 250 named going rows = two full pages plus a 50-row last page; page 4 is
// past the end. Two further going rows (one unnamed, one with no user row)
// are excluded from the aggregate Going total and never named, so the
// aggregate (250) equals the roster length and must never be turned into a
// page total.
const TOTAL_NAMED = 250;
const GOING_TOTAL = TOTAL_NAMED;
const pad = (n: number) => String(n).padStart(3, "0");
const synthId = (i: number) => `400000000000000${pad(i)}`;
const synthName = (i: number) => `paging-attendee-${pad(i)}`;
const sorted = (ids: string[]) => [...ids].sort();
const pageIds = (page: number) => {
  const ids: string[] = [];
  for (let i = (page - 1) * PAGE; i < Math.min(page * PAGE, TOTAL_NAMED); i++) ids.push(synthId(i));
  return ids;
};
// Audit expectation: rendered page + lookahead (first row of next page).
const auditedIds = (page: number) => {
  const ids = pageIds(page);
  const lookahead = page * PAGE;
  if (lookahead < TOTAL_NAMED) ids.push(synthId(lookahead));
  return sorted(ids.filter((id) => id !== MEMBER.userId));
};
const link = (i: number) => `<a href="/members/${synthId(i)}">${synthName(i)}</a>`;
const pageHref = (page: number) =>
  page <= 1 ? `/e/${EVENT_KEY}` : `/e/${EVENT_KEY}?attendees=${page}`;

// SUBJECT's seeded RSVP is removed so the 250 synthetic rows are the whole
// named population; createdAt ties in groups of 25 like the paging suite.
async function seedPaging(db: MemberDataFixture["db"]) {
  await db.delete(rsvps);
  const [event] = await db.select().from(events);
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
  await db.insert(users).values(userRows);
  await db.insert(rsvps).values(rsvpRows);
  await db.insert(users).values({ id: "400000000000000900", username: "" });
  await db.insert(rsvps).values([
    { eventId: event!.id, userId: "400000000000000900", status: "going" },
    { eventId: event!.id, userId: "400000000000000901", status: "going" },
    { eventId: event!.id, userId: "400000000000000902", status: "waitlisted" },
  ]);
  return event!;
}

const CURRENT_ID = 'data-testid="event-attendees-current-page"';

// Test-only text extraction for assertions (no HTML sink): walk angle
// brackets instead of a `<...>` regex replace so the helper does not read
// as an HTML sanitizer (CodeQL incomplete sanitization). tagReplacement is
// emitted once per tag, mirroring the empty- vs space-join at the call sites.
function textOutsideTags(fragment: string, tagReplacement = "") {
  let out = "";
  let inTag = false;
  for (const ch of fragment) {
    if (ch === "<" && !inTag) {
      out += tagReplacement;
      inTag = true;
    } else if (ch === ">" && inTag) inTag = false;
    else if (!inTag) out += ch;
  }
  return out;
}

function currentPageElement(html: string) {
  const m = html.match(
    new RegExp(`<([a-zA-Z][a-zA-Z0-9-]*)\\b([^>]*${CURRENT_ID}[^>]*)>([\\s\\S]*?)</\\1>`),
  );
  if (!m) return null;
  return {
    attrs: m[2]!,
    text: textOutsideTags(m[3]!).replace(/\s+/g, " ").trim(),
    index: m.index!,
  };
}

function attendeesNav(html: string) {
  const m = html.match(/<nav\b[^>]*aria-label="Attendee pages"[^>]*>([\s\S]*?)<\/nav>/);
  if (!m) return null;
  return {
    inner: m[1]!,
    text: textOutsideTags(m[1]!, " ").replace(/\s+/g, " "),
    index: m.index!,
    end: m.index! + m[0].length,
  };
}

function pagingLink(html: string, testid: "event-attendees-prev" | "event-attendees-next") {
  const m = html.match(new RegExp(`<a\\b([^>]*data-testid="${testid}"[^>]*)>`));
  if (!m) return null;
  return { href: m[1]!.match(/href="([^"]*)"/)?.[1] ?? null, index: m.index! };
}

// The one assertion every paged state in both renderers must satisfy.
function expectCurrentPage(
  html: string,
  page: number,
  expected: { prevHref: string | null; nextHref: string | null },
) {
  const nav = attendeesNav(html);
  expect(nav, "attendee pagination nav").not.toBeNull();
  expect(html.split(CURRENT_ID).length - 1, "exactly one current-page element").toBe(1);
  const el = currentPageElement(html);
  expect(el, "current-page element").not.toBeNull();
  // Visible, accessible, and the model's actual page — with no invented total.
  expect(el!.text).toBe(`Page ${page}`);
  expect(el!.attrs).toContain('aria-current="page"');
  expect(el!.attrs).not.toMatch(/aria-hidden/);
  expect(el!.attrs).not.toMatch(/(^|\s)hidden(\s|=|$)/);
  expect(el!.index).toBeGreaterThan(nav!.index);
  expect(el!.index).toBeLessThan(nav!.end);
  expect(nav!.text).not.toMatch(/\bof\s+\d+\b/);
  expect(html).not.toContain(`Page ${page} of`);
  const prev = pagingLink(html, "event-attendees-prev");
  const next = pagingLink(html, "event-attendees-next");
  if (expected.prevHref === null) {
    expect(prev, "no previous link").toBeNull();
  } else {
    expect(prev?.href, "previous href unchanged").toBe(expected.prevHref);
    expect(prev!.index, "label after previous link").toBeLessThan(el!.index);
  }
  if (expected.nextHref === null) {
    expect(next, "no next link").toBeNull();
  } else {
    expect(next?.href, "next href unchanged").toBe(expected.nextHref);
    expect(next!.index, "label before next link").toBeGreaterThan(el!.index);
  }
}

function expectNoPager(html: string) {
  expect(html).not.toContain(CURRENT_ID);
  expect(attendeesNav(html)).toBeNull();
  expect(html).not.toContain('data-testid="event-attendees-prev"');
  expect(html).not.toContain('data-testid="event-attendees-next"');
}

describe.skipIf(!process.env.DATABASE_URL)(
  "Hono attendee current-page label acceptance (isolated agent-testdb schema)",
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

    it.each([
      { page: 1, path: undefined, prevHref: null, nextHref: pageHref(2), first: 0 },
      { page: 2, path: withPage("2"), prevHref: pageHref(1), nextHref: pageHref(3), first: PAGE },
      { page: 3, path: withPage("3"), prevHref: pageHref(2), nextHref: null, first: 2 * PAGE },
    ])("shows Page $page beside the unchanged prev/next links", async (c) => {
      await seedPaging(fixture.db);
      const res = await request(c.path, { headers: await headers() });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain(link(c.first));
      expect(html).toContain(`${GOING_TOTAL} going`);
      expectCurrentPage(html, c.page, { prevHref: c.prevHref, nextHref: c.nextHref });
      // No extra identity read: exactly this page plus its lookahead audited.
      expect(await logs()).toMatchObject([
        { subjectUserIds: auditedIds(c.page), route: "events.page" },
      ]);
    });

    it("shows the past-end page number with the bare-URL return link and no audit row", async () => {
      await seedPaging(fixture.db);
      const res = await request(withPage("4"), { headers: await headers() });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("There are no more attendees on this page.");
      expect(html).not.toContain(synthName(0));
      expect(html).not.toContain(synthName(TOTAL_NAMED - 1));
      expectCurrentPage(html, 4, { prevHref: pageHref(1), nextHref: null });
      expect(await logs()).toHaveLength(0);
    });

    it("labels a malformed attendees value with the normalized page 1, not the raw value", async () => {
      await seedPaging(fixture.db);
      const res = await request(withPage("2x"), { headers: await headers() });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain(link(0));
      expectCurrentPage(html, 1, { prevHref: null, nextHref: pageHref(2) });
      expect(await logs()).toMatchObject([{ subjectUserIds: auditedIds(1) }]);
    });

    it("keeps a single-page list free of pager and label (control)", async () => {
      const res = await request(undefined, { headers: await headers() });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain(`<a href="/members/${SUBJECT.userId}">${SUBJECT.username}</a>`);
      expect(html).toContain("Who&#39;s going (1)");
      expectNoPager(html);
      expect(await logs()).toMatchObject([{ subjectUserIds: [SUBJECT.userId] }]);
    });

    it.each(["guest", "non-member"])(
      "%s sees no attendee section, pager, or label on a paged URL (control)",
      async (role) => {
        await seedPaging(fixture.db);
        const res = await request(withPage("2"), {
          headers: role === "guest" ? {} : await headers(OUTSIDER),
        });
        expect(res.status).toBe(200);
        const html = await res.text();
        expect(html).toContain(`${GOING_TOTAL} going`);
        expect(html).not.toContain(synthName(PAGE));
        expect(html).not.toContain("event-attendees");
        expectNoPager(html);
        expect(await logs()).toHaveLength(0);
      },
    );
  },
);

// Kit parity: same recipe as test/event-attendee-paging-acceptance.test.ts —
// the framework-free resolver over the real store, rendered through the
// Svelte SSR bundle. Hono a11y/visual gates do not exercise this renderer.
const webRequire = createRequire(new URL("../web/package.json", import.meta.url));
const { compile } = webRequire("svelte/compiler") as {
  compile: (
    source: string,
    options: { generate: string; dev: boolean; filename: string },
  ) => { js: { code: string } };
};

async function buildKitBundle() {
  const worktree = fileURLToPath(new URL("../", import.meta.url));
  const scratch = mkdtempSync(join(tmpdir(), "kit-attendee-current-page-"));
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
          name: "kit-attendee-current-page-ssr",
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

describe.skipIf(!process.env.DATABASE_URL)(
  "Kit attendee current-page label parity (real store)",
  () => {
    let fixture: MemberDataFixture;
    let renderDetail: (model: Record<string, unknown>) => string;
    const memberSession: KitRequestSession = {
      status: "authenticated",
      session: {
        userId: MEMBER.userId,
        username: MEMBER.username,
        avatar: null,
        member: true,
        moderator: false,
      },
    };
    const outsiderSession: KitRequestSession = {
      status: "authenticated",
      session: {
        userId: OUTSIDER.userId,
        username: OUTSIDER.username,
        avatar: null,
        member: false,
        moderator: false,
      },
    };
    const guestSession: KitRequestSession = { status: "guest", session: null };
    async function renderKit(search: string, session: KitRequestSession = memberSession) {
      const store: KitEventDetailStore = {
        ...kitEventDetailStore(env),
        dbForFn: async () => fixture.db,
      };
      const outcome = await resolveKitEventDetail({
        key: EVENT_KEY,
        search,
        path: `/e/${EVENT_KEY}`,
        env,
        session,
        joinResult: null,
        setHeaders: () => {},
        store,
      });
      expect(outcome.kind).toBe("ok");
      if (outcome.kind !== "ok") throw new Error("unreachable");
      const model = outcome.model as unknown as Record<string, unknown>;
      return { model, html: renderDetail(model) };
    }

    beforeAll(async () => {
      fixture = await createMemberDataFixture(process.env.DATABASE_URL!);
      ({ renderDetail } = await buildKitBundle());
    });
    beforeEach(async () => {
      await fixture.reset();
      await seed(fixture.db);
      await seedPaging(fixture.db);
    });
    afterEach(async () => {
      vi.restoreAllMocks();
      await fixture?.reset();
    });
    afterAll(() => fixture?.dispose());

    it.each([
      { page: 1, search: "", prevHref: null, nextHref: pageHref(2) },
      { page: 2, search: "?attendees=2", prevHref: pageHref(1), nextHref: pageHref(3) },
      { page: 3, search: "?attendees=3", prevHref: pageHref(2), nextHref: null },
    ])("renders Page $page from the model beside the unchanged prev/next links", async (c) => {
      const { model, html } = await renderKit(c.search);
      expect(model.attendeesPaging).toMatchObject({
        page: c.page,
        prevHref: c.prevHref,
        nextHref: c.nextHref,
      });
      expect(model.goingCount).toBe(GOING_TOTAL);
      expect((model.attendees as { id: string }[]).map((a) => a.id)).toEqual(pageIds(c.page));
      expectCurrentPage(html, c.page, { prevHref: c.prevHref, nextHref: c.nextHref });
    });

    it("renders the past-end page number with the bare-URL return link", async () => {
      const { model, html } = await renderKit("?attendees=4");
      expect(model.attendeesPaging).toMatchObject({
        page: 4,
        prevHref: pageHref(1),
        nextHref: null,
      });
      expect(html).toContain("There are no more attendees on this page.");
      expect(html).not.toContain(synthName(0));
      expectCurrentPage(html, 4, { prevHref: pageHref(1), nextHref: null });
    });

    it("labels a malformed attendees value with the normalized page 1", async () => {
      const { model, html } = await renderKit("?attendees=2x");
      expect(model.attendeesPaging).toMatchObject({ page: 1 });
      expectCurrentPage(html, 1, { prevHref: null, nextHref: pageHref(2) });
    });

    it("keeps a single-page list free of pager and label (control)", async () => {
      await fixture.db.delete(rsvps);
      const [event] = await fixture.db.select().from(events);
      await fixture.db.insert(rsvps).values({
        eventId: event!.id,
        userId: synthId(0),
        status: "going",
      });
      const { model, html } = await renderKit("");
      expect(model.attendeesPaging).toMatchObject({ page: 1, prevHref: null, nextHref: null });
      expect(html).toContain("Who's going (1)");
      expectNoPager(html);
    });

    it.each([
      { role: "guest", session: guestSession },
      { role: "non-member", session: outsiderSession },
    ])(
      "$role model renders no attendee section, pager, or label (control)",
      async ({ session }) => {
        const { html } = await renderKit("?attendees=2", session);
        expect(html).not.toContain(synthName(PAGE));
        expect(html).not.toContain('data-testid="event-attendees"');
        expectNoPager(html);
      },
    );
  },
);

// route-inventory: GET /e/:key
// route-inventory: POST /e/:key/rsvp
// Acceptance: a no-JS (native form) RSVP submission made from a later
// attendee page returns the member to that same attendee page.
//
// Locked contract (paired builder must satisfy without editing this file):
// - Renderer-to-POST round trip: render GET /e/<key>?attendees=2 as a member,
//   take the native RSVP form exactly as served (its action, every rendered
//   field, and the browser Referer for that page), submit it natively, and
//   the success destination is /e/<key>?attendees=2. Page 3 behaves the same
//   with attendees=3. The carrier is the builder's choice (form action query,
//   a rendered field, or an equally native channel); this suite submits
//   whatever the renderer actually emits, so it prescribes no mechanism. A
//   destination hard-coded to page 2, or one that only works with JS, fails.
// - Join (status=going) and withdraw (status=withdraw) both keep the page,
//   on the Hono page and on the Kit EventDetail rendering (whose form posts
//   to the same controller), and the RSVP write itself still happens.
// - Auth recovery: the same submission with the session gone answers 303 to
//   the sign-in route whose decoded `next` is /e/<key>?attendees=2, so the
//   member lands back on page 2 after signing in.
// - Native refusals (429 throttled, 503 database unavailable, 403 closed
//   after render) keep their status (and Retry-After on 429) and their
//   "Return to the event" link points at /e/<key>?attendees=2.
// - Page one stays bare: submissions rendered from /e/<key> and from
//   /e/<key>?attendees=1 return to the bare /e/<key> (never ?attendees=1),
//   and a malformed page query (?attendees=2x) renders page one and returns
//   bare.
// - Strict normalization: tampering every page carrier the renderer emitted
//   (action params, rendered fields, an `attendees` body/query value, and the
//   Referer) with malformed or unsafe values — 0, negatives, fractions,
//   padded/leading-zero/suffixed numbers, unsafe integers, absolute or
//   protocol-relative external URLs, another event's path — can never choose
//   an external or cross-event destination and never selects an offset: the
//   write still succeeds and the destination falls back to the bare event
//   page. The same fallback holds on the auth-recovery and refusal paths.
// Uses only the isolated disposable-schema member-data fixture (skipped
// without DATABASE_URL); no live, staging, or production access.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import { eq } from "drizzle-orm";
import { build } from "esbuild";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import app from "./app";
import { events, rsvps } from "../src/db/admin-schema";
import { users } from "../src/db/schema";
import type { Env } from "../src/env";
import {
  kitEventDetailStore,
  resolveKitEventDetail,
  type KitEventDetailStore,
} from "../src/events/kit-detail";
import type { KitRequestSession } from "../src/kit-session";
import { createMemorySessionStore } from "../src/sessions";
import { cookieFor, env, EVENT_KEY, MEMBER, seed } from "./helpers/member-data";
import { createMemberDataFixture, type MemberDataFixture } from "./helpers/member-data-db";

const BASE = env.APP_URL;
const PAGE = 100;
// Three attendee pages: page 3 holds the final 10 synthetic rows.
const TOTAL_NAMED = 210;
const pad = (n: number) => String(n).padStart(3, "0");
const synthId = (i: number) => `500000000000000${pad(i)}`; // 18-digit snowflake-shaped
const synthName = (i: number) => `native-page-attendee-${pad(i)}`;
const HONEY_FIELD = "website"; // RSVP decoy: never filled by a genuine browser

const decodeEntities = (value: string) =>
  value
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&#x27;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");

const attr = (attrs: string, name: string): string | null => {
  const m = attrs.match(new RegExp(`\\b${name}="([^"]*)"`));
  return m ? decodeEntities(m[1]!) : null;
};

interface NativeSubmission {
  /** Fully resolved form action, exactly as a browser resolves it. */
  url: URL;
  /** Every submittable rendered field except the chosen status button. */
  fields: URLSearchParams;
  /** The page URL the form was rendered on (the browser Referer). */
  referer: string;
}

/** Extract the served native RSVP form as a browser would submit it: the
 * resolved action, every named non-button input, and the clicked button's
 * status. Fails loudly when the requested button is not rendered, so a
 * missing join/withdraw control cannot masquerade as a redirect failure. */
function extractSubmission(html: string, pagePath: string, status: string): NativeSubmission {
  for (const form of html.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/g)) {
    const attrs = form[1]!;
    if (!attrs.includes("data-rsvp-form")) continue;
    const inner = form[2]!;
    const fields = new URLSearchParams();
    for (const input of inner.matchAll(/<input\b([^>]*?)>/g)) {
      const inputAttrs = input[1]!;
      const name = attr(inputAttrs, "name");
      const type = (attr(inputAttrs, "type") ?? "text").toLowerCase();
      if (!name || ["submit", "button", "image", "reset"].includes(type)) continue;
      if (/\bdisabled\b/.test(inputAttrs)) continue;
      fields.append(name, attr(inputAttrs, "value") ?? "");
    }
    let buttonFound = false;
    for (const button of inner.matchAll(/<button\b([^>]*?)>/g)) {
      if (attr(button[1]!, "name") === "status" && attr(button[1]!, "value") === status)
        buttonFound = true;
    }
    expect(buttonFound, `native form renders a status=${status} button`).toBe(true);
    fields.set("status", status);
    return {
      url: new URL(attr(attrs, "action") ?? pagePath, BASE),
      fields,
      referer: new URL(pagePath, BASE).href,
    };
  }
  throw new Error("no native RSVP form (data-rsvp-form) rendered");
}

/** Overwrite every page carrier with one hostile value: action params,
 * rendered fields (the decoy stays empty, as a browser leaves it), an
 * explicit attendees body/query value, and the Referer page value. */
function tamperCarriers(submission: NativeSubmission, evil: string): void {
  for (const key of [...submission.url.searchParams.keys()])
    submission.url.searchParams.set(key, evil);
  submission.url.searchParams.set("attendees", evil);
  for (const key of [...submission.fields.keys()]) {
    if (key === "status" || key === HONEY_FIELD) continue;
    submission.fields.set(key, evil);
  }
  submission.fields.set("attendees", evil);
  const referer = new URL(submission.referer);
  referer.searchParams.set("attendees", evil);
  submission.referer = referer.href;
}

/** Parse a redirect/link destination and pin it to this event on this origin. */
function expectEventDestination(raw: string | null, attendees: string | null): void {
  expect(raw, "destination is present").not.toBeNull();
  const dest = new URL(raw!, BASE);
  expect(dest.origin).toBe(new URL(BASE).origin);
  expect(dest.pathname).toBe(`/e/${EVENT_KEY}`);
  expect(dest.searchParams.get("attendees")).toBe(attendees);
  expect(dest.search).toBe(attendees === null ? "" : `?attendees=${attendees}`);
  expect(dest.hash).toBe("");
}

function returnLinkHref(html: string): string {
  const m = html.match(/<a href="([^"]*)">Return to the event<\/a>/);
  expect(m, "refusal renders the return-to-event link").not.toBeNull();
  return decodeEntities(m![1]!);
}

// Kit SSR bundle recipe (same as test/event-attendee-paging-acceptance.test.ts).
const webRequire = createRequire(new URL("../web/package.json", import.meta.url));
const { compile } = webRequire("svelte/compiler") as {
  compile: (
    source: string,
    options: { generate: string; dev: boolean; filename: string },
  ) => { js: { code: string } };
};
let kitBundle: Promise<{ renderDetail: (model: Record<string, unknown>) => string }> | undefined;
function buildKitBundle() {
  kitBundle ??= (async () => {
    const worktree = fileURLToPath(new URL("../", import.meta.url));
    const scratch = mkdtempSync(join(tmpdir(), "kit-native-rsvp-page-"));
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
            name: "kit-native-rsvp-page-ssr",
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
  })();
  return kitBundle;
}

describe.skipIf(!process.env.DATABASE_URL)(
  "native RSVP submissions keep the attendee page (isolated agent-testdb schema)",
  () => {
    let fixture: MemberDataFixture;
    let sessions = createMemorySessionStore();
    const dbEnv = () =>
      ({
        ...env,
        ADMIN_DB: fixture.db,
        SESSION_STORE: sessions,
        SYNC_EVENT_QUEUE: { send: async () => {} },
      }) as unknown as Env;
    // Same sessions, no database: the write cannot run (503 path).
    const noDbEnv = () => ({ ...env, SESSION_STORE: sessions }) as unknown as Env;
    const memberCookie = () => cookieFor(sessions, MEMBER);

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
      return event!;
    }

    const memberRow = async () =>
      (await fixture.db.select().from(rsvps).where(eq(rsvps.userId, MEMBER.userId)))[0];

    /** GET the event page as MEMBER and extract its native submission. */
    async function renderHonoSubmission(pagePath: string, status: string) {
      const res = await app.request(
        pagePath,
        { headers: { cookie: await memberCookie() } },
        dbEnv(),
      );
      expect(res.status).toBe(200);
      return extractSubmission(await res.text(), pagePath, status);
    }

    async function postSubmission(
      submission: NativeSubmission,
      opts: { cookie?: string | null; bindings?: Env } = {},
    ) {
      const cookie = opts.cookie === undefined ? await memberCookie() : opts.cookie;
      return app.request(
        submission.url.pathname + submission.url.search,
        {
          method: "POST",
          headers: {
            ...(cookie ? { cookie } : {}),
            origin: BASE,
            referer: submission.referer,
            "content-type": "application/x-www-form-urlencoded",
          },
          body: submission.fields,
        },
        opts.bindings ?? dbEnv(),
      );
    }

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
    async function renderKitSubmission(search: string, status: string) {
      const store: KitEventDetailStore = {
        ...kitEventDetailStore(env),
        dbForFn: async () => fixture.db,
      };
      const outcome = await resolveKitEventDetail({
        key: EVENT_KEY,
        search,
        path: `/e/${EVENT_KEY}`,
        env,
        session: kitSession,
        joinResult: null,
        setHeaders: () => {},
        store,
      });
      expect(outcome.kind).toBe("ok");
      if (outcome.kind !== "ok") throw new Error("unreachable");
      const { renderDetail } = await buildKitBundle();
      const html = renderDetail(outcome.model as unknown as Record<string, unknown>);
      return extractSubmission(html, `/e/${EVENT_KEY}${search}`, status);
    }

    beforeAll(async () => {
      fixture = await createMemberDataFixture(process.env.DATABASE_URL!);
    });
    beforeEach(async () => {
      await fixture.client`delete from web_throttle_hits`;
      await fixture.reset();
      await seed(fixture.db);
      sessions = createMemorySessionStore();
    });
    afterEach(async () => {
      vi.restoreAllMocks();
      await fixture.client`delete from web_throttle_hits`;
      await fixture?.reset();
    });
    afterAll(() => fixture?.dispose());

    it("keeps ?attendees=2 on a native join from page two, and the write lands", async () => {
      await seedPaging();
      const submission = await renderHonoSubmission(`/e/${EVENT_KEY}?attendees=2`, "going");
      const res = await postSubmission(submission);
      expect(res.status).toBe(303);
      expectEventDestination(res.headers.get("location"), "2");
      expect(await memberRow()).toMatchObject({ status: "going" });
      // The destination really is page two: following it renders page-two
      // identities, not page one.
      const landed = await app.request(
        res.headers.get("location")!,
        { headers: { cookie: await memberCookie() } },
        dbEnv(),
      );
      const html = await landed.text();
      expect(html).toContain(synthName(PAGE));
      expect(html).not.toContain(synthName(0));
    });

    it("keeps ?attendees=2 on a native withdraw from page two, and the row goes", async () => {
      const event = await seedPaging();
      await fixture.db
        .insert(rsvps)
        .values({ eventId: event.id, userId: MEMBER.userId, status: "going" });
      const submission = await renderHonoSubmission(`/e/${EVENT_KEY}?attendees=2`, "withdraw");
      const res = await postSubmission(submission);
      expect(res.status).toBe(303);
      expectEventDestination(res.headers.get("location"), "2");
      expect(await memberRow()).toBeUndefined();
    });

    it("keeps ?attendees=3 on a native join from page three (not hard-coded to page two)", async () => {
      await seedPaging();
      const submission = await renderHonoSubmission(`/e/${EVENT_KEY}?attendees=3`, "going");
      const res = await postSubmission(submission);
      expect(res.status).toBe(303);
      expectEventDestination(res.headers.get("location"), "3");
      expect(await memberRow()).toMatchObject({ status: "going" });
    });

    it.each([`/e/${EVENT_KEY}`, `/e/${EVENT_KEY}?attendees=1`, `/e/${EVENT_KEY}?attendees=2x`])(
      "keeps page one bare for a native join rendered from %s (control)",
      async (pagePath) => {
        await seedPaging();
        const submission = await renderHonoSubmission(pagePath, "going");
        const res = await postSubmission(submission);
        expect(res.status).toBe(303);
        expectEventDestination(res.headers.get("location"), null);
        expect(await memberRow()).toMatchObject({ status: "going" });
      },
    );

    it("keeps ?attendees=2 in the auth-recovery destination when the session is gone", async () => {
      await seedPaging();
      const submission = await renderHonoSubmission(`/e/${EVENT_KEY}?attendees=2`, "going");
      const res = await postSubmission(submission, { cookie: null });
      expect(res.status).toBe(303);
      const location = new URL(res.headers.get("location")!, BASE);
      expect(location.origin).toBe(new URL(BASE).origin);
      expect(location.pathname).toBe("/join/discord");
      expectEventDestination(location.searchParams.get("next"), "2");
      expect(await memberRow()).toBeUndefined(); // no write without a session
    });

    it("keeps ?attendees=2 on the throttled (429) refusal return link", async () => {
      await seedPaging();
      // Spend the shared twelve-write budget through the JSON resource.
      for (let i = 0; i < 12; i++) {
        const put = await app.request(
          `/events/${EVENT_KEY}/rsvp`,
          {
            method: "PUT",
            headers: {
              cookie: await memberCookie(),
              origin: BASE,
              "content-type": "application/json",
            },
            body: JSON.stringify({ status: "going" }),
          },
          dbEnv(),
        );
        expect(put.status).toBeLessThan(300);
      }
      const submission = await renderHonoSubmission(`/e/${EVENT_KEY}?attendees=2`, "withdraw");
      const res = await postSubmission(submission);
      expect(res.status).toBe(429);
      expect(Number(res.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
      expectEventDestination(returnLinkHref(await res.text()), "2");
      expect(await memberRow()).toMatchObject({ status: "going" }); // refused, not withdrawn
    });

    it("keeps ?attendees=2 on the database-unavailable (503) refusal return link", async () => {
      await seedPaging();
      const submission = await renderHonoSubmission(`/e/${EVENT_KEY}?attendees=2`, "going");
      const res = await postSubmission(submission, { bindings: noDbEnv() });
      expect(res.status).toBe(503);
      expectEventDestination(returnLinkHref(await res.text()), "2");
    });

    it("keeps ?attendees=2 on the closed-after-render (403) refusal return link", async () => {
      const event = await seedPaging();
      const submission = await renderHonoSubmission(`/e/${EVENT_KEY}?attendees=2`, "going");
      await fixture.db.update(events).set({ rsvpOpen: false }).where(eq(events.id, event.id));
      const res = await postSubmission(submission);
      expect(res.status).toBe(403);
      expectEventDestination(returnLinkHref(await res.text()), "2");
      expect(await memberRow()).toBeUndefined();
    });

    it.each([
      "0",
      "-1",
      "1.5",
      "2x",
      " 2",
      "02",
      "999999999999999999999",
      "https://evil.example/steal",
      "//evil.example/steal",
      "/e/another-event",
      "2&attendees=3",
      "javascript:alert(1)",
    ])("falls back to the bare event page when every carrier is tampered to %j", async (evil) => {
      await seedPaging();
      const submission = await renderHonoSubmission(`/e/${EVENT_KEY}?attendees=2`, "going");
      tamperCarriers(submission, evil);
      const res = await postSubmission(submission);
      expect(res.status).toBe(303);
      const location = res.headers.get("location");
      expectEventDestination(location, null);
      expect(location).not.toContain("evil.example");
      expect(location).not.toContain("another-event");
      // Tampering with page context never blocks or fakes the write itself.
      expect(await memberRow()).toMatchObject({ status: "going" });
    });

    it("never lets a cross-origin Referer choose the destination", async () => {
      await seedPaging();
      const submission = await renderHonoSubmission(`/e/${EVENT_KEY}?attendees=2`, "going");
      tamperCarriers(submission, "not-a-page");
      submission.referer = `https://evil.example/e/${EVENT_KEY}?attendees=2`;
      const res = await postSubmission(submission);
      expect(res.status).toBe(303);
      expectEventDestination(res.headers.get("location"), null);
      expect(res.headers.get("location")).not.toContain("evil.example");
    });

    it("falls back bare on auth recovery when every carrier carries an external URL", async () => {
      await seedPaging();
      const submission = await renderHonoSubmission(`/e/${EVENT_KEY}?attendees=2`, "going");
      tamperCarriers(submission, "https://evil.example/steal");
      const res = await postSubmission(submission, { cookie: null });
      expect(res.status).toBe(303);
      const location = new URL(res.headers.get("location")!, BASE);
      expect(location.pathname).toBe("/join/discord");
      expect(location.searchParams.get("next")).not.toContain("evil.example");
      expectEventDestination(location.searchParams.get("next"), null);
    });

    it("falls back bare on the 503 refusal link when every carrier is tampered", async () => {
      await seedPaging();
      const submission = await renderHonoSubmission(`/e/${EVENT_KEY}?attendees=2`, "going");
      tamperCarriers(submission, "//evil.example/steal");
      const res = await postSubmission(submission, { bindings: noDbEnv() });
      expect(res.status).toBe(503);
      const href = returnLinkHref(await res.text());
      expect(href).not.toContain("evil.example");
      expectEventDestination(href, null);
    });

    it("keeps ?attendees=2 on a native join from the Kit page-two rendering", async () => {
      await seedPaging();
      const submission = await renderKitSubmission("?attendees=2", "going");
      const res = await postSubmission(submission);
      expect(res.status).toBe(303);
      expectEventDestination(res.headers.get("location"), "2");
      expect(await memberRow()).toMatchObject({ status: "going" });
    });

    it("keeps ?attendees=2 on a native withdraw from the Kit page-two rendering", async () => {
      const event = await seedPaging();
      await fixture.db
        .insert(rsvps)
        .values({ eventId: event.id, userId: MEMBER.userId, status: "going" });
      const submission = await renderKitSubmission("?attendees=2", "withdraw");
      const res = await postSubmission(submission);
      expect(res.status).toBe(303);
      expectEventDestination(res.headers.get("location"), "2");
      expect(await memberRow()).toBeUndefined();
    });

    it("keeps page one bare for a native join from the Kit bare rendering (control)", async () => {
      await seedPaging();
      const submission = await renderKitSubmission("", "going");
      const res = await postSubmission(submission);
      expect(res.status).toBe(303);
      expectEventDestination(res.headers.get("location"), null);
      expect(await memberRow()).toMatchObject({ status: "going" });
    });
  },
);

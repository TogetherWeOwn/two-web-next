import { createHmac } from "node:crypto";
import { expect, test, type APIRequestContext } from "@playwright/test";
import postgres from "postgres";
import { sectionOf } from "../../ci/kit-section-contract.mjs";
import { requireGithubRunner, requireTestDatabase } from "../ci-only.mjs";
import {
  expectedKitMarker,
  kitFixtureOwnsMemberBoard,
  kitFixtureSessionSecret,
  KIT_ORIGIN,
  normalizeOrigin,
  parityTargets,
  PARITY_VIEWPORTS,
  scrubSecrets,
  type ParityTarget,
} from "../kit-parity";

// Kit journey parity (docs/kit-parity-gates.md): the journeys run
// against BOTH the Hono worker and the built Kit Worker in one run, and
// every body comparison is origin-normalized first. Guest routes need no
// session; the member-board journey spends exactly one QA login (below)
// whose bearer token is replayed to both targets (re-signed for the Kit
// fixture's own secret) — the token and cookie values never appear in
// assertions or artifacts, and every body is scrubbed.
// Login journeys (member RSVP, moderator admin, profile edit) stay Hono-only
// until their routes migrate; they are ledgered as loud skips with reasons by
// ci/kit-parity-gates.mjs, never as quiet test.skip calls here.
const targets = parityTargets();
const contexts = new Map<string, APIRequestContext>();

test.beforeAll(async ({ playwright }) => {
  for (const target of targets) {
    contexts.set(
      target.name,
      await playwright.request.newContext({
        baseURL: target.origin,
        ignoreHTTPSErrors: target.ignoreHTTPSErrors,
      }),
    );
  }
});

test.afterAll(async () => {
  for (const context of contexts.values()) await context.dispose();
});

function api(target: ParityTarget): APIRequestContext {
  const context = contexts.get(target.name);
  if (!context) throw new Error(`kit-parity: no API context for ${target.name}`);
  return context;
}

// One QA login for the whole member-board journey, issued by the Hono worker:
// the session row lives in the shared seeded Postgres, so the same bearer
// token authenticates on both targets. The cookie signature does not replay
// across targets — the isolated Kit fixture verifies with its own synthetic
// secret (ci/kit-worker-dev.mjs, pinned by ci/kit-parity-ci-wiring.test.mjs),
// so the Kit copy is re-signed with that fixture value below. In production
// both renderers share one deployed secret and no re-signing exists.
// POST /auth/qa/:identity shares the qa-login throttle, so exactly one login
// is spent here however many board fetches follow.
let memberCookiePromise: Promise<string> | null = null;
function honoMemberCookie(): Promise<string> {
  memberCookiePromise ??= (async () => {
    const token = process.env.E2E_QA_TOKEN;
    if (!token) throw new Error("Missing ephemeral CI QA token");
    const hono = targets.find((target) => target.name === "hono")!;
    const response = await api(hono).post("/auth/qa/qa-member", {
      headers: { "X-TWO-QA-Auth": token, Origin: "https://localhost:8787" },
      maxRedirects: 0,
    });
    expect(response.status(), "QA login issues a session").toBe(204);
    const setCookie = (await response.headersArray()).find(
      (header) =>
        header.name.toLowerCase() === "set-cookie" &&
        header.value.startsWith("__Host-two_session="),
    );
    if (!setCookie) throw new Error("QA login set no session cookie");
    return setCookie.value.split(";")[0]!;
  })();
  return memberCookiePromise;
}

async function memberCookie(target: ParityTarget): Promise<string> {
  const pair = await honoMemberCookie();
  if (target.name !== "kit") return pair;
  const eq = pair.indexOf("=");
  const signed = pair.slice(eq + 1);
  const raw = signed.slice(0, signed.lastIndexOf("."));
  const signature = createHmac("sha256", kitFixtureSessionSecret()).update(raw).digest("base64");
  return `${pair.slice(0, eq + 1)}${raw}.${signature}`;
}

function expectNoMarker(headers: Record<string, string>, label: string) {
  expect(
    headers["x-two-renderer"] ?? null,
    `${label}: Hono-owned response carries no Kit marker`,
  ).toBeNull();
}

for (const target of targets) {
  test.describe(`${target.name}: past archive renders the seeded row`, () => {
    test("page one renders the list with the seeded row", async () => {
      const response = await api(target).get("/events/past");
      expect(response.status()).toBe(200);
      expect(response.headers()["content-type"]).toContain("text/html");
      // Renderer ownership is per target: Kit answers with the
      // manifest-derived marker once enabled, Hono never carries one
      // (ci/kit-preview-e2e.mjs previewParity asserts the same split).
      const expectedMarker = target.name === "kit" ? expectedKitMarker("/events/past") : null;
      expect(response.headers()["x-two-renderer"] ?? null).toBe(expectedMarker);
      const body = await response.text();
      expect(scrubSecrets(body)).toEqual([]);
      expect(body).toContain('data-testid="past-events"');
      expect(body).toContain("E2E Past Night");
      expect(body).toContain("Welcome, guest");
      expect(body).not.toContain("Sign out");
    });

    test("page two renders the out-of-range refusal", async () => {
      const response = await api(target).get("/events/past?page=2");
      expect(response.status()).toBe(200);
      const body = await response.text();
      expect(body).toContain('data-testid="past-events-out-of-range"');
      expect(body).toContain("Page 2 is outside the archive. There is 1 page.");
    });
  });

  // Join landing (GET /join only; /join/discord + /join/callback stay
  // Hono-owned, covered by e2e/join-blocked.spec.ts on the Hono worker).
  // Bodies come from raw API fetches with no browser JS executed, so these
  // assertions ARE the no-JS proof: the funnel content is in the first bytes.
  test.describe(`${target.name}: join landing keeps its funnel contract`, () => {
    test("landing keeps its actions, one widget zone and guest chrome", async () => {
      const response = await api(target).get("/join");
      expect(response.status()).toBe(200);
      expect(response.headers()["content-type"]).toContain("text/html");
      // Renderer ownership is per target: Kit answers with the
      // manifest-derived marker once enabled, Hono never carries one.
      const expectedMarker = target.name === "kit" ? expectedKitMarker("/join") : null;
      expect(response.headers()["x-two-renderer"] ?? null).toBe(expectedMarker);
      const body = await response.text();
      expect(scrubSecrets(body)).toEqual([]);
      expect(body).toContain('data-testid="join-oneclick"');
      expect(body).toContain('data-testid="join-invite"');
      expect(body).toContain("Welcome, guest");
      expect(body).not.toContain("Sign out");
      expect(body).not.toContain("<iframe");
      // Exactly one widget zone across the three isolate states (cold facade,
      // warm presence + facade link, down fallback); presence only rides the
      // facade link, which owns the click that builds the frame.
      const hasLoad = body.includes('data-testid="join-widget-load"');
      const hasFallback = body.includes('data-testid="join-widget-fallback"');
      expect(hasLoad !== hasFallback, `${target.name} join shows exactly one widget zone`).toBe(
        true,
      );
      if (body.includes('data-testid="join-widget-presence"')) expect(hasLoad).toBe(true);
      // Public without a flash: no cookies are sent on this journey.
      expect(["public, max-age=60", "public, max-age=3600"]).toContain(
        response.headers()["cache-control"],
      );
      expect(response.headers()["vary"] ?? "").toMatch(/cookie/i);
    });

    test("safe next survives onto one-click, hostile next leaves no trace", async () => {
      const safe = await api(target).get("/join?next=%2Fevents");
      expect(await safe.text()).toContain("/join/discord?next=%2Fevents");
      const hostile = await api(target).get("/join?next=https%3A%2F%2Fevil.test");
      const hostileBody = await hostile.text();
      expect(hostileBody).toContain('href="/join/discord"');
      expect(hostileBody).not.toContain("evil.test");
    });
  });

  // Auth recovery (GET /auth/recover only; the one-use journey writes stay
  // Hono-owned, and /join/callback stays Hono-owned with single OAuth
  // authority). Bodies come from raw API fetches with no browser JS executed,
  // so these assertions ARE the no-JS proof: the shell, retry and invite
  // fallback are in the first bytes.
  test.describe(`${target.name}: auth recovery keeps its outcome contract`, () => {
    test("expired session renders the shared shell with retry, invite and guest chrome", async () => {
      const response = await api(target).get("/auth/recover?next=%2Fprofile%3Fedit%3D1");
      expect(response.status()).toBe(200);
      expect(response.headers()["content-type"]).toContain("text/html");
      // Renderer ownership is per target: Kit answers with the
      // manifest-derived marker once enabled, Hono never carries one.
      const expectedMarker = target.name === "kit" ? expectedKitMarker("/auth/recover") : null;
      expect(response.headers()["x-two-renderer"] ?? null).toBe(expectedMarker);
      const body = await response.text();
      expect(scrubSecrets(body)).toEqual([]);
      expect(body).toContain('id="recovery-heading"');
      expect(body).toContain('data-testid="recovery-retry"');
      expect(body).toContain('data-testid="recovery-invite"');
      expect(body).toContain('href="/auth/discord?next=%2Fprofile%3Fedit%3D1"');
      expect(body).toContain('href="/discord"');
      expect(body).toContain("Welcome, guest");
      expect(body).not.toContain("Sign out");
      expect(body).not.toContain("<script");
      expect(body).not.toContain("<iframe");
      // Per-visitor journey state: never shared-cacheable.
      expect(response.headers()["cache-control"]).toBe("no-store, private");
      // The Hono controller still owns the one-use journey writes, served
      // undecorated through honoFetch on both targets until enablement.
      const setCookies = (await response.headersArray())
        .filter((h) => h.name.toLowerCase() === "set-cookie")
        .map((h) => h.value)
        .join("\n");
      expect(setCookies).toContain("__Host-two_login_intended=");
      expect(setCookies).toContain("__Host-two_expired_write=");
    });

    test("safe next survives onto the login retry, hostile next leaves no trace", async () => {
      const hostile = await api(target).get("/auth/recover?next=https%3A%2F%2Fevil.test");
      const hostileBody = await hostile.text();
      expect(hostileBody).toContain('href="/auth/discord?next=%2Fprofile"');
      expect(hostileBody).not.toContain("evil.test");
    });
  });

  // Member leaderboard (GET /leaderboards/members only): the authenticated
  // parity journey. Admission and grammar are asserted per target, the served
  // board carries the member contract (private, no-store, noindex, member
  // chrome, no profile links), and bodies are secret-scrubbed. A signed-in
  // non-member 403 cannot be minted by the QA seam (both QA identities are
  // members), so that arm stays pinned hermetically
  // (test/member-leaderboard-seasonal-relative-acceptance.test.ts and
  // test/kit-members.test.ts).
  test.describe(`${target.name}: member leaderboard keeps its member contract`, () => {
    test("guest is bounced to Discord sign-in, never the board", async () => {
      const response = await api(target).get("/leaderboards/members", { maxRedirects: 0 });
      expect(response.status()).toBe(302);
      expect(response.headers()["location"] ?? "").toContain("/auth/discord");
      const body = await response.text();
      expect(scrubSecrets(body)).toEqual([]);
      expect(body).not.toContain("Member leaderboard");
    });

    test("member board serves overall, relative, season and activity views privately", async () => {
      const cookie = await memberCookie(target);
      // The Kit target must answer from the Kit load, not the Hono fallback:
      // the parity fixture owns the board (kitFixtureOwnsMemberBoard), so
      // its marker is "kit". The shipped manifest now owns the board on Kit
      // for deployed workers too, so the fixture flag is redundant for this
      // entry (rollback is enabled: false). If the fixture ever stops
      // owning it, this expectation fails instead of proving Hono-vs-Hono.
      if (target.name === "kit")
        expect(kitFixtureOwnsMemberBoard(), "Kit fixture owns the member board").toBe(true);
      const expectedMarker = target.name === "kit" ? "kit" : null;
      for (const path of [
        "/leaderboards/members",
        "/leaderboards/members?scope=relative",
        "/leaderboards/members?season=2026",
        "/leaderboards/members?activity=valheim",
      ]) {
        const response = await api(target).get(path, { headers: { cookie } });
        expect(response.status(), `${target.name} ${path}`).toBe(200);
        expect(response.headers()["content-type"]).toContain("text/html");
        expect(response.headers()["x-two-renderer"] ?? null).toBe(expectedMarker);
        // Per-viewer rows: never shared-cacheable, on either renderer.
        expect(response.headers()["cache-control"]).toBe("private, no-store");
        const body = await response.text();
        expect(scrubSecrets(body)).toEqual([]);
        expect(body).toContain("<h1>Member leaderboard</h1>");
        expect(body).toContain('<meta name="robots" content="noindex, nofollow"');
        expect(body).toContain('aria-label="Board scope"');
        expect(body).toContain("Sign out");
        expect(body).not.toContain("Welcome, guest");
        expect(body).not.toContain('href="/members/');
      }
    });

    test("member board data request carries no Discord IDs", async () => {
      // SvelteKit serves __data.json from the load's return value even with
      // csr = false, so the Kit payload must carry rank + name + count +
      // isViewer only: no ranked member's Discord ID, no viewerId. Hono
      // never served this path, so its body must carry no IDs either.
      const cookie = await memberCookie(target);
      const response = await api(target).get("/leaderboards/members/__data.json", {
        headers: { cookie },
      });
      if (target.name === "kit") expect(response.status()).toBe(200);
      const body = await response.text();
      expect(scrubSecrets(body)).toEqual([]);
      expect(body).not.toContain("userId");
      expect(body).not.toContain("viewerId");
    });

    test("bad season, scope and activity answer 400 before any board", async () => {
      const cookie = await memberCookie(target);
      for (const path of [
        "/leaderboards/members?season=bogus",
        "/leaderboards/members?scope=friends",
        "/leaderboards/members?scope=bogus",
        "/leaderboards/members?activity=chess!",
      ]) {
        const response = await api(target).get(path, { headers: { cookie } });
        expect(response.status(), `${target.name} ${path}`).toBe(400);
        const body = await response.text();
        expect(scrubSecrets(body)).toEqual([]);
        expect(body).not.toContain("<h1>Member leaderboard</h1>");
      }
    });
  });

  test.describe(`${target.name}: public feeds and SEO answer unauthenticated GETs`, () => {
    test("sitemap pins the seeded event GUID", async () => {
      const response = await api(target).get("/sitemap_index.xml");
      expect(response.status()).toBe(200);
      expect(response.headers()["content-type"]).toContain("application/xml");
      expectNoMarker(response.headers(), `${target.name} sitemap`);
      const body = await response.text();
      expect(scrubSecrets(body)).toEqual([]);
      expect(body).toContain("<urlset");
      expect(body).toContain("/e/01J00000000000000000000001</loc>");
    });

    test("RSS and ICS carry the contract envelopes with no cookies", async () => {
      const rss = await api(target).get("/events.rss");
      expect(rss.status()).toBe(200);
      expect(rss.headers()["content-type"]).toBe("application/rss+xml; charset=utf-8");
      expect(rss.headers()["cache-control"]).toBe("max-age=300, public");
      expect(rss.headers()["set-cookie"] ?? null).toBeNull();
      expectNoMarker(rss.headers(), `${target.name} rss`);
      expect(await rss.text()).toContain('<guid isPermaLink="true">');

      const ics = await api(target).get("/events.ics");
      expect(ics.status()).toBe(200);
      expect(ics.headers()["content-type"]).toBe("text/calendar; charset=utf-8");
      expect(ics.headers()["set-cookie"] ?? null).toBeNull();
      const icsBody = await ics.text();
      expect(icsBody).toContain("BEGIN:VCALENDAR");
      expect(icsBody).toContain("UID:01J00000000000000000000001@");
    });
  });

  test.describe(`${target.name}: reserved and API surface stays Hono-owned`, () => {
    test("/up answers without the Kit marker", async () => {
      const response = await api(target).get("/up");
      expect(response.status()).toBe(200);
      expectNoMarker(response.headers(), `${target.name} /up`);
    });

    test("disabled ingress fails closed without the Kit marker", async () => {
      const response = await api(target).post("/api/agent-events", { data: {} });
      expect([401, 403, 404]).toContain(response.status());
      expectNoMarker(response.headers(), `${target.name} /api/*`);
    });

    test("cross-origin form POST is refused by the hardened gate", async () => {
      const response = await api(target).post("/events/past", {
        headers: {
          origin: "https://evil.example",
          "content-type": "application/x-www-form-urlencoded",
        },
        data: "title=x",
      });
      expect(response.status()).toBe(403);
      expect(response.headers()["content-type"]).toContain("application/json");
      expect(await response.json()).toEqual({ error: "cross_origin" });
      expect(response.headers()["content-security-policy"] ?? "").toContain("default-src 'self'");
    });
  });

  for (const viewport of PARITY_VIEWPORTS) {
    test(`${target.name}: archive ${viewport.name} has no horizontal overflow`, async ({
      browser,
    }) => {
      const context = await browser.newContext({
        baseURL: target.origin,
        ignoreHTTPSErrors: target.ignoreHTTPSErrors,
        viewport: viewport.size,
      });
      const pageErrors: string[] = [];
      try {
        // Only the two parity loopbacks may be reached; anything else fails
        // the journey instead of leaking a packet.
        await context.route("**/*", (route) => {
          const url = new URL(route.request().url());
          const allowed = url.origin === "https://localhost:8787" || url.origin === KIT_ORIGIN;
          return allowed ? route.continue() : route.abort("blockedbyclient");
        });
        const page = await context.newPage();
        page.on("pageerror", (error) => pageErrors.push(error.message));
        const response = await page.goto("/events/past");
        expect(response?.status()).toBe(200);
        await expect(page.getByTestId("past-events")).toBeVisible();
        // String form: the e2e tsconfig has no DOM lib (same as the
        // copy-link and skip-link specs), so no document/window names here.
        const overflow = (await page.evaluate(
          "({ width: document.documentElement.scrollWidth, viewport: window.innerWidth })",
        )) as unknown as { width: number; viewport: number };
        expect(
          overflow.width,
          `${target.name} ${viewport.name}: no horizontal overflow`,
        ).toBeLessThanOrEqual(overflow.viewport);
        expect(pageErrors, "no uncaught page errors").toEqual([]);
      } finally {
        await context.close();
      }
    });
  }

  // Two-width visuals for the join two-column layout (desktop side-by-side,
  // mobile stacked): no horizontal overflow and no page errors at either
  // width, on both renderers.
  for (const viewport of PARITY_VIEWPORTS) {
    test(`${target.name}: join ${viewport.name} has no horizontal overflow`, async ({
      browser,
    }) => {
      const context = await browser.newContext({
        baseURL: target.origin,
        ignoreHTTPSErrors: target.ignoreHTTPSErrors,
        viewport: viewport.size,
      });
      const pageErrors: string[] = [];
      try {
        // Only the two parity loopbacks may be reached; anything else fails
        // the journey instead of leaking a packet.
        await context.route("**/*", (route) => {
          const url = new URL(route.request().url());
          const allowed = url.origin === "https://localhost:8787" || url.origin === KIT_ORIGIN;
          return allowed ? route.continue() : route.abort("blockedbyclient");
        });
        const page = await context.newPage();
        page.on("pageerror", (error) => pageErrors.push(error.message));
        const response = await page.goto("/join");
        expect(response?.status()).toBe(200);
        await expect(page.getByTestId("join-oneclick")).toBeVisible();
        // String form: the e2e tsconfig has no DOM lib (same as the
        // copy-link and skip-link specs), so no document/window names here.
        const overflow = (await page.evaluate(
          "({ width: document.documentElement.scrollWidth, viewport: window.innerWidth })",
        )) as unknown as { width: number; viewport: number };
        expect(
          overflow.width,
          `${target.name} ${viewport.name}: no horizontal overflow`,
        ).toBeLessThanOrEqual(overflow.viewport);
        expect(pageErrors, "no uncaught page errors").toEqual([]);
      } finally {
        await context.close();
      }
    });
  }
}

test("cross-target: normalized archive sections match", async () => {
  const bodies = new Map<string, string>();
  for (const target of targets) {
    const response = await api(target).get("/events/past");
    expect(response.status()).toBe(200);
    bodies.set(target.name, normalizeOrigin(await response.text(), target.origin));
  }
  // Framework-tolerant comparison (ci/kit-section-contract.mjs, same
  // treatment as ci/kit-preview-e2e.mjs): raw section bytes always differ
  // (hydration markers, boolean attributes, `>` escaping), so compare the
  // normalized contract after origin normalization, not the bytes.
  expect(
    sectionOf(bodies.get("kit")!, "past-events"),
    "Kit section matches Hono section after origin normalization",
  ).toBe(sectionOf(bodies.get("hono")!, "past-events"));
});

test("cross-target: join one-click hrefs agree on the safe next", async () => {
  // No byte equality: the invite URL and widget zone differ per worker env
  // (e2e Hono guild vs Kit fixture guild). The next-forwarding guard is
  // env-independent, so the one-click href must agree exactly.
  const hrefs = new Map<string, string | null>();
  for (const target of targets) {
    const response = await api(target).get("/join?next=%2Fevents");
    expect(response.status()).toBe(200);
    const body = await response.text();
    const match =
      body.match(/data-testid="join-oneclick"[^>]*href="([^"]+)"/) ??
      body.match(/href="([^"]+)"[^>]*data-testid="join-oneclick"/);
    hrefs.set(target.name, match?.[1] ?? null);
  }
  expect(hrefs.get("kit"), "Kit one-click href readable").toBe("/join/discord?next=%2Fevents");
  expect(hrefs.get("kit"), "Kit one-click agrees with Hono on the safe next").toBe(
    hrefs.get("hono"),
  );
});

// Successful archive page turns with browser history restoration.
//
// Isolated deterministic fixture: 24 dated rows plus the seeded past night
// make 25 archived rows at page size 20, so totalPages is 2. Page one holds
// the 20 newest turns (24 down to 05); page two holds turns 04 down to 01
// plus the seeded past night as the oldest row. The shared one-row seed is
// untouched and the existing refusal assertions keep running; this journey
// only adds rows while it runs and deletes them afterwards.
//
// Every read carries a bypass cookie so the shared one-row anonymous entry
// stays untouched and this journey never settles fixture HTML into it. The
// cookie is not a session: the journey asserts guest chrome throughout and
// performs no logins and no RSVP writes. External traffic is aborted like
// the overflow journeys. Only shipped attributes are used (no new testids).
//
// A broken Older/Newer href lands on the wrong URL or the out-of-range
// refusal, so row identities and the page URL fail. A stale fragment swap
// keeps the old rows, so identities and the canonical fail.
//
// The island validates the fetched page's canonical against the browser
// origin. On the Hono target that origin is localhost while APP_URL is the
// virtual staging URL, so the e2e test worker translates the archive HTML
// back to localhost (e2e/worker.ts) — the deployed invariant, where
// APP_URL is the serving origin. The Kit fixture already serves its own
// origin as APP_URL, so its turns need no translation.
const ARCHIVE_TURN_COUNT = 24;
const ARCHIVE_TURN_KEY_PREFIX = "01K000000000000000000000";
const ARCHIVE_PAST_NIGHT_KEY = "01J00000000000000000000002";
const ARCHIVE_BYPASS_COOKIE = "e2e-archive-bypass=1";

function archiveTurnKey(i: number): string {
  return `${ARCHIVE_TURN_KEY_PREFIX}${String(i).padStart(2, "0")}`;
}

function archiveTurnTitle(i: number): string {
  return `E2E Archive Turn ${String(i).padStart(2, "0")}`;
}

function archiveTurnStartsAt(i: number): string {
  return `2024-06-${String(i).padStart(2, "0")}T18:00:00Z`;
}

function archiveTurnEndsAt(i: number): string {
  return `2024-06-${String(i).padStart(2, "0")}T20:00:00Z`;
}

async function seedArchiveTurns(): Promise<void> {
  requireGithubRunner();
  const url = requireTestDatabase(process.env.DATABASE_URL) as string;
  const sql = postgres(url, { max: 1 });
  try {
    await sql`delete from events where event_key like '01K000000000000000000000%'`;
    for (let i = 1; i <= ARCHIVE_TURN_COUNT; i++) {
      await sql`insert into events (event_key, title, description, starts_at, ends_at, timezone, status, capacity, rsvp_open)
        values (${archiveTurnKey(i)}, ${archiveTurnTitle(i)}, 'Disposable archive page-turn fixture',
          ${archiveTurnStartsAt(i)}, ${archiveTurnEndsAt(i)}, 'UTC', 'published', 10, true)`;
    }
  } finally {
    await sql.end();
  }
}

async function sweepArchiveTurns(): Promise<void> {
  requireGithubRunner();
  const url = requireTestDatabase(process.env.DATABASE_URL) as string;
  const sql = postgres(url, { max: 1 });
  try {
    await sql`delete from events where event_key like '01K000000000000000000000%'`;
  } finally {
    await sql.end();
  }
}

test.describe("archive page turns prove successful paging and history", () => {
  test.beforeAll(async () => {
    await seedArchiveTurns();
  });

  test.afterAll(async () => {
    await sweepArchiveTurns();
  });

  for (const target of targets) {
    test(`${target.name}: Older, Newer and Back restore the archive pages`, async ({ browser }) => {
      const expectedMarker = target.name === "kit" ? expectedKitMarker("/events/past") : null;

      // Renderer proof on both pages through the enabled entry, bypassing
      // the shared one-row anonymous entry so the fixture rows are read.
      const pageOneApi = await api(target).get("/events/past", {
        headers: { cookie: ARCHIVE_BYPASS_COOKIE },
      });
      expect(pageOneApi.status()).toBe(200);
      expect(pageOneApi.headers()["x-two-renderer"] ?? null).toBe(expectedMarker);
      const pageOneBody = await pageOneApi.text();
      expect(scrubSecrets(pageOneBody)).toEqual([]);
      expect(pageOneBody).toContain("E2E Archive Turn 24");
      expect(pageOneBody).toContain("E2E Archive Turn 05");
      expect(pageOneBody).not.toContain("E2E Archive Turn 04");
      expect(pageOneBody).not.toContain("E2E Past Night");

      const pageTwoApi = await api(target).get("/events/past?page=2", {
        headers: { cookie: ARCHIVE_BYPASS_COOKIE },
      });
      expect(pageTwoApi.status()).toBe(200);
      expect(pageTwoApi.headers()["x-two-renderer"] ?? null).toBe(expectedMarker);
      const pageTwoBody = await pageTwoApi.text();
      expect(scrubSecrets(pageTwoBody)).toEqual([]);
      expect(pageTwoBody).toContain("E2E Archive Turn 04");
      expect(pageTwoBody).toContain("E2E Archive Turn 01");
      expect(pageTwoBody).toContain("E2E Past Night");
      expect(pageTwoBody).not.toContain("E2E Archive Turn 24");
      expect(pageTwoBody).not.toContain("E2E Archive Turn 05");

      const context = await browser.newContext({
        baseURL: target.origin,
        ignoreHTTPSErrors: target.ignoreHTTPSErrors,
        viewport: { width: 1280, height: 800 },
        extraHTTPHeaders: { cookie: ARCHIVE_BYPASS_COOKIE },
      });
      const pageErrors: string[] = [];
      try {
        // Only the two parity loopbacks may be reached; anything else fails
        // the journey instead of leaking a packet.
        await context.route("**/*", (route) => {
          const url = new URL(route.request().url());
          const allowed = url.origin === "https://localhost:8787" || url.origin === KIT_ORIGIN;
          return allowed ? route.continue() : route.abort("blockedbyclient");
        });
        const page = await context.newPage();
        page.on("pageerror", (error) => pageErrors.push(error.message));

        async function archiveKeys(): Promise<string[]> {
          const items = page.locator('[data-testid="past-events-list"] [data-event-key]');
          const handles = await items.all();
          const keys: string[] = [];
          for (const handle of handles) {
            const key = await handle.getAttribute("data-event-key");
            if (key) keys.push(key);
          }
          return keys;
        }

        // The island turns pages with pushState (no document navigation); a
        // missing, 404ing or CSP-blocked island falls back to full loads
        // with the same end state. String form: the e2e tsconfig has no DOM
        // lib, so no window names here. A full navigation replaces the
        // document and drops this marker; island turns keep it.
        async function expectSameDoc(): Promise<void> {
          expect(
            await page.evaluate("window.__archiveSameDoc ?? null"),
            "island kept the document (no full navigation)",
          ).toBe(1);
        }

        const response = await page.goto("/events/past");
        expect(response?.status()).toBe(200);
        expect(response?.headers()["x-two-renderer"] ?? null).toBe(expectedMarker);
        await expect(page).toHaveURL(/\/events\/past$/);
        await expect(page.getByTestId("past-events")).toBeVisible();
        await expect(page.getByTestId("past-events")).toHaveAttribute("data-page", "1");
        await expect(page.getByTestId("past-events")).toHaveAttribute("data-total-pages", "2");
        await expect(page.getByTestId("past-events-list")).toBeVisible();
        await expect(page.getByTestId("past-events-list")).toContainText("E2E Archive Turn 24");
        await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
          "href",
          /\/events\/past$/,
        );
        await expect(page.locator('meta[name="robots"]')).toHaveAttribute(
          "content",
          "noindex, follow",
        );
        await expect(page.getByText("Welcome, guest")).toBeVisible();
        await expect(page.getByText("Sign out")).toHaveCount(0);
        await expect(page.locator('a[data-archive-page]:has-text("Older")')).toBeVisible();
        await expect(page.locator('a[data-archive-page]:has-text("Newer")')).toHaveCount(0);
        let keys = await archiveKeys();
        expect(keys).toHaveLength(20);
        expect(keys).toContain(archiveTurnKey(24));
        expect(keys).toContain(archiveTurnKey(5));
        expect(keys).not.toContain(archiveTurnKey(4));
        expect(keys).not.toContain(ARCHIVE_PAST_NIGHT_KEY);
        await page.evaluate("window.__archiveSameDoc = 1");

        await page.locator('a[data-archive-page]:has-text("Older")').click();
        await expect(page).toHaveURL(/\/events\/past\?page=2/);
        await expectSameDoc();
        await expect(page.getByTestId("past-events")).toHaveAttribute("data-page", "2");
        await expect(page.getByTestId("past-events-list")).toContainText("E2E Past Night");
        await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
          "href",
          /\/events\/past\?page=2/,
        );
        await expect(page.locator('meta[name="robots"]')).toHaveAttribute(
          "content",
          "noindex, follow",
        );
        await expect(page.locator('a[data-archive-page]:has-text("Newer")')).toBeVisible();
        await expect(page.locator('a[data-archive-page]:has-text("Older")')).toHaveCount(0);
        keys = await archiveKeys();
        expect(keys).toHaveLength(5);
        expect(keys).toContain(archiveTurnKey(4));
        expect(keys).toContain(archiveTurnKey(1));
        expect(keys).toContain(ARCHIVE_PAST_NIGHT_KEY);
        expect(keys).not.toContain(archiveTurnKey(24));
        expect(keys).not.toContain(archiveTurnKey(5));

        await page.locator('a[data-archive-page]:has-text("Newer")').click();
        await expect(page).toHaveURL(/\/events\/past$/);
        await expectSameDoc();
        await expect(page.getByTestId("past-events")).toHaveAttribute("data-page", "1");
        await expect(page.getByTestId("past-events-list")).toContainText("E2E Archive Turn 24");
        await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
          "href",
          /\/events\/past$/,
        );
        keys = await archiveKeys();
        expect(keys).toHaveLength(20);
        expect(keys).toContain(archiveTurnKey(24));
        expect(keys).not.toContain(ARCHIVE_PAST_NIGHT_KEY);

        await page.locator('a[data-archive-page]:has-text("Older")').click();
        await expect(page).toHaveURL(/\/events\/past\?page=2/);
        await expectSameDoc();
        await expect(page.getByTestId("past-events-list")).toContainText("E2E Past Night");
        await page.goBack();
        await expect(page).toHaveURL(/\/events\/past$/);
        await expectSameDoc();
        await expect(page.getByTestId("past-events")).toHaveAttribute("data-page", "1");
        await expect(page.getByTestId("past-events-list")).toContainText("E2E Archive Turn 24");
        await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
          "href",
          /\/events\/past$/,
        );
        await expect(page.locator('meta[name="robots"]')).toHaveAttribute(
          "content",
          "noindex, follow",
        );
        keys = await archiveKeys();
        expect(keys).toHaveLength(20);
        expect(keys).toContain(archiveTurnKey(24));
        expect(keys).toContain(archiveTurnKey(5));
        expect(keys).not.toContain(ARCHIVE_PAST_NIGHT_KEY);
        await expect(page.getByText("Welcome, guest")).toBeVisible();
        await expect(page.getByText("Sign out")).toHaveCount(0);

        expect(pageErrors, "no uncaught page errors").toEqual([]);
      } finally {
        await context.close();
      }
    });
  }
});

test("Kit worker answers traffic within the liveness bound", async ({ playwright }) => {
  // Liveness only: true startup (spawn-to-first-200) is enforced by this
  // project's Kit webServer readiness timeout, which derives from
  // startup.maxMs in ci/kit-perf-budget.json — a worker that never becomes
  // ready fails the run before any journey executes. This probe records warm
  // latency in the report without gating on it.
  const started = Date.now();
  const context = await playwright.request.newContext({ baseURL: KIT_ORIGIN });
  try {
    const response = await context.get("/favicon.ico");
    expect(response.status()).toBe(200);
  } finally {
    await context.dispose();
  }
  const elapsed = Date.now() - started;
  test.info().annotations.push({ type: "kit-first-200-ms", description: String(elapsed) });
  expect(elapsed, `Kit warm first-200 ${elapsed}ms fits the 10s liveness bound`).toBeLessThan(
    10_000,
  );
});

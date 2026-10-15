import { expect, test, type APIRequestContext } from "@playwright/test";
import { sectionOf } from "../../ci/kit-section-contract.mjs";
import {
  expectedKitMarker,
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
// whose cookie is replayed to both targets — the token and cookie values
// never appear in assertions or artifacts, and every body is scrubbed.
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

// One QA login for the whole member-board journey, issued by the Hono worker
// and replayed to both targets: the session row lives in the shared seeded
// Postgres and both workers verify the signed cookie with the same secret
// (e2e/prepare.mjs publishes E2E_SESSION_SECRET for ci/kit-worker-dev.mjs).
// POST /auth/qa/:identity shares the qa-login throttle, so exactly one login
// is spent here however many board fetches follow.
let memberCookiePromise: Promise<string> | null = null;
function memberCookie(): Promise<string> {
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
      const cookie = await memberCookie();
      const expectedMarker =
        target.name === "kit" ? expectedKitMarker("/leaderboards/members") : null;
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

    test("bad season, scope and activity answer 400 before any board", async () => {
      const cookie = await memberCookie();
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

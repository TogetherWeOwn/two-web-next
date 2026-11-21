import { createHash, createHmac, randomBytes } from "node:crypto";
import {
  expect,
  test,
  type APIRequestContext,
  type APIResponse,
  type Page,
} from "@playwright/test";
import postgres from "postgres";
import { assertEmberArchive, stripEmberDelta } from "../../ci/kit-archive-delta.mjs";
import { normalizeSection, sectionOf } from "../../ci/kit-section-contract.mjs";
import { QA_IDENTITIES } from "../../src/qa";
import { requireGithubRunner, requireTestDatabase } from "../ci-only.mjs";
import {
  expectedKitMarker,
  HONO_ORIGIN,
  kitFixtureOwnsEventDetail,
  kitFixtureOwnsMemberBoard,
  kitFixtureSessionSecret,
  KIT_ORIGIN,
  memberBoardDataRows,
  memberBoardTable,
  normalizeOrigin,
  parityTargets,
  PARITY_VIEWPORTS,
  scrubSecrets,
  type ParityTarget,
} from "../kit-parity";
import { qaLoginRetryBudgetMs } from "../qa-login-retry.mjs";
import { expectSavedReviewActions } from "../saved-review-actions";
import { postParityQaLogin } from "./parity-qa-login.mjs";

// Kit journey parity (docs/kit-parity-gates.md): the journeys run
// against BOTH the Hono worker and the built Kit Worker in one run, and
// every body comparison is origin-normalized first. Guest routes need no
// session; the member-board journey spends exactly one QA login (counted
// below and asserted in afterAll) whose bearer token is replayed to both
// targets (re-signed for the Kit fixture's own secret) — the token and
// cookie values never appear in assertions or artifacts, and every body
// is scrubbed. The journey also makes its viewer the board's one ranked
// member with a single going RSVP on the seeded event, deleted in
// afterAll: no earlier journey leaves a going RSVP behind, so without it
// both boards render their empty state and ranked content is unprovable.
// Login journeys (member RSVP, moderator admin, profile edit) stay Hono-only
// until their routes migrate; they are ledgered as loud skips with reasons by
// ci/kit-parity-gates.mjs, never as quiet test.skip calls here.
const targets = parityTargets();
const contexts = new Map<string, APIRequestContext>();

test.beforeAll(async ({ playwright }) => {
  // Hook timeout: the config's 30s covers the setup itself; the shared QA
  // login's bounded 429 waits get their own budget (qa-login-retry.mjs), one
  // login — a capped 65s wait dies on the bare hook timeout without this raise.
  test.setTimeout(30_000 + qaLoginRetryBudgetMs(1));
  for (const target of targets) {
    contexts.set(
      target.name,
      await playwright.request.newContext({
        baseURL: target.origin,
        ignoreHTTPSErrors: target.ignoreHTTPSErrors,
      }),
    );
  }
  const hono = targets.find((target) => target.name === "hono")!;
  await memberCookie(hono);
  // Seed the ranked count before the first cache-settling read on either
  // isolate (src/events/anon-cache.ts).
  await memberGoingRsvp();
  // The QA login above populates the Hono jar. Recreate that context so
  // subsequent guest requests stay anonymous; member requests replay the
  // memoized cookie explicitly without another login.
  await contexts.get(hono.name)!.dispose();
  contexts.set(
    hono.name,
    await playwright.request.newContext({
      baseURL: hono.origin,
      ignoreHTTPSErrors: hono.ignoreHTTPSErrors,
    }),
  );
});

test.afterAll(async () => {
  try {
    const id = memberRsvpId;
    if (id !== null) {
      await withSessionDb(async (sql) => {
        const deleted = await sql`delete from rsvps where id = ${id} returning id`;
        expect(deleted, "worker's ranked RSVP deleted").toHaveLength(1);
      });
    }
  } finally {
    for (const context of contexts.values()) await context.dispose();
  }
  // The shared member journey spends one QA login. Session-renewal coverage
  // uses one DB-minted isolated session (no login) so a Kit rotation cannot
  // stale the shared bearer.
  if (memberCookiePromise !== null) {
    expect(qaLoginCount, "exactly one shared QA login").toBe(1);
  }
  if (renewalMintCount > 0) {
    expect(renewalMintCount, "exactly one isolated renewal session").toBe(1);
  }
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
// is spent here however many board fetches follow. The spend is counted at
// the one call site and asserted in afterAll, so losing the `??=` fails the
// run instead of quietly burning a login per fetch.
let qaLoginCount = 0;
let memberCookiePromise: Promise<string> | null = null;
function honoMemberCookie(): Promise<string> {
  memberCookiePromise ??= (async () => {
    qaLoginCount += 1;
    const token = process.env.E2E_QA_TOKEN;
    if (!token) throw new Error("Missing ephemeral CI QA token");
    const hono = targets.find((target) => target.name === "hono")!;
    // The e2e suite's 10 logins share this window: a 429 honors Retry-After
    // into a fresh window instead of failing the file (parity-qa-login.mjs).
    const response = await postParityQaLogin(
      () =>
        api(hono).post("/auth/qa/qa-member", {
          headers: { "X-TWO-QA-Auth": token, Origin: "https://localhost:8787" },
          maxRedirects: 0,
        }),
      { identity: "qa-member" },
    );
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

function signCookieForTarget(source: string, target: ParityTarget): string {
  if (target.name !== "kit") return source;
  const eq = source.indexOf("=");
  const signed = source.slice(eq + 1);
  const raw = signed.slice(0, signed.lastIndexOf("."));
  const signature = createHmac("sha256", kitFixtureSessionSecret()).update(raw).digest("base64");
  return `${source.slice(0, eq + 1)}${raw}.${signature}`;
}

async function memberCookie(target: ParityTarget): Promise<string> {
  const pair = await honoMemberCookie();
  // Freshest wins: rotating page reads (GET /events, GET /e/:key) retire the
  // presented bearer to bounded grace and deliver the replacement via Set-Cookie into
  // Hono's jar. Kit has a separate cookie signature, but shares that same
  // session row, so it must re-sign the jar's current pair when a rotation
  // has already run.
  const hono = targets.find((candidate) => candidate.name === "hono")!;
  const state = await api(hono).storageState();
  const current = state.cookies.find((cookie) => cookie.name === "__Host-two_session");
  const source = current ? `${current.name}=${current.value}` : pair;
  return signCookieForTarget(source, target);
}

// qa-moderator fixture identity (src/qa.ts QA_IDENTITIES): the isolated
// renewal session belongs to a different user than the shared qa-member
// bearer, so neither issuance nor rotation can disturb the shared jar.
const QA_MODERATOR_DISCORD_ID = "900000000000001397";
const QA_MODERATOR_USERNAME = "QA Moderator";

let renewalMintCount = 0;
async function isolatedRenewalCookie(target: ParityTarget): Promise<string> {
  // DB-minted renewal session (QA-LOGIN BUDGET FIX): the renewal test needs
  // an isolated session — never the shared member bearer, which a Kit
  // rotation would stale — but the login itself is not under test, so the
  // row is minted directly in the shared CI Postgres instead of POSTing
  // /auth/qa and spending the throttled qa-login budget. The row mirrors
  // what the Hono worker's issueSession writes (src/index.tsx): a fresh
  // `two_`-prefixed bearer (src/sessions.ts newSessionToken shape), a full
  // 120-minute sliding expiry, and the fresh-login same-user sweep
  // (src/sessions.ts revokeUserSessions), so a dirty-run teardown session is
  // revoked exactly as a fresh issuance would. No roster write: the login's
  // roster upsert feeds profile reads, while the detail page touches users
  // rows only for RSVP holders — and the minted identity holds no RSVP.
  // The cookie is signed with the Kit fixture secret
  // and presented to the Kit target only — the Hono secret is never needed.
  renewalMintCount += 1;
  const bearer = `two_${randomBytes(32).toString("base64url")}`;
  const tokenHash = createHash("sha256").update(bearer).digest("hex");
  const expiresAt = new Date(Date.now() + 120 * 60 * 1000);
  await withSessionDb(async (sql) => {
    await sql`
      insert into web_sessions (token_hash, status_hash, user_id, username, avatar, member, moderator, expires_at)
      values (${tokenHash}, ${tokenHash}, ${QA_MODERATOR_DISCORD_ID}, ${QA_MODERATOR_USERNAME}, null, true, true, ${expiresAt})`;
    await sql`
      update web_sessions set revoked_at = now()
      where user_id = ${QA_MODERATOR_DISCORD_ID} and token_hash != ${tokenHash}
        and revoked_at is null and expires_at > clock_timestamp()`;
    await sql`
      delete from web_session_grace
      where user_id = ${QA_MODERATOR_DISCORD_ID}
        and predecessor_hash != ${tokenHash} and successor_hash != ${tokenHash}`;
  });
  const signature = createHmac("sha256", kitFixtureSessionSecret()).update(bearer).digest("base64");
  return signCookieForTarget(`__Host-two_session=${bearer}.${signature}`, target);
}

function bearerFromCookie(cookie: string): string {
  const value = cookie.slice(cookie.indexOf("=") + 1);
  return value.slice(0, value.lastIndexOf("."));
}

async function withSessionDb<T>(run: (sql: ReturnType<typeof postgres>) => Promise<T>): Promise<T> {
  requireGithubRunner();
  const url = requireTestDatabase(process.env.DATABASE_URL) as string;
  const sql = postgres(url, { max: 1 });
  try {
    return await run(sql);
  } finally {
    await sql.end();
  }
}

async function ageSessionNearExpiry(
  cookie: string,
): Promise<{ tokenHash: string; expiresAt: Date }> {
  const tokenHash = createHash("sha256").update(bearerFromCookie(cookie)).digest("hex");
  const expiresAt = new Date(Date.now() + 30_000);
  await withSessionDb(async (sql) => {
    const updated = await sql`
      update web_sessions set expires_at = ${expiresAt}
      where token_hash = ${tokenHash} and revoked_at is null
      returning token_hash`;
    expect(updated, "the authenticated fixture session exists").toHaveLength(1);
  });
  return { tokenHash, expiresAt };
}

async function sessionExpiry(tokenHash: string): Promise<Date | null> {
  return withSessionDb(async (sql) => {
    const rows = await sql<{ expires_at: Date }[]>`
      select expires_at from web_sessions where token_hash = ${tokenHash} and revoked_at is null`;
    return rows[0]?.expires_at ?? null;
  });
}

async function sessionCount(): Promise<number> {
  return withSessionDb(async (sql) => {
    const rows = await sql<{ count: string }[]>`select count(*)::text as count from web_sessions`;
    return Number(rows[0]?.count ?? 0);
  });
}

// The board's one ranked member: the QA viewer answers going to the seeded
// published event (e2e/seed.mjs, "E2E Community Night", 2099, no game).
// Earlier journeys withdraw or cancel every going RSVP they create, so
// a worker inserts and owns this fixture row, without spending the RSVP
// limiter budget reserved for the journeys. A restarted worker seeds anew.
// Its 2099 start and missing game also pin the season=2026 and activity=valheim
// views to their empty state below.
const SEEDED_EVENT_KEY = "01J00000000000000000000001";
let memberRsvpId: number | null = null;
let memberRsvpPromise: Promise<void> | null = null;
function memberGoingRsvp(): Promise<void> {
  memberRsvpPromise ??= withSessionDb(async (sql) => {
    const rows = await sql<{ id: number; status: string }[]>`
      insert into rsvps (event_id, user_id, status)
      select id, ${QA_IDENTITIES["qa-member"]!.discordId}, 'going'
      from events where event_key = ${SEEDED_EVENT_KEY}
      on conflict (event_id, user_id) do nothing
      returning id, status`;
    const [inserted] = rows;
    memberRsvpId = inserted?.id ?? null;
    expect(rows, "worker inserted its ranked RSVP without replacing another row").toHaveLength(1);
    expect(inserted?.status, "ranked RSVP holds a seat, not the waitlist").toBe("going");
  }).catch((error: unknown) => {
    memberRsvpPromise = null;
    throw error;
  });
  return memberRsvpPromise;
}

// The viewer's ranked row as both renderers emit it, after the shared
// normalization: rank 1, the seeded going count 1. The bare name also
// rides the member chrome, so only the table row proves ranked content.
const RANKED_ROW = '<td>1</td><th scope="row">QA Member</th><td>1</td>';

function expectNoMarker(headers: Record<string, string>, label: string) {
  expect(
    headers["x-two-renderer"] ?? null,
    `${label}: Hono-owned response carries no Kit marker`,
  ).toBeNull();
}

async function compactMenu(page: Page) {
  if (
    (page.viewportSize()?.width ?? Infinity) > 820 ||
    !(await page.locator("header#menu-sheet").count())
  ) {
    return null;
  }
  const name = { name: "Menu", exact: true };
  return page.getByRole("button", name).or(page.getByRole("link", name));
}

async function closeCompactMenu(page: Page, menu: Awaited<ReturnType<typeof compactMenu>>) {
  if (menu)
    await menu
      .or(page.getByRole("link", { name: "Close menu", exact: true }))
      .last()
      .click();
}

function headerSignOut(page: Page) {
  return page
    .locator('.header-account form[method="post"][action="/logout"] button[type="submit"]')
    .and(page.getByRole("button", { name: "Sign out", exact: true }));
}

test("kit: capture synthetic non-member and account-hidden headers", async ({ browser }) => {
  test.setTimeout(120_000);
  requireGithubRunner();
  for (const state of ["non-member", "account-hidden"] as const) {
    for (const width of [1280, 390]) {
      const bearer = `two_${randomBytes(32).toString("base64url")}`;
      const tokenHash = createHash("sha256").update(bearer).digest("hex");
      const userId = `9${BigInt(`0x${randomBytes(7).toString("hex")}`)
        .toString()
        .padStart(17, "0")}`;
      const signature = createHmac("sha256", kitFixtureSessionSecret())
        .update(bearer)
        .digest("base64");
      const context = await browser.newContext({
        baseURL: KIT_ORIGIN,
        viewport: { width, height: width === 1280 ? 800 : 844 },
        storageState: {
          cookies: [
            {
              name: "__Host-two_session",
              value: `${bearer}.${signature}`,
              domain: new URL(KIT_ORIGIN).hostname,
              path: "/",
              expires: -1,
              httpOnly: true,
              secure: true,
              sameSite: "Lax",
            },
          ],
          origins: [],
        },
      });
      try {
        await withSessionDb(async (sql) => {
          await sql`
            insert into web_sessions (token_hash, status_hash, user_id, username, avatar, member, moderator, expires_at)
            values (${tokenHash}, ${tokenHash}, ${userId}, 'Synthetic Viewer', null, ${state === "account-hidden"}, false, ${new Date(Date.now() + 120 * 60 * 1000)})`;
        });
        await context.route("**/*", (route) =>
          new URL(route.request().url()).origin === KIT_ORIGIN
            ? route.continue()
            : route.abort("blockedbyclient"),
        );
        const page = await context.newPage();
        const path =
          state === "non-member" ? `/e/${SEEDED_EVENT_KEY}` : "/leaderboards/members?season=bogus";
        const response = await page.goto(path);
        expect(response?.status()).toBe(state === "non-member" ? 200 : 400);
        expect(response?.headers()["x-two-renderer"]).toBe("kit");
        if (state === "non-member") {
          await (await compactMenu(page))?.click();
          await expect(page.locator(".header-account .who")).toHaveText("Synthetic Viewer");
          await expect(headerSignOut(page)).toBeVisible();
          await expect(page.locator('.main-nav a[href="/leaderboards/members"]')).toHaveCount(0);
        } else {
          await expect(page.locator(".header-account")).toHaveCount(0);
          await expect(
            page.getByRole("heading", { name: "Check the board filters" }),
          ).toBeVisible();
        }
        await page.evaluate(() => (globalThis as any).document.fonts.ready);
        await page.screenshot({
          path: test.info().outputPath(`brand-kit-${state}-${width}.png`),
          animations: "disabled",
          caret: "hide",
        });
      } finally {
        try {
          await context.close();
        } finally {
          await withSessionDb(async (sql) => {
            await sql`delete from web_session_grace where user_id = ${userId}`;
            await sql`delete from web_sessions where user_id = ${userId}`;
          });
        }
      }
    }
  }
});

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

    // Both renderers ship the Logo/Icon 1 head links: SVG favicon first, then
    // the PNG fallback and the touch icon, matched on tag attributes so the
    // Hono JSX and Kit app.html spellings both qualify.
    test("head declares the SVG favicon with PNG fallbacks", async () => {
      const response = await api(target).get("/events/past");
      expect(response.status()).toBe(200);
      const body = await response.text();
      const links = body.match(/<link\b[^>]*>/g) ?? [];
      const find = (rel: string, href: string) =>
        links.findIndex((tag) => tag.includes(`rel="${rel}"`) && tag.includes(`href="${href}"`));
      const svg = find("icon", "/favicon.svg");
      const png = find("icon", "/icons/icon-192.png");
      expect(svg, `${target.name}: SVG favicon link`).toBeGreaterThan(-1);
      expect(links[svg]).toContain('type="image/svg+xml"');
      expect(png, `${target.name}: PNG fallback link`).toBeGreaterThan(svg);
      expect(links[png]).toContain('type="image/png"');
      expect(find("apple-touch-icon", "/icons/apple-touch-icon.png")).toBeGreaterThan(-1);
    });

    test("page two renders the out-of-range refusal", async () => {
      const response = await api(target).get("/events/past?page=2");
      expect(response.status()).toBe(200);
      const body = await response.text();
      expect(body).toContain('data-testid="past-events-out-of-range"');
      expect(body).toContain("Page 2 is outside the archive. There is 1 page.");
    });
  });

  // Events index (GET /events only; POST /events and /events.json stay
  // Hono-owned, covered by e2e/events-create-validation.spec.ts on Hono).
  // Bodies come from raw API fetches with no browser JS executed, so these
  // assertions ARE the no-JS proof: the calendar content is in the first bytes.
  test.describe(`${target.name}: events index renders the seeded row`, () => {
    test("list renders the calendar island with the seeded row", async () => {
      const response = await api(target).get("/events");
      expect(response.status()).toBe(200);
      expect(response.headers()["content-type"]).toContain("text/html");
      // Renderer ownership is per target: Kit answers with the
      // manifest-derived marker once enabled, Hono never carries one.
      const expectedMarker = target.name === "kit" ? expectedKitMarker("/events") : null;
      expect(response.headers()["x-two-renderer"] ?? null).toBe(expectedMarker);
      expect(response.headers()["cache-control"]).toMatch(/^public, max-age=(?:[1-9]|[1-5]\d|60)$/);
      // Full and island-fragment representations share the URL and differ by
      // X-Two-Island, so Vary carries both tokens.
      const eventsVaryTokens = (response.headers()["vary"] ?? "")
        .split(",")
        .map((token) => token.trim().toLowerCase());
      expect(eventsVaryTokens).toContain("cookie");
      expect(eventsVaryTokens).not.toContain("x-cookie");
      expect(eventsVaryTokens).toContain("x-two-island");
      const body = await response.text();
      expect(scrubSecrets(body)).toEqual([]);
      expect(body).toContain('data-island="events-calendar"');
      expect(body).toContain('data-testid="events-calendar"');
      const canonicalHref = body.match(
        /<link\b[^>]*\brel="canonical"[^>]*\bhref="([^"]+)"[^>]*>/,
      )?.[1];
      expect(canonicalHref).toBeDefined();
      const canonical = new URL(canonicalHref!, target.origin);
      expect(canonical.pathname).toBe("/events");
      expect(canonical.search).toBe("");
      expect(canonical.hash).toBe("");
      expect(body).toContain('data-testid="events-list"');
      expect(body).toContain('data-testid="events-view-list"');
      expect(body).toContain('data-testid="events-view-calendar"');
      expect(body).toContain('data-testid="events-search"');
      expect(body).toContain('data-testid="events-past-archive-link"');
      expect(body).toContain('data-testid="events-subscribe"');
      expect(body).toContain("E2E Community Night");
      expect(body).toContain("Welcome, guest");
      expect(body).not.toContain("Sign out");
    });

    test("POST and the JSON contract stay Hono-owned without the Kit marker", async () => {
      const post = await api(target).post("/events", {
        headers: { origin: target.origin },
        data: { title: "Seed swap" },
      });
      expect(post.status()).toBe(401);
      expect(post.headers()["x-two-renderer"] ?? null).toBeNull();
      const json = await api(target).get("/events.json");
      expect(json.status()).toBe(401);
      expect(json.headers()["x-two-renderer"] ?? null).toBeNull();
      expect(await json.json()).toEqual({ error: "unauthenticated" });
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
      // The loopback fixture enables Kit for join even while the shipped
      // manifest leaves it disabled; Hono must never carry the Kit marker.
      const expectedMarker = target.name === "kit" ? "kit" : null;
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
      const hasPresence = body.includes('data-testid="join-widget-presence"');
      if (hasPresence) expect(hasLoad).toBe(true);
      // No flash cookies are sent on this journey; presence must not be stored.
      expect(response.headers()["cache-control"]).toBe(
        hasPresence ? "no-store" : "public, max-age=3600",
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
      // Only this loopback Worker enables the Kit recovery presentation.
      const expectedMarker = target.name === "kit" ? "kit" : null;
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
      // The Hono controller still owns the one-use journey write. A
      // bare landing visit never arms the pending notice: only a genuine
      // expired-write bounce does, so an attacker link cannot pre-arm a
      // false restored banner.
      const setCookies = (await response.headersArray())
        .filter((h) => h.name.toLowerCase() === "set-cookie")
        .map((h) => h.value)
        .join("\n");
      expect(setCookies).toContain("__Host-two_login_intended=");
      expect(setCookies).not.toContain("__Host-two_expired_write=");

      await test.step("HEAD keeps the recovery headers and signed cookie without a body", async () => {
        const head = await api(target).head("/auth/recover?next=%2Fprofile", {
          headers: { "if-none-match": "*" },
        });
        expect(head.status()).toBe(200);
        expect(head.headers()["x-two-renderer"] ?? null).toBe(expectedMarker);
        expect(head.headers()["cache-control"]).toBe("no-store, private");
        expect(head.headers()["set-cookie"]).toContain("__Host-two_login_intended=");
        expect(head.headers().etag).toBeUndefined();
        expect(await head.text()).toBe("");
      });
    });

    test("safe next survives onto the login retry, hostile next leaves no trace", async () => {
      const hostile = await api(target).get("/auth/recover?next=https%3A%2F%2Fevil.test");
      const hostileBody = await hostile.text();
      expect(hostileBody).toContain('href="/auth/discord?next=%2Fprofile"');
      expect(hostileBody).not.toContain("evil.test");
    });
  });

  // Hot-zone heatmaps (GET /hotzones + joins|voice|games only; unknown
  // segments 404, never a grid). Bodies come from raw API fetches with no
  // browser JS executed, so these assertions ARE the no-JS proof: the
  // aggregate grids, signal nav and estimate labels are in the first bytes.
  test.describe(`${target.name}: hot-zone heatmaps keep their aggregate contract`, () => {
    const hotzonePaths = ["/hotzones", "/hotzones/joins", "/hotzones/voice", "/hotzones/games"];

    test("index and signals serve aggregate grids with the manifest marker", async ({
      playwright,
    }) => {
      // Earlier auth journeys rotate cookies into the shared jar. Pin the
      // public-cache proof to a fresh guest context, not test execution order.
      const guest = await playwright.request.newContext({
        baseURL: target.origin,
        ignoreHTTPSErrors: target.ignoreHTTPSErrors,
      });
      try {
        for (const path of hotzonePaths) {
          expect((await guest.storageState()).cookies).toEqual([]);
          const response = await guest.get(path);
          expect(response.status(), `${target.name} ${path}`).toBe(200);
          expect(response.headers()["content-type"]).toContain("text/html");
          // Renderer ownership is per target: Kit answers with the
          // manifest-derived marker once enabled, Hono never carries one.
          const derived = expectedKitMarker(path);
          expect(derived, `manifest owns ${path} on Kit`).toBe("kit");
          const expectedMarker = target.name === "kit" ? derived : null;
          expect(
            response.headers()["x-two-renderer"] ?? null,
            `${target.name} ${path} marker`,
          ).toBe(expectedMarker);
          // The Kit target must answer from the Kit load, not the Hono
          // fallback: pin the literal kit marker so Hono-vs-Hono cannot pass.
          if (target.name === "kit")
            expect(
              response.headers()["x-two-renderer"] ?? null,
              `${path} Kit target answers from Kit`,
            ).toBe("kit");
          expect(response.headers()["cache-control"]).toBe("public, max-age=300");
          const body = await response.text();
          expect(scrubSecrets(body), `${target.name} ${path} secret scrub`).toEqual([]);
          expect(body).toContain("<table>");
          expect(body).toContain('<meta name="robots" content="noindex, follow"');
          // Both renderers replace guest sign-in with the direct Discord action.
          const header = body.match(/<header\b[^>]*>[\s\S]*?<\/header>/)?.[0];
          expect(header).toContain('href="/discord"');
          expect(header).toContain("Open Discord");
          expect(header).not.toContain("Sign in with Discord");
          expect(header).not.toContain("/join/discord");
          expect(body).not.toContain("Sign out");
          expect(body).not.toMatch(/discord_id|created_at/i);
          expect(body).toContain('<link rel="canonical"');
        }
      } finally {
        await guest.dispose();
      }
      // Index links all three signals and ships the voice/games estimate
      // labels; signal pages carry the cross-signal nav.
      const indexBody = await (await api(target).get("/hotzones")).text();
      expect(indexBody).toContain("Hot zones");
      expect(indexBody).toMatch(/across [1-9]\d* scheduled gatherings/);
      expect(indexBody).toContain('href="/hotzones/joins"');
      expect(indexBody).toContain('href="/hotzones/voice"');
      expect(indexBody).toContain('href="/hotzones/games"');
      expect(indexBody).toContain(
        "Season-independent seeded estimates of voice activity (estimates until calibration).",
      );
      expect(indexBody).toContain(
        "Season-independent seeded estimates of games activity (estimates until calibration).",
      );
      // The singular captions pin the real index loaders through rendering
      // on both targets: a reworded season claim on either loader line (not
      // just the exact old string) fails here.
      expect(indexBody).toContain("Season-independent seeded estimate of voice activity");
      expect(indexBody).toContain("Season-independent seeded estimate of games activity");
      const joinsBody = await (await api(target).get("/hotzones/joins")).text();
      expect(joinsBody).toMatch(/across [1-9]\d* scheduled gatherings/);
      expect(joinsBody).toContain("joins hot zone");
      expect(joinsBody).toContain("Join activity for season");
      expect(joinsBody).toContain("Successful joins only");
      expect(joinsBody).toContain('href="/hotzones"');
      const voiceBody = await (await api(target).get("/hotzones/voice")).text();
      expect(voiceBody).toContain("voice hot zone");
      expect(voiceBody).toContain("Season-independent seeded estimate of voice activity");
      expect(voiceBody).toContain("estimates until bot event-store calibration");
      const gamesBody = await (await api(target).get("/hotzones/games")).text();
      expect(gamesBody).toContain("games hot zone");
      expect(gamesBody).toContain("Season-independent seeded estimate of games activity");
      expect(gamesBody).toContain("estimates until bot event-store calibration");
    });

    test("cookie-bearing hot zones retain the renderer's cache privacy contract", async ({
      playwright,
    }) => {
      const guest = await playwright.request.newContext({
        baseURL: target.origin,
        ignoreHTTPSErrors: target.ignoreHTTPSErrors,
      });
      try {
        for (const path of hotzonePaths) {
          // Even an unverified, non-session cookie makes Kit HTML private.
          // Hono's aggregate route keeps its existing public-cache contract.
          const response = await guest.get(path, { headers: { cookie: "parity-cache=1" } });
          expect(response.status(), `${target.name} ${path}`).toBe(200);
          expect(response.headers()["cache-control"]).toBe(
            target.name === "kit" ? "private, no-store" : "public, max-age=300",
          );
          expect(response.headers()["vary"] ?? "").toMatch(/cookie/i);
          const body = await response.text();
          expect(scrubSecrets(body)).toEqual([]);
          expect(body).toContain("<table>");
          expect(body).not.toContain('data-testid="auth-error"');
          expect(body).not.toContain("Sign out");
        }
      } finally {
        await guest.dispose();
      }
    });

    test("bad season answers 400 before any grid", async () => {
      for (const path of [
        "/hotzones?season=bogus",
        "/hotzones/joins?season=bogus",
        "/hotzones/voice?season=bogus",
        "/hotzones/games?season=bogus",
      ]) {
        const response = await api(target).get(path);
        expect(response.status(), `${target.name} ${path}`).toBe(400);
        const body = await response.text();
        expect(scrubSecrets(body)).toEqual([]);
        expect(body).not.toContain("<table>");
        // Body parity, not just status: both twins answer the branded 400
        // shell — never the bare "Unknown season" text (Hono mutant) and
        // never the 500 shell at HTTP 400 (Kit boundary mutant).
        expect(body.trim(), `${target.name} ${path}`).not.toBe("Unknown season");
        expect(body, `${target.name} ${path}`).not.toContain("Something broke on our side");
        expect(body, `${target.name} ${path}`).toMatch(
          /class="recovery-code(?:\s[^"]*)?"[^>]*>\s*400\s*</,
        );
        expect(body, `${target.name} ${path}`).toContain('data-testid="error-home"');
        expect(body, `${target.name} ${path}`).toContain("Back to the homepage");
        expect(body, `${target.name} ${path}`).toContain("noindex, nofollow");
      }
    });

    test("unknown signal falls through to the Hono 404", async () => {
      const response = await api(target).get("/hotzones/bogus");
      expect(response.status()).toBe(404);
      expect(
        response.headers()["x-two-renderer"] ?? null,
        `${target.name} unknown signal carries no Kit marker`,
      ).toBeNull();
      const body = await response.text();
      expect(scrubSecrets(body)).toEqual([]);
      expect(body).not.toContain("<table>");
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
      // Read-after-write across workers: the session row is committed by the
      // single shared QA login moments earlier on the Hono worker, and this
      // suite runs with retries: 0, so one first-read miss (an unknown
      // session reads as a guest bounce, which the client follows onto Hono)
      // must not fail the run. Poll the first view briefly; the strict
      // asserts below still prove the contract on the settled read.
      await expect
        .poll(
          async () => {
            const ready = await api(target).get("/leaderboards/members", {
              headers: { cookie },
            });
            return (
              ready.status() === 200 &&
              (ready.headers()["x-two-renderer"] ?? null) === expectedMarker
            );
          },
          {
            message: `${target.name} member board session becomes visible`,
            timeout: 15000,
          },
        )
        .toBe(true);
      // Ranked content, not just board chrome: the viewer's going RSVP on
      // the seeded 2099 event ranks them on the overall and relative
      // views, while the 2026 season window and the valheim game filter
      // exclude that event and must render the empty state. A renderer
      // serving no rows (or the wrong rows) fails here, not just on 200s.
      await memberGoingRsvp();
      for (const { path, ranked } of [
        { path: "/leaderboards/members", ranked: true },
        { path: "/leaderboards/members?scope=relative", ranked: true },
        { path: "/leaderboards/members?season=2026", ranked: false },
        { path: "/leaderboards/members?activity=valheim", ranked: false },
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
        const normalized = normalizeSection(body);
        if (ranked) {
          expect(normalized, `${target.name} ${path}: ranked viewer row`).toContain(RANKED_ROW);
        } else {
          expect(body, `${target.name} ${path}: empty board`).toContain(
            "Nobody is ranked for this season and game yet.",
          );
          expect(normalized, `${target.name} ${path}: no ranked row`).not.toContain(RANKED_ROW);
        }
      }
    });

    test("member board data request carries no Discord IDs", async () => {
      // SvelteKit serves __data.json from the load's return value even with
      // csr = false, so the Kit payload must carry rank + name + count +
      // isViewer only: no ranked member's Discord ID, no viewerId. Hono
      // never served this path, so its body must carry no IDs either.
      const cookie = await memberCookie(target);
      await memberGoingRsvp();
      const response = await api(target).get("/leaderboards/members/__data.json", {
        headers: { cookie },
      });
      if (target.name === "kit") expect(response.status()).toBe(200);
      const body = await response.text();
      expect(scrubSecrets(body)).toEqual([]);
      expect(body).not.toContain("userId");
      expect(body).not.toContain("viewerId");
      // Shape, not just status: the Kit payload is parsed and its rows
      // must be exactly the viewer's ranked row (rank + name + count +
      // server-side viewer mark), so a 200 with the data missing fails.
      if (target.name === "kit") {
        expect(memberBoardDataRows(body), "Kit __data.json rows").toEqual([
          { rank: 1, username: "QA Member", count: 1, isViewer: true },
        ]);
      }
    });

    test("bad season, scope and activity answer 400 before any board", async () => {
      const cookie = await memberCookie(target);
      for (const path of [
        "/leaderboards/members?season=bogus",
        "/leaderboards/members?scope=friends",
        "/leaderboards/members?scope=bogus",
        // Punctuation is a valid savable game name, so the activity
        // refusal pin uses an overlong value (101 chars > 100 max).
        `/leaderboards/members?activity=${"a".repeat(101)}`,
      ]) {
        const response = await api(target).get(path, { headers: { cookie } });
        expect(response.status(), `${target.name} ${path}`).toBe(400);
        const body = await response.text();
        expect(scrubSecrets(body)).toEqual([]);
        expect(body).not.toContain("<h1>Member leaderboard</h1>");
      }
    });
  });

  // Live event detail (GET /e/:key only): the RSVP companion's executed
  // journey. The shipped manifest keeps the entry disabled until the companion
  // passes, so the Kit target answers from the Kit load only through the
  // loopback fixture (kitFixtureOwnsEventDetail); Hono always answers without
  // the marker. JSON/ICS stay Hono-owned with no manifest entries and every
  // RSVP mutation keeps Hono as its single authority. Bodies are
  // origin-normalized before comparison where hosts differ by design.
  test.describe(`${target.name}: live event detail keeps its RSVP companion contract`, () => {
    const EVENT_KEY = "01J00000000000000000000001";
    const EVENT_PATH = `/e/${EVENT_KEY}`;

    test("guest renders the published contract with join pitch and no attendees", async ({
      playwright,
    }) => {
      if (target.name === "kit")
        expect(kitFixtureOwnsEventDetail(), "Kit fixture owns the event detail").toBe(true);
      const expectedMarker = target.name === "kit" ? "kit" : null;
      // Cookie-free by construction: the shared api() context accumulates
      // session cookies from the earlier QA-login journey, which would render
      // the member view (no join pitch) instead of the guest contract.
      const guest = await playwright.request.newContext({
        baseURL: target.origin,
        ignoreHTTPSErrors: target.ignoreHTTPSErrors,
      });
      try {
        const sessionsBefore = await sessionCount();
        const response = await guest.get(EVENT_PATH);
        expect(response.status(), `${target.name} guest detail`).toBe(200);
        expect(
          (await response.headersArray()).filter(
            (header) =>
              header.name.toLowerCase() === "set-cookie" &&
              header.value.startsWith("__Host-two_session="),
          ),
          `${target.name} anonymous detail does not issue a session`,
        ).toEqual([]);
        expect(
          await sessionCount(),
          `${target.name} anonymous detail does not mutate sessions`,
        ).toBe(sessionsBefore);
        expect(response.headers()["content-type"]).toContain("text/html");
        expect(response.headers()["x-two-renderer"] ?? null).toBe(expectedMarker);
        // Per-viewer page: never shared-cacheable, on either renderer.
        expect(response.headers()["cache-control"]).toBe("private, no-store");
        expect(response.headers()["vary"] ?? "").toMatch(/cookie/i);
        const body = await response.text();
        expect(scrubSecrets(body)).toEqual([]);
        expect(body).toContain("E2E Community Night");
        expect(body).toContain('data-testid="event-join-pitch"');
        expect(body).toContain('data-testid="event-copy-link"');
        expect(body).toContain('data-testid="event-jsonld"');
        expect(body).toContain('rel="canonical"');
        expect(body).toContain(`/events/${EVENT_KEY}.ics`);
        expect(body).not.toContain('data-testid="event-attendees"');
        expect(body).not.toContain("Sign out");
        expect(body).toContain("Welcome, guest");
        if (target.name === "kit") {
          expect(body).toContain('data-testid="kit-seat-card"');
          expect(body).toContain("Log in to RSVP");
          expect(body).toContain("come straight back here.");
        }
      } finally {
        await guest.dispose();
      }
    });

    test("member renders the no-JS RSVP form posting to the Hono controller", async ({
      playwright,
    }) => {
      // Test timeout: the config's 30s also bounds this test; keep the
      // one-login retry budget as headroom for the Kit path's DB mint plus
      // the renewal renders. The Hono path replays the memoized login, so
      // the budget is idle there.
      test.setTimeout(30_000 + qaLoginRetryBudgetMs(1));
      if (target.name === "kit")
        expect(kitFixtureOwnsEventDetail(), "Kit fixture owns the event detail").toBe(true);
      const expectedMarker = target.name === "kit" ? "kit" : null;
      // Put the real fixture row 30 seconds from expiry immediately before the
      // request. Both detail handlers must rotate the bearer and re-stamp the
      // full 120-minute sliding window, rather than merely refreshing cookie age.
      const cookie =
        target.name === "kit" ? await isolatedRenewalCookie(target) : await memberCookie(target);
      const prior = await ageSessionNearExpiry(cookie);
      let response: APIResponse | undefined;
      let body = "";
      let requestStartedAt = 0;
      await expect
        .poll(
          async () => {
            const startedAt = Date.now();
            const candidate = await api(target).get(EVENT_PATH, { headers: { cookie } });
            const candidateBody = await candidate.text();
            if (
              candidate.status() === 200 &&
              (candidate.headers()["x-two-renderer"] ?? null) === expectedMarker &&
              candidateBody.includes("Sign out")
            ) {
              response = candidate;
              body = candidateBody;
              requestStartedAt = startedAt;
              return true;
            }
            return false;
          },
          {
            message: `${target.name} member detail session becomes visible`,
            timeout: 15000,
          },
        )
        .toBe(true);
      if (response === undefined)
        throw new Error(`${target.name} member detail response was not captured`);
      expect(response.headers()["content-type"]).toContain("text/html");
      expect(response.headers()["cache-control"]).toBe("private, no-store");
      expect(scrubSecrets(body)).toEqual([]);
      expect(body).toContain("E2E Community Night");
      expect(body).not.toContain('data-testid="event-join-pitch"');
      // The mutation stays Hono-owned: a native form posts to the unchanged
      // controller, the islands only enhance it.
      expect(body).toContain(`action="/e/${EVENT_KEY}/rsvp"`);
      expect(body).toContain("/islands/rsvp-button.js");
      if (target.name === "kit") {
        expect(body).toContain('data-testid="kit-seat-card"');
        expect(body).toMatch(/\d+ of 10 in/);
        expect(body).not.toContain("Log in to RSVP");
      }
      expect(body).toContain("Sign out");
      expect(body).not.toContain("Welcome, guest");
      // Both renderers rotate the active bearer and renew its 120-minute
      // sliding expiry through the shared session store. Only the immediate
      // predecessor keeps a fixed <10s grace: replaying it authenticates the
      // member without rotating, minting a sibling, or renewing that window.
      const sessionSets = (await response.headersArray())
        .filter((header) => header.name.toLowerCase() === "set-cookie")
        .map((header) => header.value)
        .filter((value) => value.startsWith("__Host-two_session="));
      expect(sessionSets, `${target.name} detail rotates a near-expiry session`).toHaveLength(1);
      expect(sessionSets[0]!, `${target.name} cookie re-stamps 120 minutes`).toMatch(
        /max-age=7200/i,
      );
      const replacementCookie = sessionSets[0]!.split(";")[0]!;
      const replacementTokenHash = createHash("sha256")
        .update(bearerFromCookie(replacementCookie))
        .digest("hex");
      expect(bearerFromCookie(replacementCookie)).not.toBe(bearerFromCookie(cookie));
      expect(
        await sessionExpiry(prior.tokenHash),
        `${target.name} retires the old bearer`,
      ).toBeNull();
      const renewedExpiry = await sessionExpiry(replacementTokenHash);
      expect(renewedExpiry, `${target.name} stores the replacement session`).not.toBeNull();
      expect(renewedExpiry!.getTime()).toBeGreaterThan(prior.expiresAt.getTime());
      expect(renewedExpiry!.getTime()).toBeGreaterThanOrEqual(
        requestStartedAt + 120 * 60 * 1000 - 60_000,
      );
      expect(renewedExpiry!.getTime()).toBeLessThanOrEqual(
        requestStartedAt + 120 * 60 * 1000 + 60_000,
      );

      for (const phase of ["immediate", "expired"] as const) {
        // A real-worker clock cannot be faked. Wait past grace without
        // polling; exact-deadline behavior is pinned by the store suites.
        if (phase === "expired") await new Promise((resolve) => setTimeout(resolve, 10_050));
        // A new jar for EVERY replay: neither the shared jar nor a previous
        // replay's replacement may silently substitute for this explicit bearer.
        const replay = await playwright.request.newContext({
          baseURL: target.origin,
          ignoreHTTPSErrors: target.ignoreHTTPSErrors,
        });
        try {
          const again = await replay.get(EVENT_PATH, { headers: { cookie } });
          expect(again.status(), `${target.name} ${phase} replayed bearer`).toBe(200);
          const againBody = await again.text();
          expect(scrubSecrets(againBody)).toEqual([]);
          const replaySessionSets = (await again.headersArray()).filter(
            (header) =>
              header.name.toLowerCase() === "set-cookie" &&
              header.value.startsWith("__Host-two_session="),
          );
          expect(replaySessionSets, "replay never mints an independent sibling").toEqual([]);
          if (phase === "immediate") {
            expect(againBody).not.toContain('data-testid="event-join-pitch"');
            expect(againBody).toContain("Sign out");
            expect(againBody).not.toContain("Welcome, guest");
          } else {
            expect(againBody).toContain('data-testid="event-join-pitch"');
            expect(againBody).not.toContain("Sign out");
            expect(againBody).toContain("Welcome, guest");
          }
        } finally {
          await replay.dispose();
        }
      }
    });

    test("JSON, ICS and RSVP mutations stay Hono-owned without the Kit marker", async () => {
      // The event JSON names its viewer (waitlist position), so it needs the
      // member session like every other member read; guests get the 401
      // refusal on both renderers (src/events/routes-detail.tsx jsonSession).
      const cookie = await memberCookie(target);
      const json = await api(target).get(`/events/${EVENT_KEY}`, { headers: { cookie } });
      expect(json.status(), `${target.name} event JSON`).toBe(200);
      expectNoMarker(json.headers(), `${target.name} event JSON`);

      const ics = await api(target).get(`/events/${EVENT_KEY}.ics`);
      expect(ics.status(), `${target.name} event ICS`).toBe(200);
      expectNoMarker(ics.headers(), `${target.name} event ICS`);

      const put = await api(target).put(`/events/${EVENT_KEY}/rsvp`, { data: {} });
      expect([401, 403, 404, 422], `${target.name} RSVP PUT refused`).toContain(put.status());
      expectNoMarker(put.headers(), `${target.name} RSVP PUT`);

      const post = await api(target).post(EVENT_PATH + "/rsvp", {
        data: "status=going",
        headers: { "content-type": "application/x-www-form-urlencoded" },
      });
      expect([303, 401, 403], `${target.name} RSVP POST refused/redirected`).toContain(
        post.status(),
      );
      expectNoMarker(post.headers(), `${target.name} RSVP POST`);
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
      const body = await response.json();
      expect(body.error).toBe("cross_origin");
      expect(typeof body.request_id).toBe("string");
      expect(Object.keys(body).sort()).toEqual(["error", "request_id"]);
      expect(response.headers()["content-security-policy"] ?? "").toContain("default-src 'self'");
    });
  });

  test(`${target.name}: brand header preserves guest and member chrome at narrow widths`, async ({
    browser,
    playwright,
  }) => {
    test.setTimeout(120_000);
    const states = [
      ...(target.name === "hono"
        ? [
            { name: "guest-home", path: "/", member: false },
            { name: "guest-about", path: "/about", member: false },
            { name: "guest-join", path: "/join", member: false },
          ]
        : []),
      { name: "guest-events", path: "/events", member: false },
      { name: "member-board", path: "/leaderboards/members", member: true },
    ];
    for (const state of states) {
      const hono = targets.find((candidate) => candidate.name === "hono")!;
      if (state.member) {
        // beforeAll leaves Hono's jar guest-clean. Populate it even when this
        // capture runs alone, then re-sign its freshest cookie for the target.
        const ready = await api(hono).get("/leaderboards/members", {
          headers: { cookie: await memberCookie(hono) },
        });
        expect(ready.status(), "issued member session reaches the board").toBe(200);
      }
      const cookie = state.member ? await memberCookie(target) : null;
      const context = await browser.newContext({
        baseURL: target.origin,
        ignoreHTTPSErrors: target.ignoreHTTPSErrors,
        // Match the existing member-board visual journey: preserve the issued
        // attributes instead of deriving a secure __Host cookie from Kit's HTTP URL.
        storageState: {
          cookies: cookie
            ? (await api(hono).storageState()).cookies
                .filter((session) => session.name === "__Host-two_session")
                .map((session) => ({
                  ...session,
                  domain: new URL(target.origin).hostname,
                  value: cookie.slice(cookie.indexOf("=") + 1),
                }))
            : [],
          origins: [],
        },
      });
      try {
        await context.route("**/*", (route) => {
          const url = new URL(route.request().url());
          const allowed = url.origin === "https://localhost:8787" || url.origin === KIT_ORIGIN;
          return allowed ? route.continue() : route.abort("blockedbyclient");
        });
        if (state.member) {
          expect(
            (await context.cookies()).filter((session) => session.name === "__Host-two_session"),
            "one issued member session in the browser jar",
          ).toHaveLength(1);
        }
        const page = await context.newPage();
        for (const width of [360, 390, 768, 1280]) {
          await page.setViewportSize({ width, height: width === 1280 ? 800 : 844 });
          const response = await page.goto(state.path);
          expect(response?.status()).toBe(200);
          if (target.name === "kit") {
            expect(response?.headers()["x-two-renderer"] ?? null).toBe(
              expectedKitMarker(state.path),
            );
          }
          await page.waitForLoadState("networkidle");
          await page.screenshot({
            path: test.info().outputPath(`brand-${target.name}-${state.name}-${width}.png`),
            animations: "disabled",
            caret: "hide",
          });
          const menu = await compactMenu(page);
          const logo = await page.locator(".brand img:visible").boundingBox();
          expect(logo?.height).toBe(menu ? 32 : 50);
          if (menu) expect(logo?.width).toBeCloseTo((456.86 * 32) / 126.34, 1);
          else expect(logo?.width).toBe(width <= 480 ? 50 : 180);
          await menu?.click();
          const chrome = (await page.evaluate(`(() => {
            const account = document.querySelector('.header-account');
            const button = account.querySelector('.btn');
            const who = account.querySelector('.who');
            const range = document.createRange();
            if (button) range.selectNodeContents(button);
            return {
              overflow: document.documentElement.scrollWidth > window.innerWidth,
              buttonLines: button ? new Set([...range.getClientRects()].map(r => r.top)).size : 0,
              nameClipped: who ? who.scrollWidth > who.clientWidth : false
            };
          })()`)) as { overflow: boolean; buttonLines: number; nameClipped: boolean };
          expect(chrome.overflow, `${state.name} @ ${width}: no horizontal overflow`).toBe(false);
          if (state.member) {
            await expect(page.locator(".header-account .who")).toHaveText("QA Member");
            expect(chrome.nameClipped, `${state.name} @ ${width}: full member name`).toBe(false);
          } else {
            expect(chrome.buttonLines, `${state.name} @ ${width}: single-line action`).toBe(1);
          }
        }
      } finally {
        try {
          if (state.member && target.name === "hono") {
            // Page reads rotate the bearer. Keep the browser's latest jar for
            // later parity tests and RSVP teardown before closing the browser.
            const storageState = await context.storageState();
            expect(
              storageState.cookies.some((cookie) => cookie.name === "__Host-two_session"),
            ).toBe(true);
            const replacement = await playwright.request.newContext({
              baseURL: target.origin,
              ignoreHTTPSErrors: target.ignoreHTTPSErrors,
              storageState,
            });
            await api(target).dispose();
            contexts.set(target.name, replacement);
          }
        } finally {
          await context.close();
        }
      }
    }
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

  if (target.name === "kit") {
    for (const viewport of PARITY_VIEWPORTS) {
      test(`kit: join ${viewport.name} shows the heading and action without JavaScript`, async ({
        browser,
      }) => {
        const context = await browser.newContext({
          baseURL: target.origin,
          ignoreHTTPSErrors: target.ignoreHTTPSErrors,
          viewport: viewport.size,
          javaScriptEnabled: false,
        });
        try {
          await context.route("**/*", (route) => {
            const url = new URL(route.request().url());
            return url.origin === target.origin ? route.continue() : route.abort("blockedbyclient");
          });
          const page = await context.newPage();
          const response = await page.goto("/join?next=%2Fevents");
          expect(response?.headers()["x-two-renderer"]).toBe("kit");
          expect(response?.status()).toBe(200);
          await expect(
            page.getByRole("heading", { level: 1, name: "Play with people who show up." }),
          ).toBeVisible();
          await expect(
            page.getByText("A Discord gaming community · founded 1998 · English"),
          ).toBeVisible();
          await expect(page.locator("#join-steps-heading")).toHaveText(
            "What happens when you join",
          );
          await expect(
            page.getByRole("heading", { name: "The bot lets you in and makes you a Prospect" }),
          ).toBeVisible();
          await expect(
            page.getByRole("heading", { name: "You land back here, signed in" }),
          ).toBeVisible();
          await expect(page.getByRole("heading", { name: "What we ask of you" })).toBeVisible();
          await expect(page.getByText("You must be 18 or older.")).toBeVisible();
          await expect(page.getByRole("link", { name: "How deletion works" })).toHaveAttribute(
            "href",
            "/privacy",
          );
          await expect(
            page.getByRole("complementary", { name: "Join with one sign-in" }),
          ).toBeVisible();
          await expect(
            page.getByRole("link", { name: "Join with Discord", exact: true }),
          ).toHaveAttribute("href", "/join/discord?next=%2Fevents");
        } finally {
          await context.close();
        }
      });
    }
  }

  // Two-width hot-zone journey: the index shows the grids and the signal nav
  // works at either width, on both renderers. All four paths hold the page
  // inside the viewport (no horizontal overflow); at 390px the 7x24 grid's
  // 42rem floor scrolls inside its labelled region instead of the page.
  for (const viewport of PARITY_VIEWPORTS) {
    test(`${target.name}: hotzones ${viewport.name} shows the grids and follows signal nav`, async ({
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
        const response = await page.goto("/hotzones");
        expect(response?.status()).toBe(200);
        await expect(page.getByRole("heading", { name: "Hot zones" })).toBeVisible();
        await expect(page.getByRole("link", { name: "Joins heatmap" })).toBeVisible();
        await expect(page.getByRole("link", { name: "Voice heatmap" })).toBeVisible();
        await expect(page.getByRole("link", { name: "Games heatmap" })).toBeVisible();
        // String form: the e2e tsconfig has no DOM lib (same as the
        // copy-link and skip-link specs), so no document/window names here.
        const expectContained = async (path: string, regions: number) => {
          const overflow = (await page.evaluate(
            "({ width: document.documentElement.scrollWidth, viewport: window.innerWidth })",
          )) as unknown as { width: number; viewport: number };
          expect(
            overflow.width,
            `${target.name} ${viewport.name} ${path}: no horizontal overflow`,
          ).toBeLessThanOrEqual(overflow.viewport);
          const scroll = page.locator("[data-hotzone-scroll]");
          await expect(scroll, `${target.name} ${viewport.name} ${path}: grid regions`).toHaveCount(
            regions,
          );
          if (viewport.name === "mobile") {
            // Contained, not clipped: every region scrolls the grid's 42rem
            // floor inside itself, so the page stays put and the cells remain
            // reachable by panning the region. The e2e tsconfig has no DOM lib,
            // so type the element metrics structurally inside the callback.
            const scrollable = await scroll.evaluateAll((nodes) =>
              nodes.map((node) => {
                const element = node as unknown as { scrollWidth: number; clientWidth: number };
                return element.scrollWidth > element.clientWidth;
              }),
            );
            expect(
              scrollable,
              `${target.name} mobile ${path}: each grid scrolls inside its region`,
            ).toEqual(Array.from({ length: regions }, () => true));
          }
        };
        await expectContained("/hotzones", 3);
        // Control: the Joins heatmap path stays a live aggregate, never an
        // estimate. Voice/games must read as estimates even when this live
        // fixture has data (the raw index pins live gatherings).
        await page.getByRole("link", { name: "Joins heatmap" }).click();
        await expect(page).toHaveURL(/\/hotzones\/joins/);
        await page.waitForLoadState("load");
        await expect(page.getByRole("heading", { name: "joins hot zone" })).toBeVisible();
        await expect(page.locator("p", { hasText: /Join activity for season/ })).toBeVisible();
        await expect(page.getByText("Successful joins only")).toBeVisible();
        await expect(page.getByText(/Total estimate:/)).toHaveCount(0);
        await expect(page.getByText(/estimates until bot event-store calibration/)).toHaveCount(0);
        await expectContained("/hotzones/joins", 1);
        // Heatmap navigation from the index: each Voice/Games heatmap link is
        // visible and navigates to its matching page (the Joins click above
        // is the preserved control path).
        for (const signal of ["voice", "games"] as const) {
          const heatmap = `${signal.charAt(0).toUpperCase()}${signal.slice(1)} heatmap`;
          await page.goto("/hotzones");
          await page.waitForLoadState("load");
          await expect(page.getByRole("link", { name: heatmap })).toBeVisible();
          await page.getByRole("link", { name: heatmap }).click();
          await expect(page).toHaveURL(new RegExp(`/hotzones/${signal}`));
          await page.waitForLoadState("load");
          await expect(page.getByRole("heading", { name: `${signal} hot zone` })).toBeVisible();
        }
        // Voice/games rendered acceptance contract
        // (docs/kit-parity-gates.md): direct loads assert heading, estimate
        // copy, numeric totals, labelled table, cross-signal nav, layout,
        // privacy and marker. Pins are fixture-stable (labels, dimensions,
        // nonnegative totals) — never seeded cells or live counts.
        // Failure/empty boundaries stay status contracts, not success
        // screens: malformed season 400 and unknown signal 404 are pinned by
        // the raw API tests above; the outage 503 mapping is loader scope
        // (test/kit-hotzones.test.ts signal 503,
        // test/kit-public-load-alerts-acceptance.test.ts hotzones signal
        // outage); zero-join rendered state is out (the shared helper's
        // null-DB branch is unit-test scope,
        // test/hotzone-season-continuity-acceptance.test.ts null-DB fixture).
        for (const signal of ["voice", "games"] as const) {
          const path = `/hotzones/${signal}`;
          const caption = `Season-independent seeded estimate of ${signal} activity (hours in UTC)`;
          const signalResponse = await page.goto(path);
          expect(
            signalResponse?.status(),
            `${target.name} ${viewport.name} ${path} direct load`,
          ).toBe(200);
          const signalHeaders = signalResponse?.headers() ?? {};
          expect(signalHeaders["content-type"], `${target.name} ${path} html`).toContain(
            "text/html",
          );
          expect(signalHeaders["cache-control"], `${target.name} ${path} cache`).toBe(
            "public, max-age=300",
          );
          const derived = expectedKitMarker(path);
          expect(derived, `manifest owns ${path} on Kit`).toBe("kit");
          const expectedMarker = target.name === "kit" ? derived : null;
          expect(signalHeaders["x-two-renderer"] ?? null, `${target.name} ${path} marker`).toBe(
            expectedMarker,
          );
          if (target.name === "kit")
            expect(signalHeaders["x-two-renderer"] ?? null, `${path} Kit answers from Kit`).toBe(
              "kit",
            );
          await expect(page.getByRole("heading", { name: `${signal} hot zone` })).toBeVisible();
          await expect(
            page.getByText(new RegExp(`Season-independent seeded estimates of ${signal} activity`)),
          ).toBeVisible();
          await expect(page.getByText(/estimates until bot event-store calibration/)).toBeVisible();
          const totalText = await page.getByText(/Total estimate:/).textContent();
          expect(totalText, `${target.name} ${path} total estimate`).toMatch(/Total estimate: \d+/);
          const total = Number(totalText?.match(/Total estimate: (\d+)/)?.[1]);
          expect(
            Number.isInteger(total) && total >= 0,
            `${target.name} ${path} nonnegative total`,
          ).toBe(true);
          // Estimates, never the live joins copy.
          await expect(page.getByText("Successful joins only")).toHaveCount(0);
          expect(
            await page.content(),
            `${target.name} ${path} no live joins caption`,
          ).not.toContain("Join activity for season");
          // Cross-signal links: All hot zones plus each signal, with seasonless
          // canonical hrefs (the default all view carries no query).
          await expect(page.getByRole("link", { name: "All hot zones" })).toBeVisible();
          await expect(page.getByRole("link", { name: "joins", exact: true })).toBeVisible();
          await expect(page.getByRole("link", { name: "voice", exact: true })).toBeVisible();
          await expect(page.getByRole("link", { name: "games", exact: true })).toBeVisible();
          expect(await page.getByRole("link", { name: "All hot zones" }).getAttribute("href")).toBe(
            "/hotzones",
          );
          expect(
            await page.getByRole("link", { name: "joins", exact: true }).getAttribute("href"),
          ).toBe("/hotzones/joins");
          expect(
            await page.getByRole("link", { name: "voice", exact: true }).getAttribute("href"),
          ).toBe("/hotzones/voice");
          expect(
            await page.getByRole("link", { name: "games", exact: true }).getAttribute("href"),
          ).toBe("/hotzones/games");
          // Labelled table: one focusable region, caption, weekday rows and
          // hour columns (src/hotzones/weekday-names.ts labels; the 42rem
          // floor is unit-pinned in test/hotzones-grid-scroll-region.test.ts
          // and measured as contained scrolling by expectContained below).
          const region = page.locator("[data-hotzone-scroll]");
          await expect(region, `${target.name} ${viewport.name} ${path} one region`).toHaveCount(1);
          await expect(region).toHaveAttribute("role", "region");
          await expect(region).toHaveAttribute("aria-label", caption);
          await expect(region).toHaveAttribute("tabindex", "0");
          await expect(region.locator("caption")).toHaveText(caption);
          const headerCells = region.locator("thead th");
          await expect(headerCells).toHaveCount(25);
          await expect(headerCells.first()).toHaveText("Day (UTC)");
          for (let h = 0; h < 24; h++) {
            await expect(headerCells.nth(h + 1), `${target.name} ${path} hour ${h}`).toHaveText(
              String(h).padStart(2, "0"),
            );
          }
          const expectedWeekdays = [
            "Sunday",
            "Monday",
            "Tuesday",
            "Wednesday",
            "Thursday",
            "Friday",
            "Saturday",
          ];
          const rowHeaders = region.locator("tbody th[scope='row']");
          await expect(rowHeaders).toHaveCount(7);
          for (let d = 0; d < 7; d++) {
            await expect(rowHeaders.nth(d), `${target.name} ${path} weekday ${d}`).toHaveText(
              expectedWeekdays[d]!,
            );
          }
          await expect(region.locator("tbody tr")).toHaveCount(7);
          const cells = region.locator("tbody td");
          await expect(cells).toHaveCount(168);
          const cellTexts = await cells.allTextContents();
          expect(cellTexts).toHaveLength(168);
          let cellsSum = 0;
          for (const text of cellTexts) {
            const trimmed = text.trim();
            expect(trimmed, `${target.name} ${path} cell numeric`).toMatch(/^\d+$/);
            const n = Number(trimmed);
            expect(n, `${target.name} ${path} cell nonnegative`).toBeGreaterThanOrEqual(0);
            cellsSum += n;
          }
          expect(cellsSum, `${target.name} ${path} total matches grid sum`).toBe(total);
          // Public/privacy: guest rendered (Open Discord replaces the
          // default sign-in chrome on both renderers, so no Welcome caption
          // and no sign-in/sign-out controls), no member identifiers, noindex
          // plus canonical (cache/marker headers asserted above).
          const menu = await compactMenu(page);
          await menu?.click();
          const discord = page.getByRole("link", { name: "Open Discord" });
          await expect(discord).toBeVisible();
          await expect(discord).toHaveAttribute("href", "/discord");
          await expect(page.getByText("Sign in with Discord")).toHaveCount(0);
          await expect(page.getByText("Sign out")).toHaveCount(0);
          await closeCompactMenu(page, menu);
          expect(await page.content(), `${target.name} ${path} no member identifiers`).not.toMatch(
            /discord_id|created_at/i,
          );
          const robots = page.locator('meta[name="robots"]');
          await expect(robots).toHaveCount(1);
          await expect(robots).toHaveAttribute("content", "noindex, follow");
          const canonicalLinks = page.locator('link[rel="canonical"]');
          await expect(canonicalLinks).toHaveCount(1);
          const canonicalHref = await canonicalLinks.first().getAttribute("href");
          expect(canonicalHref, `${target.name} ${path} canonical present`).not.toBeNull();
          const canonical = new URL(canonicalHref!, target.origin);
          expect(canonical.pathname, `${target.name} ${path} canonical path`).toBe(path);
          expect(canonical.search, `${target.name} ${path} canonical query`).toBe("");
          expect(canonical.hash, `${target.name} ${path} canonical hash`).toBe("");
          await expectContained(path, 1);
        }
        expect(pageErrors, "no uncaught page errors").toEqual([]);
      } finally {
        await context.close();
      }
    });
  }
}

test("Kit guest seat card keeps its no-JS action at desktop and mobile widths", async ({
  browser,
}) => {
  expect(kitFixtureOwnsEventDetail(), "Kit fixture owns the event detail").toBe(true);
  const eventPath = "/e/01J00000000000000000000001";
  for (const viewport of [
    { width: 1280, height: 800 },
    { width: 390, height: 844 },
  ]) {
    const context = await browser.newContext({ viewport, javaScriptEnabled: false });
    try {
      const page = await context.newPage();
      const response = await page.goto(`${KIT_ORIGIN}${eventPath}`);
      expect(response?.status()).toBe(200);
      expect(response?.headers()["x-two-renderer"]).toBe("kit");
      const card = page.getByTestId("kit-seat-card");
      await expect(card.getByRole("heading", { name: "Log in to RSVP" })).toBeVisible();
      await expect(card.getByRole("link", { name: "Log in with Discord" })).toHaveAttribute(
        "href",
        `/join/discord?next=${encodeURIComponent(eventPath)}`,
      );
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        viewport.width,
      );
      const bar = page.getByRole("complementary", { name: "Your seat" });
      await expect(bar).toHaveCount(viewport.width === 390 ? 1 : 0);
      if (viewport.width === 390) {
        await expect(bar.getByRole("link", { name: "Log in with Discord" })).toHaveAttribute(
          "href",
          `/join/discord?next=${encodeURIComponent(eventPath)}`,
        );
        await expect(bar.getByRole("link", { name: "Add to calendar" })).toBeVisible();
      }
      const screenshot = test.info().outputPath(`kit-review-seat-card-guest-${viewport.width}.png`);
      if (viewport.width === 390) await card.scrollIntoViewIfNeeded();
      await page.screenshot({ path: screenshot, animations: "disabled", caret: "hide" });
      await test.info().attach(`kit-review-seat-card-guest-${viewport.width}`, {
        path: screenshot,
        contentType: "image/png",
      });
      if (viewport.width === 1280) {
        const rail = card.locator("..");
        await expect(rail).toHaveCSS("position", "sticky");
        const bounds = await rail.boundingBox();
        expect(bounds).not.toBeNull();
        expect(bounds!.height).toBeLessThanOrEqual(viewport.height - 92);
      }
    } finally {
      await context.close();
    }
  }
});

test("Kit member seat card captures open, saved and full states", async ({ browser }) => {
  const target = targets.find((item) => item.name === "kit")!;
  const key = "01J00000000000000000000991";
  const openKey = "01J00000000000000000000992";
  const savedUserId = "900000000000000846";
  const fullUserId = "900000000000000845";
  const openUserId = "900000000000000847";
  const states = [
    { name: "saved", userId: savedUserId, bearer: `two_${randomBytes(32).toString("base64url")}` },
    { name: "full", userId: fullUserId, bearer: `two_${randomBytes(32).toString("base64url")}` },
    { name: "open", userId: openUserId, bearer: `two_${randomBytes(32).toString("base64url")}` },
  ];
  const context = await browser.newContext({ baseURL: target.origin, javaScriptEnabled: false });
  const enhanced = await browser.newContext({
    baseURL: target.origin,
    viewport: { width: 390, height: 844 },
  });
  try {
    await withSessionDb(async (sql) => {
      for (const state of states) {
        const hash = createHash("sha256").update(state.bearer).digest("hex");
        await sql`insert into web_sessions (token_hash, status_hash, user_id, username, member, moderator, expires_at)
          values (${hash}, ${hash}, ${state.userId}, 'Seat fixture', true, false, ${new Date(Date.now() + 7_200_000)})`;
      }
      await sql`insert into users (id, username, member)
        values (${savedUserId}, 'Seat fixture', true), (${openUserId}, 'Seat fixture', true)`;
      await sql`insert into events (event_key, title, description, game, organizer_name, starts_at, ends_at, location, status, capacity, rsvp_open)
        values (${key}, 'Community game night', 'Bring a favourite game and meet the community.',
          'Catan', 'Vexa', '2099-03-01T18:00:00Z', '2099-03-01T20:00:00Z', 'Community voice', 'published', 1, true),
          (${openKey}, 'Community game night', 'Bring a favourite game and meet the community.',
          'Catan', 'Vexa', '2099-03-01T18:00:00Z', '2099-03-01T20:00:00Z', 'Community voice', 'published', 2, true)`;
      await sql`insert into rsvps (event_id, user_id, status)
        select id, ${savedUserId}, 'going' from events where event_key = ${key}`;
    });
    // Facts list (C6): Host then Game, one organizer hook, no member data,
    // for a guest and for each member state, at both widths. The facts
    // full page is captured for the review artifact.
    const expectFacts = async (page: Page, who: string, width: number) => {
      const facts = page.getByTestId("kit-event-facts");
      await expect(facts).toHaveCount(1);
      await expect(facts.locator("dt")).toHaveText(["Host", "Game"]);
      await expect(facts.locator("dd")).toHaveText(["Vexa", "Catan"]);
      await expect(page.getByTestId("event-organizer")).toHaveCount(1);
      await expect(facts.getByTestId("event-organizer")).toHaveText("Vexa");
      await expect(facts.locator("a")).toHaveCount(0);
      const cardBounds = await page.getByTestId("kit-seat-card").boundingBox();
      const factsBounds = await facts.boundingBox();
      const shareHeadingBounds = await page.locator(".event-share h2").boundingBox();
      expect(cardBounds).not.toBeNull();
      expect(factsBounds).not.toBeNull();
      expect(shareHeadingBounds).not.toBeNull();
      expect(factsBounds!.y - (cardBounds!.y + cardBounds!.height)).toBeCloseTo(16, 0);
      if (width === 390) {
        expect(
          shareHeadingBounds!.y - (factsBounds!.y + factsBounds!.height),
        ).toBeGreaterThanOrEqual(24);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        width,
      );
      const name = `kit-review-facts-${who}-${width}`;
      const path = test.info().outputPath(`${name}.png`);
      if (width === 1280) {
        const rail = facts.locator("..");
        const bounds = await rail.boundingBox();
        expect(bounds).not.toBeNull();
        expect(bounds!.height).toBeLessThanOrEqual(800 - 92);
      }
      await page.screenshot({ path, fullPage: true, animations: "disabled", caret: "hide" });
      await test.info().attach(name, { path, contentType: "image/png" });
    };
    const guestContext = await browser.newContext({
      baseURL: target.origin,
      javaScriptEnabled: false,
    });
    try {
      const guestPage = await guestContext.newPage();
      for (const viewport of [
        { width: 1280, height: 800 },
        { width: 390, height: 844 },
      ]) {
        await guestPage.setViewportSize(viewport);
        const response = await guestPage.goto(`/e/${key}`);
        expect(response?.status()).toBe(200);
        expect(response?.headers()["x-two-renderer"]).toBe("kit");
        await expectFacts(guestPage, "guest", viewport.width);
        // A full event keeps the guest card's login link but does not surface B4.
        await expect(guestPage.locator('aside[aria-label="Your seat"]')).toHaveCount(0);
        // Guest privacy: no roster, no member links, no sign-out chrome.
        await expect(guestPage.getByTestId("event-attendees")).toHaveCount(0);
        await expect(guestPage.locator('a[href^="/members/"]')).toHaveCount(0);
        await expect(guestPage.getByText("Sign out")).toHaveCount(0);
      }
    } finally {
      await guestContext.close();
    }
    const page = await context.newPage();
    for (const state of states) {
      const signature = createHmac("sha256", kitFixtureSessionSecret())
        .update(state.bearer)
        .digest("base64");
      await context.addCookies([
        {
          name: "__Host-two_session",
          value: `${state.bearer}.${signature}`,
          domain: new URL(target.origin).hostname,
          path: "/",
          secure: true,
          httpOnly: true,
          sameSite: "Lax",
        },
      ]);
      for (const viewport of [
        { width: 1280, height: 800 },
        { width: 390, height: 844 },
      ]) {
        await page.setViewportSize(viewport);
        const response = await page.goto(`/e/${state.name === "open" ? openKey : key}`);
        expect(response?.status()).toBe(200);
        expect(response?.headers()["x-two-renderer"]).toBe("kit");
        const card = page.getByTestId("kit-seat-card");
        const bar = page.getByRole("complementary", { name: "Your seat" });
        if (state.name === "open") {
          await expect(card.getByRole("heading", { name: "0 of 2 in" })).toBeVisible();
          await expect(card.getByText("Sign-ups open")).toBeVisible();
          await expect(card.getByRole("button", { name: "I'm in" })).toBeVisible();
          await expect(card.getByRole("link", { name: "Add to calendar" })).toHaveAttribute(
            "href",
            `/events/${openKey}.ics`,
          );
          await expect(page.getByTestId("event-going-count")).toBeHidden();
          await expect(page.getByTestId("event-spots-left")).toBeHidden();
          if (viewport.width === 390) {
            const time = page.locator(".event-layout-head > dl:last-child");
            await expect(time.locator("time[datetime]").first()).toHaveAttribute(
              "datetime",
              "2099-03-01T18:00:00.000Z",
            );
            await expect(time.locator("xpath=../following-sibling::*[1]/*[1]")).toHaveAttribute(
              "data-testid",
              "kit-seat-card",
            );
            await expect(bar).toHaveCount(1);
            await expect(bar).toHaveCSS("position", "fixed");
            await expect(bar).toContainText("0 of 2 in");
            await expect(bar).toContainText("Sign-ups open");
            await expect(bar.getByRole("link", { name: "Add to calendar" })).toHaveAttribute(
              "href",
              `/events/${openKey}.ics`,
            );
            await expect(bar.getByRole("button", { name: "I'm in" })).toBeVisible();
            await card.scrollIntoViewIfNeeded();
          } else {
            await expect(bar).toHaveCount(0);
            await expect(card.locator("..")).toHaveCSS("position", "sticky");
          }
          const name = `kit-review-seat-card-open-${viewport.width}`;
          const path = test.info().outputPath(`${name}.png`);
          await page.screenshot({ path, animations: "disabled", caret: "hide" });
          await test.info().attach(name, { path, contentType: "image/png" });
          continue;
        }
        await expect(card.getByRole("heading", { name: "Your RSVP" })).toBeVisible();
        await expect(
          card.getByRole("button", {
            name: state.name === "saved" ? /can't make it/i : /join the waitlist/i,
          }),
        ).toBeVisible();
        await expect(bar).toHaveCount(viewport.width === 390 && state.name === "saved" ? 1 : 0);
        if (viewport.width === 390 && state.name === "saved") {
          await expect(bar).toContainText("You're in");
          await expect(bar).toContainText(/Starts at \d{2}:\d{2}/);
          await expect(bar.getByRole("link", { name: "Add to calendar" })).toHaveAttribute(
            "href",
            `/events/${key}.ics`,
          );
          await expect(bar.getByRole("button")).toHaveCount(0);
        }
        const name = `kit-review-seat-card-${state.name}-${viewport.width}`;
        const path = test.info().outputPath(`${name}.png`);
        if (viewport.width === 390) await card.scrollIntoViewIfNeeded();
        await page.screenshot({ path, animations: "disabled", caret: "hide" });
        await test.info().attach(name, { path, contentType: "image/png" });
        await expectFacts(page, state.name, viewport.width);
      }
    }
    const bar = page.getByRole("complementary", { name: "Your seat" });
    await page.setViewportSize({ width: 820, height: 844 });
    await expect(bar).toHaveCount(1);
    await page.setViewportSize({ width: 821, height: 844 });
    await expect(bar).toHaveCount(0);
    await page.setViewportSize({ width: 390, height: 844 });
    const footer = page.getByRole("contentinfo");
    const lastLink = footer.getByRole("link", { name: "Privacy" });
    await footer.getByRole("link", { name: "House rules" }).focus();
    await page.keyboard.press("Tab");
    await expect(lastLink).toBeFocused();
    const expectPrivacyClear = async () => {
      const lastBounds = (await lastLink.boundingBox())!;
      const barBounds = (await bar.boundingBox())!;
      expect(lastBounds.y).toBeGreaterThanOrEqual(0);
      expect(lastBounds.y + lastBounds.height).toBeLessThanOrEqual(barBounds.y);
    };
    await expectPrivacyClear();
    await lastLink.evaluate((link) => link.scrollIntoView({ block: "end" }));
    await expectPrivacyClear();

    // Drive the shipped island in place before exercising the native form.
    await enhanced.addCookies(await context.cookies());
    const enhancedPage = await enhanced.newPage();
    await withSessionDb(async (sql) => {
      // No users row: this RSVP holds a seat but is not listed in the lineup.
      await sql`insert into rsvps (event_id, user_id, status)
        select id, '900000000000000848', 'going' from events where event_key = ${openKey}`;
    });
    await enhancedPage.goto(`/e/${openKey}`);
    const enhancedCard = enhancedPage.getByTestId("kit-seat-card");
    const enhancedBar = enhancedPage.getByRole("complementary", { name: "Your seat" });
    const lineup = enhancedPage.getByTestId("event-going-count");
    const spots = enhancedPage.getByTestId("event-spots-left");
    const initialSeat = enhancedCard.getByText("1 of 2 in", { exact: true });
    const going = lineup.locator("[data-count]");
    await expect(initialSeat).toBeVisible();
    await expect(enhancedBar).toContainText("1 of 2 in");
    await expect(lineup).toBeHidden();
    await enhancedCard.getByRole("button", { name: "I'm in" }).click();
    await expect(enhancedCard.getByTestId("rsvp-confirmed")).toBeVisible();
    await expect(lineup).toBeVisible();
    await expect(going).toHaveText("1 of 2 going");
    await expect(initialSeat).toBeHidden();
    await expect(enhancedCard.getByRole("heading", { name: "Your RSVP" })).toBeVisible();
    await expect(spots).toBeVisible();
    await expect(spots).toHaveText("Full");

    // Keep the same Kit mount across a finite → unlimited → finite edit.
    await withSessionDb(async (sql) => {
      await sql`update events set capacity = null where event_key = ${openKey}`;
    });
    await enhancedCard.getByTestId("rsvp-withdraw").click();
    await expect(going).toHaveText("0 going");
    await expect(spots).toBeHidden();
    await withSessionDb(async (sql) => {
      await sql`update events set capacity = 3 where event_key = ${openKey}`;
    });
    await enhancedCard.getByRole("button", { name: "I'm in" }).click();
    await expect(going).toHaveText("1 of 3 going");
    await expect(spots).toBeVisible();
    await expect(spots).toHaveText("1 of 3 spots left");
    await enhancedCard.getByTestId("rsvp-withdraw").click();
    await expect(going).toHaveText("0 of 3 going");

    // Start the failed-first-read journey from a fresh snapshot.
    await withSessionDb(async (sql) => {
      await sql`update events set capacity = 2 where event_key = ${openKey}`;
    });
    await enhancedPage.goto(`/e/${openKey}`);
    await expect(initialSeat).toBeVisible();
    await expect(lineup).toBeHidden();
    // Fail the first count read only; RSVP and the manual retry hit the real fixture.
    await enhancedPage.route(
      `${target.origin}/events.json?event_key=${openKey}`,
      (route) => route.fulfill({ status: 503 }),
      { times: 1 },
    );
    await enhancedCard.getByRole("button", { name: "I'm in" }).click();
    await expect(enhancedCard.getByTestId("rsvp-confirmed")).toBeVisible();
    await expect(enhancedCard.getByRole("heading", { name: "Your RSVP" })).toBeVisible();
    const stale = lineup.getByTestId("event-going-count-stale");
    await expect(stale).toBeVisible();
    await expect(stale).toContainText(
      "Going count could not refresh. Showing the last saved count.",
    );
    const retry = stale.getByRole("button", { name: "Try again" });
    await expect(retry).toBeVisible();
    await retry.click();
    await expect(stale).toHaveCount(0);
    await expect(lineup.locator("[data-count]")).toHaveText("1 of 2 going");
    await expect(spots).toBeVisible();
    await expect(spots).toHaveText("Full");
    await expect(enhancedBar).toHaveCount(0);

    await withSessionDb(async (sql) => {
      await sql`update events set capacity = 3 where event_key = ${openKey}`;
    });
    await enhancedCard.getByTestId("rsvp-withdraw").click();
    await expect(enhancedCard.getByTestId("rsvp-going")).toBeEnabled();
    await expect(lineup.locator("[data-count]")).toHaveText("0 of 3 going");
    await expect(spots).toHaveText("2 of 3 spots left");
    await expect(enhancedCard.getByRole("heading", { name: "Your RSVP" })).toBeVisible();
    await expect(enhancedCard.getByRole("heading", { name: "1 of 2 in" })).toHaveCount(0);
    await expect(enhancedBar).toHaveCount(0);

    // The enhanced navigations rotated the shared fixture session.
    await context.addCookies(await enhanced.cookies());
    const post = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname === `/e/${openKey}/rsvp`,
    );
    await bar.getByRole("button", { name: "I'm in" }).click();
    const submitted = await post;
    expect(submitted.request().postData()).toBe("status=going");
    expect(submitted.status()).toBe(303);
    expect(submitted.headers().location).toBe(`/e/${openKey}`);
    expect(submitted.headers()["x-two-renderer"]).toBeUndefined();
    await expect(page.getByTestId("kit-seat-card").getByTestId("rsvp-confirmed")).toBeVisible();
    await expect(bar).toContainText("You're in");
    await expect(bar.getByRole("button")).toHaveCount(0);

    // Reload from the real saved row, using the session returned by the native flow.
    await enhanced.addCookies(await context.cookies());
    await enhancedPage.reload();
    await expect(enhancedBar).toContainText("You're in");
    await enhancedPage.route(`**/events/${openKey}/rsvp`, (route) => route.abort("failed"));
    await enhancedCard.getByTestId("rsvp-withdraw").click();
    await expect(enhancedCard.getByTestId("rsvp-unknown")).toHaveAttribute("role", "alert");
    await expect(enhancedBar).toHaveCount(0);

    // Probe absence against actual server snapshots, without redoing the sibling renderer captures.
    await context.addCookies(await enhanced.cookies());
    for (const state of ["live", "ended", "cancelled"]) {
      await withSessionDb(async (sql) => {
        const endsAt = new Date(Date.now() + (state === "live" ? 3_600_000 : -3_600_000));
        await sql`update events set starts_at = now() - interval '2 hours', ends_at = ${endsAt},
          status = ${state === "cancelled" ? "cancelled" : "published"} where event_key = ${openKey}`;
      });
      const response = await page.goto(`/e/${openKey}`);
      expect(response?.status()).toBe(state === "cancelled" ? 410 : 200);
      expect(response?.headers()["x-two-renderer"]).toBe("kit");
      await expect(page.locator('aside[aria-label="Your seat"]')).toHaveCount(0);
    }
  } finally {
    await Promise.all([context.close(), enhanced.close()]);
    await withSessionDb(async (sql) => {
      await sql`delete from events where event_key in (${key}, ${openKey})`;
      for (const state of states) {
        await sql`delete from web_session_grace where user_id = ${state.userId}`;
        await sql`delete from web_sessions where user_id = ${state.userId}`;
      }
      await sql`delete from users where id in (${savedUserId}, ${openUserId})`;
    });
  }
});

function archiveSectionForComparison(section: string, kitOwnsArchive: boolean): string {
  if (kitOwnsArchive) assertEmberArchive(section);
  return normalizeSection(kitOwnsArchive ? stripEmberDelta(section) : section);
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
  const kitSection = bodies
    .get("kit")!
    .match(/<section[^>]*data-testid="past-events"[\s\S]*?<\/section>/)?.[0];
  expect(kitSection, "Kit archive section exists").toBeDefined();
  const kitOwnsArchive = expectedKitMarker("/events/past") === "kit";
  if (kitOwnsArchive) {
    const fallback = stripEmberDelta(kitSection!);
    expect(archiveSectionForComparison(kitSection!, true)).toBe(
      archiveSectionForComparison(fallback, false),
    );
    expect(archiveSectionForComparison(kitSection!, false)).not.toBe(
      archiveSectionForComparison(fallback, false),
    );
    expect(fallback).toContain("E2E Past Night");
    expect(archiveSectionForComparison(kitSection!, true)).not.toBe(
      archiveSectionForComparison(fallback.replace("E2E Past Night", "Different event"), false),
    );
    expect(() =>
      archiveSectionForComparison(kitSection!.replace("Sign-up record", "Changed"), true),
    ).toThrow();
  }
  expect(
    archiveSectionForComparison(kitSection!, kitOwnsArchive),
    "Archive section matches Hono under the configured ownership",
  ).toBe(sectionOf(bodies.get("hono")!, "past-events"));
});

test("Kit Events groups schedule dates but plots the grid on host-local dates", async ({
  page,
}) => {
  const key = "01J00000000000000000000EM8E";
  await withSessionDb(async (sql) => {
    await sql`insert into events (event_key, title, starts_at, ends_at, timezone, status)
      values (${key}, 'E2E May LA', '2099-05-15T01:00:00Z', '2099-05-15T02:00:00Z',
        'America/Los_Angeles', 'published')`;
  });
  try {
    await page.setViewportSize({ width: 744, height: 844 });
    await page.context().addCookies([{ name: "e2e-parity-bypass", value: "1", url: KIT_ORIGIN }]);
    await page.goto(`${KIT_ORIGIN}/events`);
    const group = page.getByTestId("events-list").getByRole("list", { name: /15 May/ });
    await expect(group.getByRole("listitem")).toHaveCount(2);
    const row = group.getByTestId("event-card").first();
    await expect(row.getByRole("heading", { level: 4 })).toHaveText("E2E May LA");
    await expect(row.locator(".schedule-actions")).toHaveCSS("grid-column", "3");
    await page.goto(`${KIT_ORIGIN}/events?view=calendar&month=2099-05&past=1`);
    await expect(page.locator(".schedule-clock")).toContainText(/local dates.*UTC/);
    await expect(page.locator('[data-date="2099-05-14"]')).toContainText("E2E May LA");
    await expect(page.locator('[data-date="2099-05-15"]')).not.toContainText("E2E May LA");
  } finally {
    await withSessionDb(async (sql) => {
      await sql`delete from events where event_key = ${key}`;
    });
  }
});

test("Kit calendar styles survive a swap into the old document", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  // Serve the old Hono shell without the new aliases; the island fetches from Kit.
  const old = await page.request.get(`${HONO_ORIGIN}/events`, { maxRedirects: 0 });
  expect(old.status()).toBe(200);
  await page.route(`${KIT_ORIGIN}/events`, (route) => route.fulfill({ response: old }), {
    times: 1,
  });
  await page.route(`${KIT_ORIGIN}/theme-tokens.css`, (route) =>
    route.fulfill({ contentType: "text/css", body: "" }),
  );
  await page.goto(`${KIT_ORIGIN}/events`);
  await expect(page.locator(".schedule-views")).toBeVisible();
  await expect(page.locator('link[href="/kit-events-controls.css"]')).toHaveCount(0);
  const html = page.locator("html");
  await html.evaluate((element) => element.setAttribute("data-rollout-shell", "old"));
  await page.getByTestId("events-view-calendar").click();
  const selected = page.locator("nav.segments").getByTestId("events-view-calendar");
  await expect(selected).toHaveAttribute("aria-current", "page");
  await expect(selected).toHaveCSS("gap", "8px");
  await expect(selected).toHaveCSS("background-color", "rgb(46, 36, 32)");
  await page.getByTestId("events-view-list").click();
  const row = page.getByTestId("event-card").first();
  await expect(row.locator(".schedule-when")).toBeVisible();
  await expect(row).toHaveCSS("grid-template-columns", /^\d+(?:\.\d+)?px$/);
  await row.getByTestId("signin").focus();
  await expect(row.getByTestId("signin")).toBeFocused();
  await expect(html).toHaveAttribute("data-rollout-shell", "old");
});

test("cross-target: normalized events-calendar sections match", async ({ playwright, page }) => {
  // Normalize serializer noise and the Kit wrapper, not the tabs' links or selection.
  const calendarSection = async (html: string) =>
    normalizeSection(
      await page.evaluate((html) => {
        const document = new DOMParser().parseFromString(html, "text/html");
        const section = document.querySelector('section[data-testid="events-calendar"]');
        if (!section) throw new Error("Missing calendar section");
        const segments = section.querySelector('nav.segments[aria-label="How to show the events"]');
        if (segments) {
          section.querySelector('link[rel=stylesheet][href="/kit-events-controls.css"]')?.remove();
          const group = document.createElement("div");
          group.className = "schedule-views";
          group.setAttribute("role", "group");
          group.setAttribute("aria-label", "How to show the events");
          while (segments.firstChild) group.appendChild(segments.firstChild);
          segments.replaceWith(group);
        }
        for (const element of [section, ...section.querySelectorAll("*")]) {
          const attrs = [...element.attributes].sort((a, b) => a.name.localeCompare(b.name));
          for (const { name, value } of attrs) {
            element.removeAttribute(name);
            element.setAttribute(name, value);
          }
        }
        const comments = document.createTreeWalker(section, NodeFilter.SHOW_COMMENT);
        const markers: Node[] = [];
        while (comments.nextNode()) markers.push(comments.currentNode);
        for (const marker of markers) marker.parentNode?.removeChild(marker);
        return section.outerHTML;
      }, html),
    );
  const bodies = new Map<string, string>();
  for (const target of targets) {
    // A fresh jar prevents authentication by the shared QA-login cookie.
    // An unsigned, non-session cookie bypasses each worker's independent
    // anonymous cache: the member-board RSVP write may have made only one
    // cached going count stale. Compare equally fresh GUEST sections.
    const guest = await playwright.request.newContext({
      baseURL: target.origin,
      ignoreHTTPSErrors: target.ignoreHTTPSErrors,
    });
    try {
      const response = await guest.get("/events", {
        headers: { cookie: "e2e-parity-bypass=1" },
      });
      expect(response.status()).toBe(200);
      const body = await response.text();
      expect(body).toContain("Welcome, guest");
      expect(body).not.toContain("Sign out");
      expect(response.headers()["set-cookie"] ?? null).toBeNull();
      bodies.set(target.name, normalizeOrigin(body, target.origin));
    } finally {
      await guest.dispose();
    }
  }
  // Non-vacuous equality: the compared sections carry the seeded row, so
  // two empty lists cannot pass for parity.
  const hono = await calendarSection(bodies.get("hono")!);
  const kit = await calendarSection(bodies.get("kit")!);
  expect(hono, "Hono events-calendar section carries the seeded row").toContain(
    "E2E Community Night",
  );
  expect(kit, "Kit matches the Hono calendar contract after normalization").toBe(hono);
});

test("cross-target: normalized member-board tables match", async () => {
  await memberGoingRsvp();
  const tables = new Map<string, string>();
  for (const target of targets) {
    const response = await api(target).get("/leaderboards/members", {
      headers: { cookie: await memberCookie(target) },
    });
    expect(response.status()).toBe(200);
    tables.set(target.name, memberBoardTable(await response.text()));
  }
  // Non-vacuous equality: the compared tables carry the ranked row, so
  // two empty boards cannot pass for parity.
  expect(tables.get("hono"), "Hono table carries the ranked row").toContain(RANKED_ROW);
  expect(tables.get("kit"), "Kit table matches Hono table after normalization").toBe(
    tables.get("hono"),
  );
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

// Kit archive visuals: populated + out-of-range states x 2 widths into
// e2e/visual/__screenshots-kit__/ (snapshotPathTemplate in
// playwright.kit-parity.config.ts). Guest only, no login: the archive is
// public, so the qa-login throttle is untouched, and the run stays read-only
// on the deterministic seeded past row (e2e/seed.mjs "E2E Past Night",
// totalPages 1 — no new fixture route). Mask <time> like the Hono visual
// spec, fullPage, soft per width so one diff never hides the other image for
// ci/kit-visual-accept.mjs.
const ARCHIVE_VIEWS: Array<{ name: string; path: string; testid: string }> = [
  { name: "populated", path: "/events/past", testid: "past-events" },
  {
    name: "out-of-range",
    path: "/events/past?page=2",
    testid: "past-events-out-of-range",
  },
];

test.describe("kit: archive visuals", () => {
  for (const view of ARCHIVE_VIEWS) {
    test(`${view.name} @ desktop and mobile`, async ({ browser }) => {
      const kit = targets.find((target) => target.name === "kit")!;
      const context = await browser.newContext({
        baseURL: kit.origin,
        ignoreHTTPSErrors: kit.ignoreHTTPSErrors,
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
        for (const viewport of PARITY_VIEWPORTS) {
          await page.setViewportSize(viewport.size);
          const response = await page.goto(view.path);
          expect(response?.status(), `kit ${view.path} @ ${viewport.name}`).toBe(200);
          await expect(page.getByTestId(view.testid)).toBeVisible();
          await page.waitForLoadState("networkidle");
          const kitOwnsArchive = expectedKitMarker(view.path) === "kit";
          if (view.name === "populated" && kitOwnsArchive) {
            const card = page.getByTestId("event-card").first();
            await expect.soft(card.locator(".event-title")).toHaveCSS("display", "flex");
            const state = card.getByText("Sign-up record");
            await expect.soft(state).toBeVisible();
            await expect.soft(state).toHaveCSS("border-top-style", "solid");
            await expect.soft(state).toHaveCSS("font-size", "12px");
            await expect.soft(state).toHaveCSS("text-transform", "uppercase");
            await expect.soft(state).toHaveCSS("padding", "5px 7px");
            await expect.soft(state).toHaveCSS("white-space", "nowrap");
            const glyph = card.locator(".state-glyph");
            if (viewport.name === "desktop") {
              await expect.soft(glyph).toBeVisible();
              await expect.soft(glyph).toHaveCSS("width", "16px");
              await expect.soft(glyph).toHaveCSS("height", "16px");
            } else {
              await expect.soft(glyph).toBeHidden();
            }
          } else if (view.name === "populated") {
            const card = page.getByTestId("event-card").first();
            await expect.soft(card.getByRole("link", { name: "E2E Past Night" })).toBeVisible();
            await expect.soft(card.locator(".state-glyph, .event-title")).toHaveCount(0);
            await expect.soft(card.getByText("Sign-up record")).toHaveCount(0);
          }
          await expect
            .soft(page)
            .toHaveScreenshot(
              `kit-archive-${view.name}${view.name === "populated" && !kitOwnsArchive ? "-hono" : ""}-${viewport.name}.png`,
              {
                fullPage: true,
                mask: [page.locator("time")],
              },
            );
          if (view.name === "populated") {
            const name = `kit-review-archive-default-${viewport.name}`;
            const path = test.info().outputPath(`${name}.png`);
            await page.screenshot({ path, fullPage: true, mask: [page.locator("time")] });
            await test.info().attach(name, { path, contentType: "image/png" });
          }
        }
        expect(pageErrors, "no uncaught page errors").toEqual([]);
      } finally {
        await context.close();
      }
    });
  }
});

test("hono: populated archive fallback baseline @ desktop and mobile", async ({ browser }) => {
  const hono = targets.find((target) => target.name === "hono")!;
  const context = await browser.newContext({
    baseURL: hono.origin,
    ignoreHTTPSErrors: hono.ignoreHTTPSErrors,
  });
  try {
    await context.route("**/*", (route) => {
      const origin = new URL(route.request().url()).origin;
      return origin === hono.origin || origin === KIT_ORIGIN
        ? route.continue()
        : route.abort("blockedbyclient");
    });
    const page = await context.newPage();
    for (const viewport of PARITY_VIEWPORTS) {
      await page.setViewportSize(viewport.size);
      const response = await page.goto("/events/past");
      expect(response?.status()).toBe(200);
      await expect(page.getByTestId("past-events")).toBeVisible();
      await page.waitForLoadState("networkidle");
      await expect.soft(page).toHaveScreenshot(`kit-archive-populated-hono-${viewport.name}.png`, {
        fullPage: true,
        mask: [page.locator("time")],
      });
      const name = `kit-review-hono-archive-fallback-${viewport.name}`;
      const path = test.info().outputPath(`${name}.png`);
      await page.screenshot({ path, fullPage: true, mask: [page.locator("time")] });
      await test.info().attach(name, { path, contentType: "image/png" });
    }
  } finally {
    await context.close();
  }
});

test("kit: archive search and keyboard focus evidence", async ({ browser }) => {
  const context = await browser.newContext({ baseURL: KIT_ORIGIN, ignoreHTTPSErrors: true });
  try {
    await context.route("**/*", (route) => {
      const origin = new URL(route.request().url()).origin;
      return origin === "https://localhost:8787" || origin === KIT_ORIGIN
        ? route.continue()
        : route.abort("blockedbyclient");
    });
    const page = await context.newPage();
    for (const viewport of PARITY_VIEWPORTS) {
      await page.setViewportSize(viewport.size);
      const response = await page.goto("/events/past?q=Past");
      expect(response?.status()).toBe(200);
      const card = page.getByTestId("event-card").first();
      const title = card.getByRole("link", { name: "E2E Past Night" });
      await expect(title.locator("mark")).toHaveText("Past");
      await page.waitForLoadState("networkidle");
      const save = async (state: string) => {
        const name = `kit-review-archive-${state}-${viewport.name}`;
        const path = test.info().outputPath(`${name}.png`);
        await page.screenshot({ path, fullPage: true, mask: [page.locator("time")] });
        await test.info().attach(name, { path, contentType: "image/png" });
      };
      await save("search");
      for (
        let i = 0;
        i < 30 && !(await title.evaluate((el) => el === document.activeElement));
        i++
      ) {
        await page.keyboard.press("Tab");
      }
      await expect(title).toBeFocused();
      await save("focus");
    }
  } finally {
    await context.close();
  }
});

test("Kit member event detail captures the ended record at both widths", async ({ browser }) => {
  expect(kitFixtureOwnsEventDetail(), "Kit fixture owns the event detail").toBe(true);
  const target = targets.find((item) => item.name === "kit")!;
  const adjacentKey = "01J00000000000000000000993";
  const endedKey = "01J00000000000000000000994";
  const nextKey = "01J00000000000000000000995";
  const laterKey = "01J00000000000000000000996";
  const historicalKey = "01J00000000000000000000997";
  const unreadableKey = "01J00000000000000000000998";
  const userId = "900000000000000848";
  const bearer = `two_${randomBytes(32).toString("base64url")}`;
  const hash = createHash("sha256").update(bearer).digest("hex");
  const signature = createHmac("sha256", kitFixtureSessionSecret()).update(bearer).digest("base64");
  const now = Date.now();
  const context = await browser.newContext({ baseURL: target.origin, javaScriptEnabled: false });
  const enhanced = await browser.newPage({ baseURL: target.origin });
  try {
    await withSessionDb(async (sql) => {
      await sql`insert into users (id, username, member) values (${userId}, 'Seat fixture', true)`;
      await sql`insert into web_sessions (token_hash, status_hash, user_id, username, member, moderator, expires_at)
        values (${hash}, ${hash}, ${userId}, 'Seat fixture', true, false, ${new Date(now + 7_200_000)})`;
      for (const event of [
        { key: adjacentKey, start: now - 3_600_000, end: now + 3_600_000 },
        { key: endedKey, start: Date.UTC(2026, 0, 2, 4), end: Date.UTC(2026, 0, 2, 6) },
      ]) {
        await sql`insert into events (event_key, title, description, starts_at, ends_at, timezone, location, status, rsvp_open)
          values (${event.key}, 'Community game night', 'Bring a favourite game and meet the community.',
            ${new Date(event.start)}, ${new Date(event.end)}, 'America/New_York', 'Community voice', 'published', true)`;
      }
      await sql`update events set recurrence_frequency = 'weekly', recurrence_count = 6, recurrence_index = 1
        where event_key = ${endedKey}`;
      await sql`update events set parent_event_id = (select id from events where event_key = ${endedKey}),
        recurrence_index = 6 where event_key = ${adjacentKey}`;
      for (const sibling of [
        { key: laterKey, days: 14, status: "published", index: 3 },
        { key: nextKey, days: 7, status: "published", index: 4 },
        { key: historicalKey, days: 1, status: "past", index: 5 },
      ]) {
        const startsAt = now + sibling.days * 86_400_000;
        await sql`insert into events (event_key, title, starts_at, ends_at, status, parent_event_id, recurrence_index)
          select ${sibling.key}, title, ${new Date(startsAt)}, ${new Date(startsAt + 7_200_000)},
            ${sibling.status}, id, ${sibling.index} from events where event_key = ${endedKey}`;
      }
      await sql`insert into events (event_key, title, starts_at, ends_at, status, parent_event_id, recurrence_index)
        select ${unreadableKey}, title, ${new Date(Date.UTC(2026, 0, 2, 3, 59))}, 'infinity'::timestamptz,
          'published', id, 2 from events where event_key = ${endedKey}`;
      await sql`insert into rsvps (event_id, user_id, status)
        select id, ${userId}, 'going' from events where event_key = ${endedKey}`;
    });
    await context.addCookies([
      {
        name: "__Host-two_session",
        value: `${bearer}.${signature}`,
        domain: new URL(target.origin).hostname,
        path: "/",
        secure: true,
        httpOnly: true,
        sameSite: "Lax",
      },
    ]);
    const page = await context.newPage();
    const record = page.getByRole("region", { name: "Sign-up record" });
    const nextDates = page.getByRole("link", { name: /^Next one:/, includeHidden: true });
    const siblingPagerLink = page.locator(`[data-testid="event-next"][href="/e/${adjacentKey}"]`);
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 800 });
      const response = await page.goto(`/e/${endedKey}`);
      expect(response?.status()).toBe(200);
      expect(response?.headers()["x-two-renderer"]).toBe("kit");
      const time = page.getByTestId("kit-event-time");
      const menu = await compactMenu(page);
      await menu?.click();
      await expect(headerSignOut(page)).toBeVisible();
      await closeCompactMenu(page, menu);
      await expect(page.getByRole("complementary", { name: "Your seat", exact: true })).toHaveCount(
        0,
      );
      await expect(page.getByTestId("event-ongoing")).toHaveCount(0);
      await expect(time.locator('time[datetime="2026-01-02T06:00:00.000Z"]')).toHaveText(
        "2 Jan 2026, 01:00",
      );
      await expect(page.getByTestId("event-series-next")).toHaveCount(0);
      await expect(siblingPagerLink).toHaveCount(0);
      await expect(record).toHaveCount(1);
      await expect(page.getByLabel("Event overview")).not.toContainText("Sign-up record");
      await expect(page.getByRole("heading", { name: "Signed up (1)" })).toBeVisible();
      await expect(page.locator(".event-meta [data-count]")).toHaveText("1 listed sign-up");
      await expect(page.getByRole("heading", { name: "Save the date" })).toHaveCount(0);
      await expect(page.getByRole("link", { name: /to calendar|Google Calendar/ })).toHaveCount(0);
      await expect(page.getByLabel("Event link")).toBeVisible();
      const hidden = page.locator(".event-meta .event-device-timezone, .event-meta > div[hidden]");
      await expect(hidden.and(page.locator(".event-device-timezone"))).toHaveCount(4);
      await expect(hidden).toHaveCount(6);
      for (const control of await hidden.all()) expect(await control.boundingBox()).toBeNull();
      for (const fact of ["Starts", "Ends"]) {
        const label = page.getByText(fact, { exact: true });
        const row = page.locator(".event-meta > div").filter({ has: label });
        expect((await row.boundingBox())?.height).toBeLessThan(160);
      }
      await expect(page.getByTestId("kit-seat-card")).toHaveCount(0);
      await expect(record).toContainText("No Echo for this one. 1 listed sign-up.");
      await expect(nextDates).toHaveCount(1);
      await expect(record.locator(`a[href="/e/${nextKey}"]`).and(nextDates)).toBeVisible();
      await expect(page.locator(`a[href="/e/${nextKey}"]`)).toHaveCount(1);
      await expect(page.locator(`a[href="/e/${unreadableKey}"]`)).toHaveCount(0);
      if (width === 390) {
        await expect(
          page.locator(
            ".event-layout-head:has(> [data-testid=kit-event-time]:last-child) + .event-layout-rail > [aria-labelledby=signup-record-heading]:first-child",
          ),
        ).toHaveCount(1);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        width,
      );
      const name = `kit-review-event-ended-${width}`;
      const path = test.info().outputPath(`${name}.png`);
      await page.screenshot({ path, fullPage: true, animations: "disabled", caret: "hide" });
      await test.info().attach(name, { path, contentType: "image/png" });
    }
    await withSessionDb(async (sql) => {
      await sql`update events set status = 'past' where event_key in (${nextKey}, ${laterKey})`;
      await sql`update events set starts_at = ${new Date(now + 172_800_000)} where event_key = ${unreadableKey}`;
      await sql`update rsvps set user_id = '900000000000000849'
        where user_id = ${userId} and event_id = (select id from events where event_key = ${endedKey})`;
    });
    expect((await page.reload())?.status()).toBe(200);
    await expect(record).toBeVisible();
    await expect(nextDates).toHaveCount(0);
    await expect(page.getByTestId("event-series-next")).toHaveCount(0);
    await expect(siblingPagerLink).toHaveCount(0);
    await expect(page.getByTestId("event-roster-empty")).toContainText("No sign-ups are listed.");
    await expect(page.locator(".event-meta [data-count]")).toHaveText("0 listed sign-ups");
    await expect(record).toContainText("0 listed sign-ups");
    await withSessionDb(async (sql) => {
      await sql`update events set parent_event_id = null, recurrence_index = null where event_key = ${adjacentKey}`;
    });
    expect((await page.reload())?.status()).toBe(200);
    await expect(siblingPagerLink).toBeVisible();
    expect((await enhanced.goto(`/e/${endedKey}`))?.status()).toBe(200);
    await expect(enhanced.getByTestId("event-device-timezone-starts-button")).toBeVisible();
    await enhanced.getByTestId("event-chosen-timezone-input").fill("Asia/Tokyo");
    await enhanced.getByTestId("event-chosen-timezone-button").click();
    await expect(enhanced.getByTestId("event-chosen-timezone-status")).toContainText("GMT+09:00");
  } finally {
    await Promise.all([context.close(), enhanced.close()]);
    await withSessionDb(async (sql) => {
      await sql`delete from events where event_key in (${adjacentKey}, ${endedKey}, ${nextKey}, ${laterKey}, ${historicalKey}, ${unreadableKey})`;
      await sql`delete from web_session_grace where user_id = ${userId}`;
      await sql`delete from web_sessions where user_id = ${userId}`;
      await sql`delete from users where id = ${userId}`;
    });
  }
});

test("Kit saved live snapshot expires without changing the RSVP", async ({ browser }) => {
  test.setTimeout(60_000);
  expect(kitFixtureOwnsEventDetail(), "Kit fixture owns the event detail").toBe(true);
  const target = targets.find((item) => item.name === "kit")!;
  const key = "01J00000000000000000000989";
  const userId = "900000000000000843";
  const bearer = `two_${randomBytes(32).toString("base64url")}`;
  const hash = createHash("sha256").update(bearer).digest("hex");
  const signature = createHmac("sha256", kitFixtureSessionSecret()).update(bearer).digest("base64");
  const now = Date.now();
  const start = new Date(now - 3_600_000);
  const end = new Date(now + 3_600_000);
  const zone = "America/New_York";
  const localDate = new Intl.DateTimeFormat("en-GB", {
    timeZone: zone,
    weekday: "long",
    day: "numeric",
    month: "long",
  }).format(start);
  const endClock = new Intl.DateTimeFormat("en-GB", {
    timeZone: zone,
    timeStyle: "short",
  }).format(end);
  const path = `/e/${key}?attendees=1`;
  const deviceZone = "Asia/Tokyo";
  const plain = await browser.newContext({ baseURL: target.origin, javaScriptEnabled: false });
  const enhanced = await browser.newContext({ baseURL: target.origin, timezoneId: deviceZone });
  async function assertMobileSeatOrder(page: Page) {
    const time = page.locator(".event-layout-head > [data-testid=kit-event-time]:last-child");
    const seat = page.locator(
      ".event-layout-head:has(> [data-testid=kit-event-time]:last-child) + .event-layout-rail > [data-testid=kit-seat-card]:first-child",
    );
    await expect(seat).toBeVisible();
    const [block, card] = await Promise.all([time.boundingBox(), seat.boundingBox()]);
    expect(card!.y).toBeGreaterThanOrEqual(block!.y + block!.height);
  }
  async function assertScheduledTime(page: Page) {
    const time = page.getByTestId("kit-event-time");
    const ends = time.locator("p", { hasText: /^Ends / });
    await expect(time.getByText(localDate, { exact: true })).toBeVisible();
    await expect(ends).toContainText(`${endClock} ${zone}`);
    await expect(ends.locator("time")).toHaveAttribute("datetime", end.toISOString());
    await expect(page.locator(`time[datetime="${end.toISOString()}"]:visible`)).toHaveCount(1);
    return ends;
  }
  async function capture(page: Page, name: string) {
    const size = page.viewportSize()?.width === 390 ? "40px" : "89.6px";
    await expect(page.locator(".live-time .time-block > time")).toHaveCSS("font-size", size);
    const screenshot = test.info().outputPath(`${name}.png`);
    await page.screenshot({ path: screenshot, animations: "disabled", caret: "hide" });
    await test.info().attach(name, { path: screenshot, contentType: "image/png" });
  }
  try {
    await withSessionDb(async (sql) => {
      await sql`insert into users (id, username, member) values (${userId}, 'Seat fixture', true)`;
      await sql`insert into web_sessions (token_hash, status_hash, user_id, username, member, moderator, expires_at)
        values (${hash}, ${hash}, ${userId}, 'Seat fixture', true, false, ${new Date(now + 7_200_000)})`;
      await sql`insert into events (event_key, title, description, starts_at, ends_at, timezone, location, status, rsvp_open)
        values (${key}, 'Community game night', 'Bring a favourite game and meet the community.',
          ${start}, ${end}, ${zone}, 'Community voice', 'published', true)`;
    });
    const noJs = await plain.newPage();
    const guest = await noJs.goto(path);
    expect(guest?.headers()["x-two-renderer"]).toBe("kit");
    expect(guest?.headers()["cache-control"]).toBe("private, no-store");
    await plain.addCookies([
      {
        name: "__Host-two_session",
        value: `${bearer}.${signature}`,
        domain: new URL(target.origin).hostname,
        path: "/",
        secure: true,
        httpOnly: true,
        sameSite: "Lax",
      },
    ]);
    for (const { size: viewport } of PARITY_VIEWPORTS) {
      await noJs.setViewportSize(viewport);
      expect((await noJs.goto(path))?.headers()["x-two-renderer"]).toBe("kit");
      if (viewport.width === 390) await assertMobileSeatOrder(noJs);
      const rsvp = noJs.getByRole("button", { name: "I'm in", exact: true });
      await expect(rsvp).toBeEnabled();
      await expect(noJs.getByTestId("kit-seat-card").locator("form")).toHaveAttribute(
        "action",
        `/e/${key}/rsvp`,
      );
      await rsvp.scrollIntoViewIfNeeded();
      const ends = await assertScheduledTime(noJs);
      await expect(ends).toBeInViewport();
      const ordered = await ends.evaluate((line) => {
        const button = document.querySelector('[data-testid="rsvp-going"]')!;
        const follows = line.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING;
        return (
          Boolean(follows) &&
          line.getBoundingClientRect().bottom <= button.getBoundingClientRect().top
        );
      });
      expect(ordered, "the end precedes the RSVP in DOM and visual order").toBe(true);
      await capture(noJs, `kit-review-event-live-open-${viewport.width}`);
    }
    await withSessionDb(async (sql) => {
      await sql`insert into rsvps (event_id, user_id, status)
        select id, ${userId}, 'going' from events where event_key = ${key}`;
    });
    await noJs.reload();
    await expect(noJs.getByTestId("rsvp-syncing")).toBeVisible();
    await withSessionDb(async (sql) => {
      await sql`update rsvps set synced_to_discord_at = ${new Date(now)} where user_id = ${userId}`;
    });
    for (const { size: viewport } of PARITY_VIEWPORTS) {
      await noJs.setViewportSize(viewport);
      const response = await noJs.reload();
      expect(response?.status()).toBe(200);
      expect(response?.headers()["x-two-renderer"]).toBe("kit");
      expect(response?.headers()["cache-control"]).toBe("private, no-store");
      if (viewport.width === 390) await assertMobileSeatOrder(noJs);
      const time = noJs.getByTestId("kit-event-time").locator('> .time-block[data-state="live"]');
      const seat = noJs.getByTestId("kit-seat-card");
      await expect(noJs.getByTestId("event-ongoing")).toHaveText("Live");
      await expect(time.locator("[data-live-fresh]:visible").last()).toHaveText("as of");
      await assertScheduledTime(noJs);
      await expect(seat.getByRole("heading", { name: "You're in." })).toBeVisible();
      await expect(seat.getByTestId("rsvp-synced")).toHaveText("Synced to Discord.");
      await expect(seat.getByRole("button").or(seat.getByRole("link"))).toHaveCount(0);
      await expect(noJs.getByRole("complementary", { name: /^Your seat$/ })).toHaveCount(0);
      await expect(noJs.getByRole("link", { name: "Refresh the event time" })).toHaveCount(0);
      await capture(noJs, `kit-review-event-live-${viewport.width}`);
    }
    await enhanced.addCookies(await plain.cookies());
    const page = await enhanced.newPage();
    await page.goto(`${path}#snapshot`);
    const live = page.getByTestId("event-ongoing");
    await expect(live).toBeVisible();
    const deadline = Date.parse(
      (await page.locator("#kit-live-snapshot").getAttribute("data-stale-at"))!,
    );
    await page.bringToFront();
    const hidden = await live.evaluate((tag, ms) => {
      // Sample both sides in one browser task so the real timer cannot win the race.
      Date.now = () => ms - 1;
      window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
      const before = tag.hasAttribute("hidden");
      Date.now = () => ms;
      document.dispatchEvent(new Event("visibilitychange"));
      return [before, tag.hasAttribute("hidden")];
    }, deadline);
    expect(hidden).toEqual([false, true]);
    await expect(page.locator("[data-live-fresh]:visible")).toHaveCount(0);
    await expect(
      page.locator("[data-live-stale]:visible").getByText("Stale", { exact: true }),
    ).toHaveCount(3);
    await expect(page.getByRole("link", { name: "Refresh the event time" })).toHaveAttribute(
      "href",
      `${target.origin}${path}`,
    );
    await expect(page.getByTestId("rsvp-synced")).toBeVisible();
    const time = page.getByTestId("kit-event-time");
    await expect(time.getByText("live as of")).toBeVisible();
    const asOf = (await page.locator("#kit-live-snapshot").getAttribute("data-as-of"))!;
    await expect(time.locator(`time[datetime="${asOf}"]`)).toBeVisible();
    for (const { size: viewport } of PARITY_VIEWPORTS) {
      await page.setViewportSize(viewport);
      if (viewport.width === 390) await assertMobileSeatOrder(page);
      await assertScheduledTime(page);
      await expect(time.getByText("Stale", { exact: true })).toBeInViewport();
      await capture(page, `kit-review-event-stale-${viewport.width}`);
    }
    const refreshed = page.waitForResponse(
      (response) =>
        response.url() === `${target.origin}${path}` && response.request().isNavigationRequest(),
    );
    await page.getByRole("link", { name: "Refresh the event time" }).click();
    expect((await refreshed).headers()["cache-control"]).toBe("private, no-store");
    await expect(live).toBeVisible();
    await page.getByTestId("event-device-timezone-ends-button").click();
    const deviceEnd = new Intl.DateTimeFormat("en-GB", {
      timeZone: deviceZone,
      timeStyle: "short",
    }).format(end);
    await expect(page.getByTestId("event-device-timezone-ends-status")).toContainText(
      `${deviceEnd} GMT+09:00 (${deviceZone})`,
    );
    await page.addInitScript(() => {
      Date.now = () => 1;
    });
    await page.reload();
    await expect(live).toBeHidden();
    await expect(page.getByRole("link", { name: "Refresh the event time" })).toBeVisible();
    await expect(page.getByTestId("rsvp-synced")).toBeVisible();
  } finally {
    await Promise.all([plain.close(), enhanced.close()]);
    await withSessionDb(async (sql) => {
      await sql`delete from events where event_key = ${key}`;
      await sql`delete from web_session_grace where user_id = ${userId}`;
      await sql`delete from web_sessions where user_id = ${userId}`;
      await sql`delete from users where id = ${userId}`;
    });
  }
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

test("Kit saved review states at desktop and mobile widths", async ({ browser }) => {
  test.setTimeout(60_000);
  const target = targets.find((item) => item.name === "kit")!;
  expect(kitFixtureOwnsEventDetail(), "Kit fixture owns the event detail").toBe(true);
  const key = "01J00000000000000000000990";
  const userId = "900000000000000844";
  const bearer = `two_${randomBytes(32).toString("base64url")}`;
  const hash = createHash("sha256").update(bearer).digest("hex");
  const signature = createHmac("sha256", kitFixtureSessionSecret()).update(bearer).digest("base64");
  const context = await browser.newContext({ baseURL: target.origin, ignoreHTTPSErrors: true });
  try {
    await withSessionDb(async (sql) => {
      await sql`insert into web_sessions (token_hash, status_hash, user_id, username, member, moderator, expires_at)
        values (${hash}, ${hash}, ${userId}, 'Review fixture', true, true, ${new Date(Date.now() + 7_200_000)})`;
      await sql`insert into events (event_key, title, description, starts_at, ends_at, location, status)
        values (${key}, 'Community game night', 'Bring a favourite game and meet the community.',
          '2099-03-01T18:00:00Z', '2099-03-01T20:00:00Z', 'Community voice', 'draft')`;
    });
    await context.addCookies([
      {
        name: "__Host-two_session",
        value: `${bearer}.${signature}`,
        domain: new URL(target.origin).hostname,
        path: "/",
        secure: true,
        httpOnly: true,
        sameSite: "Lax",
      },
    ]);
    await context.route("**/*", (route) =>
      new URL(route.request().url()).origin === target.origin
        ? route.continue()
        : route.abort("blockedbyclient"),
    );
    const page = await context.newPage();
    for (const state of [
      "ready",
      "corrections",
      "stale",
      "unsaved",
      "published",
      "cancelled",
      "success",
    ]) {
      await withSessionDb(async (sql) => {
        await sql`update events set status = ${state === "published" || state === "success" ? "published" : state === "cancelled" ? "cancelled" : "draft"},
          location = ${state === "corrections" ? "" : "Community voice"}, updated_at = now() where event_key = ${key}`;
      });
      const query =
        state === "success"
          ? "published=1"
          : `review=1${state === "stale" ? "&publish_error=stale" : state === "unsaved" ? "&unsaved=1" : ""}`;
      const response = await page.goto(`/e/${key}?${query}`);
      expect(response?.status()).toBe(200);
      expect(response?.headers()["x-two-renderer"]).toBe("kit");
      await expect(
        page.getByRole("heading", { name: "Community game night", exact: true }),
      ).toBeVisible();
      if (state === "success") {
        await expect(page.getByTestId("event-published")).toBeVisible();
        await expect(page.getByTestId("event-review")).toHaveCount(0);
      } else {
        await expect(page.getByTestId("event-review")).toBeVisible();
        await expect(page.getByRole("button", { name: "RSVP", exact: true })).toBeDisabled();
        if (state === "published" || state === "cancelled")
          await expect(page.getByTestId("publish-reviewed-event")).toHaveCount(0);
        else if (state === "corrections")
          await expect(page.getByTestId("publish-reviewed-event")).toBeDisabled();
        else await expect(page.getByTestId("publish-reviewed-event")).toBeEnabled();
      }
      if (state === "stale") await expect(page.getByTestId("event-review-error")).toBeFocused();
      if (state === "unsaved") await expect(page.getByTestId("event-review-unsaved")).toBeVisible();
      for (const viewport of [
        { width: 1280, height: 800 },
        { width: 390, height: 844 },
      ]) {
        await page.setViewportSize(viewport);
        await expectSavedReviewActions(page, state, viewport.width);
        const name = `kit-review-${state}-${viewport.width}`;
        const path = test.info().outputPath(`${name}.png`);
        await page.screenshot({ path, fullPage: true });
        await test.info().attach(name, { path, contentType: "image/png" });
      }
    }
  } finally {
    await context.close();
    await withSessionDb(async (sql) => {
      await sql`delete from events where event_key = ${key}`;
      await sql`delete from web_session_grace where user_id = ${userId}`;
      await sql`delete from web_sessions where user_id = ${userId}`;
    });
  }
});

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

  test("Kit metadata-less archive pagination preserves the restored notice for navigation", async ({
    browser,
  }) => {
    const context = await browser.newContext({ baseURL: KIT_ORIGIN });
    const name = "__Host-two_expired_write";
    try {
      // Model a client that omits Fetch Metadata, without removing the shipped
      // island's explicit marker. No request may leave the local Kit fixture.
      await context.route("**/*", (route) => {
        if (new URL(route.request().url()).origin !== KIT_ORIGIN)
          return route.abort("blockedbyclient");
        const headers = { ...route.request().headers() };
        for (const key of Object.keys(headers))
          if (key.startsWith("sec-fetch-")) delete headers[key];
        return route.continue({ headers });
      });
      // Read the newly seeded archive rows, not the isolate's earlier guest entry.
      await context.addCookies([{ name: "e2e-archive-bypass", value: "1", url: KIT_ORIGIN }]);
      const page = await context.newPage();
      await page.goto("/events/past");
      await expect(page.getByTestId("auth-error")).toHaveCount(0);
      const raw = "restored|/events/past";
      const signature = createHmac("sha256", kitFixtureSessionSecret())
        .update(raw)
        .digest("base64");
      await context.addCookies([
        {
          name,
          value: encodeURIComponent(`${raw}.${signature}`),
          domain: new URL(KIT_ORIGIN).hostname,
          path: "/",
          secure: true,
          httpOnly: true,
          sameSite: "Lax",
        },
      ]);
      await page.evaluate("window.__noticeSameDoc = 1");
      const responsePromise = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === "/events/past" &&
          new URL(response.url()).search === "?page=2",
      );
      await page.locator('a[data-archive-page]:has-text("Older")').click();
      const pagination = await responsePromise;
      expect(pagination.status()).toBe(200);
      const paginationHeaders = await pagination.request().allHeaders();
      expect(paginationHeaders["x-two-island"]).toBe("past-events");
      expect(paginationHeaders["sec-fetch-dest"]).toBeUndefined();
      expect(paginationHeaders["sec-fetch-mode"]).toBeUndefined();
      expect((paginationHeaders["cookie"] ?? "").includes(`${name}=`)).toBe(true);
      expect(await pagination.text()).not.toContain('data-testid="auth-error"');
      await expect(page.getByTestId("past-events")).toHaveAttribute("data-page", "2");
      await expect(page.getByTestId("past-events")).not.toHaveAttribute("aria-busy");
      expect(await page.evaluate("window.__noticeSameDoc")).toBe(1);
      expect(
        (await context.cookies(KIT_ORIGIN)).filter((cookie) => cookie.name === name),
      ).toHaveLength(1);
      expect(
        (await pagination.headerValues("set-cookie")).some((cookie) =>
          cookie.startsWith(`${name}=`),
        ),
      ).toBe(false);

      const navigation = await page.goto("/events/past");
      expect(navigation?.status()).toBe(200);
      expect(navigation?.headers()["x-two-renderer"]).toBe("kit");
      await expect(page.getByTestId("auth-error")).toHaveCount(1);
      expect(
        (await context.cookies(KIT_ORIGIN)).filter((cookie) => cookie.name === name),
      ).toHaveLength(0);
      await page.goto("/events/past");
      await expect(page.getByTestId("auth-error")).toHaveCount(0);
    } finally {
      await context.close();
    }
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
        // goBack restores the URL synchronously, before the island's popstate
        // read settles; a failed read falls back to a full reload only once
        // its fetch settles. data-page flips to 1 only at the island swap (or
        // on the reloaded document) and aria-busy clears when the read
        // finishes, so read the same-document marker only after both — and
        // again after the last content assertions below, before pageErrors.
        await expect(page.getByTestId("past-events")).toHaveAttribute("data-page", "1");
        await expect(page.getByTestId("past-events")).not.toHaveAttribute("aria-busy");
        await expectSameDoc();
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
        await expectSameDoc();

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
  // startup.maxMs in ci/budgets/kit/startup.json — a worker that never becomes
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

// Kit member-board visuals: 4 views x 2 widths into
// e2e/visual/__screenshots-kit__/ (snapshotPathTemplate in
// playwright.kit-parity.config.ts). Reuses the single shared QA login above
// (memberCookie, re-signed for Kit): no extra qa-login throttle cost, and the
// board-view log rows are the journey's own writes like the API views.
// Mask <time> defensively (the board carries none today), fullPage, soft per
// width so one diff never hides the other image for ci/kit-visual-accept.mjs.
const MEMBER_BOARD_VIEWS: Array<[name: string, path: string]> = [
  ["default", "/leaderboards/members"],
  ["relative", "/leaderboards/members?scope=relative"],
  ["season", "/leaderboards/members?season=2026"],
  ["activity", "/leaderboards/members?activity=valheim"],
];

test.describe("kit: member-board visuals", () => {
  for (const [view, path] of MEMBER_BOARD_VIEWS) {
    test(`${view} @ desktop and mobile`, async ({ browser }) => {
      test.setTimeout(120_000);
      const kit = targets.find((target) => target.name === "kit")!;
      const hono = targets.find((target) => target.name === "hono")!;
      const honoCookie = await memberCookie(hono);
      await expect
        .poll(
          async () => {
            const ready = await api(hono).get("/leaderboards/members", {
              headers: { cookie: honoCookie },
            });
            return (
              ready.status() === 200 &&
              (ready.headers()["x-two-renderer"] ?? null) === null &&
              (await ready.text()).includes("Sign out")
            );
          },
          { message: "Hono member board session becomes visible", timeout: 15000 },
        )
        .toBe(true);
      await memberGoingRsvp();
      const cookie = await memberCookie(kit);
      await expect
        .poll(
          async () => {
            const ready = await api(kit).get("/leaderboards/members", {
              headers: { cookie },
            });
            return (
              ready.status() === 200 &&
              (ready.headers()["x-two-renderer"] ?? null) ===
                expectedKitMarker("/leaderboards/members") &&
              (await ready.text()).includes("Sign out")
            );
          },
          { message: "Kit member board session becomes visible", timeout: 15000 },
        )
        .toBe(true);
      const context = await browser.newContext({
        baseURL: kit.origin,
        ignoreHTTPSErrors: kit.ignoreHTTPSErrors,
        // Keep the session in the jar so a later status probe shares one
        // Cookie header with it. Raw extra headers collide with jar cookies
        // on the second navigation. Preserve the issued cookie's attributes.
        storageState: {
          cookies: (await api(hono).storageState()).cookies
            .filter((session) => session.name === "__Host-two_session")
            .map((session) => ({
              ...session,
              domain: new URL(kit.origin).hostname,
              value: cookie.slice(cookie.indexOf("=") + 1),
            })),
          origins: [],
        },
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
        for (const viewport of PARITY_VIEWPORTS) {
          await page.setViewportSize(viewport.size);
          const response = await page.goto(path);
          expect(response?.status(), `kit ${path} @ ${viewport.name}`).toBe(200);
          const cookieHeaders = (await response!.request().headersArray()).filter(
            (header) => header.name.toLowerCase() === "cookie",
          );
          expect(cookieHeaders.length, "one browser Cookie header").toBe(1);
          const cookieNames = cookieHeaders[0]!.value
            .split(/;\s*/)
            .map((pair) => pair.slice(0, pair.indexOf("=")));
          expect(cookieNames.filter((name) => name === "__Host-two_session")).toHaveLength(1);
          if (viewport.name === "mobile") {
            expect(
              cookieNames.filter((name) => name === "__Host-two_session_status"),
              "second navigation replays the status probe alongside the session",
            ).toHaveLength(1);
          }
          await expect(page.getByRole("heading", { name: "Member leaderboard" })).toBeVisible();
          await expect(page.getByRole("navigation", { name: "Board scope" })).toBeVisible();
          await page.waitForLoadState("networkidle");
          if (view === "default" || view === "relative") {
            const rankedRow = page.getByRole("row").filter({
              has: page.getByRole("rowheader", { name: "QA Member" }),
            });
            await expect(rankedRow.getByRole("cell")).toHaveText(["1", "1"]);
          } else {
            await expect(
              page.getByText("Nobody is ranked for this season and game yet."),
            ).toBeVisible();
            await expect(page.getByRole("rowheader", { name: "QA Member" })).toHaveCount(0);
          }
          await expect.soft(page).toHaveScreenshot(`member-board-${view}-${viewport.name}.png`, {
            fullPage: true,
            mask: [page.locator("time")],
          });
        }
        expect(pageErrors, "no uncaught page errors").toEqual([]);
      } finally {
        await context.close();
      }
    });
  }
});

test("Kit cancelled event renders its record and next date without JavaScript", async ({
  browser,
}) => {
  test.setTimeout(90_000);
  const target = targets.find((item) => item.name === "kit")!;
  expect(kitFixtureOwnsEventDetail()).toBe(true);
  const prefix = "01J0000000000000000CXN000";
  const key = (n: number) => `${prefix}${n}`;
  const attendee = "900000000000000848";
  const game = "Fixture tabletop";
  try {
    await withSessionDb(async (sql) => {
      await sql`insert into users (id, username, member) values (${attendee}, 'Fixture Attendee Marker', true)`;
      const [root] = await sql<{ id: number }[]>`
        insert into events (event_key,title,game,organizer_name,description,join_instructions,starts_at,ends_at,timezone,status,recurrence_frequency,recurrence_index)
        values (${key(1)},'Cancelled series night',${game},'Fixture Public Host','Public synthetic summary','Private instructions marker',
          '2099-03-01T18:00Z','2099-03-01T20:00Z','Asia/Kolkata','cancelled','weekly',1) returning id`;
      await sql`insert into rsvps (event_id,user_id,status) values (${root!.id},${attendee},'going')`;
      await sql`insert into events (event_key,title,game,starts_at,ends_at,timezone,status,parent_event_id,recurrence_index) values
        (${key(2)},'Later sibling',${game},'2099-03-22T18:00Z','2099-03-22T20:00Z','UTC','published',${root!.id},2),
        (${key(3)},'Next sibling',${game},'2099-03-15T18:00Z','2099-03-15T20:00Z','Pacific/Auckland','published',${root!.id},3),
        (${key(4)},'Unpublished sibling',${game},'2099-03-08T18:00Z','2099-03-08T20:00Z','UTC','draft',${root!.id},4),
        (${key(5)},'Cancelled sibling',${game},'2099-03-09T18:00Z','2099-03-09T20:00Z','UTC','cancelled',${root!.id},5),
        (${key(6)},'Historical sibling',${game},'2099-03-10T18:00Z','2099-03-10T20:00Z','UTC','past',${root!.id},6),
        (${key(7)},'Invalid sibling',null,'2099-03-11T18:00Z','infinity','UTC','published',${root!.id},7),
        (${`${prefix}a`},'Unroutable sibling',null,'2099-03-12T18:00Z','2099-03-12T20:00Z','UTC','published',${root!.id},8),
        (${key(8)},'Other event',${game},'2099-03-05T18:00Z','2099-03-05T20:00Z','UTC','published',null,null),
        (${key(9)},'Standalone cancellation',${game},'2099-04-01T18:00Z','2099-04-01T20:00Z','UTC','cancelled',null,null)`;
      await sql`update events set description = 'Draft description marker' where event_key = ${key(4)}`;
    });
    const privateMarkers =
      /Fixture Attendee Marker|Private instructions marker|Draft description marker|data-rsvp-form/;
    const Cookie = await memberCookie(target);
    const signed = await api(target).get(`/e/${key(1)}`, { headers: { Cookie } });
    expect(signed.status()).toBe(410);
    expect(await signed.text()).not.toMatch(privateMarkers);
    for (const width of [1280, 390]) {
      const context = await browser.newContext({
        baseURL: target.origin,
        viewport: { width, height: width === 390 ? 844 : 800 },
        javaScriptEnabled: false,
      });
      try {
        const page = await context.newPage();
        for (const state of ["guest", "fallback"]) {
          const fallback = state === "fallback";
          const eventKey = key(fallback ? 9 : 1);
          const response = await page.goto(`/e/${eventKey}`);
          expect(response?.status()).toBe(410);
          expect(response!.headers()).toMatchObject({
            "x-two-renderer": "kit",
            "cache-control": "private, no-store",
            "x-robots-tag": "noindex, nofollow",
          });
          expect(await response!.text()).not.toMatch(privateMarkers);
          await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);
          const actions =
            'main form, aside[aria-label="Your seat"], [data-testid="event-join-pitch"]';
          await expect(page.locator(actions)).toHaveCount(0);
          await expect(page.getByTestId("event-cancelled")).toHaveText("Cancelled");
          const calendar = page.getByTestId("event-cancelled-ics");
          await expect(calendar).toHaveAttribute("href", `/events/${eventKey}.ics`);
          const alternatives = page.getByTestId("event-cancelled-alternatives");
          await expect(alternatives.getByRole("link", { name: "Other event" })).toBeVisible();
          const next = page.getByRole("link", { name: "See the next date" });
          const record = page.getByTestId("event-cancelled-record");
          if (fallback) {
            await expect(next).toHaveCount(0);
            await expect(record.locator("time")).toHaveCount(0);
          } else {
            const time = page.getByTestId("event-cancelled-time");
            const facts = page.getByTestId("kit-event-facts");
            await expect(facts.getByText("Fixture Public Host", { exact: true })).toBeVisible();
            await expect(time).toHaveAttribute("datetime", "2099-03-01T18:00:00.000Z");
            await expect(time.locator("s")).toHaveText("23:30");
            await expect(time.locator("..")).toContainText("Asia/Kolkata · 18:00 UTC");
            await expect(next).toHaveAttribute("href", `/e/${key(3)}`);
            const nextTime = record.locator("time");
            await expect(nextTime).toHaveAttribute("datetime", "2099-03-15T18:00:00.000Z");
            await expect(record).toContainText(/Next one:.*16 March 2099.*07:00/);
            if (width === 390) {
              const ids = ["event-cancelled-time", "event-cancelled-record", "kit-event-facts"];
              const nodes = page.locator(ids.map((id) => `[data-testid="${id}"]`).join(","));
              const order = await nodes.evaluateAll((els) =>
                els.map((el) => el.getAttribute("data-testid")),
              );
              expect(order).toEqual(ids);
              const boxes = await Promise.all(
                [time, record, facts].map((node) => node.boundingBox()),
              );
              expect(boxes[0]!.y).toBeLessThan(boxes[1]!.y);
              expect(boxes[1]!.y).toBeLessThan(boxes[2]!.y);
            } else {
              expect((await record.boundingBox())!.x).toBeGreaterThan(
                (await time.boundingBox())!.x,
              );
            }
          }
          const name = `kit-review-cancelled-record-${state}-${width}`;
          const path = test.info().outputPath(`${name}.png`);
          await page.screenshot({ path, fullPage: true, animations: "disabled", caret: "hide" });
          await test.info().attach(name, { path, contentType: "image/png" });
        }
      } finally {
        await context.close();
      }
    }
  } finally {
    await withSessionDb(async (sql) => {
      await sql`delete from rsvps where user_id = ${attendee}`;
      await sql`delete from events where event_key like ${`${prefix}%`}`;
      await sql`delete from users where id = ${attendee}`;
    });
  }
});

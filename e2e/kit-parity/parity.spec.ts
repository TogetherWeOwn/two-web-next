import { createHmac } from "node:crypto";
import { expect, test, type APIRequestContext } from "@playwright/test";
import postgres from "postgres";
import { normalizeSection, sectionOf } from "../../ci/kit-section-contract.mjs";
import { requireGithubRunner, requireTestDatabase } from "../ci-only.mjs";
import {
  expectedKitMarker,
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

// Kit journey parity (docs/kit-parity-gates.md): the journeys run
// against BOTH the Hono worker and the built Kit Worker in one run, and
// every body comparison is origin-normalized first. Guest routes need no
// session; the member-board journey spends exactly one QA login (counted
// below and asserted in afterAll) whose bearer token is replayed to both
// targets (re-signed for the Kit fixture's own secret) — the token and
// cookie values never appear in assertions or artifacts, and every body
// is scrubbed. The journey also makes its viewer the board's one ranked
// member with a single going RSVP on the seeded event, withdrawn in
// afterAll: no earlier journey leaves a going RSVP behind, so without it
// both boards render their empty state and ranked content is unprovable.
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
  // Ranked RSVP before the first cache-settling read: anonymous /events
  // entries are isolate-local (src/events/anon-cache.ts) and the RSVP PUT
  // retires only the Hono isolate, so establishing the going RSVP here means
  // every guest entry settled later on either isolate already carries
  // count=1. This spends the journey's one memoized QA login early; the
  // afterAll withdrawal and the exactly-one-login assertion are unchanged.
  await memberGoingRsvp();
  // Leave the shared jar guest-clean: the QA login above stores its session
  // cookie in the Hono context, and every later api(hono) call would send
  // it — turning the guest-contract tests (public cache-control on /events,
  // the 302 member-board bounce) into member reads. Recreate the context
  // instead: the memoized pair stays live (the RSVP PUT never rotates), so
  // later memberCookie() calls replay it explicitly with no second login.
  const hono = targets.find((target) => target.name === "hono")!;
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
    // Undo the journey's one ranked RSVP while its Hono context is alive,
    // so the seeded event is left exactly as the earlier journeys left it.
    if (memberRsvpCreated) {
      const hono = targets.find((target) => target.name === "hono")!;
      const withdrawn = await api(hono).delete(`/events/${SEEDED_EVENT_KEY}/rsvp`, {
        headers: { cookie: await memberCookie(hono), Origin: "https://localhost:8787" },
      });
      expect(withdrawn.status(), "ranked RSVP withdrawn").toBe(204);
    }
  } finally {
    for (const context of contexts.values()) await context.dispose();
  }
  // The whole parity run spends one QA login however many board fetches
  // follow: dropping the memoization below burns one login per fetch
  // against the shared qa-login throttle, and this counter is the proof.
  if (memberCookiePromise !== null) {
    expect(qaLoginCount, "exactly one QA login for the member journey").toBe(1);
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
  // Freshest wins: rotating page reads (GET /events, GET /e/:key) retire the
  // presented bearer to bounded grace and deliver the replacement via Set-Cookie into
  // Hono's jar. Kit has a separate cookie signature, but shares that same
  // session row, so it must re-sign the jar's current pair when a rotation
  // has already run.
  const hono = targets.find((candidate) => candidate.name === "hono")!;
  const state = await api(hono).storageState();
  const current = state.cookies.find((cookie) => cookie.name === "__Host-two_session");
  const source = current ? `${current.name}=${current.value}` : pair;
  if (target.name !== "kit") return source;

  const eq = source.indexOf("=");
  const signed = source.slice(eq + 1);
  const raw = signed.slice(0, signed.lastIndexOf("."));
  const signature = createHmac("sha256", kitFixtureSessionSecret()).update(raw).digest("base64");
  return `${source.slice(0, eq + 1)}${raw}.${signature}`;
}

// The board's one ranked member: the QA viewer answers going to the seeded
// published event (e2e/seed.mjs, "E2E Community Night", 2099, no game).
// Earlier journeys withdraw or cancel every going RSVP they create, so
// this idempotent write — memoized within a worker, replayed after a restart,
// and withdrawn in afterAll — gives both renderers a ranked row to serve.
// Its 2099 start and missing game also pin the season=2026 and activity=valheim
// views to their empty state below.
const SEEDED_EVENT_KEY = "01J00000000000000000000001";
let memberRsvpCreated = false;
let memberRsvpPromise: Promise<void> | null = null;
function memberGoingRsvp(): Promise<void> {
  memberRsvpPromise ??= (async () => {
    const hono = targets.find((target) => target.name === "hono")!;
    const response = await api(hono).put(`/events/${SEEDED_EVENT_KEY}/rsvp`, {
      headers: { cookie: await memberCookie(hono), Origin: "https://localhost:8787" },
      data: { status: "going" },
    });
    expect([200, 201], "ranked RSVP created or refreshed").toContain(response.status());
    memberRsvpCreated = true;
    const body = (await response.json()) as { data?: { status?: string } };
    expect(body.data?.status, "ranked RSVP holds a seat, not the waitlist").toBe("going");
  })().catch((error: unknown) => {
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

  // Hot-zone heatmaps (GET /hotzones + joins|voice|games only; unknown
  // segments 404, never a grid). Bodies come from raw API fetches with no
  // browser JS executed, so these assertions ARE the no-JS proof: the
  // aggregate grids, signal nav and estimate labels are in the first bytes.
  test.describe(`${target.name}: hot-zone heatmaps keep their aggregate contract`, () => {
    const hotzonePaths = ["/hotzones", "/hotzones/joins", "/hotzones/voice", "/hotzones/games"];

    test("index and signals serve aggregate grids with the manifest marker", async () => {
      for (const path of hotzonePaths) {
        const response = await api(target).get(path);
        expect(response.status(), `${target.name} ${path}`).toBe(200);
        expect(response.headers()["content-type"]).toContain("text/html");
        // Renderer ownership is per target: Kit answers with the
        // manifest-derived marker once enabled, Hono never carries one.
        const derived = expectedKitMarker(path);
        expect(derived, `manifest owns ${path} on Kit`).toBe("kit");
        const expectedMarker = target.name === "kit" ? derived : null;
        expect(response.headers()["x-two-renderer"] ?? null, `${target.name} ${path} marker`).toBe(
          expectedMarker,
        );
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

    test("bad season answers 400 before any grid", async () => {
      for (const path of ["/hotzones?season=bogus", "/hotzones/joins?season=bogus"]) {
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
        const response = await guest.get(EVENT_PATH);
        expect(response.status(), `${target.name} guest detail`).toBe(200);
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
      } finally {
        await guest.dispose();
      }
    });

    test("member renders the no-JS RSVP form posting to the Hono controller", async ({
      playwright,
    }) => {
      if (target.name === "kit")
        expect(kitFixtureOwnsEventDetail(), "Kit fixture owns the event detail").toBe(true);
      const expectedMarker = target.name === "kit" ? "kit" : null;
      const cookie = await memberCookie(target);
      const response = await api(target).get(EVENT_PATH, { headers: { cookie } });
      expect(response.status(), `${target.name} member detail`).toBe(200);
      expect(response.headers()["content-type"]).toContain("text/html");
      expect(response.headers()["x-two-renderer"] ?? null).toBe(expectedMarker);
      expect(response.headers()["cache-control"]).toBe("private, no-store");
      const body = await response.text();
      expect(scrubSecrets(body)).toEqual([]);
      expect(body).toContain("E2E Community Night");
      expect(body).not.toContain('data-testid="event-join-pitch"');
      // The mutation stays Hono-owned: a native form posts to the unchanged
      // controller, the islands only enhance it.
      expect(body).toContain(`action="/e/${EVENT_KEY}/rsvp"`);
      expect(body).toContain("/islands/rsvp-button.js");
      expect(body).toContain("Sign out");
      expect(body).not.toContain("Welcome, guest");
      // Hono rotates the active bearer and renews its 120-minute sliding
      // expiry. Only its immediate predecessor has a fixed <10s grace:
      // replay cannot rotate, mint a sibling or renew that window. Kit's
      // read-only bridge never rotates or sets cookies, so its bearer stays
      // live beyond that window. Kit-only browsing still lacks sliding renewal.
      const sessionSets = (await response.headersArray())
        .filter((header) => header.name.toLowerCase() === "set-cookie")
        .map((header) => header.value)
        .filter((value) => value.startsWith("__Host-two_session="));
      if (target.name === "kit") {
        expect(sessionSets, "kit detail keeps the read-only bridge: no rotation").toEqual([]);
      } else {
        expect(sessionSets.length, "hono detail rotates the session").toBe(1);
        expect(sessionSets[0]!, "rotation re-stamps 120 minutes").toMatch(/max-age=7200/i);
      }
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
          if (target.name === "kit" || phase === "immediate") {
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
        await page.getByRole("link", { name: "Joins heatmap" }).click();
        await expect(page).toHaveURL(/\/hotzones\/joins/);
        await page.waitForLoadState("load");
        await expect(page.getByRole("heading", { name: "joins hot zone" })).toBeVisible();
        await expectContained("/hotzones/joins", 1);
        for (const signal of ["voice", "games"]) {
          const signalResponse = await page.goto(`/hotzones/${signal}`);
          expect(signalResponse?.status()).toBe(200);
          await expect(page.getByRole("heading", { name: `${signal} hot zone` })).toBeVisible();
          await expectContained(`/hotzones/${signal}`, 1);
        }
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

test("cross-target: normalized events-calendar sections match", async ({ playwright }) => {
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
  expect(
    sectionOf(bodies.get("hono")!, "events-calendar"),
    "Hono events-calendar section carries the seeded row",
  ).toContain("E2E Community Night");
  expect(
    sectionOf(bodies.get("kit")!, "events-calendar"),
    "Kit section matches Hono section after origin normalization",
  ).toBe(sectionOf(bodies.get("hono")!, "events-calendar"));
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
          await expect
            .soft(page)
            .toHaveScreenshot(`kit-archive-${view.name}-${viewport.name}.png`, {
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
        extraHTTPHeaders: { cookie },
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

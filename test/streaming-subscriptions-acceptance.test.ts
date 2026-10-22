// route-inventory: POST /streaming/checkout
// route-inventory: POST /streaming/portal
// route-inventory: POST /webhooks/stripe
// S2 acceptance: streaming subscriptions + Stripe test-mode checkout/portal/webhooks.
//
// BUILDER CONTRACT (spec section 9 S2, decisions D1/D2). The Builder builds on
// this card's branch and MUST NOT edit this file or
// test/helpers/streaming-entitlement-fixture.ts. Until the slice lands this suite
// is RED: route tests fail with 404 (or the 403 the global same-origin guard
// answers on the unregistered webhook path), schema/entitlement tests fail on the
// missing table/module, and the two hygiene controls stay green.
//
// Pinned routes (all POST-only; GET on any of them stays 404):
// - POST /streaming/checkout — member-only (guest: 302/303 into /auth/*,
//   signed-in non-member: 403), same-origin guard applies (no exemption).
//   JSON { tier: "basic" | "plus" } -> 200 { url: "<stripe checkout url>" }.
//   Stateless: no database needed. Creates a Stripe Checkout Session in
//   subscription mode with INLINE price_data (no Price ids, so tests verify
//   amounts without dashboard state): basic unit_amount 500, plus 1500,
//   currency usd, recurring interval month (monthly-only, D1), quantity 1,
//   mode subscription, client_reference_id = user id, metadata.tier, and
//   subscription_data.metadata { user_id, tier } so later subscription events
//   carry linkage. success_url/cancel_url start with APP_URL. Uses env
//   STRIPE_SECRET verbatim as the Bearer token (never a hardcoded key).
//   Invalid/missing tier -> 400 before any Stripe call. Any non-2xx or network
//   failure from Stripe -> 502 with a generic error (never echo upstream body).
// - POST /streaming/portal — same auth + guard posture. Reads the member's
//   subscriptions row; none -> 404. Creates a Stripe billing-portal session for
//   that row's stripe_customer_id (return_url under APP_URL) -> 200 { url }.
//   Same 502 rule on Stripe failures.
// - POST /webhooks/stripe — session-free (no cookie, no SESSION_STORE), with an
//   exact method+path same-origin exemption like /api/agent-events (Stripe sends
//   no Origin). Verifies the Stripe-Signature header (t=<unix>,v1=<hex> [,v1...])
//   over "<timestamp>.<raw body>" with HMAC-SHA256 keyed by env
//   STRIPE_WEBHOOK_SECRET, timing-safe compare against every v1 (rotation),
//   |now - t| <= 300 s. Verification runs on the raw bytes before JSON parsing
//   and before any database access. Failures (missing/malformed header, wrong
//   secret, tampered bytes, stale/future timestamp, empty or non-JSON body) ->
//   400 JSON { error }. Unknown event types and validly-signed events without
//   TWO linkage (the shared org account also sends Kofra events, D2) -> 200
//   { received: true } with no row change and no Stripe fetch. The handler never
//   calls Stripe: it trusts the verified event.
// Webhook event matrix (all -> 200 { received: true } unless noted):
// - checkout.session.completed: client_reference_id (fallback metadata.user_id)
//   + metadata.tier (basic|plus only; anything else -> 400) + customer +
//   subscription ids -> insert subscriptions row status active. Unknown user ->
//   400 (no 500s to Stripe). Period is provisional (now -> now+30d); the
//   subscription event below carries authoritative timestamps.
// - customer.subscription.created / .updated (same upsert): match the row by
//   stripe_subscription_id, else metadata.user_id (unknown subscription with
//   valid linkage creates the row). Store status/period/cancel_at_period_end
//   verbatim, including unknown future statuses (forwards-compat; entitlement
//   treats unknown as off).
// - customer.subscription.deleted -> status canceled, row kept, period kept.
// - invoice.payment_failed -> status past_due on the row matched by subscription
//   (fallback customer), period kept (grace runs from current_period_end).
// - invoice.payment_succeeded -> status active (recovery), period kept.
// - users.member is never read for entitlement and never written by any route.
// Entitlement helper (src/streaming/entitlement.ts):
// - export function isStreamingEntitled(
//     sub: { status: string; currentPeriodEnd: Date } | null | undefined,
//     now?: Date,
//   ): boolean
// - true for active and trialing; true for past_due iff now <=
//   currentPeriodEnd + 3 days (inclusive); false for canceled, paused,
//   incomplete, incomplete_expired, unpaid, unknown statuses and null.
// Secrets (TEST MODE ONLY, D2): env STRIPE_SECRET (Stripe secret key) and
// STRIPE_WEBHOOK_SECRET (whsec signing secret) via wrangler secret put, never in
// source. No live key literal (the sk/pk/rk live-prefixed forms) may appear anywhere in
// the repo, including docs (refer to them only in redacted/split form). Neither
// secret name nor any test/live key fragment may appear under src/islands,
// assets, public or web (client-reachable).
// BUILDER ALSO OWNS (no test edits needed): add the three routes to
// test/fixtures/route-inventory.json with reviewed auth labels, add exact
// `METHOD /path` entries to docs/parity.md or docs/url-freeze.md, add the
// POST /webhooks/stripe same-origin exemption, and land the subscriptions
// migration (spec section 4) with drizzle journal + lock updates. The
// route-inventory guard reads this file's references as stale until that lands.
// Out of scope: GET /streaming marketing page, live keys / live launch (owner
// step), and every S3+ slice. Fake secrets below deliberately avoid real key
// prefixes so gitleaks never flags this file; live-key fragments are built by
// concatenation so the literals never appear here.
import { createHmac } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, URL as NodeURL } from "node:url";
import { serializeSigned } from "hono/utils/cookie";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import app from "./app";
import type { Env } from "../src/env";
import { SESSION_COOKIE } from "../src/session-cookie";
import {
  createMemorySessionStore,
  hashToken,
  newSessionToken,
  type SessionStore,
} from "../src/sessions";
import { users } from "../src/db/schema";
import { createMemberDataFixture, type MemberDataFixture } from "./helpers/member-data-db";
import {
  ensureEntitlementOff,
  readSubscription,
  seedSubscription,
  subscriptionsTableExists,
} from "./helpers/streaming-entitlement-fixture";

const APP_URL = "https://next.example.test";
const SESSION_SECRET = "test-session-secret-at-least-32-bytes-long";
// Deliberately not real key shapes (see header): the route must use these env
// values verbatim, which the Stripe stubs assert per request.
const STRIPE_SECRET = "test-stripe-secret-key-32-bytes-minimum";
const WEBHOOK_SECRET = "test-stripe-webhook-secret-32-bytes-min";
const STRIPE_API = "https://api.stripe.com";
const CHECKOUT_URL = "https://checkout.stripe.com/c/pay/cs_test_acceptance";
const PORTAL_URL = "https://billing.stripe.com/p/session/bps_test_acceptance";

type TestEnv = Env & {
  SESSION_STORE?: SessionStore;
  ADMIN_DB?: unknown;
  STRIPE_SECRET?: string;
  STRIPE_WEBHOOK_SECRET?: string;
};

function baseEnv(extra: Partial<TestEnv> = {}): TestEnv {
  return {
    APP_URL,
    DISCORD_CLIENT_ID: "client-id",
    DISCORD_GUILD_ID: "326474832151838730",
    DISCORD_INVITE_URL: "https://discord.gg/invite",
    DISCORD_CLIENT_SECRET: "client-secret",
    DISCORD_BOT_TOKEN: "bot-token",
    SESSION_SECRET,
    STRIPE_SECRET,
    STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
    ...extra,
  } as TestEnv;
}

async function cookieFor(
  store: SessionStore,
  row: { userId: string; username: string; member: boolean },
): Promise<string> {
  const token = newSessionToken();
  await store.create({
    tokenHash: await hashToken(token),
    userId: row.userId,
    username: row.username,
    avatar: null,
    member: row.member,
    moderator: false,
    expiresAt: new Date(Date.now() + 3600_000),
  });
  const serialized = await serializeSigned(SESSION_COOKIE, token, SESSION_SECRET, {
    path: "/",
    secure: true,
    httpOnly: true,
    sameSite: "Lax",
  });
  return serialized.split(";")[0]!;
}

const MEMBER = { userId: "100000000000000021", username: "streamer", member: true };
const OUTSIDER = { userId: "100000000000000022", username: "outsider", member: false };

// Stripe signature scheme: signed payload "<timestamp>.<raw body>", HMAC-SHA256
// with the webhook secret, header "t=<timestamp>,v1=<hex>" (multiple v1 during
// rotation). Tolerance 300 s, same as Stripe's default.
function signStripePayload(secret: string, rawBody: string, timestamp: number): string {
  return createHmac("sha256", secret).update(`${timestamp}.${rawBody}`, "utf8").digest("hex");
}

function stripeHeader(secret: string, rawBody: string, timestamp?: number): string {
  const t = timestamp ?? Math.floor(Date.now() / 1000);
  return `t=${t},v1=${signStripePayload(secret, rawBody, t)}`;
}

async function webhookPost(
  rawBody: string,
  signature: string | null,
  env: TestEnv,
  contentType = "application/json",
): Promise<Response> {
  const headers: Record<string, string> = { "content-type": contentType };
  if (signature !== null) headers["stripe-signature"] = signature;
  // No Origin: Stripe never sends one, so the exemption must carry this path.
  return await app.request("/webhooks/stripe", { method: "POST", headers, body: rawBody }, env);
}

function noFetch(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("fetch must not be called on this path");
    }),
  );
}

type CapturedStripeCall = { url: string; init: RequestInit & { headers?: Headers } };

function stubStripeApi(
  handler: (url: string, init: RequestInit) => Response,
): CapturedStripeCall[] {
  const calls: CapturedStripeCall[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = String(input instanceof Request ? input.url : input);
      if (!url.startsWith(`${STRIPE_API}/`)) throw new Error(`Non-Stripe fetch refused: ${url}`);
      calls.push({ url, init: init as CapturedStripeCall["init"] });
      return handler(url, init);
    }),
  );
  return calls;
}

function bearerOf(init: RequestInit): string {
  const headers = new Headers(init.headers);
  return headers.get("authorization") ?? "";
}

function formOf(init: RequestInit): URLSearchParams {
  return new URLSearchParams(typeof init.body === "string" ? init.body : "");
}

afterEach(() => vi.unstubAllGlobals());

describe("webhook signature verification (DB-free)", () => {
  const env = () => baseEnv();
  const eventBody = JSON.stringify({
    id: "evt_test_unknown",
    object: "event",
    type: "payment_intent.created",
    data: { object: { id: "pi_test_unknown", object: "payment_intent" } },
  });

  it("missing signature is 400, never 403 or 404", async () => {
    noFetch();
    const res = await webhookPost(eventBody, null, env());
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: expect.any(String) });
  });

  it("malformed signature is 400", async () => {
    noFetch();
    const res = await webhookPost(eventBody, "not-a-stripe-signature", env());
    expect(res.status).toBe(400);
  });

  it("signature under the wrong secret is 400", async () => {
    noFetch();
    const res = await webhookPost(
      eventBody,
      stripeHeader("a-different-webhook-secret-value-000", eventBody),
      env(),
    );
    expect(res.status).toBe(400);
  });

  it("tampered bytes fail against the original signature", async () => {
    noFetch();
    const sig = stripeHeader(WEBHOOK_SECRET, eventBody);
    const tampered = eventBody.replace("pi_test_unknown", "pi_test_attacker");
    const res = await webhookPost(tampered, sig, env());
    expect(res.status).toBe(400);
  });

  it("verifies raw bytes, not re-serialized JSON: whitespace change fails", async () => {
    noFetch();
    const compact = JSON.stringify({ id: "evt_test_ws", object: "event", type: "x", n: 1 });
    const sig = stripeHeader(WEBHOOK_SECRET, compact);
    const spaced = JSON.stringify({ id: "evt_test_ws", object: "event", type: "x", n: 1 }, null, 2);
    expect(JSON.parse(spaced)).toEqual(JSON.parse(compact));
    const res = await webhookPost(spaced, sig, env());
    expect(res.status).toBe(400);
  });

  it("stale timestamp is 400", async () => {
    noFetch();
    const tenMinutesAgo = Math.floor(Date.now() / 1000) - 600;
    const res = await webhookPost(
      eventBody,
      stripeHeader(WEBHOOK_SECRET, eventBody, tenMinutesAgo),
      env(),
    );
    expect(res.status).toBe(400);
  });

  it("future timestamp beyond tolerance is 400", async () => {
    noFetch();
    const inTenMinutes = Math.floor(Date.now() / 1000) + 600;
    const res = await webhookPost(
      eventBody,
      stripeHeader(WEBHOOK_SECRET, eventBody, inTenMinutes),
      env(),
    );
    expect(res.status).toBe(400);
  });

  it("wrong-length and wrong-content signatures get identical 400s (no oracle)", async () => {
    noFetch();
    const t = Math.floor(Date.now() / 1000);
    const short = await webhookPost(eventBody, `t=${t},v1=abc123`, env());
    const wrong = await webhookPost(eventBody, `t=${t},v1=${"0".repeat(64)}`, env());
    expect(short.status).toBe(400);
    expect(wrong.status).toBe(400);
    expect(await short.text()).toBe(await wrong.text());
  });

  it("empty body is 400", async () => {
    noFetch();
    const res = await webhookPost("", stripeHeader(WEBHOOK_SECRET, ""), env());
    expect(res.status).toBe(400);
  });

  it("non-JSON body with a valid signature is 400", async () => {
    noFetch();
    const raw = "not json at all";
    const res = await webhookPost(raw, stripeHeader(WEBHOOK_SECRET, raw), env());
    expect(res.status).toBe(400);
  });

  it("valid signature, unknown event type: 200 ignored with no Stripe fetch", async () => {
    noFetch();
    const res = await webhookPost(eventBody, stripeHeader(WEBHOOK_SECRET, eventBody), env());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true });
  });

  it("accepts any matching v1 during secret rotation", async () => {
    noFetch();
    const t = Math.floor(Date.now() / 1000);
    const good = signStripePayload(WEBHOOK_SECRET, eventBody, t);
    const header = `t=${t},v1=${"0".repeat(64)},v1=${good}`;
    const res = await webhookPost(eventBody, header, env());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true });
  });

  it("GET on the webhook path stays 404 (POST-only)", async () => {
    const res = await app.request("/webhooks/stripe", { method: "GET" }, baseEnv());
    expect(res.status).toBe(404);
  });
});

describe("checkout and portal auth (DB-free)", () => {
  function memberEnv() {
    const sessions = createMemorySessionStore();
    return { sessions, env: baseEnv({ SESSION_STORE: sessions }) };
  }

  it("guest checkout redirects into auth, never 404 or 200", async () => {
    noFetch();
    const { env } = memberEnv();
    const res = await app.request(
      "/streaming/checkout",
      {
        method: "POST",
        headers: { origin: APP_URL, "content-type": "application/json" },
        body: JSON.stringify({ tier: "basic" }),
      },
      env,
    );
    expect([302, 303]).toContain(res.status);
    expect(res.headers.get("location") ?? "").toMatch(/\/auth\//);
  });

  it("guest portal redirects into auth", async () => {
    noFetch();
    const { env } = memberEnv();
    const res = await app.request(
      "/streaming/portal",
      { method: "POST", headers: { origin: APP_URL } },
      env,
    );
    expect([302, 303]).toContain(res.status);
    expect(res.headers.get("location") ?? "").toMatch(/\/auth\//);
  });

  it("signed-in non-member cannot check out (403)", async () => {
    noFetch();
    const { sessions, env } = memberEnv();
    const cookie = await cookieFor(sessions, OUTSIDER);
    const res = await app.request(
      "/streaming/checkout",
      {
        method: "POST",
        headers: { cookie, origin: APP_URL, "content-type": "application/json" },
        body: JSON.stringify({ tier: "basic" }),
      },
      env,
    );
    expect(res.status).toBe(403);
  });

  it("signed-in non-member cannot open the portal (403)", async () => {
    noFetch();
    const { sessions, env } = memberEnv();
    const cookie = await cookieFor(sessions, OUTSIDER);
    const res = await app.request(
      "/streaming/portal",
      { method: "POST", headers: { cookie, origin: APP_URL } },
      env,
    );
    expect(res.status).toBe(403);
  });

  it("member checkout without Origin is 403 (same-origin guard applies)", async () => {
    noFetch();
    const { sessions, env } = memberEnv();
    const cookie = await cookieFor(sessions, MEMBER);
    const res = await app.request(
      "/streaming/checkout",
      {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ tier: "basic" }),
      },
      env,
    );
    expect(res.status).toBe(403);
  });

  it.each([{ tier: "gold" }, { tier: "annual" }, {}])(
    "invalid tier is 400 before any Stripe call",
    async (body) => {
      noFetch();
      const { sessions, env } = memberEnv();
      const cookie = await cookieFor(sessions, MEMBER);
      const res = await app.request(
        "/streaming/checkout",
        {
          method: "POST",
          headers: { cookie, origin: APP_URL, "content-type": "application/json" },
          body: JSON.stringify(body),
        },
        env,
      );
      expect(res.status).toBe(400);
    },
  );

  it("Stripe failure on checkout is 502 without the upstream body", async () => {
    stubStripeApi(
      () =>
        new Response(JSON.stringify({ error: { message: "stripe-says-no-test-probe" } }), {
          status: 400,
          headers: { "content-type": "application/json" },
        }),
    );
    const { sessions, env } = memberEnv();
    const cookie = await cookieFor(sessions, MEMBER);
    const res = await app.request(
      "/streaming/checkout",
      {
        method: "POST",
        headers: { cookie, origin: APP_URL, "content-type": "application/json" },
        body: JSON.stringify({ tier: "basic" }),
      },
      env,
    );
    expect(res.status).toBe(502);
    expect(await res.text()).not.toContain("stripe-says-no-test-probe");
  });
});

describe("checkout creates a test-mode session (DB-free, stateless)", () => {
  async function checkout(tier: string) {
    const sessions = createMemorySessionStore();
    const env = baseEnv({ SESSION_STORE: sessions });
    const cookie = await cookieFor(sessions, MEMBER);
    const calls = stubStripeApi(
      () =>
        new Response(JSON.stringify({ id: "cs_test_acceptance", url: CHECKOUT_URL }), {
          headers: { "content-type": "application/json" },
        }),
    );
    const res = await app.request(
      "/streaming/checkout",
      {
        method: "POST",
        headers: { cookie, origin: APP_URL, "content-type": "application/json" },
        body: JSON.stringify({ tier }),
      },
      env,
    );
    return { res, calls };
  }

  it("basic is $5/mo recurring with member linkage", async () => {
    const { res, calls } = await checkout("basic");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ url: CHECKOUT_URL });
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe(`${STRIPE_API}/v1/checkout/sessions`);
    expect(bearerOf(call.init)).toBe(`Bearer ${STRIPE_SECRET}`);
    const form = formOf(call.init);
    expect(form.get("mode")).toBe("subscription");
    expect(form.get("line_items[0][price_data][unit_amount]")).toBe("500");
    expect(form.get("line_items[0][price_data][currency]")).toBe("usd");
    expect(form.get("line_items[0][price_data][recurring][interval]")).toBe("month");
    expect(form.get("client_reference_id")).toBe(MEMBER.userId);
    expect(form.get("metadata[tier]")).toBe("basic");
    expect(form.get("subscription_data[metadata][user_id]")).toBe(MEMBER.userId);
    expect(form.get("subscription_data[metadata][tier]")).toBe("basic");
    expect(form.get("success_url") ?? "").toMatch(/^https:\/\/next\.example\.test\//);
    expect(form.get("cancel_url") ?? "").toMatch(/^https:\/\/next\.example\.test\//);
  });

  it("plus is $15/mo recurring with member linkage", async () => {
    const { res, calls } = await checkout("plus");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ url: CHECKOUT_URL });
    const form = formOf(calls[0]!.init);
    expect(form.get("line_items[0][price_data][unit_amount]")).toBe("1500");
    expect(form.get("line_items[0][price_data][recurring][interval]")).toBe("month");
    expect(form.get("metadata[tier]")).toBe("plus");
    expect(form.get("subscription_data[metadata][tier]")).toBe("plus");
  });
});

describe("secret hygiene (controls: green before and after the slice)", () => {
  const repoRoot = fileURLToPath(new NodeURL("../", import.meta.url));
  // Live-key fragments stay split so the literals never appear in this file.
  const LIVE_KEY_FRAGMENTS = ["sk_" + "live_", "pk_" + "live_", "rk_" + "live_"];
  const CLIENT_DIRS = ["src/islands", "assets", "public", "web"];
  const SKIP_DIRS = new Set([
    ".git",
    "node_modules",
    "dist",
    "coverage",
    ".wrangler",
    "artifacts",
    "playwright-report",
    "test-results",
  ]);

  function* textFiles(dir: string): Generator<string> {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) yield* textFiles(join(dir, entry.name));
      } else if (entry.isFile()) {
        yield join(dir, entry.name);
      }
    }
  }

  function hitsIn(file: string, needles: string[]): string[] {
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      return [];
    }
    if (text.includes("\0")) return [];
    return needles.filter((needle) => text.includes(needle));
  }

  it("no live Stripe key literal anywhere in the repo", () => {
    const offenders: string[] = [];
    for (const file of textFiles(repoRoot)) {
      const hits = hitsIn(file, LIVE_KEY_FRAGMENTS);
      if (hits.length > 0) offenders.push(`${file} (${hits.join(",")})`);
      if (offenders.length >= 5) break;
    }
    expect(offenders).toEqual([]);
  });

  it("Stripe secrets stay out of client-reachable code", () => {
    const needles = [
      "STRIPE_SECRET",
      "STRIPE_WEBHOOK_SECRET",
      "sk_" + "test_",
      "sk_" + "live_",
      "pk_" + "test_",
      "pk_" + "live_",
    ];
    const offenders: string[] = [];
    for (const dir of CLIENT_DIRS) {
      for (const file of textFiles(join(repoRoot, dir))) {
        const hits = hitsIn(file, needles);
        if (hits.length > 0) offenders.push(`${file} (${hits.join(",")})`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

// Dynamic import by variable so this file typechecks before the Builder creates
// the module; a missing module fails the test with a BUILDER-tagged message,
// never with a compile error. Path and signature are pinned by the header.
const ENTITLEMENT_MODULE = "../src/streaming/entitlement";
type EntitlementModule = {
  isStreamingEntitled: (
    sub: { status: string; currentPeriodEnd: Date } | null | undefined,
    now?: Date,
  ) => boolean;
};

async function loadEntitlement(): Promise<EntitlementModule> {
  try {
    return (await import(/* @vite-ignore */ ENTITLEMENT_MODULE)) as EntitlementModule;
  } catch {
    expect.fail(
      "BUILDER: create src/streaming/entitlement.ts exporting " +
        "isStreamingEntitled(row, now?) (see the contract header of this file).",
    );
  }
}

describe.skipIf(!process.env.DATABASE_URL)("subscriptions slice (agent-testdb)", () => {
  let fixture: MemberDataFixture;
  beforeAll(async () => {
    fixture = await createMemberDataFixture(process.env.DATABASE_URL!);
  });
  afterAll(() => fixture?.dispose());

  async function reset(): Promise<void> {
    await fixture.reset();
  }

  function liveEnv(sessions?: SessionStore): TestEnv {
    return baseEnv({ SESSION_STORE: sessions, ADMIN_DB: fixture.db });
  }

  async function seedUser(userId: string, member: boolean): Promise<void> {
    await fixture.db.insert(users).values({ id: userId, username: `user-${userId}`, member });
  }

  describe("subscriptions schema", () => {
    it("subscriptions table exists once the migration lands", async () => {
      await reset();
      expect(await subscriptionsTableExists(fixture.client)).toBe(true);
    });

    it("columns, keys and user linkage match spec section 4", async () => {
      await reset();
      expect(await subscriptionsTableExists(fixture.client)).toBe(true);
      const columns = await fixture.client<{ column_name: string; is_nullable: string }[]>`
        SELECT column_name, is_nullable FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'subscriptions'`;
      const byName = new Map(columns.map((c) => [c.column_name, c.is_nullable]));
      for (const column of [
        "user_id",
        "stripe_customer_id",
        "stripe_subscription_id",
        "tier",
        "status",
        "current_period_start",
        "current_period_end",
        "cancel_at_period_end",
      ]) {
        expect(byName.has(column), `column ${column}`).toBe(true);
        expect(byName.get(column), `column ${column} NOT NULL`).toBe("NO");
      }
      const pk = await fixture.client<{ column_name: string }[]>`
        SELECT kcu.column_name FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name = kcu.constraint_name
          AND tc.table_schema = kcu.table_schema
        WHERE tc.table_schema = current_schema()
          AND tc.table_name = 'subscriptions' AND tc.constraint_type = 'PRIMARY KEY'`;
      expect(pk.map((r) => r.column_name)).toEqual(["user_id"]);
      const uniques = await fixture.client<{ column_name: string }[]>`
        SELECT kcu.column_name FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name = kcu.constraint_name
          AND tc.table_schema = kcu.table_schema
        WHERE tc.table_schema = current_schema()
          AND tc.table_name = 'subscriptions' AND tc.constraint_type = 'UNIQUE'`;
      expect(uniques.map((r) => r.column_name)).toContain("stripe_subscription_id");
      const fks = await fixture.client<{ column_name: string; foreign_table: string }[]>`
        SELECT kcu.column_name, ccu.table_name AS foreign_table
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name = kcu.constraint_name
          AND tc.table_schema = kcu.table_schema
        JOIN information_schema.constraint_column_usage ccu
          ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
        WHERE tc.table_schema = current_schema()
          AND tc.table_name = 'subscriptions' AND tc.constraint_type = 'FOREIGN KEY'`;
      expect(fks).toContainEqual({ column_name: "user_id", foreign_table: "users" });
    });

    it("users table gains no streaming columns", async () => {
      await reset();
      const columns = await fixture.client<{ column_name: string }[]>`
        SELECT column_name FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'users'`;
      const names = columns.map((c) => c.column_name);
      expect(names.filter((n) => /stream|subscri|tier|billing|stripe/i.test(n))).toEqual([]);
    });
  });

  describe("entitlement helper matrix", () => {
    const NOW = new Date("2026-10-22T12:00:00.000Z");
    const DAY_MS = 86400000;
    const row = (status: string, currentPeriodEnd: Date) => ({ status, currentPeriodEnd });

    it("active is entitled", async () => {
      const mod = await loadEntitlement();
      expect(mod.isStreamingEntitled(row("active", new Date(NOW.getTime() - DAY_MS)), NOW)).toBe(
        true,
      );
    });

    it("trialing is entitled", async () => {
      const mod = await loadEntitlement();
      expect(
        mod.isStreamingEntitled(row("trialing", new Date(NOW.getTime() + 7 * DAY_MS)), NOW),
      ).toBe(true);
    });

    it("past_due inside the 3-day grace is entitled", async () => {
      const mod = await loadEntitlement();
      expect(
        mod.isStreamingEntitled(row("past_due", new Date(NOW.getTime() - 2 * DAY_MS)), NOW),
      ).toBe(true);
    });

    it("past_due exactly at grace expiry is still entitled (inclusive)", async () => {
      const mod = await loadEntitlement();
      expect(
        mod.isStreamingEntitled(row("past_due", new Date(NOW.getTime() - 3 * DAY_MS)), NOW),
      ).toBe(true);
    });

    it("past_due past grace is not entitled", async () => {
      const mod = await loadEntitlement();
      expect(
        mod.isStreamingEntitled(row("past_due", new Date(NOW.getTime() - 3 * DAY_MS - 1000)), NOW),
      ).toBe(false);
    });

    it.each(["canceled", "paused", "incomplete", "incomplete_expired", "unpaid"])(
      "%s is never entitled",
      async (status) => {
        const mod = await loadEntitlement();
        expect(
          mod.isStreamingEntitled(row(status, new Date(NOW.getTime() + 30 * DAY_MS)), NOW),
        ).toBe(false);
      },
    );

    it("unknown future statuses fail closed", async () => {
      const mod = await loadEntitlement();
      expect(
        mod.isStreamingEntitled(row("weird_future", new Date(NOW.getTime() + 30 * DAY_MS)), NOW),
      ).toBe(false);
    });

    it("no subscription row is not entitled", async () => {
      const mod = await loadEntitlement();
      expect(mod.isStreamingEntitled(null, NOW)).toBe(false);
      expect(mod.isStreamingEntitled(undefined, NOW)).toBe(false);
    });
  });

  describe("portal session (test mode)", () => {
    it("member with a subscription gets a billing-portal URL for their customer", async () => {
      await reset();
      await seedUser(MEMBER.userId, true);
      const seeded = await seedSubscription(fixture.client, {
        userId: MEMBER.userId,
        tier: "plus",
        status: "active",
        stripeCustomerId: `cus_test_portal_${MEMBER.userId}`,
      });
      const sessions = createMemorySessionStore();
      const calls = stubStripeApi(
        () =>
          new Response(JSON.stringify({ url: PORTAL_URL }), {
            headers: { "content-type": "application/json" },
          }),
      );
      const cookie = await cookieFor(sessions, MEMBER);
      const res = await app.request(
        "/streaming/portal",
        { method: "POST", headers: { cookie, origin: APP_URL } },
        liveEnv(sessions),
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ url: PORTAL_URL });
      expect(calls).toHaveLength(1);
      const call = calls[0]!;
      expect(call.url).toBe(`${STRIPE_API}/v1/billing_portal/sessions`);
      expect(bearerOf(call.init)).toBe(`Bearer ${STRIPE_SECRET}`);
      const form = formOf(call.init);
      expect(form.get("customer")).toBe(seeded.stripeCustomerId);
      expect(form.get("return_url") ?? "").toMatch(/^https:\/\/next\.example\.test\//);
    });

    it("member without a subscription gets 404, with no Stripe call", async () => {
      await reset();
      await seedUser(MEMBER.userId, true);
      const sessions = createMemorySessionStore();
      const calls = stubStripeApi(() => new Response(JSON.stringify({ url: PORTAL_URL })));
      const cookie = await cookieFor(sessions, MEMBER);
      const res = await app.request(
        "/streaming/portal",
        { method: "POST", headers: { cookie, origin: APP_URL } },
        liveEnv(sessions),
      );
      expect(res.status).toBe(404);
      expect(calls).toHaveLength(0);
    });

    it("Stripe failure on portal is 502 without the upstream body", async () => {
      await reset();
      await seedUser(MEMBER.userId, true);
      await seedSubscription(fixture.client, { userId: MEMBER.userId });
      stubStripeApi(
        () =>
          new Response(JSON.stringify({ error: { message: "portal-says-no-test-probe" } }), {
            status: 500,
            headers: { "content-type": "application/json" },
          }),
      );
      const sessions = createMemorySessionStore();
      const cookie = await cookieFor(sessions, MEMBER);
      const res = await app.request(
        "/streaming/portal",
        { method: "POST", headers: { cookie, origin: APP_URL } },
        liveEnv(sessions),
      );
      expect(res.status).toBe(502);
      expect(await res.text()).not.toContain("portal-says-no-test-probe");
    });
  });

  describe("webhook event matrix", () => {
    function hashCode(s: string): number {
      let h = 0;
      for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
      return h;
    }

    async function postEvent(type: string, object: Record<string, unknown>): Promise<Response> {
      noFetch();
      const raw = JSON.stringify({
        id: `evt_test_${Math.abs(hashCode(type + JSON.stringify(object)))}`,
        object: "event",
        type,
        data: { object },
      });
      // Session-free by contract: no SESSION_STORE in this env.
      return webhookPost(raw, stripeHeader(WEBHOOK_SECRET, raw), liveEnv());
    }

    function subscriptionObject(overrides: Record<string, unknown> = {}): Record<string, unknown> {
      return {
        id: `sub_test_${MEMBER.userId}`,
        object: "subscription",
        customer: `cus_test_${MEMBER.userId}`,
        status: "active",
        current_period_start: Math.floor(Date.now() / 1000) - 86400,
        current_period_end: Math.floor(Date.now() / 1000) + 30 * 86400,
        cancel_at_period_end: false,
        metadata: { user_id: MEMBER.userId, tier: "basic" },
        ...overrides,
      };
    }

    it("checkout.session.completed creates an active basic row, member flag untouched", async () => {
      await reset();
      await seedUser(MEMBER.userId, false);
      const res = await postEvent("checkout.session.completed", {
        id: "cs_test_basic",
        object: "checkout.session",
        mode: "subscription",
        customer: `cus_test_${MEMBER.userId}`,
        subscription: `sub_test_${MEMBER.userId}`,
        client_reference_id: MEMBER.userId,
        metadata: { user_id: MEMBER.userId, tier: "basic" },
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ received: true });
      const stored = await readSubscription(fixture.client, MEMBER.userId);
      expect(stored).toMatchObject({
        userId: MEMBER.userId,
        stripeCustomerId: `cus_test_${MEMBER.userId}`,
        stripeSubscriptionId: `sub_test_${MEMBER.userId}`,
        tier: "basic",
        status: "active",
        cancelAtPeriodEnd: false,
      });
      expect(stored!.currentPeriodEnd.getTime()).toBeGreaterThan(Date.now());
      const mod = await loadEntitlement();
      expect(
        mod.isStreamingEntitled(
          { status: stored!.status, currentPeriodEnd: stored!.currentPeriodEnd },
          new Date(),
        ),
      ).toBe(true);
      const member = await fixture.client<{ member: boolean }[]>`
        SELECT member FROM users WHERE id = ${MEMBER.userId}`;
      expect(member[0]!.member).toBe(false);
    });

    it("checkout.session.completed creates an active plus row", async () => {
      await reset();
      await seedUser(MEMBER.userId, true);
      const res = await postEvent("checkout.session.completed", {
        id: "cs_test_plus",
        object: "checkout.session",
        mode: "subscription",
        customer: `cus_test_plus_${MEMBER.userId}`,
        subscription: `sub_test_plus_${MEMBER.userId}`,
        client_reference_id: MEMBER.userId,
        metadata: { user_id: MEMBER.userId, tier: "plus" },
      });
      expect(res.status).toBe(200);
      expect(await readSubscription(fixture.client, MEMBER.userId)).toMatchObject({
        tier: "plus",
        status: "active",
        stripeSubscriptionId: `sub_test_plus_${MEMBER.userId}`,
      });
    });

    it("checkout with an unknown tier is 400 with no row", async () => {
      await reset();
      await seedUser(MEMBER.userId, true);
      const res = await postEvent("checkout.session.completed", {
        id: "cs_test_gold",
        object: "checkout.session",
        mode: "subscription",
        customer: `cus_test_gold_${MEMBER.userId}`,
        subscription: `sub_test_gold_${MEMBER.userId}`,
        client_reference_id: MEMBER.userId,
        metadata: { user_id: MEMBER.userId, tier: "gold" },
      });
      expect(res.status).toBe(400);
      expect(await readSubscription(fixture.client, MEMBER.userId)).toBeNull();
    });

    it("checkout for an unknown user is 400, never 500", async () => {
      await reset();
      const res = await postEvent("checkout.session.completed", {
        id: "cs_test_ghost",
        object: "checkout.session",
        mode: "subscription",
        customer: "cus_test_ghost",
        subscription: "sub_test_ghost",
        client_reference_id: "999999999999999999",
        metadata: { user_id: "999999999999999999", tier: "basic" },
      });
      expect(res.status).toBe(400);
    });

    it("subscription.updated moves active to past_due, keeping the period", async () => {
      await reset();
      await seedUser(MEMBER.userId, true);
      const seeded = await seedSubscription(fixture.client, { userId: MEMBER.userId });
      const res = await postEvent(
        "customer.subscription.updated",
        subscriptionObject({ status: "past_due", cancel_at_period_end: true }),
      );
      expect(res.status).toBe(200);
      const stored = await readSubscription(fixture.client, MEMBER.userId);
      expect(stored).toMatchObject({ status: "past_due", cancelAtPeriodEnd: true });
      expect(stored!.currentPeriodEnd.getTime()).toBe(seeded.currentPeriodEnd.getTime());
    });

    it("subscription.created upserts an unknown subscription via metadata linkage", async () => {
      await reset();
      await seedUser(MEMBER.userId, true);
      const periodEnd = Math.floor(Date.now() / 1000) + 7 * 86400;
      const res = await postEvent(
        "customer.subscription.created",
        subscriptionObject({
          id: "sub_test_created_new",
          status: "trialing",
          current_period_end: periodEnd,
          metadata: { user_id: MEMBER.userId, tier: "plus" },
        }),
      );
      expect(res.status).toBe(200);
      expect(await readSubscription(fixture.client, MEMBER.userId)).toMatchObject({
        status: "trialing",
        tier: "plus",
        stripeSubscriptionId: "sub_test_created_new",
      });
    });

    it("deleted keeps the row as canceled (entitlement off)", async () => {
      await reset();
      await seedUser(MEMBER.userId, true);
      await seedSubscription(fixture.client, { userId: MEMBER.userId, status: "active" });
      const res = await postEvent(
        "customer.subscription.deleted",
        subscriptionObject({ status: "canceled" }),
      );
      expect(res.status).toBe(200);
      const stored = await readSubscription(fixture.client, MEMBER.userId);
      expect(stored).toMatchObject({ status: "canceled" });
      const mod = await loadEntitlement();
      expect(
        mod.isStreamingEntitled(
          { status: stored!.status, currentPeriodEnd: stored!.currentPeriodEnd },
          new Date(),
        ),
      ).toBe(false);
    });

    it("payment_failed flips active to past_due (grace starts at period end)", async () => {
      await reset();
      await seedUser(MEMBER.userId, true);
      await seedSubscription(fixture.client, { userId: MEMBER.userId, status: "active" });
      const res = await postEvent("invoice.payment_failed", {
        id: "in_test_failed",
        object: "invoice",
        customer: `cus_test_${MEMBER.userId}`,
        subscription: `sub_test_${MEMBER.userId}`,
        status: "open",
        attempt_count: 1,
      });
      expect(res.status).toBe(200);
      expect(await readSubscription(fixture.client, MEMBER.userId)).toMatchObject({
        status: "past_due",
      });
    });

    it("payment_succeeded recovers past_due to active", async () => {
      await reset();
      await seedUser(MEMBER.userId, true);
      await seedSubscription(fixture.client, { userId: MEMBER.userId, status: "past_due" });
      const res = await postEvent("invoice.payment_succeeded", {
        id: "in_test_paid",
        object: "invoice",
        customer: `cus_test_${MEMBER.userId}`,
        subscription: `sub_test_${MEMBER.userId}`,
        status: "paid",
        attempt_count: 1,
      });
      expect(res.status).toBe(200);
      expect(await readSubscription(fixture.client, MEMBER.userId)).toMatchObject({
        status: "active",
      });
    });

    it("unknown event type is 200 with no row change", async () => {
      await reset();
      await seedUser(MEMBER.userId, true);
      await seedSubscription(fixture.client, { userId: MEMBER.userId, status: "active" });
      const res = await postEvent("payment_intent.created", {
        id: "pi_test_other",
        object: "payment_intent",
        customer: `cus_test_${MEMBER.userId}`,
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ received: true });
      expect(await readSubscription(fixture.client, MEMBER.userId)).toMatchObject({
        status: "active",
      });
    });

    it("event without TWO linkage is 200 ignored (shared account sends Kofra events)", async () => {
      await reset();
      await seedUser(MEMBER.userId, true);
      const res = await postEvent("checkout.session.completed", {
        id: "cs_test_kofra",
        object: "checkout.session",
        mode: "payment",
        customer: "cus_kofra_unrelated",
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ received: true });
      expect(await readSubscription(fixture.client, MEMBER.userId)).toBeNull();
    });

    it("unknown future subscription status is stored verbatim, entitlement fails closed", async () => {
      await reset();
      await seedUser(MEMBER.userId, true);
      await seedSubscription(fixture.client, { userId: MEMBER.userId, status: "active" });
      const res = await postEvent(
        "customer.subscription.updated",
        subscriptionObject({ status: "weird_future" }),
      );
      expect(res.status).toBe(200);
      const stored = await readSubscription(fixture.client, MEMBER.userId);
      expect(stored!.status).toBe("weird_future");
      const mod = await loadEntitlement();
      expect(
        mod.isStreamingEntitled(
          { status: stored!.status, currentPeriodEnd: stored!.currentPeriodEnd },
          new Date(),
        ),
      ).toBe(false);
    });

    it("full journey: checkout then cancel then webhook-deleted ends entitled-off", async () => {
      await reset();
      await seedUser(MEMBER.userId, true);
      const completed = await postEvent("checkout.session.completed", {
        id: "cs_test_journey",
        object: "checkout.session",
        mode: "subscription",
        customer: `cus_test_${MEMBER.userId}`,
        subscription: `sub_test_${MEMBER.userId}`,
        client_reference_id: MEMBER.userId,
        metadata: { user_id: MEMBER.userId, tier: "basic" },
      });
      expect(completed.status).toBe(200);
      const mod = await loadEntitlement();
      const afterCheckout = await readSubscription(fixture.client, MEMBER.userId);
      expect(
        mod.isStreamingEntitled(
          { status: afterCheckout!.status, currentPeriodEnd: afterCheckout!.currentPeriodEnd },
          new Date(),
        ),
      ).toBe(true);
      const deleted = await postEvent(
        "customer.subscription.deleted",
        subscriptionObject({ status: "canceled" }),
      );
      expect(deleted.status).toBe(200);
      const afterDelete = await readSubscription(fixture.client, MEMBER.userId);
      expect(
        mod.isStreamingEntitled(
          { status: afterDelete!.status, currentPeriodEnd: afterDelete!.currentPeriodEnd },
          new Date(),
        ),
      ).toBe(false);
    });
  });

  describe("entitlement-off fixture for later slices", () => {
    it("ensureEntitlementOff deletes the row so later slices start clean", async () => {
      await reset();
      await seedUser(MEMBER.userId, true);
      await seedSubscription(fixture.client, { userId: MEMBER.userId, status: "active" });
      expect(await readSubscription(fixture.client, MEMBER.userId)).not.toBeNull();
      await ensureEntitlementOff(fixture.client, MEMBER.userId);
      expect(await readSubscription(fixture.client, MEMBER.userId)).toBeNull();
      const mod = await loadEntitlement();
      expect(mod.isStreamingEntitled(null, new Date())).toBe(false);
    });

    it("ensureEntitlementOff is a no-op without a row", async () => {
      await reset();
      await seedUser(MEMBER.userId, true);
      await ensureEntitlementOff(fixture.client, MEMBER.userId);
      expect(await readSubscription(fixture.client, MEMBER.userId)).toBeNull();
    });
  });
});

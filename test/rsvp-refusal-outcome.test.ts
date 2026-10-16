// RSVP refusal outcomes through the shared HTML outcome renderer.
//
// Card 26/43: the no-JS POST /e/:key/rsvp refusal page (paused/closed writes,
// throttled writes, outage writes) is a typed RsvpRefusalModel rendered once
// through renderHtmlOutcome, never by an inline c.html() call. The mutation
// itself stays Hono-owned and runs exactly once per POST; only the refusal
// rendering moves onto the shared interface, so a future Svelte SSR adapter
// consumes the same model with only the injected renderer changing.
//
// Part 1 is hermetic (no DB, no session): model mapping, outcome defaults and
// single-execution. Part 2 pins the live POST contract that the refactor must
// preserve byte-for-byte: statuses, Retry-After, copy, return link, focus and
// privacy.
import { Hono } from "hono";
import { serializeSigned } from "hono/utils/cookie";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import app from "./app";
import type { Env } from "../src/env";
import { RSVP_COPY, throttleWaitCopy } from "../src/islands/contracts-rsvp-button";
import { renderHtmlOutcome, type HtmlOutcome } from "../src/html-outcome";
import {
  RSVP_REFUSAL_GENERIC_MESSAGE,
  rsvpRefusalModelFor,
  rsvpRefusalOutcome,
  type RsvpRefusalModel,
} from "../src/events/rsvp-refusal";
import {
  createMemorySessionStore,
  hashToken,
  newSessionToken,
  type SessionStore,
} from "../src/sessions";
import {
  createMemberDataFixture,
  testDatabaseUrl,
  type MemberDataFixture,
} from "./helpers/member-data-db";
import { events } from "../src/db/admin-schema";

const APP_URL = "https://next.example.test";
const SESSION_SECRET = "test-session-secret-at-least-32-bytes-long";

const store: SessionStore = createMemorySessionStore();

async function cookieFor(userId: string): Promise<string> {
  const token = newSessionToken();
  await store.create({
    tokenHash: await hashToken(token),
    userId,
    username: userId,
    avatar: null,
    member: true,
    moderator: false,
    expiresAt: new Date(Date.now() + 3600_000),
  });
  return (
    await serializeSigned("__Host-two_session", token, SESSION_SECRET, {
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "Lax",
    })
  ).split(";")[0]!;
}

const baseEnv = {
  APP_URL,
  SESSION_SECRET,
  SESSION_STORE: store,
  DISCORD_CLIENT_ID: "client-id",
  DISCORD_GUILD_ID: "326474832151838730",
  DISCORD_INVITE_URL: "https://discord.gg/invite",
  DISCORD_CLIENT_SECRET: "client-secret",
  DISCORD_BOT_TOKEN: "bot-token",
} as unknown as Env;

const guestPost = (key: string, status: string, env: Env) =>
  app.request(
    `/e/${key}/rsvp`,
    {
      method: "POST",
      headers: {
        origin: APP_URL,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ status }),
    },
    env,
  );

// cookieFor is async; build the authed POST separately so the header is real.
async function authedPost(key: string, userId: string, status: string, env: Env) {
  return app.request(
    `/e/${key}/rsvp`,
    {
      method: "POST",
      headers: {
        cookie: await cookieFor(userId),
        origin: APP_URL,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ status }),
    },
    env,
  );
}

describe("rsvp refusal model", () => {
  it("maps a closed write onto the generic message with the event return path", () => {
    expect(rsvpRefusalModelFor({ status: 403, retryAfter: null, eventKey: "EVT" })).toEqual({
      title: RSVP_COPY.failedTitle,
      message: RSVP_REFUSAL_GENERIC_MESSAGE,
      returnPath: "/e/EVT",
    });
  });

  it("maps a throttled write onto the announced wait with the served seconds", () => {
    expect(rsvpRefusalModelFor({ status: 429, retryAfter: "7", eventKey: "EVT" })).toEqual({
      title: RSVP_COPY.failedTitle,
      message: throttleWaitCopy(7),
      returnPath: "/e/EVT",
    });
  });

  it("falls back to the moment copy when the 429 carries no usable Retry-After", () => {
    expect(rsvpRefusalModelFor({ status: 429, retryAfter: null, eventKey: "EVT" }).message).toBe(
      throttleWaitCopy(null),
    );
  });

  it("keeps non-throttle failures generic even with a Retry-After present", () => {
    expect(rsvpRefusalModelFor({ status: 503, retryAfter: "3", eventKey: "EVT" }).message).toBe(
      RSVP_REFUSAL_GENERIC_MESSAGE,
    );
  });
});

describe("rsvp refusal outcome", () => {
  const model: RsvpRefusalModel = {
    title: RSVP_COPY.failedTitle,
    message: RSVP_REFUSAL_GENERIC_MESSAGE,
    returnPath: "/e/EVT",
  };

  it("carries the controller status and headers without inventing its own", () => {
    // Cache posture and Vary ride the context presets the JSON controller set
    // before refusing; the outcome only forwards what the caller passes.
    const outcome = rsvpRefusalOutcome(model, () => "bytes", { status: 429 });
    expect(outcome.status).toBe(429);
    expect(outcome.headers).toBeUndefined();
    const withRetry = rsvpRefusalOutcome(model, () => "bytes", {
      status: 429,
      headers: { "Retry-After": "7" },
    });
    expect(withRetry.headers).toEqual({ "Retry-After": "7" });
  });

  it("executes the injected renderer exactly once per outcome object", async () => {
    let calls = 0;
    const renderer = () => {
      calls += 1;
      return `<p>${calls}</p>`;
    };
    const outcome: HtmlOutcome<RsvpRefusalModel> = rsvpRefusalOutcome(model, renderer, {
      status: 403,
    });
    const probe = new Hono<{ Bindings: Env }>();
    probe.get("/once", (c) => renderHtmlOutcome(c, outcome));
    probe.get("/twice", async (c) => {
      const first = await renderHtmlOutcome(c, outcome);
      void first;
      return renderHtmlOutcome(c, outcome);
    });
    const first = await probe.request("/once", {}, baseEnv);
    expect(await first.text()).toBe("<p>1</p>");
    const second = await probe.request("/twice", {}, baseEnv);
    // A re-read of the same outcome object never re-renders: the mutation
    // result is computed once, and only the bytes are buffered again.
    expect(await second.text()).toBe("<p>1</p>");
    expect(calls).toBe(1);
  });
});

describe("POST /e/:key/rsvp refusal contract (preserved through the refactor)", () => {
  it("redirects a guest POST to login without rendering the refusal", async () => {
    const res = await guestPost("01ARZ3NDEKTSV4RRFFQ69G5FAA", "going", baseEnv);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toContain("/join/discord?next=");
  });

  it("renders the 503 refusal as branded HTML when the database is unavailable", async () => {
    // No ADMIN_DB/DB in baseEnv: the write cannot run, so the adapter answers
    // the refusal page instead of JSON. No session or DB content may leak.
    const res = await authedPost("01ARZ3NDEKTSV4RRFFQ69G5FAA", "u1", "going", baseEnv);
    expect(res.status).toBe(503);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    const html = await res.text();
    // Hono JSX escapes the apostrophe; the served bytes carry &#39;.
    expect(html).toContain(`<h1>${RSVP_COPY.failedTitle.replaceAll("'", "&#39;")}</h1>`);
    expect(html).toContain('role="alert"');
    expect(html).toContain(RSVP_REFUSAL_GENERIC_MESSAGE);
    expect(html).toContain('href="/e/01ARZ3NDEKTSV4RRFFQ69G5FAA"');
    expect(html).toContain("Return to the event");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("u1");
  });
});

describe.skipIf(!process.env.DATABASE_URL)(
  "POST /e/:key/rsvp stored refusals (agent-testdb)",
  () => {
    let fixture: MemberDataFixture;
    let db: MemberDataFixture["db"];
    const sent: unknown[] = [];
    const env = {
      ...baseEnv,
      get ADMIN_DB() {
        return db;
      },
      SYNC_EVENT_QUEUE: { send: async (m: unknown) => void sent.push(m) },
    } as unknown as Env;

    beforeAll(async () => {
      fixture = await createMemberDataFixture(process.env.DATABASE_URL!, { max: 5 });
      db = fixture.db;
    });
    beforeEach(async () => {
      await fixture.client`delete from web_throttle_hits`;
      await fixture.reset();
      sent.length = 0;
    });
    afterAll(async () => {
      await fixture?.dispose();
    });

    const seed = async (over: Partial<typeof events.$inferInsert> = {}) => {
      const key = `01ARZ3NDEKTSV4RRFFQ69G${Math.random()
        .toString(36)
        .slice(2, 6)
        .toUpperCase()
        .replace(/[^0-9A-HJKMNP-TV-Z]/g, "5")}`.slice(0, 26);
      const [row] = await db
        .insert(events)
        .values({
          eventKey: key,
          title: "Refusal night",
          startsAt: new Date(Date.now() + 3600_000),
          endsAt: new Date(Date.now() + 7200_000),
          status: "published",
          ...over,
        })
        .returning();
      return row!;
    };

    it("renders the paused refusal with 403, no Retry-After and the return link", async () => {
      const row = await seed({ rsvpOpen: false });
      const res = await authedPost(row.eventKey, "paused-member", "going", env);
      expect(res.status).toBe(403);
      expect(res.headers.get("retry-after")).toBeNull();
      expect(res.headers.get("cache-control")).toBe("private, no-store");
      const html = await res.text();
      // Hono JSX escapes the apostrophe; the served bytes carry &#39;.
      expect(html).toContain(`<h1>${RSVP_COPY.failedTitle.replaceAll("'", "&#39;")}</h1>`);
      expect(html).toContain('role="alert"');
      expect(html).toContain(RSVP_REFUSAL_GENERIC_MESSAGE);
      expect(html).toContain(`href="/e/${row.eventKey}"`);
      expect(html).toContain("Return to the event");
      expect(html).not.toContain("<script");
      expect(html).not.toContain("paused-member");
    });

    it("renders the throttled refusal with Retry-After and the announced wait", async () => {
      const row = await seed();
      const submit = (status: string) => authedPost(row.eventKey, "busy-member", status, env);
      for (let i = 0; i < 4; i++) {
        const ok = await submit("going");
        expect(ok.status).toBe(303);
        expect(ok.headers.get("location")).toBe(`/e/${row.eventKey}`);
      }
      // Spend the rest of the shared twelve-write budget through JSON so the
      // POST below is the thirteenth accepted-window write.
      for (let i = 0; i < 8; i++) {
        await app.request(
          `/events/${row.eventKey}/rsvp`,
          {
            method: "PUT",
            headers: {
              cookie: await cookieFor("busy-member"),
              origin: APP_URL,
              "content-type": "application/json",
            },
            body: JSON.stringify({ status: "going" }),
          },
          env,
        );
      }
      const limited = await submit("going");
      expect(limited.status).toBe(429);
      const retryAfter = limited.headers.get("retry-after");
      expect(Number(retryAfter)).toBeGreaterThanOrEqual(1);
      // The throttle controller overwrites the write entry's preset with its own
      // directive order; the refusal keeps the served value verbatim.
      expect(limited.headers.get("cache-control")).toBe("no-store, private");
      const html = await limited.text();
      // Hono JSX escapes the apostrophe; the served bytes carry &#39;.
      expect(html).toContain(`<h1>${RSVP_COPY.failedTitle.replaceAll("'", "&#39;")}</h1>`);
      expect(html).toContain('role="alert"');
      expect(html).toContain(throttleWaitCopy(Number(retryAfter)));
      expect(html).toContain(`href="/e/${row.eventKey}"`);
      expect(html).not.toContain("<script");
      expect(html).not.toContain("busy-member");
    });
  },
);

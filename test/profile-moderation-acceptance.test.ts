// Profile moderation acceptance: report button + moderator field hiding.
//
// FAIL-FIRST OWNERSHIP: this file is owned by the acceptance card. The Builder
// implements against it and never edits it. Most tests below are RED until the
// moderation slice lands; tests marked PIN pass both before and after and guard
// behavior the slice must not change.
//
// Spec interface (the contract the Builder implements):
//
// - POST /members/:user/report — report a profile. `:user` is a snowflake or a
//   handle (case-insensitive, citext parity). Open to every viewer class:
//   guest, signed-in non-member, member, owner and moderator. The reporter is
//   attributed when signed in, null for guests. Guests post the handle, never
//   the snowflake: public HTML must never carry a Discord id, so the report
//   form cannot name the numeric subject.
//   - JSON `{ reason }` -> 200 `{ reported: true }`.
//   - Form `reason=...` -> 303 to `/members/<subject snowflake>`.
//   - `reason`: required, trimmed non-empty, at most 500 code points, no NUL.
//     Anything else is 422 (`{ errors: { reason } }` for JSON).
//   - Unknown subject -> 404. No queue row, no audit row, whatever the viewer.
//   - Rate-limited through the shared `throttle` dep, consulted before any
//     store read or write (invalid bodies and unknown subjects still spend
//     budget). Buckets: `profile-report:user:<id>` signed in,
//     `profile-report:ip:<cf-connecting-ip>` for guests. A limited verdict is
//     the shared 429 shape with a Retry-After header and no queue row.
//   - Default budget: PROFILE_REPORT_THROTTLE_PER_MINUTE = 10 on the profiles
//     barrel. Reports are rare and abuse-prone; 10/min is generous for a
//     human and cheap on web_throttle_hits. Profile writes keep 30/min.
//   - Each accepted report creates exactly one queue item
//     `{ subjectUserId, reporterId, reason, createdAt }` through the
//     `reportStore` dep. Reports are member/guest actions: they write NO
//     audit row.
//   - Same-origin still applies (global middleware): a foreign Origin is 403
//     with no queue row. Never add a report exemption.
// - POST /members/:user/hide — hide or unhide ONE field. `:user` is a
//   snowflake only (moderator tool; no public HTML involved). Moderator bit
//   required, ownership irrelevant: guest writes take the established
//   expired-write bounce (401 for JSON, 303 recovery for forms); any signed-in
//   non-moderator (member, owner, outsider) is 403.
//   - Body `{ field, hidden }`. JSON booleans are strict; forms send
//     `hidden=true|false` strings. Extra keys are 422 (whole-write refusal,
//     like profile saves): no key may smuggle content past the hide.
//   - Hideable: bio, games, timezone, steam, links, featured_games, banner.
//     Identity and rank facts (username, avatar, rank, member_since) are
//     never hideable: 422. Unknown subjects are 404.
//   - JSON -> 200 `{ field, hidden }`; form -> 303 to `/members/:user`.
//   - State lives behind the `moderationStore` dep
//     (`hiddenFields(userId)`, `setHidden(userId, field, hidden)`); the
//     profile store rows are never rewritten by a hide.
//   - Every accepted request audits exactly one row through the
//     `moderationAudit` sink — even a redundant hide — with
//     `{ subjectType: "Profile", subjectId, causerId, description:
//     "hid|unhid profile field <field>", properties: { <field>:
//     { before, after } } }` (booleans). Refused requests audit nothing.
// - Hidden-field visibility on profile reads:
//   - members (and guests on the public page) no longer see the field;
//   - the owner still sees it, with a `data-testid="profile-hidden-notice"`,
//   - moderators still see it.
//   - Each field hides independently: hiding bio leaves games visible.
// - No moderator edit beyond hiding: PATCH (and the form-override POST) on
//   another member's profile stays owner-only; hide/unhide never changes the
//   member's stored bio, games or timezone.
//
// Seams (all optional ProfileDeps, memory-fakeable; the Builder adds them):
// `reportStore.create`, `moderationStore.hiddenFields/setHidden`,
// `moderationAudit(entry)`, and `store.findByHandle(handle)` for
// handle-addressed reports (drizzle version reads profiles.handle once the
// schema slice lands; until then handle reports cannot resolve).
//
// Builder checklist beyond the tests: add both routes to
// test/fixtures/route-inventory.json with `// route-inventory:` references
// (this file deliberately carries none: a reference without a fixture entry
// fails the inventory guard as stale) plus `METHOD /pattern` entries in
// docs/parity.md or docs/url-freeze.md; surface the queue where moderators
// work; run the staging journey below.
//
// The `as unknown as ProfileDeps` casts keep this file type-clean while the
// deps do not exist yet: RED is behavioral (404/302 where the contract wants
// 200/303/429/422), never a collection or type error.
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { AccessEntry } from "../src/access-log";
import type { Env } from "../src/env";
import * as profilesBarrel from "../src/profiles/routes";
import { profilesApp } from "../src/profiles/routes";
import type { ProfileDeps } from "../src/profiles/routes-shared";
import { createMemoryProfileStore, type MemberView } from "../src/profiles/store";
import { sameOrigin } from "../src/same-origin";
import {
  createMemorySessionStore,
  hashToken,
  newSessionToken,
  type SessionStore,
} from "../src/sessions";

const SESSION_SECRET = "test-session-secret-at-least-32-bytes-long";
const APP_URL = "https://next.example.test";
const env: Env = {
  APP_URL,
  DISCORD_CLIENT_ID: "client-id",
  DISCORD_GUILD_ID: "326474832151838730",
  DISCORD_INVITE_URL: "https://discord.gg/invite",
  DISCORD_CLIENT_SECRET: "client-secret",
  DISCORD_BOT_TOKEN: "bot-token",
  SESSION_SECRET,
};

const ALICE = { userId: "100000000000000001", username: "alice", member: true, moderator: false };
const BOB = { userId: "100000000000000002", username: "bob", member: true, moderator: false };
const MOD = { userId: "100000000000000003", username: "mod", member: true, moderator: true };
const OUTSIDER = {
  userId: "100000000000000004",
  username: "outsider",
  member: false,
  moderator: false,
};
const UNKNOWN_SNOWFLAKE = "100000000000000009";

type Actor = typeof ALICE;

async function cookieFor(store: SessionStore, row: Actor): Promise<string> {
  const token = newSessionToken();
  await store.create({
    tokenHash: await hashToken(token),
    userId: row.userId,
    username: row.username,
    avatar: null,
    member: row.member,
    moderator: row.moderator,
    expiresAt: new Date(Date.now() + 3600_000),
  });
  const { serializeSigned } = await import("hono/utils/cookie");
  const serialized = await serializeSigned("__Host-two_session", token, SESSION_SECRET, {
    path: "/",
    secure: true,
    httpOnly: true,
    sameSite: "Lax",
  });
  return serialized.split(";")[0]!;
}

type ReportRow = {
  id: number;
  subjectUserId: string;
  reporterId: string | null;
  reason: string;
  createdAt: Date;
};

type AuditEntry = {
  subjectType: string;
  subjectId: string;
  causerId: string | null;
  description: string;
  properties: Record<string, { before: unknown; after: unknown }>;
};

type Verdict = { limited: false } | { limited: true; retryAfter: number };

const seedMembers = (): MemberView[] => [
  {
    id: ALICE.userId,
    username: "alice",
    avatar: null,
    bio: "Alice bio text 7f3a",
    games: ["Chess", "Go"],
    timezone: "Europe/London",
  },
  {
    id: BOB.userId,
    username: "bob",
    avatar: null,
    bio: "Bob bio text 9c1e",
    games: ["Checkers"],
    timezone: "America/New_York",
  },
  { id: MOD.userId, username: "mod", avatar: null, bio: null, games: [], timezone: null },
];

const HANDLES: Record<string, string> = {
  alice: ALICE.userId,
  bob: BOB.userId,
  mod: MOD.userId,
};

function harness(opts: { throttle?: (bucket: string) => Promise<Verdict> } = {}) {
  const sessions = createMemorySessionStore();
  const memory = createMemoryProfileStore(seedMembers());
  const store = {
    ...memory,
    findByHandle: async (handle: string): Promise<MemberView | null> => {
      const id = HANDLES[handle.toLowerCase()];
      return id ? memory.find(id) : null;
    },
  };
  const reports: ReportRow[] = [];
  const hidden = new Map<string, Set<string>>();
  const audits: AuditEntry[] = [];
  const throttleSeen: string[] = [];
  const log: AccessEntry[] = [];
  const app = profilesApp({
    sessionStore: sessions,
    store,
    accessLog: async (e: AccessEntry) => {
      const subjects = [...new Set(e.subjectUserIds.filter((s: string) => s !== e.viewerUserId))];
      if (subjects.length === 0) return false;
      log.push({ ...e, subjectUserIds: subjects });
      return true;
    },
    reportStore: {
      create: async (item: {
        subjectUserId: string;
        reporterId: string | null;
        reason: string;
      }): Promise<ReportRow> => {
        const row: ReportRow = {
          id: reports.length + 1,
          ...item,
          createdAt: new Date(),
        };
        reports.push(row);
        return row;
      },
    },
    moderationStore: {
      hiddenFields: async (userId: string): Promise<string[]> => [...(hidden.get(userId) ?? [])],
      setHidden: async (userId: string, field: string, isHidden: boolean): Promise<void> => {
        const set = hidden.get(userId) ?? new Set<string>();
        if (isHidden) set.add(field);
        else set.delete(field);
        hidden.set(userId, set);
      },
    },
    moderationAudit: async (entry: AuditEntry): Promise<void> => {
      audits.push(entry);
    },
    ...(opts.throttle
      ? {
          throttle: async (bucket: string): Promise<Verdict> => {
            throttleSeen.push(bucket);
            return opts.throttle!(bucket);
          },
        }
      : {}),
  } as unknown as ProfileDeps);
  const hiddenList = (userId: string): string[] => [...(hidden.get(userId) ?? [])].sort();
  return { app, sessions, store: memory, reports, hiddenList, audits, throttleSeen, log };
}

const jsonPost = (cookie: string | null, body: unknown, extra: Record<string, string> = {}) => ({
  method: "POST" as const,
  headers: {
    "content-type": "application/json",
    accept: "application/json",
    ...(cookie ? { cookie } : {}),
    ...extra,
  },
  body: JSON.stringify(body),
});

const formPost = (
  cookie: string | null,
  fields: Record<string, string>,
  extra: Record<string, string> = {},
) => ({
  method: "POST" as const,
  headers: {
    cookie: cookie ?? "",
    origin: APP_URL,
    "content-type": "application/x-www-form-urlencoded",
    ...extra,
  },
  body: new URLSearchParams(fields),
});

describe("report: default budget", () => {
  it("pins PROFILE_REPORT_THROTTLE_PER_MINUTE = 10 on the profiles barrel", () => {
    const budget = (profilesBarrel as unknown as Record<string, unknown>)
      .PROFILE_REPORT_THROTTLE_PER_MINUTE;
    expect(budget).toBe(10);
  });
});

describe("report: submission and queue item", () => {
  it("member JSON report creates one queue item with reporter and reason", async () => {
    const { app, sessions, reports, audits } = harness();
    const res = await app.request(
      `/members/${ALICE.userId}/report`,
      jsonPost(await cookieFor(sessions, BOB), { reason: "  spam links  " }),
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ reported: true });
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      subjectUserId: ALICE.userId,
      reporterId: BOB.userId,
      reason: "spam links",
    });
    expect(reports[0]!.createdAt).toBeInstanceOf(Date);
    expect(audits).toHaveLength(0);
  });

  it("guest report is accepted with a null reporter", async () => {
    const { app, reports, audits } = harness();
    const res = await app.request(
      `/members/${ALICE.userId}/report`,
      jsonPost(null, { reason: "impersonation" }, { "cf-connecting-ip": "203.0.113.7" }),
      env,
    );
    expect(res.status).toBe(200);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      subjectUserId: ALICE.userId,
      reporterId: null,
      reason: "impersonation",
    });
    expect(audits).toHaveLength(0);
  });

  it("moderator and outsider reports are attributed like any signed-in viewer", async () => {
    const { app, sessions, reports } = harness();
    for (const actor of [MOD, OUTSIDER]) {
      const res = await app.request(
        `/members/${ALICE.userId}/report`,
        jsonPost(await cookieFor(sessions, actor), { reason: `flagged by ${actor.username}` }),
        env,
      );
      expect(res.status, actor.username).toBe(200);
    }
    expect(reports.map((r) => r.reporterId)).toEqual([MOD.userId, OUTSIDER.userId]);
  });

  it("self-report is accepted (moderators triage, the endpoint does not judge)", async () => {
    const { app, sessions, reports } = harness();
    const res = await app.request(
      `/members/${ALICE.userId}/report`,
      jsonPost(await cookieFor(sessions, ALICE), { reason: "testing the button" }),
      env,
    );
    expect(res.status).toBe(200);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ subjectUserId: ALICE.userId, reporterId: ALICE.userId });
  });

  it("form report 303s to the subject's canonical member URL", async () => {
    const { app, sessions, reports } = harness();
    const res = await app.request(
      `/members/${ALICE.userId}/report`,
      formPost(await cookieFor(sessions, BOB), { reason: "spam links" }),
      env,
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/members/${ALICE.userId}`);
    expect(reports).toHaveLength(1);
  });

  it("handle-addressed report resolves case-insensitively and redirects to the snowflake URL", async () => {
    const { app, reports } = harness();
    const res = await app.request(
      "/members/AlIcE/report",
      formPost(null, { reason: "spam links" }),
      env,
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/members/${ALICE.userId}`);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ subjectUserId: ALICE.userId, reporterId: null });
  });

  it("unknown snowflake and unknown handle are 404 with no queue row and no audit", async () => {
    const { app, sessions, reports, audits } = harness();
    const cookie = await cookieFor(sessions, BOB);
    for (const subject of [UNKNOWN_SNOWFLAKE, "no-such-handle"]) {
      const res = await app.request(
        `/members/${subject}/report`,
        jsonPost(cookie, { reason: "spam" }),
        env,
      );
      expect(res.status, subject).toBe(404);
    }
    const guest = await app.request(
      `/members/${UNKNOWN_SNOWFLAKE}/report`,
      jsonPost(null, { reason: "spam" }),
      env,
    );
    expect(guest.status).toBe(404);
    expect(reports).toHaveLength(0);
    expect(audits).toHaveLength(0);
  });

  it("PIN: foreign Origin stays 403 behind the global middleware with no queue row", async () => {
    const { app, reports } = harness();
    const mounted = new Hono<{ Bindings: Env }>().use("*", sameOrigin).route("/", app);
    const res = await mounted.request(
      `/members/${ALICE.userId}/report`,
      formPost(null, { reason: "spam" }, { origin: "https://evil.example" }),
      env,
    );
    expect(res.status).toBe(403);
    expect(reports).toHaveLength(0);
  });
});

describe("report: reason validation", () => {
  it.each([{ body: {} }, { body: { reason: "   " } }, { body: { reason: "x".repeat(501) } }])(
    "JSON rejects an invalid reason with 422 errors and no queue row: %o",
    async ({ body }) => {
      const { app, sessions, reports, audits } = harness();
      const res = await app.request(
        `/members/${ALICE.userId}/report`,
        jsonPost(await cookieFor(sessions, BOB), body),
        env,
      );
      expect(res.status).toBe(422);
      const payload = (await res.json()) as { errors: Record<string, string> };
      expect(typeof payload.errors.reason).toBe("string");
      expect(payload.errors.reason?.length).toBeGreaterThan(0);
      expect(reports).toHaveLength(0);
      expect(audits).toHaveLength(0);
    },
  );

  it("JSON accepts a 500-code-point reason", async () => {
    const { app, sessions, reports } = harness();
    const res = await app.request(
      `/members/${ALICE.userId}/report`,
      jsonPost(await cookieFor(sessions, BOB), { reason: "x".repeat(500) }),
      env,
    );
    expect(res.status).toBe(200);
    expect(reports).toHaveLength(1);
  });

  it("JSON rejects NUL in the reason", async () => {
    const { app, sessions, reports } = harness();
    const res = await app.request(
      `/members/${ALICE.userId}/report`,
      jsonPost(await cookieFor(sessions, BOB), { reason: "spam\0links" }),
      env,
    );
    expect(res.status).toBe(422);
    expect(reports).toHaveLength(0);
  });

  it("extra keys are refused (no reporter spoofing past attribution)", async () => {
    const { app, sessions, reports } = harness();
    const res = await app.request(
      `/members/${ALICE.userId}/report`,
      jsonPost(await cookieFor(sessions, BOB), { reason: "spam", reporterId: MOD.userId }),
      env,
    );
    expect(res.status).toBe(422);
    expect(reports).toHaveLength(0);
  });

  it("form rejects a blank reason with 422 and no queue row", async () => {
    const { app, sessions, reports } = harness();
    const res = await app.request(
      `/members/${ALICE.userId}/report`,
      formPost(await cookieFor(sessions, BOB), { reason: "  " }),
      env,
    );
    expect(res.status).toBe(422);
    expect(await res.text()).toMatch(/reason/i);
    expect(reports).toHaveLength(0);
  });
});

describe("report: rate limiting", () => {
  it("throttle precedes validation: a blank reason still spends budget, then 422s", async () => {
    const { app, sessions, reports, throttleSeen } = harness({
      throttle: async () => ({ limited: false }),
    });
    const res = await app.request(
      `/members/${ALICE.userId}/report`,
      jsonPost(await cookieFor(sessions, BOB), { reason: "  " }),
      env,
    );
    expect(res.status).toBe(422);
    expect(throttleSeen).toHaveLength(1);
    expect(reports).toHaveLength(0);
  });

  it("throttle precedes subject lookup: unknown subjects still spend budget, then 404", async () => {
    const { app, sessions, throttleSeen } = harness({
      throttle: async () => ({ limited: false }),
    });
    const res = await app.request(
      `/members/${UNKNOWN_SNOWFLAKE}/report`,
      jsonPost(await cookieFor(sessions, BOB), { reason: "spam" }),
      env,
    );
    expect(res.status).toBe(404);
    expect(throttleSeen).toHaveLength(1);
  });

  it("signed-in bucket names the reporter", async () => {
    const { app, sessions, throttleSeen } = harness({
      throttle: async () => ({ limited: false }),
    });
    const res = await app.request(
      `/members/${ALICE.userId}/report`,
      jsonPost(await cookieFor(sessions, BOB), { reason: "spam" }),
      env,
    );
    expect(res.status).toBe(200);
    expect(throttleSeen).toHaveLength(1);
    expect(throttleSeen[0]).toContain("profile-report");
    expect(throttleSeen[0]).toContain(BOB.userId);
  });

  it("guest bucket names the connecting IP", async () => {
    const { app, throttleSeen } = harness({ throttle: async () => ({ limited: false }) });
    const res = await app.request(
      `/members/${ALICE.userId}/report`,
      jsonPost(null, { reason: "spam" }, { "cf-connecting-ip": "203.0.113.9" }),
      env,
    );
    expect(res.status).toBe(200);
    expect(throttleSeen).toHaveLength(1);
    expect(throttleSeen[0]).toContain("profile-report");
    expect(throttleSeen[0]).toContain("203.0.113.9");
  });

  it("limited JSON report is 429 with Retry-After, rate_limited reason and no queue row", async () => {
    const { app, sessions, reports } = harness({
      throttle: async () => ({ limited: true, retryAfter: 42 }),
    });
    const res = await app.request(
      `/members/${ALICE.userId}/report`,
      jsonPost(await cookieFor(sessions, BOB), { reason: "spam" }),
      env,
    );
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("42");
    const payload = (await res.json()) as { reason: string };
    expect(payload.reason).toBe("rate_limited");
    expect(reports).toHaveLength(0);
  });

  it("limited form report is 429 with Retry-After and no queue row", async () => {
    const { app, sessions, reports } = harness({
      throttle: async () => ({ limited: true, retryAfter: 17 }),
    });
    const res = await app.request(
      `/members/${ALICE.userId}/report`,
      formPost(await cookieFor(sessions, BOB), { reason: "spam" }),
      env,
    );
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("17");
    expect(reports).toHaveLength(0);
  });

  it("limited guest report is 429 with no queue row", async () => {
    const { app, reports } = harness({
      throttle: async () => ({ limited: true, retryAfter: 60 }),
    });
    const res = await app.request(
      `/members/${ALICE.userId}/report`,
      jsonPost(null, { reason: "spam" }, { "cf-connecting-ip": "203.0.113.11" }),
      env,
    );
    expect(res.status).toBe(429);
    expect(reports).toHaveLength(0);
  });
});

describe("hide: authorization matrix", () => {
  it("PIN: guest JSON hide takes the expired-write 401 with no state change and no audit", async () => {
    const { app, hiddenList, audits } = harness();
    const res = await app.request(
      `/members/${ALICE.userId}/hide`,
      jsonPost(null, { field: "bio", hidden: true }),
      env,
    );
    expect(res.status).toBe(401);
    const payload = (await res.json()) as { error: string; recovery: string };
    expect(payload.error).toBe("Unauthorized");
    expect(typeof payload.recovery).toBe("string");
    expect(hiddenList(ALICE.userId)).toEqual([]);
    expect(audits).toHaveLength(0);
  });

  it("PIN: guest form hide takes the expired-write 303 with no state change and no audit", async () => {
    const { app, hiddenList, audits } = harness();
    const res = await app.request(
      `/members/${ALICE.userId}/hide`,
      formPost(null, { field: "bio", hidden: "true" }),
      env,
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toContain("/auth/recover");
    expect(hiddenList(ALICE.userId)).toEqual([]);
    expect(audits).toHaveLength(0);
  });

  it.each([
    ["member", BOB],
    ["owner", ALICE],
    ["outsider", OUTSIDER],
  ])("%s is 403 with no state change and no audit", async (_label, actor) => {
    const { app, sessions, hiddenList, audits } = harness();
    const res = await app.request(
      `/members/${ALICE.userId}/hide`,
      jsonPost(await cookieFor(sessions, actor), { field: "bio", hidden: true }),
      env,
    );
    expect(res.status).toBe(403);
    expect(hiddenList(ALICE.userId)).toEqual([]);
    expect(audits).toHaveLength(0);
  });

  it("moderator hides with 200, seam state and exactly one audit row", async () => {
    const { app, sessions, hiddenList, audits } = harness();
    const res = await app.request(
      `/members/${ALICE.userId}/hide`,
      jsonPost(await cookieFor(sessions, MOD), { field: "bio", hidden: true }),
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ field: "bio", hidden: true });
    expect(hiddenList(ALICE.userId)).toEqual(["bio"]);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toEqual({
      subjectType: "Profile",
      subjectId: ALICE.userId,
      causerId: MOD.userId,
      description: "hid profile field bio",
      properties: { bio: { before: false, after: true } },
    });
  });

  it("moderator unhide restores with 200 and one audit row", async () => {
    const { app, sessions, hiddenList, audits } = harness();
    const cookie = await cookieFor(sessions, MOD);
    const hide = await app.request(
      `/members/${ALICE.userId}/hide`,
      jsonPost(cookie, { field: "bio", hidden: true }),
      env,
    );
    expect(hide.status).toBe(200);
    const unhide = await app.request(
      `/members/${ALICE.userId}/hide`,
      jsonPost(cookie, { field: "bio", hidden: false }),
      env,
    );
    expect(unhide.status).toBe(200);
    expect(await unhide.json()).toEqual({ field: "bio", hidden: false });
    expect(hiddenList(ALICE.userId)).toEqual([]);
    expect(audits).toHaveLength(2);
    expect(audits[1]).toEqual({
      subjectType: "Profile",
      subjectId: ALICE.userId,
      causerId: MOD.userId,
      description: "unhid profile field bio",
      properties: { bio: { before: true, after: false } },
    });
  });

  it("owner-moderator may hide on their own profile (the bit governs, still audited)", async () => {
    const { app, sessions, hiddenList, audits } = harness();
    const res = await app.request(
      `/members/${MOD.userId}/hide`,
      jsonPost(await cookieFor(sessions, MOD), { field: "bio", hidden: true }),
      env,
    );
    expect(res.status).toBe(200);
    expect(hiddenList(MOD.userId)).toEqual(["bio"]);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ subjectId: MOD.userId, causerId: MOD.userId });
  });

  it("form hide 303s to the subject's member URL", async () => {
    const { app, sessions, hiddenList, audits } = harness();
    const res = await app.request(
      `/members/${ALICE.userId}/hide`,
      formPost(await cookieFor(sessions, MOD), { field: "bio", hidden: "true" }),
      env,
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/members/${ALICE.userId}`);
    expect(hiddenList(ALICE.userId)).toEqual(["bio"]);
    expect(audits).toHaveLength(1);
  });

  it("unknown subject is 404 with no audit", async () => {
    const { app, sessions, audits } = harness();
    const res = await app.request(
      `/members/${UNKNOWN_SNOWFLAKE}/hide`,
      jsonPost(await cookieFor(sessions, MOD), { field: "bio", hidden: true }),
      env,
    );
    expect(res.status).toBe(404);
    expect(audits).toHaveLength(0);
  });

  it("hide is snowflake-only: handles are 404 (moderators use member URLs)", async () => {
    const { app, sessions, audits } = harness();
    const res = await app.request(
      "/members/alice/hide",
      jsonPost(await cookieFor(sessions, MOD), { field: "bio", hidden: true }),
      env,
    );
    expect(res.status).toBe(404);
    expect(audits).toHaveLength(0);
  });
});

describe("hide: field allowlist", () => {
  it.each(["bio", "games", "timezone", "steam", "links", "featured_games", "banner"])(
    "accepts hideable field %s with seam state and one audit row",
    async (field) => {
      const { app, sessions, hiddenList, audits } = harness();
      const res = await app.request(
        `/members/${ALICE.userId}/hide`,
        jsonPost(await cookieFor(sessions, MOD), { field, hidden: true }),
        env,
      );
      expect(res.status).toBe(200);
      expect(hiddenList(ALICE.userId)).toEqual([field]);
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({
        subjectType: "Profile",
        subjectId: ALICE.userId,
        causerId: MOD.userId,
        description: `hid profile field ${field}`,
      });
      expect(audits[0]!.properties[field]).toEqual({ before: false, after: true });
    },
  );

  it.each(["username", "avatar", "rank", "member_since", "", "__proto__"])(
    "refuses non-hideable field %s with 422, no state change, no audit",
    async (field) => {
      const { app, sessions, hiddenList, audits } = harness();
      const res = await app.request(
        `/members/${ALICE.userId}/hide`,
        jsonPost(await cookieFor(sessions, MOD), { field, hidden: true }),
        env,
      );
      expect(res.status).toBe(422);
      const payload = (await res.json()) as { errors: Record<string, string> };
      expect(typeof payload.errors.field).toBe("string");
      expect(hiddenList(ALICE.userId)).toEqual([]);
      expect(audits).toHaveLength(0);
    },
  );
});

describe("hide: body validation", () => {
  it.each([
    ["missing field", { hidden: true }],
    ["missing hidden", { field: "bio" }],
    ["empty body", {}],
    ["string hidden in JSON", { field: "bio", hidden: "true" }],
    ["null hidden", { field: "bio", hidden: null }],
  ])("JSON %s is 422 with no state change and no audit", async (_label, body) => {
    const { app, sessions, hiddenList, audits } = harness();
    const res = await app.request(
      `/members/${ALICE.userId}/hide`,
      jsonPost(await cookieFor(sessions, MOD), body),
      env,
    );
    expect(res.status).toBe(422);
    expect(hiddenList(ALICE.userId)).toEqual([]);
    expect(audits).toHaveLength(0);
  });

  it("form rejects a non-boolean hidden with 422", async () => {
    const { app, sessions, hiddenList, audits } = harness();
    const res = await app.request(
      `/members/${ALICE.userId}/hide`,
      formPost(await cookieFor(sessions, MOD), { field: "bio", hidden: "banana" }),
      env,
    );
    expect(res.status).toBe(422);
    expect(hiddenList(ALICE.userId)).toEqual([]);
    expect(audits).toHaveLength(0);
  });

  it("extra keys are refused and the member's stored content is untouched", async () => {
    const { app, sessions, store, hiddenList, audits } = harness();
    const res = await app.request(
      `/members/${ALICE.userId}/hide`,
      jsonPost(await cookieFor(sessions, MOD), { field: "bio", hidden: true, bio: "pwned" }),
      env,
    );
    expect(res.status).toBe(422);
    expect(hiddenList(ALICE.userId)).toEqual([]);
    expect(audits).toHaveLength(0);
    expect(store.rows.get(ALICE.userId)).toMatchObject({
      bio: "Alice bio text 7f3a",
      games: ["Chess", "Go"],
      timezone: "Europe/London",
    });
  });
});

describe("hide: audit completeness", () => {
  it("every accepted request audits exactly once, even a redundant hide", async () => {
    const { app, sessions, audits } = harness();
    const cookie = await cookieFor(sessions, MOD);
    for (const n of [1, 2]) {
      const res = await app.request(
        `/members/${ALICE.userId}/hide`,
        jsonPost(cookie, { field: "bio", hidden: true }),
        env,
      );
      expect(res.status, `hide #${n}`).toBe(200);
    }
    expect(audits).toHaveLength(2);
    expect(audits[1]).toMatchObject({
      description: "hid profile field bio",
      properties: { bio: { before: true, after: true } },
    });
  });

  it("unhiding a never-hidden field is accepted and audited", async () => {
    const { app, sessions, audits } = harness();
    const res = await app.request(
      `/members/${ALICE.userId}/hide`,
      jsonPost(await cookieFor(sessions, MOD), { field: "games", hidden: false }),
      env,
    );
    expect(res.status).toBe(200);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      description: "unhid profile field games",
      properties: { games: { before: false, after: false } },
    });
  });

  it("hide and unhide never rewrite the member's stored content", async () => {
    const { app, sessions, store } = harness();
    const cookie = await cookieFor(sessions, MOD);
    for (const hidden of [true, false]) {
      const res = await app.request(
        `/members/${ALICE.userId}/hide`,
        jsonPost(cookie, { field: "bio", hidden }),
        env,
      );
      expect(res.status).toBe(200);
    }
    expect(store.rows.get(ALICE.userId)).toMatchObject({
      bio: "Alice bio text 7f3a",
      games: ["Chess", "Go"],
      timezone: "Europe/London",
    });
  });
});

describe("hide: read visibility", () => {
  it("hidden bio disappears for members while other fields stay", async () => {
    const { app, sessions } = harness();
    const hide = await app.request(
      `/members/${ALICE.userId}/hide`,
      jsonPost(await cookieFor(sessions, MOD), { field: "bio", hidden: true }),
      env,
    );
    expect(hide.status).toBe(200);
    const res = await app.request(
      `/members/${ALICE.userId}`,
      { headers: { cookie: await cookieFor(sessions, BOB) } },
      env,
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).not.toContain("Alice bio text 7f3a");
    expect(html).toContain("Chess");
    expect(html).toContain("Europe/London");
  });

  it("owner still sees a hidden field with a notice", async () => {
    const { app, sessions } = harness();
    const hide = await app.request(
      `/members/${ALICE.userId}/hide`,
      jsonPost(await cookieFor(sessions, MOD), { field: "bio", hidden: true }),
      env,
    );
    expect(hide.status).toBe(200);
    const res = await app.request(
      `/members/${ALICE.userId}`,
      { headers: { cookie: await cookieFor(sessions, ALICE) } },
      env,
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Alice bio text 7f3a");
    expect(html).toContain('data-testid="profile-hidden-notice"');
  });

  it("owner sees no notice when nothing is hidden", async () => {
    const { app, sessions } = harness();
    const res = await app.request(
      `/members/${ALICE.userId}`,
      { headers: { cookie: await cookieFor(sessions, ALICE) } },
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).not.toContain('data-testid="profile-hidden-notice"');
  });

  it("moderators still see hidden fields", async () => {
    const { app, sessions } = harness();
    const hide = await app.request(
      `/members/${ALICE.userId}/hide`,
      jsonPost(await cookieFor(sessions, MOD), { field: "bio", hidden: true }),
      env,
    );
    expect(hide.status).toBe(200);
    const res = await app.request(
      `/members/${ALICE.userId}`,
      { headers: { cookie: await cookieFor(sessions, MOD) } },
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Alice bio text 7f3a");
  });

  it("hidden games and timezone disappear for members", async () => {
    const { app, sessions } = harness();
    const cookie = await cookieFor(sessions, MOD);
    for (const field of ["games", "timezone"]) {
      const hide = await app.request(
        `/members/${ALICE.userId}/hide`,
        jsonPost(cookie, { field, hidden: true }),
        env,
      );
      expect(hide.status, field).toBe(200);
    }
    const res = await app.request(
      `/members/${ALICE.userId}`,
      { headers: { cookie: await cookieFor(sessions, BOB) } },
      env,
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).not.toContain("Chess");
    expect(html).not.toContain("Europe/London");
    expect(html).toContain("Alice bio text 7f3a");
  });

  it("unhide restores the field for members", async () => {
    const { app, sessions } = harness();
    const cookie = await cookieFor(sessions, MOD);
    const hide = await app.request(
      `/members/${ALICE.userId}/hide`,
      jsonPost(cookie, { field: "bio", hidden: true }),
      env,
    );
    expect(hide.status).toBe(200);
    const unhide = await app.request(
      `/members/${ALICE.userId}/hide`,
      jsonPost(cookie, { field: "bio", hidden: false }),
      env,
    );
    expect(unhide.status).toBe(200);
    const res = await app.request(
      `/members/${ALICE.userId}`,
      { headers: { cookie: await cookieFor(sessions, BOB) } },
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Alice bio text 7f3a");
  });
});

describe("moderators cannot edit content beyond hiding", () => {
  it("PIN: moderator PATCH on another member's profile stays owner-only", async () => {
    const { app, sessions, store } = harness();
    const res = await app.request(
      `/members/${ALICE.userId}`,
      {
        method: "PATCH",
        headers: {
          cookie: await cookieFor(sessions, MOD),
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({ bio: "moderator rewrite", games: [], timezone: "" }),
      },
      env,
    );
    expect(res.status).toBe(403);
    expect(store.rows.get(ALICE.userId)!.bio).toBe("Alice bio text 7f3a");
  });

  it("PIN: moderator form-override POST on another member's profile stays owner-only", async () => {
    const { app, sessions, store } = harness();
    const res = await app.request(
      `/members/${ALICE.userId}`,
      formPost(await cookieFor(sessions, MOD), {
        _method: "PATCH",
        bio: "moderator rewrite",
        games_text: "",
        timezone: "",
      }),
      env,
    );
    expect(res.status).toBe(403);
    expect(store.rows.get(ALICE.userId)!.bio).toBe("Alice bio text 7f3a");
  });
});

// Staging journey (manual; runs after every profile slice lands on staging).
// Each step names the unit tests above that already prove the server behavior;
// the journey proves the wiring a hermetic suite cannot see: the public page
// carries the button, the queue is where moderators work, and hidden content
// (including the banner) disappears for guests. Skipped in CI by design.
describe.skip("staging journey: report button and moderator hiding", () => {
  it("guest: public profile shows a Report button and no Discord identity", () => {
    // Open the subject's public /u/<handle> page as a guest. The page shows a
    // Report control with data-testid profile-report-button; view-source shows
    // no Discord username or snowflake anywhere in the HTML.
  });

  it("guest: submitting a report confirms; flooding is rate-limited", () => {
    // Submit the report form with a reason (unit: guest report accepted).
    // The page confirms without revealing whether a queue item existed.
    // Submit 11 reports within a minute: the 11th is refused (429), proving
    // the 10/min default budget (unit: limited guest report).
  });

  it("member: reporting attributes the signed-in reporter", () => {
    // As a signed-in member, report another member's public profile with a
    // reason (unit: member JSON report creates one queue item).
  });

  it("moderator: the queue shows each report with reporter, reason and date", () => {
    // As a moderator, open the report queue. Both reports above are listed
    // with subject, reporter (member name; "guest" for the anonymous one),
    // reason text and creation date.
  });

  it("moderator: hiding bio removes it for guests and members only", () => {
    // Hide the subject's bio (unit: moderator hides). Guest and signed-in
    // member views of /u/<handle> no longer show the bio; the owner's view
    // still shows it with a hidden notice; the moderator's view still shows
    // it (unit: read visibility).
  });

  it("moderator: hiding the banner removes it for guests and members only", () => {
    // Hide the subject's banner (unit: banner is hideable). Guest and member
    // views show no banner; owner and moderator views still show it.
  });

  it("moderator: unhide restores every field", () => {
    // Unhide bio and banner (unit: unhide restores). Guest and member views
    // show both again.
  });

  it("activity log records every hide and unhide with actor and before/after", () => {
    // The activity log lists each hide/unhide above with the moderator as
    // causer, subject Profile:<id>, and per-field before/after (unit: audit
    // completeness). Report submissions appear in the queue only, never in
    // the activity log (unit: reports write no audit row).
  });

  it("moderator: editing another member's content beyond hiding is refused", () => {
    // Any moderator attempt to save another member's bio, games or timezone
    // is refused and the stored content is unchanged (unit: PINs + hide body
    // validation). Cleanup: unhide every test field, resolve the test queue
    // items.
  });
});

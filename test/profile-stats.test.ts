import { PgDialect } from "drizzle-orm/pg-core";
import { serializeSigned } from "hono/utils/cookie";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../src/db/index";
import type { EnvWithAdminDb } from "../src/admin/db";
import type { AccessEntry } from "../src/access-log";
import { profilesApp, type ProfileDeps } from "../src/profiles/routes";
import { MEMBER_STATS_BUDGET_MS, memberStatsWithBudget, readMemberStats, readOwnedMemberStats } from "../src/profiles/stats";
import { createMemoryProfileStore } from "../src/profiles/store";
import { createMemorySessionStore, hashToken, newSessionToken } from "../src/sessions";

const MEMBER = "100000000000000001";
const VIEWER = "100000000000000002";
const SECRET = "profile-stats-local-fixture-secret-32-bytes";
const env: EnvWithAdminDb = {
  APP_URL: "https://next.example.test",
  SESSION_SECRET: SECRET,
  DISCORD_CLIENT_ID: "fixture", DISCORD_CLIENT_SECRET: "fixture",
  DISCORD_GUILD_ID: "fixture", DISCORD_BOT_TOKEN: "fixture", DISCORD_INVITE_URL: "https://discord.gg/fixture",
};
const fullMember = {
  member_id: MEMBER, joined_at: "2025-01-01T00:00:00Z", tenure_days: "637", rank_key: "community_regular", is_current_member: true,
};
const milestones = [
  { milestone: "first_event", occurred_at: "2026-09-29T19:00:00Z", detail: "Chess <script>alert(1)</script>" },
  { milestone: "joined", occurred_at: "2025-01-01T00:00:00Z", detail: null },
];

function fixture(memberRows: Record<string, unknown>[] = [fullMember], milestoneRows: Record<string, unknown>[] = milestones) {
  const execute = vi.fn().mockResolvedValueOnce(memberRows).mockResolvedValueOnce(milestoneRows);
  return { db: { execute } as unknown as Db, execute };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("readMemberStats (local SQL-result fixtures)", () => {
  it("reads both bot-owned views with a bound member id and newest-first milestones", async () => {
    const { db, execute } = fixture();
    expect(await readMemberStats(db, MEMBER)).toEqual({
      joinedAt: new Date(fullMember.joined_at), tenureDays: 637, rankKey: "community_regular", isCurrentMember: true,
      milestones: milestones.map((row) => ({ type: row.milestone, occurredAt: new Date(row.occurred_at), detail: row.detail })),
    });
    const dialect = new PgDialect();
    const queries = execute.mock.calls.map(([query]) => dialect.sqlToQuery(query));
    expect(queries[0]!.sql).toContain("from web_v1.members where member_id = $1 limit 1");
    expect(queries[1]!.sql).toContain("where member_id = $1 order by occurred_at desc");
    expect(queries.map((query) => query.params)).toEqual([[MEMBER], [MEMBER]]);
  });

  it("returns no block for no row, without reading milestones", async () => {
    const { db, execute } = fixture([]);
    expect(await readMemberStats(db, MEMBER)).toBeNull();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(await readMemberStats(null, MEMBER)).toBeNull();
  });

  it.each(["42P01", "08006"])("never throws for a missing view or DB failure (%s), and logs no error details", async (code) => {
    const { db, execute } = fixture();
    execute.mockReset().mockRejectedValue(Object.assign(new Error(`postgres://secret@host/${MEMBER}`), { code }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await readMemberStats(db, MEMBER)).toBeNull();
    expect(warn).toHaveBeenCalledOnce();
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/secret|postgres|100000000000000001/);
  });

  it("hides the whole block if only the milestones view is missing", async () => {
    const { db, execute } = fixture();
    execute.mockReset().mockResolvedValueOnce([fullMember]).mockRejectedValueOnce(new Error("missing milestones view"));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await readMemberStats(db, MEMBER)).toBeNull();
  });

  it("does not start milestones after a member query outlives the budget", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { db, execute } = fixture();
    let finish!: (rows: Record<string, unknown>[]) => void;
    execute.mockReset().mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const pending = readMemberStats(db, MEMBER);
    await vi.advanceTimersByTimeAsync(MEMBER_STATS_BUDGET_MS);
    expect(await pending).toBeNull();
    finish([fullMember]);
    await vi.advanceTimersByTimeAsync(0);
    expect(execute).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels an owned client's stalled milestone query at the shared deadline", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { db, execute } = fixture();
    let rejectQuery!: (error: Error) => void;
    execute.mockReset().mockResolvedValueOnce([fullMember]).mockImplementationOnce(() => new Promise((_, reject) => { rejectQuery = reject; }));
    const end = vi.fn().mockImplementation(async () => { rejectQuery(new Error("CONNECTION_DESTROYED")); });
    const owned = { ...db, $client: { end } } as unknown as Db;
    const pending = memberStatsWithBudget((id, signal) => readOwnedMemberStats(owned, id, signal), MEMBER);
    await vi.advanceTimersByTimeAsync(MEMBER_STATS_BUDGET_MS - 1);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(end).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toBeNull();
    expect(end).toHaveBeenCalledExactlyOnceWith({ timeout: 0 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["success", "no row", "error", "already aborted"])("closes owned clients after %s", async (outcome) => {
    const { db, execute } = fixture(outcome === "no row" ? [] : [fullMember]);
    if (outcome === "error") execute.mockReset().mockRejectedValue(new Error("DB down"));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const end = vi.fn().mockResolvedValue(undefined);
    const controller = new AbortController();
    if (outcome === "already aborted") controller.abort();
    const pending = readOwnedMemberStats({ ...db, $client: { end } } as unknown as Db, MEMBER, controller.signal);
    if (outcome === "already aborted") await expect(pending).rejects.toThrow();
    else expect(await pending).toEqual(outcome === "success" ? expect.objectContaining({ rankKey: "community_regular" }) : null);
    expect(end).toHaveBeenCalledExactlyOnceWith({ timeout: 0 });
    if (outcome === "already aborted") expect(execute).not.toHaveBeenCalled();
  });

  it("normalizes nullable/malformed fields, zero days, former members and bad milestone dates", async () => {
    const { db } = fixture([{ ...fullMember, joined_at: "bad-date", tenure_days: 0, rank_key: "", is_current_member: false }], [
      { milestone: "ignored", occurred_at: "bad-date", detail: null },
      { milestone: "joined", occurred_at: new Date("2025-01-01T00:00:00Z"), detail: "" },
    ]);
    expect(await readMemberStats(db, MEMBER)).toEqual({
      joinedAt: null, tenureDays: 0, rankKey: null, isCurrentMember: false,
      milestones: [{ type: "joined", occurredAt: new Date("2025-01-01T00:00:00Z"), detail: null }],
    });
    const missing = fixture([{ joined_at: null, tenure_days: null, rank_key: null }], []);
    expect(await readMemberStats(missing.db, MEMBER)).toMatchObject({ joinedAt: null, tenureDays: null, rankKey: null, milestones: [] });
  });
});

async function harness(db: Db, deps: Pick<ProfileDeps, "stats"> = {}) {
  const sessions = createMemorySessionStore();
  const log: AccessEntry[] = [];
  const app = profilesApp({
    ...deps,
    sessionStore: sessions,
    throttle: async () => ({ limited: false }),
    store: createMemoryProfileStore([{ id: MEMBER, username: "alice", avatar: null, bio: "Profile still here", games: [], timezone: null, rank: "Existing rank", joinedAt: new Date("2024-06-15T00:00:00Z") }]),
    accessLog: async (entry) => {
      if (entry.viewerUserId === MEMBER) return false;
      log.push(entry);
      return true;
    },
  });
  const cookieFor = async (id = VIEWER, member = true) => {
    const token = newSessionToken();
    await sessions.create({ tokenHash: await hashToken(token), userId: id, username: "fixture", avatar: null, member, moderator: false, expiresAt: new Date(Date.now() + 3600_000) });
    return (await serializeSigned("__Host-two_session", token, SECRET, { path: "/", secure: true, httpOnly: true, sameSite: "Lax" })).split(";")[0]!;
  };
  return { app, log, cookieFor, bindings: { ...env, ADMIN_DB: db } };
}

describe("profile stats route wiring (local fixtures, no external DB)", () => {
  it("renders full stats and escaped milestones; the same profile subject covers the stats read", async () => {
    const { db } = fixture();
    const { app, log, cookieFor, bindings } = await harness(db);
    const res = await app.request(`/members/${MEMBER}`, { headers: { cookie: await cookieFor() } }, bindings);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('data-testid="profile-stats"');
    expect(html).toContain("Community Regular");
    expect(html).toContain("637 days");
    expect(html).toContain("1 Jan 2025");
    expect(html).toContain("Current member");
    expect(html).toContain('<dl class="profile-stats-grid">');
    expect(html).toContain("<dt>Milestones</dt><dd>2</dd>");
    expect(html.indexOf("<strong>First Event</strong>")).toBeLessThan(html.indexOf("<strong>Joined</strong>"));
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ subjectUserIds: [MEMBER], viewerUserId: VIEWER, route: "profiles.show" });
  });

  it.each([
    { rank: null, joined: null },
    { rank: "community_regular", joined: null },
    { rank: null, joined: fullMember.joined_at },
  ])("preserves existing fields individually for partial stats ($rank / $joined)", async ({ rank, joined }) => {
    const { db } = fixture([{ ...fullMember, rank_key: rank, joined_at: joined }], []);
    const { app, cookieFor, bindings } = await harness(db);
    const res = await app.request(`/members/${MEMBER}`, { headers: { cookie: await cookieFor() } }, bindings);
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).toContain('data-testid="profile-stats"');
    expect(html).toContain(rank ? "Community Regular" : "Existing rank");
    expect(html).toContain(joined ? "1 Jan 2025" : "Joined June 2024");
    expect(html.match(/data-testid="profile-rank"/g)).toHaveLength(1);
    expect(html.match(/data-testid="profile-joined"/g)).toHaveLength(1);
  });

  it.each(["stalled milestones", "throwing source"])("keeps the page and audit available with a %s", async (failure) => {
    const { db, execute } = fixture();
    let signalSeen: AbortSignal | undefined;
    let queryStarted!: () => void;
    const started = new Promise<void>((resolve) => { queryStarted = resolve; });
    const deps = failure === "throwing source" ? { stats: async (_id: string, signal: AbortSignal) => {
      signalSeen = signal;
      queryStarted();
      throw new Error("source down");
    } } : {};
    if (failure === "stalled milestones") execute.mockReset().mockResolvedValueOnce([fullMember]).mockImplementationOnce(() => {
      queryStarted();
      return new Promise(() => {});
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { app, log, cookieFor, bindings } = await harness(db, deps);
    const cookie = await cookieFor();
    vi.useFakeTimers();
    const pending = app.request(`/members/${MEMBER}`, { headers: { cookie } }, bindings);
    await started;
    await vi.advanceTimersByTimeAsync(MEMBER_STATS_BUDGET_MS);
    const res = await pending;
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Profile still here");
    expect(html).not.toContain('data-testid="profile-stats"');
    expect(log).toHaveLength(1);
    expect(log[0]?.subjectUserIds).toEqual([MEMBER]);
    if (signalSeen) expect(signalSeen.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["full stats", "missing view"])("preserves stats and submitted inputs on an invalid plain form with %s", async (outcome) => {
    const { db, execute } = fixture();
    if (outcome === "missing view") execute.mockReset().mockRejectedValue(new Error("42P01"));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { app, log, cookieFor, bindings } = await harness(db);
    const res = await app.request(`/members/${MEMBER}`, {
      method: "POST",
      headers: { cookie: await cookieFor(MEMBER), "content-type": "application/x-www-form-urlencoded", origin: env.APP_URL },
      body: new URLSearchParams({ _method: "PATCH", bio: "New <bio>", games_text: "Chess\nGo", timezone: "Invalid/Zone" }),
    }, bindings);
    const html = await res.text();
    expect(res.status).toBe(422);
    expect(html).toContain("Choose a valid IANA timezone");
    expect(html).toContain("New &lt;bio&gt;");
    expect(html).toContain("Chess\nGo");
    expect(html).toContain('value="Invalid/Zone"');
    expect(html).toContain(outcome === "full stats" ? "1 Jan 2025" : "Joined June 2024");
    expect(html.includes('data-testid="profile-stats"')).toBe(outcome === "full stats");
    expect(log).toHaveLength(0);
  });

  it("renders stats on /profile too, without logging the owner as a subject", async () => {
    const { db } = fixture([{ ...fullMember, tenure_days: 1, is_current_member: false }], []);
    const { app, log, cookieFor, bindings } = await harness(db);
    const res = await app.request("/profile", { headers: { cookie: await cookieFor(MEMBER) } }, bindings);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("1 day</dd>");
    expect(html).toContain("Former member");
    expect(html).toContain("No milestones yet.");
    expect(log).toHaveLength(0);
  });

  it.each(["no row", "missing view", "DB error", "missing milestones"])("keeps the page 200 and hides the block for %s", async (failure) => {
    const { db, execute } = fixture([]);
    if (failure === "missing milestones") execute.mockReset().mockResolvedValueOnce([fullMember]).mockRejectedValueOnce(new Error("42P01"));
    else if (failure !== "no row") execute.mockReset().mockRejectedValue(new Error(failure));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { app, log, cookieFor, bindings } = await harness(db);
    const res = await app.request(`/members/${MEMBER}`, { headers: { cookie: await cookieFor() } }, bindings);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Profile still here");
    expect(html).not.toContain('data-testid="profile-stats"');
    expect(log).toHaveLength(1);
  });

  it("guests, non-members and unknown profiles never reach the stats reader", async () => {
    const { db, execute } = fixture();
    const { app, log, cookieFor, bindings } = await harness(db);
    for (const path of ["/profile", `/members/${MEMBER}`]) {
      const guest = await app.request(path, {}, bindings);
      expect(guest.status).toBe(302);
      expect(await guest.text()).not.toContain("Community Regular");
      expect((await app.request(path, { headers: { cookie: await cookieFor(VIEWER, false) } }, bindings)).status).toBe(403);
    }
    expect((await app.request("/members/999999999999999999", { headers: { cookie: await cookieFor() } }, bindings)).status).toBe(404);
    expect(execute).not.toHaveBeenCalled();
    expect(log).toHaveLength(0);
  });

  it("still refuses stats exposure when the existing access-log sink fails", async () => {
    const { db } = fixture();
    const sessions = createMemorySessionStore();
    const token = newSessionToken();
    await sessions.create({ tokenHash: await hashToken(token), userId: VIEWER, username: "fixture", avatar: null, member: true, moderator: false, expiresAt: new Date(Date.now() + 3600_000) });
    const cookie = (await serializeSigned("__Host-two_session", token, SECRET, { path: "/", secure: true })).split(";")[0]!;
    const app = profilesApp({ sessionStore: sessions, store: createMemoryProfileStore([{ id: MEMBER, username: "alice", avatar: null, bio: null, games: [], timezone: null }]), accessLog: async () => { throw new Error("sink down"); } });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await app.request(`/members/${MEMBER}`, { headers: { cookie } }, { ...env, ADMIN_DB: db });
    expect(res.status).toBe(503);
    expect(await res.text()).not.toContain("Community Regular");
  });
});

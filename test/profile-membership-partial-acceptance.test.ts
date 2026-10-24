// Acceptance: profiles preserve membership facts when optional milestones fail.
//
// A milestones outage must not discard a successfully read membership. When the
// membership query succeeds and the milestones query fails (error, missing view,
// or budget expiry), the profile keeps joined/rank/tenure/membership facts and
// shows milestones as unavailable — never "No milestones yet" and never a
// fabricated zero. A genuinely empty milestone list keeps its ordinary empty
// state. A truncated list keeps the existing "+" count and states plainly that
// it shows the newest bounded window.
//
// Behavioral contract only: these tests assert rendered facts and states, never
// the field names or shapes the implementation uses to carry them. The single
// 500ms total budget, owned-client cancellation, and the access-audit boundary
// are preserved; recovery is an explicit safe GET, never background retry or an
// automatic reload over an unsaved editor.
//
// RED expectations on unmodified source: every test marked RED below fails
// because the current code collapses any stats failure to null and hides the
// whole block. Controls marked GREEN pass before and after the fix.
//
// Protected acceptance file: the paired builder starts from this branch/SHA,
// never edits this file, and returns test corrections to the Test Author.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import { PgDialect, type PgSession } from "drizzle-orm/pg-core";
import { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { build } from "esbuild";
import { serializeSigned } from "hono/utils/cookie";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { AccessEntry } from "../src/access-log";
import type { EnvWithAdminDb } from "../src/admin/db";
import type { Db } from "../src/db/index";
import { resolveKitProfile } from "../src/profiles/kit";
import { profilesApp, type ProfileDeps } from "../src/profiles/routes";
import {
  MEMBER_MILESTONES_CAP,
  MEMBER_STATS_BUDGET_MS,
  memberStatsWithBudget,
  readMemberStats,
  readOwnedMemberStats,
} from "../src/profiles/stats";
import { createMemoryProfileStore } from "../src/profiles/store";
import { createMemorySessionStore, hashToken, newSessionToken } from "../src/sessions";

const MEMBER = "100000000000000001";
const VIEWER = "100000000000000002";
const SECRET = "profile-partial-acceptance-fixture-secret-32b";
const env: EnvWithAdminDb = {
  APP_URL: "https://next.example.test",
  SESSION_SECRET: SECRET,
  DISCORD_CLIENT_ID: "fixture",
  DISCORD_CLIENT_SECRET: "fixture",
  DISCORD_GUILD_ID: "fixture",
  DISCORD_BOT_TOKEN: "fixture",
  DISCORD_INVITE_URL: "https://discord.gg/fixture",
};
const fullMember = {
  member_id: MEMBER,
  joined_at: "2025-01-01T00:00:00Z",
  tenure_days: "637",
  rank_key: "community_regular",
  is_current_member: true,
};
const milestoneRows = [
  {
    member_id: MEMBER,
    milestone: "first_event",
    occurred_at: "2026-09-29T19:00:00Z",
    detail: "Chess night",
  },
  { member_id: MEMBER, milestone: "joined", occurred_at: "2025-01-01T00:00:00Z", detail: null },
];

function fixture(
  memberRows: Record<string, unknown>[] = [fullMember],
  rows: Record<string, unknown>[] = milestoneRows,
) {
  // Faithful-driver default: real execute always resolves an array, so later
  // reads (e.g. the self-view history read) resolve empty, never undefined.
  const execute = vi
    .fn()
    .mockResolvedValue([])
    .mockResolvedValueOnce(memberRows)
    .mockResolvedValueOnce(rows);
  const session = {
    prepareQuery: (query: unknown) => ({ execute: () => execute(query) }),
  } as unknown as PgSession;
  const db = new PostgresJsDatabase(new PgDialect(), session, undefined) as Db;
  db.execute = db.execute.bind(db);
  return { db, execute };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function harness(db: Db, deps: Pick<ProfileDeps, "stats"> = {}) {
  const sessions = createMemorySessionStore();
  const log: AccessEntry[] = [];
  const app = profilesApp({
    ...deps,
    sessionStore: sessions,
    throttle: async () => ({ limited: false }),
    store: createMemoryProfileStore([
      {
        id: MEMBER,
        username: "alice",
        avatar: null,
        bio: "Profile still here",
        games: [],
        timezone: null,
        joinedAt: new Date("2024-06-15T00:00:00Z"),
      },
    ]),
    accessLog: async (entry) => {
      if (entry.viewerUserId === MEMBER) return false;
      log.push(entry);
      return true;
    },
  });
  const cookieFor = async (id = VIEWER, member = true) => {
    const token = newSessionToken();
    await sessions.create({
      tokenHash: await hashToken(token),
      userId: id,
      username: "fixture",
      avatar: null,
      member,
      moderator: false,
      expiresAt: new Date(Date.now() + 3600_000),
    });
    return (
      await serializeSigned("__Host-two_session", token, SECRET, {
        path: "/",
        secure: true,
        httpOnly: true,
        sameSite: "Lax",
      })
    ).split(";")[0]!;
  };
  return { app, log, cookieFor, bindings: { ...env, ADMIN_DB: db } };
}

const statsSection = (html: string): string | null =>
  html.match(/<section\b[^>]*data-testid="profile-stats"[^>]*>([\s\S]*?)<\/section>/)?.[1] ?? null;

// Membership facts as rendered by the shared statsLabel/statsDate helpers.
function expectMembershipFacts(block: string): void {
  expect(block).toContain("Community Regular");
  expect(block).toContain("1 Jan 2025");
  expect(block).toContain("637 days");
  expect(block).toContain("Current member");
}

function expectNoStatsFacts(html: string): void {
  expect(html).not.toContain("Community Regular");
  expect(html).not.toContain("1 Jan 2025");
  expect(html).not.toContain("637 days");
}

// Milestones count cell scoped to its <dt>, tolerant of SSR whitespace.
const MILESTONES_ZERO = /<dt>\s*Milestones\s*<\/dt>\s*<dd[^>]*>\s*0(?:\s|<!--|<\/dd>)/;
const MILESTONES_TRUNCATED = /<dt>\s*Milestones\s*<\/dt>\s*<dd[^>]*>\s*100\+/;

function expectMilestonesUnavailable(block: string): void {
  expect(block, "milestones outage must read as unavailable").toMatch(/unavailable/i);
  expect(block, "an outage is not an empty list").not.toContain("No milestones yet");
  expect(block, "an outage must not fabricate a zero count").not.toMatch(MILESTONES_ZERO);
}

function expectValidEmpty(block: string): void {
  expect(block).toContain("No milestones yet");
  expect(block).toMatch(MILESTONES_ZERO);
}

function expectNoLeak(html: string, warnCalls: unknown[][]): void {
  expect(html).not.toMatch(/42P01|postgres:\/\/|CONNECTION_DESTROYED|fixture-secret/);
  expect(JSON.stringify(warnCalls)).not.toMatch(/secret|postgres|100000000000000001/);
}

// Recovery is a plain keyboard-reachable link to the same profile URL.
function expectSafeGetRecovery(html: string, block: string, profilePath: string): void {
  expect(html, "no automatic reload over a profile page").not.toMatch(
    /<meta\b[^>]*http-equiv=["']?refresh/i,
  );
  const link = block
    .match(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)
    ?.find((tag) => /retry|refresh|reload|try again/i.test(tag));
  expect(link, "an explicit safe-GET recovery link").toBeDefined();
  expect(link ?? "").toContain(profilePath);
}

type RenderView = (props: Record<string, unknown>) => string;
let renderKitView: RenderView;

beforeAll(async () => {
  const worktree = fileURLToPath(new URL("../", import.meta.url));
  const webRequire = createRequire(new URL("../web/package.json", import.meta.url));
  const { compile } = webRequire("svelte/compiler") as {
    compile: (
      source: string,
      options: { generate: string; dev: boolean; filename: string },
    ) => { js: { code: string } };
  };
  const scratch = mkdtempSync(
    join(
      process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? process.env.PAPERCLIP_SCRATCH_DIR ?? tmpdir(),
      "profile-partial-acceptance-",
    ),
  );
  try {
    const entry = join(scratch, "entry.mjs");
    const outfile = join(scratch, "view.mjs");
    writeFileSync(
      entry,
      `import { render } from "svelte/server";
import View from ${JSON.stringify(join(worktree, "web/src/lib/ProfileView.svelte"))};
export function renderView(props) {
 const { body, head } = render(View, { props });
 return head + body;
}`,
    );
    await build({
      entryPoints: [entry],
      bundle: true,
      platform: "node",
      format: "esm",
      outfile,
      logLevel: "warning",
      absWorkingDir: worktree,
      nodePaths: [join(worktree, "web/node_modules"), join(worktree, "node_modules")],
      plugins: [
        {
          name: "profile-partial-acceptance-svelte-ssr",
          setup(plugin) {
            plugin.onLoad({ filter: /\.svelte$/ }, (args) => ({
              contents: compile(readFileSync(args.path, "utf8"), {
                generate: "server",
                dev: false,
                filename: args.path,
              }).js.code,
              loader: "js",
              resolveDir: dirname(args.path),
            }));
          },
        },
      ],
    });
    ({ renderView: renderKitView } = (await import(pathToFileURL(outfile).href)) as {
      renderView: RenderView;
    });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}, 120000);

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("readMemberStats preserves membership when milestones fail", () => {
  it("RED: a second-query failure keeps joined/rank/tenure/membership facts", async () => {
    const failing = fixture([fullMember], []);
    failing.execute
      .mockReset()
      .mockResolvedValueOnce([fullMember])
      .mockRejectedValueOnce(new Error("missing milestones view"));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const stats = await readMemberStats(failing.db, MEMBER);
    expect(stats, "membership must survive a milestones failure").not.toBeNull();
    expect(stats).toMatchObject({
      joinedAt: new Date(fullMember.joined_at),
      tenureDays: 637,
      rankKey: "community_regular",
      isCurrentMember: true,
    });
    expect(stats?.milestones ?? []).toEqual([]);
  });

  it("GREEN: valid empty milestones keep the ordinary empty value", async () => {
    const { db } = fixture([fullMember], []);
    const stats = await readMemberStats(db, MEMBER);
    expect(stats).toMatchObject({
      joinedAt: new Date(fullMember.joined_at),
      tenureDays: 637,
      rankKey: "community_regular",
      isCurrentMember: true,
      milestonesTruncated: false,
      milestones: [],
    });
  });

  it("GREEN: a first-query failure never throws, warns once, and leaks nothing", async () => {
    const { db, execute } = fixture();
    execute
      .mockReset()
      .mockRejectedValue(
        Object.assign(new Error(`postgres://fixture-secret@host/${MEMBER}`), { code: "42P01" }),
      );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const stats = await readMemberStats(db, MEMBER);
    // Shape-agnostic: either null or an explicit unavailable without facts.
    if (stats !== null) {
      expect(stats.joinedAt).toBeNull();
      expect(stats.rankKey).toBeNull();
      expect(stats.tenureDays).toBeNull();
      expect(stats.milestones).toEqual([]);
    }
    expect(warn).toHaveBeenCalledOnce();
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/secret|postgres|100000000000000001/);
  });

  it("GREEN: absent member rows stay absent without reading milestones", async () => {
    const { db, execute } = fixture([]);
    const stats = await readMemberStats(db, MEMBER);
    if (stats !== null) {
      expect(stats.joinedAt).toBeNull();
      expect(stats.rankKey).toBeNull();
      expect(stats.tenureDays).toBeNull();
      expect(stats.milestones).toEqual([]);
    }
    expect(execute).toHaveBeenCalledTimes(1);
    expect(await readMemberStats(null, MEMBER)).toBeNull();
  });

  it("GREEN: 100 rows are complete and 101 rows probe the pinned cap, newest-first", async () => {
    // Feed newest-first like the ordered query would; the 101st row is the
    // oldest probe the SQL uses only to detect truncation.
    const rows = (count: number) =>
      Array.from({ length: count }, (_, i) => {
        const n = MEMBER_MILESTONES_CAP - i;
        return {
          member_id: MEMBER,
          milestone: `m${String(n).padStart(3, "0")}`,
          occurred_at: new Date(Date.UTC(2025, 0, 1) + n * 86_400_000).toISOString(),
          detail: null,
        };
      });
    const exact = fixture([fullMember], rows(MEMBER_MILESTONES_CAP));
    const exactStats = await readMemberStats(exact.db, MEMBER);
    expect(exactStats?.milestones).toHaveLength(MEMBER_MILESTONES_CAP);
    expect(exactStats?.milestonesTruncated).toBe(false);
    const over = fixture([fullMember], rows(MEMBER_MILESTONES_CAP + 1));
    const overStats = await readMemberStats(over.db, MEMBER);
    expect(overStats?.milestones).toHaveLength(MEMBER_MILESTONES_CAP);
    expect(overStats?.milestonesTruncated).toBe(true);
    expect(overStats?.milestones[0]?.type).toBe(
      `m${String(MEMBER_MILESTONES_CAP).padStart(3, "0")}`,
    );
    expect(overStats?.milestones.at(-1)?.type).toBe("m001");
    const queries = over.execute.mock.calls.map(([query]) => query as { sql: string });
    expect(queries[1]!.sql).toContain("limit 101");
    expect(queries[1]!.sql).toContain("order by occurred_at desc");
  });
});

describe("stats budget, cancellation, and late settlement", () => {
  it("RED: a stalled milestones query with an owned client keeps membership", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { db, execute } = fixture();
    let rejectQuery!: (error: Error) => void;
    execute
      .mockReset()
      .mockResolvedValueOnce([fullMember])
      .mockImplementationOnce(
        () =>
          new Promise((_, reject) => {
            rejectQuery = reject;
          }),
      );
    const end = vi.fn().mockImplementation(async () => {
      rejectQuery(new Error("CONNECTION_DESTROYED"));
    });
    const owned = { ...db, $client: { end } } as unknown as Db;
    const pending = memberStatsWithBudget(
      (id, signal) => readOwnedMemberStats(owned, id, signal),
      MEMBER,
    );
    await vi.advanceTimersByTimeAsync(MEMBER_STATS_BUDGET_MS - 1);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(end).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    const stats = await pending;
    expect(stats, "a milestones timeout must keep membership").not.toBeNull();
    expect(stats).toMatchObject({
      joinedAt: new Date(fullMember.joined_at),
      tenureDays: 637,
      rankKey: "community_regular",
      isCurrentMember: true,
    });
    expect(end).toHaveBeenCalledExactlyOnceWith({ timeout: 0 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("GREEN: a membership stall reports no facts, closes the owner, and starts nothing else", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { db, execute } = fixture();
    let finish!: (rows: Record<string, unknown>[]) => void;
    execute.mockReset().mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = readMemberStats(db, MEMBER);
    await vi.advanceTimersByTimeAsync(MEMBER_STATS_BUDGET_MS);
    const stats = await pending;
    if (stats !== null) {
      expect(stats.joinedAt).toBeNull();
      expect(stats.rankKey).toBeNull();
      expect(stats.tenureDays).toBeNull();
      expect(stats.milestones).toEqual([]);
    }
    finish([fullMember]);
    await vi.advanceTimersByTimeAsync(0);
    expect(execute).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("GREEN: a late milestones settlement never rewrites the timed-out outcome", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { db, execute } = fixture();
    const gate = deferred<Record<string, unknown>[]>();
    // Attach a settlement observer up front so the late success can never
    // escape as an unhandled rejection, whatever the outcome shape.
    const observed = gate.promise.then(
      (rows) => ({ settled: true as const, rows }),
      (error: unknown) => ({ settled: false as const, error }),
    );
    execute.mockReset().mockResolvedValueOnce([fullMember]).mockReturnValueOnce(gate.promise);
    const end = vi.fn().mockImplementation(async () => {
      gate.reject(new Error("CONNECTION_DESTROYED"));
    });
    const owned = { ...db, $client: { end } } as unknown as Db;
    const pending = memberStatsWithBudget(
      (id, signal) => readOwnedMemberStats(owned, id, signal),
      MEMBER,
    );
    await vi.advanceTimersByTimeAsync(MEMBER_STATS_BUDGET_MS);
    const decided = await pending;
    const callsAtDecision = execute.mock.calls.length;
    // A loser that settles after cancellation must not reopen the read.
    gate.resolve([...milestoneRows]);
    await vi.advanceTimersByTimeAsync(0);
    await observed;
    expect(execute.mock.calls.length).toBe(callsAtDecision);
    expect(await pending).toEqual(decided);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("GREEN: the total budget stays a single 500ms window", () => {
    expect(MEMBER_STATS_BUDGET_MS).toBe(500);
    expect(MEMBER_MILESTONES_CAP).toBe(100);
  });
});

describe("Hono partial, unavailable, and truncated states", () => {
  it("RED: milestones failure keeps membership and reads as unavailable", async () => {
    const { db, execute } = fixture();
    execute
      .mockReset()
      .mockResolvedValueOnce([fullMember])
      .mockRejectedValueOnce(new Error("missing milestones view"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { app, log, cookieFor, bindings } = await harness(db);
    const res = await app.request(
      `/members/${MEMBER}`,
      { headers: { cookie: await cookieFor() } },
      bindings,
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Profile still here");
    const block = statsSection(html);
    expect(block, "membership must survive a milestones failure").not.toBeNull();
    expectMembershipFacts(block!);
    expectMilestonesUnavailable(block!);
    expectNoLeak(html, warn.mock.calls);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ subjectUserIds: [MEMBER], viewerUserId: VIEWER });
    expectSafeGetRecovery(html, block!, `/members/${MEMBER}`);
  });

  it("RED: a throwing optional source keeps the page and reads as unavailable", async () => {
    const { db } = fixture();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { app, log, cookieFor, bindings } = await harness(db, {
      stats: async () => {
        throw new Error("source down");
      },
    });
    const res = await app.request(
      `/members/${MEMBER}`,
      { headers: { cookie: await cookieFor() } },
      bindings,
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Profile still here");
    expect(html).toMatch(/unavailable/i);
    expect(log).toHaveLength(1);
  });

  it("RED: a truncated list keeps + and names the newest bounded window", async () => {
    const rows = Array.from({ length: MEMBER_MILESTONES_CAP + 1 }, (_, i) => ({
      member_id: MEMBER,
      milestone: `m${String(i).padStart(3, "0")}`,
      occurred_at: new Date(Date.UTC(2025, 0, 1) + i * 86_400_000).toISOString(),
      detail: null,
    }));
    const { db } = fixture([fullMember], rows);
    const { app, log, cookieFor, bindings } = await harness(db);
    const res = await app.request(
      `/members/${MEMBER}`,
      { headers: { cookie: await cookieFor() } },
      bindings,
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    const block = statsSection(html);
    expect(block).not.toBeNull();
    expect(block!).toMatch(MILESTONES_TRUNCATED);
    expect(block!, "a capped list must say it shows the newest window").toMatch(/newest/i);
    expect(block!).not.toMatch(MILESTONES_ZERO);
    expect(log).toHaveLength(1);
  });

  it("GREEN: valid empty milestones keep the ordinary empty state", async () => {
    const { db } = fixture([fullMember], []);
    const { app, cookieFor, bindings } = await harness(db);
    const res = await app.request(
      `/members/${MEMBER}`,
      { headers: { cookie: await cookieFor() } },
      bindings,
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    const block = statsSection(html);
    expect(block).not.toBeNull();
    expectMembershipFacts(block!);
    expectValidEmpty(block!);
    expect(block!).not.toMatch(/unavailable/i);
  });

  it("RED: a membership failure keeps the page, shows unavailable, and invents nothing", async () => {
    const { db, execute } = fixture();
    execute.mockReset().mockRejectedValue(new Error("DB error"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { app, log, cookieFor, bindings } = await harness(db);
    const res = await app.request(
      `/members/${MEMBER}`,
      { headers: { cookie: await cookieFor() } },
      bindings,
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Profile still here");
    expect(html).toMatch(/unavailable/i);
    expectNoStatsFacts(html);
    expectNoLeak(html, warn.mock.calls);
    expect(log).toHaveLength(1);
  });

  it("GREEN: absent member rows keep the page without stats facts or error text", async () => {
    const { db } = fixture([]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { app, log, cookieFor, bindings } = await harness(db);
    const res = await app.request(
      `/members/${MEMBER}`,
      { headers: { cookie: await cookieFor() } },
      bindings,
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Profile still here");
    expectNoStatsFacts(html);
    expect(html).not.toMatch(/unavailable/i);
    expectNoLeak(html, warn.mock.calls);
    expect(log).toHaveLength(1);
  });

  it("GREEN: an unfinished borrowed query still refuses instead of releasing", async () => {
    const { db, execute } = fixture();
    let started!: () => void;
    const gate = new Promise<void>((resolve) => {
      started = resolve;
    });
    execute
      .mockReset()
      .mockResolvedValueOnce([fullMember])
      .mockImplementationOnce(() => {
        started();
        return new Promise(() => {});
      });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { app, log, cookieFor, bindings } = await harness(db);
    const cookie = await cookieFor();
    vi.useFakeTimers();
    const pending = app.request(`/members/${MEMBER}`, { headers: { cookie } }, bindings);
    await gate;
    await vi.advanceTimersByTimeAsync(MEMBER_STATS_BUDGET_MS);
    const res = await pending;
    expect(res.status).toBe(503);
    expect(await res.text()).not.toContain("Profile still here");
    expect(log).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("Hono editor, privacy, and audit pins", () => {
  it("RED: an invalid owner form keeps its draft and the partial membership facts", async () => {
    const { db, execute } = fixture();
    execute
      .mockReset()
      .mockResolvedValueOnce([fullMember])
      .mockRejectedValueOnce(new Error("missing milestones view"));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { app, log, cookieFor, bindings } = await harness(db);
    const res = await app.request(
      `/members/${MEMBER}`,
      {
        method: "POST",
        headers: {
          cookie: await cookieFor(MEMBER),
          "content-type": "application/x-www-form-urlencoded",
          origin: env.APP_URL,
        },
        body: new URLSearchParams({
          _method: "PATCH",
          bio: "New <bio>",
          games_text: "Chess\nGo",
          timezone: "Invalid/Zone",
        }),
      },
      bindings,
    );
    const html = await res.text();
    expect(res.status).toBe(422);
    expect(html).toContain("Choose a valid IANA timezone");
    expect(html).toContain("New &lt;bio&gt;");
    expect(html).toContain("Chess\nGo");
    expect(html).toContain('value="Invalid/Zone"');
    const block = statsSection(html);
    expect(block, "a draft error must not discard partial membership").not.toBeNull();
    expectMembershipFacts(block!);
    expectMilestonesUnavailable(block!);
    expect(block!, "recovery over a draft warns before a reload").toMatch(/unsaved|draft|discard/i);
    expect(log).toHaveLength(0);
  });

  it("GREEN: guests, non-members, and unknown profiles never reach the stats reader", async () => {
    const { db, execute } = fixture();
    const { app, log, cookieFor, bindings } = await harness(db);
    for (const path of ["/profile", `/members/${MEMBER}`]) {
      expect((await app.request(path, {}, bindings)).status).toBe(302);
      expect(
        (await app.request(path, { headers: { cookie: await cookieFor(VIEWER, false) } }, bindings))
          .status,
      ).toBe(403);
    }
    expect(
      (
        await app.request(
          "/members/999999999999999999",
          { headers: { cookie: await cookieFor() } },
          bindings,
        )
      ).status,
    ).toBe(404);
    expect(execute).not.toHaveBeenCalled();
    expect(log).toHaveLength(0);
  });

  it("GREEN: the owner editor and joined fallback survive every stats state", async () => {
    for (const setup of ["partial", "empty"] as const) {
      const { db, execute } = fixture();
      // mockReset wipes the fixture's faithful empty-array default, so each
      // arm re-pins it: later reads (the self-view history read) resolve
      // empty like a real driver, never undefined.
      if (setup === "partial")
        execute
          .mockReset()
          .mockResolvedValue([])
          .mockResolvedValueOnce([fullMember])
          .mockRejectedValueOnce(new Error("missing milestones view"));
      else
        execute
          .mockReset()
          .mockResolvedValue([])
          .mockResolvedValueOnce([fullMember])
          .mockResolvedValueOnce([]);
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const { app, log, cookieFor, bindings } = await harness(db);
      const res = await app.request(
        "/profile",
        { headers: { cookie: await cookieFor(MEMBER) } },
        bindings,
      );
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain('data-testid="profile-form"');
      expect(html).toContain("Edit your profile");
      expect(html.match(/data-testid="profile-joined"/g)).toHaveLength(1);
      expect(log).toHaveLength(0);
      vi.restoreAllMocks();
    }
  });
});

describe("Kit twin renders the same stats states", () => {
  const viewerSession = (userId: string) =>
    ({
      status: "authenticated",
      session: { userId, username: "viewer", avatar: null, member: true, moderator: false },
    }) as Parameters<typeof resolveKitProfile>[0]["session"];
  const storeWithAlice = () =>
    createMemoryProfileStore([
      {
        id: MEMBER,
        username: "alice",
        avatar: null,
        bio: "Profile still here",
        games: [],
        timezone: null,
        joinedAt: new Date("2024-06-15T00:00:00Z"),
      },
    ]);

  it("RED: Kit keeps membership and reads milestones as unavailable", async () => {
    const failing = fixture([fullMember], []);
    failing.execute
      .mockReset()
      .mockResolvedValueOnce([fullMember])
      .mockRejectedValueOnce(new Error("missing milestones view"));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const stats = await readMemberStats(failing.db, MEMBER);
    expect(stats, "membership must survive a milestones failure").not.toBeNull();
    const outcome = await resolveKitProfile(
      { session: viewerSession(VIEWER), requestedId: MEMBER, joinResult: null },
      { store: storeWithAlice(), stats: async () => stats },
    );
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;
    const html = renderKitView({
      member: outcome.member,
      stats: outcome.stats,
      isOwner: outcome.isOwner,
      isModerator: outcome.isModerator,
      appUrl: env.APP_URL,
      joinResult: outcome.joinResult,
    });
    expect(html).toContain("Profile still here");
    const block = statsSection(html);
    expect(block).not.toBeNull();
    expectMembershipFacts(block!);
    expectMilestonesUnavailable(block!);
    expectSafeGetRecovery(html, block!, `/members/${MEMBER}`);
  });

  it("GREEN: Kit keeps the ordinary empty state for valid empty milestones", async () => {
    const { db } = fixture([fullMember], []);
    const stats = await readMemberStats(db, MEMBER);
    const outcome = await resolveKitProfile(
      { session: viewerSession(VIEWER), requestedId: MEMBER, joinResult: null },
      { store: storeWithAlice(), stats: async () => stats },
    );
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;
    const html = renderKitView({
      member: outcome.member,
      stats: outcome.stats,
      isOwner: outcome.isOwner,
      isModerator: outcome.isModerator,
      appUrl: env.APP_URL,
      joinResult: outcome.joinResult,
    });
    const block = statsSection(html);
    expect(block).not.toBeNull();
    expectMembershipFacts(block!);
    expectValidEmpty(block!);
  });

  it("RED: Kit truncation keeps + and names the newest bounded window", async () => {
    const rows = Array.from({ length: MEMBER_MILESTONES_CAP + 1 }, (_, i) => ({
      member_id: MEMBER,
      milestone: `m${String(i).padStart(3, "0")}`,
      occurred_at: new Date(Date.UTC(2025, 0, 1) + i * 86_400_000).toISOString(),
      detail: null,
    }));
    const { db } = fixture([fullMember], rows);
    const stats = await readMemberStats(db, MEMBER);
    const outcome = await resolveKitProfile(
      { session: viewerSession(VIEWER), requestedId: MEMBER, joinResult: null },
      { store: storeWithAlice(), stats: async () => stats },
    );
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;
    const html = renderKitView({
      member: outcome.member,
      stats: outcome.stats,
      isOwner: outcome.isOwner,
      isModerator: outcome.isModerator,
      appUrl: env.APP_URL,
      joinResult: outcome.joinResult,
    });
    const block = statsSection(html);
    expect(block).not.toBeNull();
    expect(block!).toMatch(MILESTONES_TRUNCATED);
    expect(block!, "a capped list must say it shows the newest window").toMatch(/newest/i);
  });

  it("RED: Kit membership failure shows unavailable and invents nothing", async () => {
    const { db, execute } = fixture();
    execute.mockReset().mockRejectedValue(new Error("DB error"));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const stats = await readMemberStats(db, MEMBER);
    const outcome = await resolveKitProfile(
      { session: viewerSession(VIEWER), requestedId: MEMBER, joinResult: null },
      { store: storeWithAlice(), stats: async () => stats },
    );
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;
    const html = renderKitView({
      member: outcome.member,
      stats: outcome.stats,
      isOwner: outcome.isOwner,
      isModerator: outcome.isModerator,
      appUrl: env.APP_URL,
      joinResult: outcome.joinResult,
    });
    expect(html).toContain("Profile still here");
    expect(html).toMatch(/unavailable/i);
    expectNoStatsFacts(html);
  });
});

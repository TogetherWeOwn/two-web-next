import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  resolveDrillTarget,
  resolveDrillWebOrigin,
  runInternalActionDrill,
} from "../src/probes/internal-action-drill";
import { BotTerminalError } from "../src/jobs/types";
import type { AnnouncementResult, RoleAssignResult } from "../src/bot/client";
import type { BotClient, BotFailure } from "../src/jobs/types";

const PRODUCTION_BOT = "https://bot.internal.example";
const STAGING_BOT = "https://bot-staging.internal.example";
const STAGING_WEB = "https://next.togetherweown.com";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const fail = (o: Partial<BotFailure>): BotFailure => ({
  ok: false,
  code: "x",
  status: 503,
  requestId: null,
  message: "m",
  retryable: true,
  retryAfterSeconds: null,
  ...o,
});
const roleOk: RoleAssignResult = { ok: true, requestId: "r1", outcome: "assigned" };

function okClient() {
  const seenKeys: string[] = [];
  const bodies: string[] = [];
  return {
    seenKeys,
    bodies,
    assignRole: async () => roleOk,
    postAnnouncement: async (a: { channelKey: string; body: string }, key: string) => {
      seenKeys.push(key);
      bodies.push(a.body);
      return { ok: true, requestId: "r2", messageId: "m1", replayed: false } as AnnouncementResult;
    },
    upsertEvent: async (): Promise<never> => {
      throw new Error("unreachable: the drill never upserts events");
    },
  };
}

const ARGS = {
  discordId: "900000000000009999",
  roleKey: "rocketleague",
  channelKey: "qa-throwaway",
};
const FIXED_NOW = () => new Date("2026-10-01T00:00:00.000Z");

describe("drill web-origin guard (APP_URL)", () => {
  it("admits staging, preview and dev origins", () => {
    expect(resolveDrillWebOrigin(STAGING_WEB)).toBe(STAGING_WEB);
    expect(resolveDrillWebOrigin("https://next.togetherweown.com/")).toBe(STAGING_WEB);
    expect(resolveDrillWebOrigin("http://localhost:8787")).toBe("http://localhost:8787");
  });

  it("refuses the production apex and its alternate spellings", () => {
    for (const apex of [
      "https://togetherweown.com",
      "https://TOGETHERWEOWN.COM/",
      "https://togetherweown.com./",
      "http://togetherweown.com:8787",
    ]) {
      expect(() => resolveDrillWebOrigin(apex)).toThrow(/production/);
    }
  });

  it("refuses a missing, malformed or unsafe APP_URL", () => {
    expect(() => resolveDrillWebOrigin(undefined)).toThrow(BotTerminalError);
    expect(() => resolveDrillWebOrigin("")).toThrow(BotTerminalError);
    expect(() => resolveDrillWebOrigin("not a url")).toThrow(BotTerminalError);
    for (const unsafe of [
      "ftp://next.togetherweown.com",
      "https://user:fixture-password@next.togetherweown.com",
      "https://next.togetherweown.com?token=fixture",
      "https://next.togetherweown.com#fixture",
    ]) {
      expect(() => resolveDrillWebOrigin(unsafe)).toThrow(BotTerminalError);
    }
    // A bare subdomain of the apex is staging, not production — admitted.
    expect(resolveDrillWebOrigin("https://anything.togetherweown.com")).toBe(
      "https://anything.togetherweown.com",
    );
  });
});

describe("drill target resolution", () => {
  it("admits a staging bot with a staging web origin", () => {
    expect(
      resolveDrillTarget({
        BOT_ENDPOINT_URL: STAGING_BOT,
        BOT_PRODUCTION_URL: PRODUCTION_BOT,
        APP_URL: STAGING_WEB,
      }),
    ).toEqual({ botUrl: STAGING_BOT, webOrigin: STAGING_WEB });
  });

  it("refuses the production bot host", () => {
    expect(() =>
      resolveDrillTarget({
        BOT_ENDPOINT_URL: PRODUCTION_BOT,
        BOT_PRODUCTION_URL: PRODUCTION_BOT,
        APP_URL: STAGING_WEB,
      }),
    ).toThrow(/production/);
  });

  it("refuses the production web apex even with a staging bot", () => {
    expect(() =>
      resolveDrillTarget({
        BOT_ENDPOINT_URL: STAGING_BOT,
        BOT_PRODUCTION_URL: PRODUCTION_BOT,
        APP_URL: "https://togetherweown.com",
      }),
    ).toThrow(/production/);
  });

  it("refuses a missing APP_URL or production exclusion before any network", () => {
    expect(() =>
      resolveDrillTarget({ BOT_ENDPOINT_URL: STAGING_BOT, BOT_PRODUCTION_URL: PRODUCTION_BOT }),
    ).toThrow(BotTerminalError);
    expect(() =>
      resolveDrillTarget({
        BOT_ENDPOINT_URL: STAGING_BOT,
        BOT_PRODUCTION_URL: "",
        APP_URL: STAGING_WEB,
      }),
    ).toThrow(BotTerminalError);
  });
});

describe("runInternalActionDrill (fixture client, no network)", () => {
  it("handles one role.assign and one announcement.post through the real producer/consumer pair", async () => {
    const bot = okClient();
    const r = await runInternalActionDrill(bot as unknown as BotClient, ARGS, FIXED_NOW);
    expect(r.ok).toBe(true);
    expect(r.checks.map((c) => c.label)).toEqual([
      "role.assign dispatched with a null carrier",
      "announcement.post dispatched with a UUID carrier",
      "role.assign handled",
      "announcement.post handled",
    ]);
    // The announcement went out exactly once, keyed by a fresh UUID carrier;
    // the body names this drill and the fixed clock.
    expect(bot.seenKeys).toHaveLength(1);
    expect(bot.seenKeys[0]).toMatch(UUID_RE);
    expect(bot.bodies).toHaveLength(1);
    expect(bot.bodies[0]).toContain("TOG-11706 drill run. Ignore. 2026-10-01T00:00:00.000Z");
  });

  it("never upserts events: CallInternalAction handles role.assign/announcement.post only", async () => {
    const bot = okClient();
    const spy = bot.upsertEvent;
    const r = await runInternalActionDrill(bot as unknown as BotClient, ARGS, FIXED_NOW);
    expect(r.ok).toBe(true);
    expect(bot.upsertEvent).toBe(spy); // untouched: the drill cannot reach it
  });

  it("fails loudly on a terminal bot refusal and keeps the other checks", async () => {
    const bot = {
      ...okClient(),
      assignRole: async () => fail({ code: "action_not_allowed", status: 403, retryable: false }),
    };
    const r = await runInternalActionDrill(bot as unknown as BotClient, ARGS, FIXED_NOW);
    expect(r.ok).toBe(false);
    expect(r.checks.find((c) => c.label === "role.assign handled")?.ok).toBe(false);
    expect(r.checks.find((c) => c.label === "announcement.post handled")?.ok).toBe(true);
  });

  it("a queued retry becomes a failed check: the drill takes a single pass", async () => {
    const bot = {
      ...okClient(),
      postAnnouncement: async () =>
        fail({ code: "rate_limited", status: 429, retryable: true, retryAfterSeconds: 42 }),
    };
    const r = await runInternalActionDrill(bot as unknown as BotClient, ARGS, FIXED_NOW);
    expect(r.ok).toBe(false);
    expect(r.failures.some((f) => f.includes("retry requested in 42s"))).toBe(true);
  });

  it("a thrown transport error becomes a failed check, not a crash", async () => {
    const bot = {
      ...okClient(),
      assignRole: async (): Promise<RoleAssignResult> => {
        throw new Error("connection reset");
      },
    };
    const r = await runInternalActionDrill(bot as unknown as BotClient, ARGS, FIXED_NOW);
    expect(r.ok).toBe(false);
    expect(r.failures.some((f) => f.includes("threw"))).toBe(true);
  });

  it("a terminal throw inside the call becomes a class-only failed check", async () => {
    // handleCallInternalAction converts BotTerminalError to terminalFailureReason()
    // (class-only, TOG-11627): the class is kept, provider text never leaks. The
    // CLI's assertConfigured owns the exit-2 path before the drill starts.
    const bot = {
      assignRole: async (): Promise<RoleAssignResult> => {
        throw new BotTerminalError("The bot refused role.assign with `malformed` [fixture-secret]");
      },
      postAnnouncement: async () =>
        ({ ok: true, requestId: "r2", messageId: "m1", replayed: false }) as AnnouncementResult,
      upsertEvent: async (): Promise<never> => {
        throw new Error("unreachable");
      },
    };
    const r = await runInternalActionDrill(bot as unknown as BotClient, ARGS, FIXED_NOW);
    expect(r.ok).toBe(false);
    expect(r.checks.find((c) => c.label === "role.assign handled")?.ok).toBe(false);
    expect(r.failures.some((f) => f.includes("BotTerminalError"))).toBe(true);
    expect(r.failures.some((f) => f.includes("malformed") || f.includes("fixture-secret"))).toBe(
      false,
    );
    expect(r.checks.find((c) => c.label === "announcement.post handled")?.ok).toBe(true);
  });
});

describe("internal-action-drill CLI", () => {
  const run = (args: string[], env: Record<string, string>): { code: number; out: string } => {
    try {
      const out = execFileSync(
        process.execPath,
        ["--import", "./bin/ts-hook.mjs", "bin/internal-action-drill.mjs", ...args],
        { encoding: "utf8", env: { ...process.env, ...env }, timeout: 30_000 },
      );
      return { code: 0, out };
    } catch (e) {
      const err = e as { status?: number; stdout?: string; stderr?: string };
      return { code: err.status ?? -1, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
    }
  };
  const opts = [
    "--discord-id=900000000000009999",
    "--role-key=rocketleague",
    "--channel-key=qa-throwaway",
  ];
  const stagingEnv = {
    APP_URL: STAGING_WEB,
    BOT_ENDPOINT_URL: STAGING_BOT,
    BOT_PRODUCTION_URL: PRODUCTION_BOT,
    BOT_SHARED_SECRET: "fixture-only",
    BOT_KEY_ID: "web-staging",
  };

  it("exit 2 on missing options, without touching the network", () => {
    const r = run([], { APP_URL: STAGING_WEB, BOT_ENDPOINT_URL: STAGING_BOT });
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/--discord-id/);
  });

  it("exit 2 when the bot target is the production host", () => {
    const r = run(opts, { ...stagingEnv, BOT_ENDPOINT_URL: PRODUCTION_BOT });
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/production/);
  });

  it("exit 2 when APP_URL is the production apex, even with a staging bot", () => {
    const r = run(opts, { ...stagingEnv, APP_URL: "https://togetherweown.com" });
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/production/);
  });

  it.each(["", "not a url", "ftp://bot.internal.example"])(
    "exit 2 on invalid production exclusion before network: %s",
    (production) => {
      const r = run(opts, { ...stagingEnv, BOT_PRODUCTION_URL: production });
      expect(r.code).toBe(2);
      expect(r.out).toMatch(/BOT_PRODUCTION_URL/);
      expect(r.out).not.toContain("fixture-only");
    },
  );

  it("exit 2 on a missing APP_URL before network", () => {
    const { APP_URL: _dropped, ...noWeb } = stagingEnv;
    const r = run(opts, noWeb);
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/APP_URL/);
  });

  it("refuses credential-bearing targets without echoing their credentials", () => {
    const r = run(opts, {
      ...stagingEnv,
      BOT_ENDPOINT_URL: "https://user:fixture-password@staging.example",
      APP_URL: "https://user:fixture-password@next.togetherweown.com",
    });
    expect(r.code).toBe(2);
    expect(r.out).not.toContain("fixture-password");
  });

  it("exit 2 when the bot is not configured", () => {
    const { BOT_SHARED_SECRET: _dropped, ...noSecret } = stagingEnv;
    const r = run(opts, noSecret);
    expect(r.code).toBe(2);
  });

  it("is wired as drill:internal-action without touching check or CI scripts", () => {
    const scripts = JSON.parse(readFileSync("package.json", "utf8")).scripts;
    expect(scripts["drill:internal-action"]).toBe(
      "node --import ./bin/ts-hook.mjs bin/internal-action-drill.mjs",
    );
    expect(scripts.check).toBe(
      "npm run lint && npm run typecheck && npm run e2e:typecheck && npm run config:check && npm run test && node --test ci/a11y-*.test.mjs && npm run test:cutover && npm run test:shadow && npm run test:smoke && npm run e2e:safety",
    );
  });
});

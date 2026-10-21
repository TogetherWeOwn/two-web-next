import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  APPROVED_MODERATOR_ROLE_IDS,
  checkModerators,
  DOOMED_MODERATOR_ROLE_IDS,
  PRODUCTION_GUILD_ID,
  STAGING_GUILD_ID,
  STAGING_MODERATOR_ROLE_IDS,
} from "../src/probes/check-moderators";
import { runBotSmoke, stagingEndpoint } from "../src/probes/bot-smoke";
import { BotTerminalError } from "../src/jobs/types";
import type { AnnouncementResult, EventUpsertResult, RoleAssignResult } from "../src/bot/client";
import type { BotFailure } from "../src/jobs/types";

const APPROVED = APPROVED_MODERATOR_ROLE_IDS.join(",");
const SYSOP = "508654771276873729";
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

describe("discord:check-moderators (role-config probe)", () => {
  it("blank is the correct state for local dev without --require-configured", () => {
    const p = checkModerators("");
    expect(p.ok).toBe(true);
    expect(p.failures).toBe(0);
    expect(p.findings.find((f) => f.name === "configured")?.status).toBe("PASS");
    expect(p.findings.find((f) => f.name === "fails-closed")?.status).toBe("PASS");
  });

  it("blank fails loudly with require-configured (the staging case)", () => {
    const p = checkModerators("", { requireConfigured: true });
    expect(p.ok).toBe(false);
    expect(p.findings.find((f) => f.name === "configured")?.status).toBe("FAIL");
  });

  it("exactly the approved Owner+Moderator pair passes every check", () => {
    const p = checkModerators(APPROVED, { requireConfigured: true });
    expect(p.ok).toBe(true);
    expect(p.findings).toHaveLength(5);
    expect(p.findings.every((f) => f.status === "PASS")).toBe(true);
  });

  it("fails on a doomed role that looks configured and grants nothing", () => {
    const doomed = Object.keys(DOOMED_MODERATOR_ROLE_IDS)[0]!;
    const p = checkModerators(`${APPROVED},${doomed}`, { requireConfigured: true });
    expect(p.ok).toBe(false);
    expect(p.findings.find((f) => f.name === "no-doomed-roles")?.status).toBe("FAIL");
  });

  it("retired SySOp alone fails: it is doomed and not approved", () => {
    expect(DOOMED_MODERATOR_ROLE_IDS[SYSOP]).toBeDefined();
    const p = checkModerators(SYSOP, { requireConfigured: true });
    expect(p.ok).toBe(false);
    expect(p.findings.find((f) => f.name === "no-doomed-roles")?.status).toBe("FAIL");
    expect(p.findings.find((f) => f.name === "is-approved")?.status).toBe("FAIL");
  });

  it("fails on a role name where an ID belongs", () => {
    const p = checkModerators("Moderator", { requireConfigured: true });
    expect(p.ok).toBe(false);
    expect(p.findings.find((f) => f.name === "shape")?.status).toBe("FAIL");
    expect(p.findings.find((f) => f.name === "is-approved")?.status).toBe("FAIL");
  });

  it("fails when an approved role is missing", () => {
    const p = checkModerators(APPROVED_MODERATOR_ROLE_IDS[0], { requireConfigured: true });
    expect(p.ok).toBe(false);
    expect(p.findings.find((f) => f.name === "is-approved")?.status).toBe("FAIL");
  });

  it.each([
    `${APPROVED},100000000000000001`,
    `${APPROVED},${APPROVED_MODERATOR_ROLE_IDS[0]}`,
    APPROVED_MODERATOR_ROLE_IDS[1],
    // Two-entry lists with a wrong member: the membership clause (not just
    // the length) must reject these. Kills the `every(...) => true` mutant.
    `${APPROVED_MODERATOR_ROLE_IDS[0]},100000000000000001`,
    `${APPROVED_MODERATOR_ROLE_IDS[0]},${APPROVED_MODERATOR_ROLE_IDS[0]}`,
  ])("refuses a list other than exactly the approved pair: %s", (raw) => {
    const p = checkModerators(raw, { requireConfigured: true });
    expect(p.ok).toBe(false);
    expect(p.findings.find((f) => f.name === "is-approved")?.status).toBe("FAIL");
    expect(p.unknowns).toBe(0);
  });

  it("trims whitespace and drops empties", () => {
    const [owner, moderator] = APPROVED_MODERATOR_ROLE_IDS;
    const p = checkModerators(`  ${owner} , ${moderator} , ,`, { requireConfigured: true });
    expect(p.ok).toBe(true);
  });

  it("malformed garbage alongside a good ID fails shape", () => {
    const p = checkModerators(`${APPROVED},abc`, { requireConfigured: true });
    expect(p.ok).toBe(false);
    expect(p.findings.find((f) => f.name === "shape")?.status).toBe("FAIL");
  });
});

describe("discord:check-moderators guild binding (staging vs production)", () => {
  const STAGING = STAGING_MODERATOR_ROLE_IDS.join(",");

  it("staging pair in the staging guild passes every check", () => {
    const p = checkModerators(STAGING, { requireConfigured: true, guildId: STAGING_GUILD_ID });
    expect(p.ok).toBe(true);
    expect(p.findings.find((f) => f.name === "guild-binding")?.status).toBe("PASS");
    expect(p.findings.every((f) => f.status === "PASS")).toBe(true);
  });

  it("production pair in the production guild passes every check", () => {
    const p = checkModerators(APPROVED, {
      requireConfigured: true,
      guildId: PRODUCTION_GUILD_ID,
    });
    expect(p.ok).toBe(true);
    expect(p.findings.find((f) => f.name === "guild-binding")?.status).toBe("PASS");
  });

  it("production pair in the staging guild fails (role IDs are guild-scoped)", () => {
    const p = checkModerators(APPROVED, {
      requireConfigured: true,
      guildId: STAGING_GUILD_ID,
    });
    expect(p.ok).toBe(false);
    expect(p.findings.find((f) => f.name === "guild-binding")?.status).toBe("FAIL");
    expect(p.findings.find((f) => f.name === "is-approved")?.status).toBe("FAIL");
  });

  it("staging pair in the production guild fails", () => {
    const p = checkModerators(STAGING, {
      requireConfigured: true,
      guildId: PRODUCTION_GUILD_ID,
    });
    expect(p.ok).toBe(false);
    expect(p.findings.find((f) => f.name === "guild-binding")?.status).toBe("FAIL");
  });

  it("unknown guild fails closed", () => {
    const p = checkModerators(APPROVED, {
      requireConfigured: true,
      guildId: "100000000000000001",
    });
    expect(p.ok).toBe(false);
    expect(p.findings.find((f) => f.name === "guild-binding")?.status).toBe("FAIL");
  });

  it("omitted guild keeps the legacy production-pair behavior with no binding finding", () => {
    const p = checkModerators(APPROVED, { requireConfigured: true });
    expect(p.ok).toBe(true);
    expect(p.findings.some((f) => f.name === "guild-binding")).toBe(false);
  });
});

describe("check-moderators CLI", () => {
  const run = (args: string[], env: Record<string, string>) =>
    execFileSync(
      process.execPath,
      ["--import", "./bin/ts-hook.mjs", "bin/check-moderators.mjs", ...args],
      {
        encoding: "utf8",
        env: { ...process.env, ...env },
        timeout: 30_000,
      },
    );
  const exitOf = (args: string[], env: Record<string, string>): number => {
    try {
      run(args, env);
      return 0;
    } catch (e) {
      return (e as { status?: number }).status ?? -1;
    }
  };

  it("blank passes locally, fails with --require-configured", () => {
    expect(exitOf([], { DISCORD_MODERATOR_ROLE_IDS: "" })).toBe(0);
    expect(exitOf(["--require-configured"], { DISCORD_MODERATOR_ROLE_IDS: "" })).toBe(1);
  });

  it("exactly the approved pair passes with --require-configured and --json", () => {
    expect(exitOf(["--require-configured"], { DISCORD_MODERATOR_ROLE_IDS: APPROVED })).toBe(0);
    const out = run(["--require-configured", "--json"], { DISCORD_MODERATOR_ROLE_IDS: APPROVED });
    expect(JSON.parse(out)).toMatchObject({ failures: 0, ok: true });
    expect(exitOf(["--require-configured"], { DISCORD_MODERATOR_ROLE_IDS: SYSOP })).toBe(1);
  });

  it("a doomed role fails the CLI", () => {
    const doomed = Object.keys(DOOMED_MODERATOR_ROLE_IDS)[0]!;
    expect(exitOf(["--require-configured"], { DISCORD_MODERATOR_ROLE_IDS: doomed })).toBe(1);
  });
});

describe("smoke staging guard", () => {
  it("refuses a missing or malformed target (exit 2: misconfigured)", () => {
    expect(() => stagingEndpoint(undefined)).toThrow(BotTerminalError);
    expect(() => stagingEndpoint("")).toThrow(BotTerminalError);
    expect(() => stagingEndpoint("not a url")).toThrow(BotTerminalError);
  });

  it("refuses the production host when the operator names it", () => {
    expect(() =>
      stagingEndpoint("https://bot.internal.example", "https://bot.internal.example"),
    ).toThrow(/production/);
    expect(() =>
      stagingEndpoint("https://BOT.internal.example/", "https://bot.internal.example/health"),
    ).toThrow(/production/);
  });

  it("admits a staging host that is not production", () => {
    expect(
      stagingEndpoint("https://bot-staging.internal.example", "https://bot.internal.example"),
    ).toBe("https://bot-staging.internal.example");
  });

  it.each([undefined, "", " ", "not a url", "ftp://bot.internal.example"])(
    "refuses missing or invalid production exclusion: %s",
    (production) => {
      expect(() => stagingEndpoint("https://bot-staging.internal.example", production)).toThrow(
        BotTerminalError,
      );
    },
  );

  it.each([
    "http://bot.internal.example:8787",
    "https://BOT.internal.example:444/",
    "https://bot.internal.example./",
  ])("refuses alternate spelling/port of the production hostname: %s", (target) => {
    expect(() => stagingEndpoint(target, "https://bot.internal.example")).toThrow(/production/);
  });

  it.each([
    "ftp://staging.example",
    "https://user:password@staging.example",
    "https://staging.example?token=secret",
    "https://staging.example#secret",
  ])("refuses unsafe target: %s", (target) => {
    expect(() => stagingEndpoint(target, "https://bot.internal.example")).toThrow(BotTerminalError);
  });
});

describe("bot:internal-action-smoke orchestration (fixture client)", () => {
  const args = {
    discordId: "900000000000009999",
    roleKey: "rocketleague",
    channelKey: "qa-throwaway",
    eventKey: "tog-test-1",
  };
  const fixedNow = () => new Date("2026-09-30T00:00:00.000Z");
  const roleOk: RoleAssignResult = { ok: true, requestId: "r1", outcome: "assigned" };
  const eventOk: EventUpsertResult = {
    ok: true,
    requestId: "r3",
    outcome: "created",
    discordEventId: "d1",
    replayed: false,
  };

  function stubClient(ann: (key: string, body: string) => AnnouncementResult | BotFailure) {
    const seen: string[] = [];
    return {
      seen,
      assignRole: async () => roleOk,
      postAnnouncement: async (a: { channelKey: string; body: string }, key: string) => {
        seen.push(key);
        return ann(key, a.body);
      },
      upsertEvent: async () => eventOk,
    };
  }

  it("passes when the retry replays the same message id", async () => {
    const client = stubClient(() => ({
      ok: true,
      requestId: "r2",
      messageId: "m1",
      replayed: true,
    }));
    const r = await runBotSmoke(client, args, fixedNow);
    expect(r.ok).toBe(true);
    expect(r.checks.map((c) => c.label)).toEqual([
      "role.assign is ok",
      "announcement.post is ok",
      "retry is ok",
      "retry is flagged Idempotent-Replay",
      "retry returns the original message_id",
      "event.upsert is ok",
    ]);
    // Same idempotency key on both announcement attempts (fresh nonce is the client's job).
    expect(client.seen).toHaveLength(2);
    expect(client.seen[0]).toBe(client.seen[1]);
  });

  it("announcement-only mode never calls role.assign or event.upsert", async () => {
    const calls: string[] = [];
    const client = {
      assignRole: async (): Promise<RoleAssignResult> => {
        calls.push("role.assign");
        throw new Error("must not be called");
      },
      postAnnouncement: async () => {
        calls.push("announcement.post");
        return {
          ok: true,
          requestId: "r2",
          messageId: "m1",
          replayed: calls.length > 1,
        } as AnnouncementResult;
      },
      upsertEvent: async (): Promise<EventUpsertResult> => {
        calls.push("event.upsert");
        throw new Error("must not be called");
      },
    };
    const r = await runBotSmoke(
      client,
      { announcementOnly: true, channelKey: "qa-throwaway" },
      fixedNow,
    );
    expect(r.ok).toBe(true);
    expect(calls).toEqual(["announcement.post", "announcement.post"]);
    expect(r.checks.map((c) => c.label)).toEqual([
      "announcement.post is ok",
      "retry is ok",
      "retry is flagged Idempotent-Replay",
      "retry returns the original message_id",
    ]);
  });

  it("reuses byte-identical announcement payload with an advancing clock", async () => {
    const bodies: string[] = [];
    const client = stubClient((_key, body) => {
      bodies.push(body);
      return { ok: true, requestId: "r2", messageId: "m1", replayed: bodies.length > 1 };
    });
    let tick = 0;
    const r = await runBotSmoke(client, args, () => new Date(Date.UTC(2026, 9, 1) + tick++ * 1000));
    expect(r.ok).toBe(true);
    expect(client.seen[0]).toBe(client.seen[1]);
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toBe(bodies[1]);
  });

  it("fails when the retry posts a second message instead of replaying", async () => {
    let n = 0;
    const client = stubClient(() => ({
      ok: true,
      requestId: "r2",
      messageId: `m${++n}`,
      replayed: false,
    }));
    const r = await runBotSmoke(client, args, fixedNow);
    expect(r.ok).toBe(false);
    expect(r.failures.some((f) => f.includes("Idempotent-Replay"))).toBe(true);
    expect(r.failures.some((f) => f.includes("original message_id"))).toBe(true);
  });

  it("fails loudly on a bot refusal and keeps the other checks", async () => {
    const client = {
      assignRole: async () => fail({ code: "action_not_allowed", status: 403, retryable: false }),
      postAnnouncement: async () =>
        ({ ok: true, requestId: "r2", messageId: "m1", replayed: true }) as AnnouncementResult,
      upsertEvent: async () => eventOk,
    };
    const r = await runBotSmoke(client, args, fixedNow);
    expect(r.ok).toBe(false);
    expect(r.checks.find((c) => c.label === "role.assign is ok")?.ok).toBe(false);
    expect(r.checks.find((c) => c.label === "event.upsert is ok")?.ok).toBe(true);
  });

  it("a misconfigured client propagates (exit 2), it is not a failed check", async () => {
    const client = {
      assignRole: async () => {
        throw new BotTerminalError("Bot is not configured: BOT_SHARED_SECRET is missing.");
      },
      postAnnouncement: async (): Promise<AnnouncementResult> => {
        throw new Error("unreachable");
      },
      upsertEvent: async (): Promise<EventUpsertResult> => {
        throw new Error("unreachable");
      },
    };
    await expect(runBotSmoke(client, args, fixedNow)).rejects.toThrow(BotTerminalError);
  });

  it("a thrown transport error becomes a failed check, not a crash", async () => {
    const client = {
      assignRole: async (): Promise<RoleAssignResult> => {
        throw new Error("connection reset");
      },
      postAnnouncement: async () =>
        ({ ok: true, requestId: "r2", messageId: "m1", replayed: true }) as AnnouncementResult,
      upsertEvent: async () => eventOk,
    };
    const r = await runBotSmoke(client, args, fixedNow);
    expect(r.ok).toBe(false);
    expect(r.failures.some((f) => f.includes("threw"))).toBe(true);
  });
});

describe("internal-action-smoke CLI", () => {
  const run = (args: string[], env: Record<string, string>): { code: number; out: string } => {
    try {
      const out = execFileSync(
        process.execPath,
        ["--import", "./bin/ts-hook.mjs", "bin/internal-action-smoke.mjs", ...args],
        { encoding: "utf8", env: { ...process.env, ...env }, timeout: 30_000 },
      );
      return { code: 0, out };
    } catch (e) {
      const err = e as { status?: number; stdout?: string; stderr?: string };
      return { code: err.status ?? -1, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
    }
  };

  it("exit 2 on missing options, without touching the network", () => {
    const r = run([], { BOT_ENDPOINT_URL: "https://bot-staging.internal.example" });
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/--discord-id/);
  });

  it("--announcement-only needs only --channel-key (exit 2 without it)", () => {
    const r = run(["--announcement-only"], {
      BOT_ENDPOINT_URL: "https://bot-staging.internal.example",
    });
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/--channel-key/);
    expect(r.out).not.toMatch(/--discord-id|--role-key/);
  });

  it("--announcement-only still refuses the production host", () => {
    const r = run(["--announcement-only", "--channel-key=qa-throwaway"], {
      BOT_ENDPOINT_URL: "https://bot.internal.example",
      BOT_PRODUCTION_URL: "https://bot.internal.example",
      BOT_SHARED_SECRET: "x",
      BOT_KEY_ID: "web-staging",
    });
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/production/);
  });

  it("exit 2 when the target is the production host", () => {
    const r = run(
      ["--discord-id=900000000000009999", "--role-key=rocketleague", "--channel-key=qa-throwaway"],
      {
        BOT_ENDPOINT_URL: "https://bot.internal.example",
        BOT_PRODUCTION_URL: "https://bot.internal.example",
        BOT_SHARED_SECRET: "x",
        BOT_KEY_ID: "web-staging",
      },
    );
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/production/);
  });

  it.each(["", "not a url", "ftp://bot.internal.example"])(
    "exit 2 on invalid production exclusion before network: %s",
    (production) => {
      const r = run(
        [
          "--discord-id=900000000000009999",
          "--role-key=rocketleague",
          "--channel-key=qa-throwaway",
        ],
        {
          BOT_ENDPOINT_URL: "https://bot-staging.internal.example",
          BOT_PRODUCTION_URL: production,
          BOT_SHARED_SECRET: "fixture-only",
          BOT_KEY_ID: "web-staging",
        },
      );
      expect(r.code).toBe(2);
      expect(r.out).toMatch(/BOT_PRODUCTION_URL/);
      expect(r.out).not.toContain("fixture-only");
    },
  );

  it("refuses credential-bearing URLs without echoing their credentials", () => {
    const r = run(
      ["--discord-id=900000000000009999", "--role-key=rocketleague", "--channel-key=qa-throwaway"],
      {
        BOT_ENDPOINT_URL: "https://user:fixture-password@staging.example",
        BOT_PRODUCTION_URL: "https://bot.internal.example",
      },
    );
    expect(r.code).toBe(2);
    expect(r.out).not.toContain("fixture-password");
  });

  it("exit 2 when the bot is not configured", () => {
    const r = run(
      [
        "--discord-id=900000000000009999",
        "--role-key=rocketleague",
        "--channel-key=qa-throwaway",
        "--apply",
      ],
      {
        BOT_ENDPOINT_URL: "https://bot-staging.internal.example",
        BOT_PRODUCTION_URL: "https://bot.internal.example",
      },
    );
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/BOT_SHARED_SECRET/);
  });
});

import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import type { AnnouncementResult, EventUpsertResult, RoleAssignResult } from "../src/bot/client";
import { BotTerminalError } from "../src/jobs/types";
import type { BotClient } from "../src/jobs/types";
import { runBotSmoke } from "../src/probes/bot-smoke";
import { runInternalActionDrill } from "../src/probes/internal-action-drill";

// Acceptance: the internal-action tools refuse ambiguous arguments and
// validate every input that applies to the chosen mode before the first
// effect.
//
// Two defects are pinned here.
//
// 1. Both CLIs (bin/internal-action-smoke.mjs, bin/internal-action-drill.mjs)
//    pick individual options out of argv and ignore everything else. An
//    unsupported --dry-run, an unknown flag, a duplicate option, positional
//    garbage or a malformed option form therefore does not stop a configured
//    live run: the tool proceeds exactly as if the extra tokens were absent.
//    The contract is exit 2 with bounded usage, before any fetch, for every
//    such token. --dry-run is refused, not turned into a preview mode.
//
// 2. The orchestration (runBotSmoke, runInternalActionDrill) performs
//    effects in sequence and only validates each payload inside the client
//    call that sends it. A later input that the existing validators refuse
//    (a 65-character event key, a whitespace or overlong channel key) is
//    discovered only after the role assignment and the announcements have
//    already happened. The contract is that every applicable input is
//    preflighted with the existing validators before the first client call:
//    an invalid later input means zero role assignments, zero announcements,
//    zero queued carrier calls and zero event writes, surfaced as the
//    validators' BotTerminalError (exit 2 at the CLI).
//
// The counting clients below deliberately do not validate anything: they
// record every call and answer success. If preflight is missing, an invalid
// input shows up here as a recorded effect (or a passing report), never as a
// fixture failure. CLI cases run the real scripts as subprocesses against a
// closed loopback port with synthetic configuration only, so any fetch a
// broken parser still attempts fails instantly on loopback; no staging,
// Discord or external network is ever contacted.

const FIXED_NOW = () => new Date("2026-10-01T00:00:00.000Z");
const OVERLONG = "k".repeat(65); // one past the 64-character key cap
const AT_CAP = "k".repeat(64);

const ROLE_OK: RoleAssignResult = { ok: true, requestId: "r1", outcome: "assigned" };
const EVENT_OK: EventUpsertResult = {
  ok: true,
  requestId: "r3",
  outcome: "created",
  discordEventId: "d1",
  replayed: false,
};

const VALID_SMOKE = {
  discordId: "900000000000009999",
  roleKey: "rocketleague",
  channelKey: "qa-throwaway",
  eventKey: "smoke-event-1",
};
const VALID_DRILL = {
  discordId: VALID_SMOKE.discordId,
  roleKey: VALID_SMOKE.roleKey,
  channelKey: VALID_SMOKE.channelKey,
};

// ---------------------------------------------------------------------------
// Orchestration preflight: runBotSmoke
// ---------------------------------------------------------------------------

function countingSmokeClient() {
  const calls: string[] = [];
  const announcementKeys: string[] = [];
  return {
    calls,
    announcementKeys,
    assignRole: async (): Promise<RoleAssignResult> => {
      calls.push("role.assign");
      return ROLE_OK;
    },
    postAnnouncement: async (
      _a: { channelKey: string; body: string },
      key: string,
    ): Promise<AnnouncementResult> => {
      calls.push("announcement.post");
      announcementKeys.push(key);
      return {
        ok: true,
        requestId: "r2",
        messageId: "m1",
        replayed: announcementKeys.length > 1,
      };
    },
    upsertEvent: async (): Promise<EventUpsertResult> => {
      calls.push("event.upsert");
      return EVENT_OK;
    },
  };
}

describe("runBotSmoke preflights every applicable input before the first effect", () => {
  it.each([
    ["a 65-character event key", { eventKey: OVERLONG }],
    ["a whitespace-only event key", { eventKey: "   " }],
    ["a 65-character channel key", { channelKey: OVERLONG }],
    ["a whitespace-only channel key", { channelKey: "   " }],
    ["a 65-character role key", { roleKey: OVERLONG }],
    ["a whitespace-only role key", { roleKey: "   " }],
    ["a non-snowflake discord id", { discordId: "not-a-snowflake" }],
    ["a 21-digit discord id", { discordId: "1".repeat(21) }],
  ])("full smoke refuses %s with zero client calls", async (_label, patch) => {
    const client = countingSmokeClient();
    await expect(runBotSmoke(client, { ...VALID_SMOKE, ...patch }, FIXED_NOW)).rejects.toThrow(
      BotTerminalError,
    );
    expect(client.calls).toEqual([]);
  });

  it.each([
    ["a 65-character channel key", OVERLONG],
    ["a whitespace-only channel key", "   "],
  ])("announcement-only refuses %s with zero client calls", async (_label, channelKey) => {
    const client = countingSmokeClient();
    await expect(
      runBotSmoke(client, { announcementOnly: true, channelKey }, FIXED_NOW),
    ).rejects.toThrow(BotTerminalError);
    expect(client.calls).toEqual([]);
  });
});

describe("runBotSmoke valid modes (controls)", () => {
  it("valid full smoke keeps role, announcement, same-key replay, event ordering", async () => {
    const client = countingSmokeClient();
    const report = await runBotSmoke(client, VALID_SMOKE, FIXED_NOW);
    expect(report.ok).toBe(true);
    expect(client.calls).toEqual([
      "role.assign",
      "announcement.post",
      "announcement.post",
      "event.upsert",
    ]);
    expect(client.announcementKeys).toHaveLength(2);
    expect(client.announcementKeys[0]).toBe(client.announcementKeys[1]);
  });

  it("keys exactly at the 64-character cap and a 20-digit snowflake are admitted", async () => {
    const client = countingSmokeClient();
    const report = await runBotSmoke(
      client,
      {
        discordId: "9".repeat(20),
        roleKey: AT_CAP,
        channelKey: AT_CAP,
        eventKey: AT_CAP,
      },
      FIXED_NOW,
    );
    expect(report.ok).toBe(true);
    expect(client.calls).toHaveLength(4);
  });

  it("announcement-only requires only its channel input and does no role or event work", async () => {
    const client = countingSmokeClient();
    const report = await runBotSmoke(
      client,
      { announcementOnly: true, channelKey: "qa-throwaway" },
      FIXED_NOW,
    );
    expect(report.ok).toBe(true);
    expect(client.calls).toEqual(["announcement.post", "announcement.post"]);
  });
});

// ---------------------------------------------------------------------------
// Orchestration preflight: runInternalActionDrill
// ---------------------------------------------------------------------------

function countingDrillBot() {
  const calls: string[] = [];
  const announcementKeys: string[] = [];
  return {
    calls,
    announcementKeys,
    assignRole: async (): Promise<RoleAssignResult> => {
      calls.push("role.assign");
      return ROLE_OK;
    },
    postAnnouncement: async (
      _a: { channelKey: string; body: string },
      key: string,
    ): Promise<AnnouncementResult> => {
      calls.push("announcement.post");
      announcementKeys.push(key);
      return { ok: true, requestId: "r2", messageId: "m1", replayed: false };
    },
    upsertEvent: async (): Promise<EventUpsertResult> => {
      calls.push("event.upsert");
      return EVENT_OK;
    },
  };
}

describe("runInternalActionDrill preflights every input before dispatch or handling", () => {
  it.each([
    ["a 65-character channel key", { channelKey: OVERLONG }],
    ["a whitespace-only channel key", { channelKey: "   " }],
    ["a 65-character role key", { roleKey: OVERLONG }],
    ["a whitespace-only role key", { roleKey: "   " }],
    ["a non-snowflake discord id", { discordId: "not-a-snowflake" }],
    ["a 21-digit discord id", { discordId: "1".repeat(21) }],
  ])("refuses %s with zero bot calls", async (_label, patch) => {
    const bot = countingDrillBot();
    await expect(
      runInternalActionDrill(bot as unknown as BotClient, { ...VALID_DRILL, ...patch }, FIXED_NOW),
    ).rejects.toThrow(BotTerminalError);
    expect(bot.calls).toEqual([]);
  });

  it("valid drill keeps its carrier and handling semantics (control)", async () => {
    const bot = countingDrillBot();
    const report = await runInternalActionDrill(
      bot as unknown as BotClient,
      VALID_DRILL,
      FIXED_NOW,
    );
    expect(report.ok).toBe(true);
    expect(bot.calls).toEqual(["role.assign", "announcement.post"]);
    expect(bot.announcementKeys).toHaveLength(1);
    expect(bot.announcementKeys[0]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });
});

// ---------------------------------------------------------------------------
// CLI argument strictness (subprocess, synthetic configuration only)
// ---------------------------------------------------------------------------

const SECRET = "fixture-only-secret-value";
// A closed loopback port: if a parser still lets a run through, its first
// fetch is refused instantly on loopback. Nothing leaves this machine.
const CLOSED_LOOPBACK_BOT = "http://127.0.0.1:1";
const BASE_ENV: Record<string, string> = {
  BOT_ENDPOINT_URL: CLOSED_LOOPBACK_BOT,
  BOT_PRODUCTION_URL: "https://bot.internal.example",
  BOT_SHARED_SECRET: SECRET,
  BOT_KEY_ID: "web-staging",
  APP_URL: "https://next.togetherweown.com",
};

function runCli(
  script: string,
  args: string[],
  overrides: Record<string, string> = {},
  drop: string[] = [],
): { code: number; out: string } {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    ...BASE_ENV,
    ...overrides,
  };
  for (const name of drop) delete env[name];
  try {
    const out = execFileSync(process.execPath, ["--import", "./bin/ts-hook.mjs", script, ...args], {
      encoding: "utf8",
      env,
      timeout: 30_000,
    });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? -1, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

// A parser refusal is exit 2 with bounded usage, before any check runs or
// any fetch is attempted: no check report, no failure summary, no secret.
function expectUsageRefusal(r: { code: number; out: string }): void {
  expect(r.code).toBe(2);
  expect(r.out).toMatch(/usage/i);
  expect(r.out.length).toBeLessThan(4000);
  expect(r.out).not.toContain("check(s) failed");
  expect(r.out).not.toContain("NEEDS WORK");
  expect(r.out).not.toContain(SECRET);
}

const SMOKE = "bin/internal-action-smoke.mjs";
const SMOKE_VALID = [
  `--discord-id=${VALID_SMOKE.discordId}`,
  `--role-key=${VALID_SMOKE.roleKey}`,
  `--channel-key=${VALID_SMOKE.channelKey}`,
  `--event-key=${VALID_SMOKE.eventKey}`,
];
const SMOKE_VALID_NO_EVENT = SMOKE_VALID.slice(0, 3);

describe("internal-action-smoke CLI rejects ambiguous arguments before fetching", () => {
  it.each([
    ["unsupported --dry-run", [...SMOKE_VALID, "--dry-run"]],
    ["unsupported --dry-run with a value", [...SMOKE_VALID, "--dry-run=true"]],
    ["an unknown flag", [...SMOKE_VALID, "--bogus=1"]],
    ["a bare unknown flag", [...SMOKE_VALID, "--bogus"]],
    ["positional garbage", [...SMOKE_VALID, "garbage"]],
    [
      "a duplicate option with a different value",
      [...SMOKE_VALID, "--channel-key=someone-elses-channel"],
    ],
    ["a duplicate option with the same value", [...SMOKE_VALID, SMOKE_VALID[1]!]],
    [
      "a duplicated --announcement-only flag",
      ["--announcement-only", "--announcement-only", `--channel-key=${VALID_SMOKE.channelKey}`],
    ],
    ["a flag given a value it does not take", [...SMOKE_VALID, "--announcement-only=true"]],
    ["a bare value option alongside the real one", [...SMOKE_VALID, "--event-key"]],
    [
      "the space-separated option form",
      [...SMOKE_VALID_NO_EVENT, "--event-key", VALID_SMOKE.eventKey],
    ],
    ["an explicitly empty option value", [...SMOKE_VALID_NO_EVENT, "--event-key="]],
  ])("exit 2 with usage for %s", (_label, args) => {
    expectUsageRefusal(runCli(SMOKE, args));
  });
});

const DRILL = "bin/internal-action-drill.mjs";
const DRILL_VALID = [
  `--discord-id=${VALID_DRILL.discordId}`,
  `--role-key=${VALID_DRILL.roleKey}`,
  `--channel-key=${VALID_DRILL.channelKey}`,
];

describe("internal-action-drill CLI rejects ambiguous arguments before fetching", () => {
  it.each([
    ["unsupported --dry-run", [...DRILL_VALID, "--dry-run"]],
    ["an unknown flag", [...DRILL_VALID, "--bogus=1"]],
    ["positional garbage", [...DRILL_VALID, "garbage"]],
    [
      "a duplicate option with a different value",
      [...DRILL_VALID, "--role-key=someone-elses-role"],
    ],
    ["the smoke-only --announcement-only flag", [...DRILL_VALID, "--announcement-only"]],
    ["the smoke-only --event-key option", [...DRILL_VALID, "--event-key=smoke-event-1"]],
    ["a bare value option alongside the real one", [...DRILL_VALID, "--channel-key"]],
    [
      "the space-separated option form",
      [DRILL_VALID[0]!, DRILL_VALID[1]!, "--channel-key", VALID_DRILL.channelKey],
    ],
  ])("exit 2 with usage for %s", (_label, args) => {
    expectUsageRefusal(runCli(DRILL, args));
  });
});

describe("CLI controls that already hold and must keep holding", () => {
  it("smoke admits the documented full argument set (reaches configuration, not usage)", () => {
    const r = runCli(SMOKE, [...SMOKE_VALID, "--apply"], {}, ["BOT_SHARED_SECRET"]);
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/BOT_SHARED_SECRET/);
  });

  it("smoke admits a run without --event-key (the key is generated)", () => {
    const r = runCli(SMOKE, [...SMOKE_VALID_NO_EVENT, "--apply"], {}, ["BOT_SHARED_SECRET"]);
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/BOT_SHARED_SECRET/);
  });

  it("smoke announcement-only still needs only --channel-key", () => {
    const r = runCli(
      SMOKE,
      ["--announcement-only", `--channel-key=${VALID_SMOKE.channelKey}`, "--apply"],
      {},
      ["BOT_SHARED_SECRET"],
    );
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/BOT_SHARED_SECRET/);
    expect(r.out).not.toMatch(/missing required/);
  });

  it("smoke still refuses the production bot host with exit 2", () => {
    const r = runCli(SMOKE, SMOKE_VALID, {
      BOT_ENDPOINT_URL: "https://bot.internal.example",
    });
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/production/);
  });

  it("smoke with no options still names the missing ones with exit 2", () => {
    const r = runCli(SMOKE, []);
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/--discord-id/);
  });

  it("drill admits the documented argument set (reaches configuration, not usage)", () => {
    const r = runCli(DRILL, [...DRILL_VALID, "--apply"], {}, ["BOT_SHARED_SECRET"]);
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/BOT_SHARED_SECRET/);
  });

  it("drill still refuses the production web apex with exit 2", () => {
    const r = runCli(DRILL, DRILL_VALID, { APP_URL: "https://togetherweown.com" });
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/production/);
  });
});

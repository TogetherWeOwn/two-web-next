import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { AnnouncementResult, EventUpsertResult, RoleAssignResult } from "../src/bot/client";
import { BotTerminalError } from "../src/jobs/types";
import type { BotClient } from "../src/jobs/types";
import { dispatchAnnouncement } from "../src/jobs/call-internal-action";
import type { QueueMessage } from "../src/jobs/types";
import { runBotSmoke } from "../src/probes/bot-smoke";
import { runInternalActionDrill } from "../src/probes/internal-action-drill";

// Acceptance: the internal-action tools preview safely and resume the same
// smoke or drill identity.
//
// OWNERSHIP: this file is owned by the acceptance handoff. The builder builds
// on this branch and never edits this file; follow-up test corrections return
// to the acceptance card. No production implementation lives here.
//
// Intended contract (failing against the current source):
//
// 1. Both CLIs (bin/internal-action-smoke.mjs, bin/internal-action-drill.mjs)
//    default to an effect-free plan and require an explicit bare `--apply`
//    for the existing staging effects. A preview needs no secrets, attempts
//    no fetch, sends no queue carriers and exits 0; it names the plan and
//    the `--apply` next action. `--apply` without credentials fails exit 2
//    before any network; `--apply` with credentials attempts the run.
// 2. `--run-id=<id>` is an optional caller-supplied run identity, validated
//    as `^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$` (1-64 chars). Malformed identities,
//    wrong targets, missing options and contradictory flags
//    (`--announcement-only` with full-run options, duplicates, valued
//    booleans, space-separated values) fail exit 2 before network, queue or
//    credential-dependent calls. The production-host refusal and the
//    no-redirect contract keep holding in both modes.
// 3. The same validated run identity plus the same payload clock makes a
//    repeated apply reuse exactly the same event key (when generated),
//    announcement/event idempotency carriers and payload bytes. Distinct
//    identities stay distinct; role assignment keeps its natural
//    idempotency (null carrier, no key). The drill must not mutate the
//    global producer semantics to fit: direct dispatches still mint fresh
//    keys.
// 4. Agent experience: a bare `--json` emits one versioned JSON plan/report
//    with stable check IDs, a static UPPER_SNAKE error code and safe next
//    actions; raw exception text and secrets never appear. One canonical
//    short staging procedure documents preview, apply, repeat-run behavior
//    and the existing held live-proof boundary.
// 5. The already-authorized staging caller passes explicit `--apply`; the
//    suite distinguishes plan output from executed proof.
//
// Fixtures only: counting clients record calls and answer success; CLI cases
// run the real scripts as subprocesses against a closed loopback port with
// synthetic configuration, so any fetch a broken mode still attempts fails
// instantly on loopback. No staging, Discord, production or external network
// is ever contacted. `runId` is passed through a cast because the current
// probe types do not declare it yet; the runtime ignores the extra prop,
// which is exactly why the determinism assertions fail first.

const FIXED_NOW = () => new Date("2026-10-01T00:00:00.000Z");
const RUN_A = "smoke-repeat-1";
const RUN_B = "smoke-repeat-2";
const DRILL_RUN_A = "drill-repeat-1";
const DRILL_RUN_B = "drill-repeat-2";
const OVERLONG_RUN = "r".repeat(65);
const AT_CAP_RUN = "r".repeat(64);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ID_RE = /^[a-z0-9][a-z0-9._-]*$/;
const CODE_RE = /^[A-Z][A-Z0-9_]+$/;

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

// The current probe types do not declare `runId` yet; the cast keeps the
// suite type-clean while the runtime contract is still missing.
const withRunId = <T extends object>(args: T, runId: string): T => ({ ...args, runId }) as T;

type SmokeArgs = Parameters<typeof runBotSmoke>[1];
type DrillArgs = Parameters<typeof runInternalActionDrill>[1];

// ---------------------------------------------------------------------------
// Counting fixtures
// ---------------------------------------------------------------------------

function countingSmokeClient() {
  const calls: string[] = [];
  const announcementKeys: string[] = [];
  const announcementBodies: string[] = [];
  const eventKeys: string[] = [];
  const eventPayloads: unknown[] = [];
  return {
    calls,
    announcementKeys,
    announcementBodies,
    eventKeys,
    eventPayloads,
    assignRole: async (): Promise<RoleAssignResult> => {
      calls.push("role.assign");
      return ROLE_OK;
    },
    postAnnouncement: async (
      a: { channelKey: string; body: string },
      key: string,
    ): Promise<AnnouncementResult> => {
      calls.push("announcement.post");
      announcementKeys.push(key);
      announcementBodies.push(a.body);
      return {
        ok: true,
        requestId: "r2",
        messageId: `m-${key.slice(0, 8)}`,
        replayed: announcementKeys.length > 1,
      };
    },
    upsertEvent: async (e: { eventKey: string }, key: string): Promise<EventUpsertResult> => {
      calls.push("event.upsert");
      eventKeys.push(key);
      eventPayloads.push(JSON.parse(JSON.stringify(e)));
      return EVENT_OK;
    },
  };
}

function countingDrillBot() {
  const calls: string[] = [];
  const announcementKeys: string[] = [];
  const announcementBodies: string[] = [];
  return {
    calls,
    announcementKeys,
    announcementBodies,
    assignRole: async (): Promise<RoleAssignResult> => {
      calls.push("role.assign");
      return ROLE_OK;
    },
    postAnnouncement: async (
      a: { channelKey: string; body: string },
      key: string,
    ): Promise<AnnouncementResult> => {
      calls.push("announcement.post");
      announcementKeys.push(key);
      announcementBodies.push(a.body);
      return { ok: true, requestId: "r2", messageId: `m-${key.slice(0, 8)}`, replayed: false };
    },
    upsertEvent: async (): Promise<EventUpsertResult> => {
      calls.push("event.upsert");
      return EVENT_OK;
    },
  };
}

// ---------------------------------------------------------------------------
// Probe determinism: the same run identity replays the same carriers/bytes
// ---------------------------------------------------------------------------

describe("smoke repeat with the same run identity reuses carriers and bytes", () => {
  it("two applies of the same plan share announcement/event carriers and payload bytes", async () => {
    const first = countingSmokeClient();
    const second = countingSmokeClient();
    const args = withRunId<SmokeArgs>({ ...VALID_SMOKE }, RUN_A);
    const one = await runBotSmoke(first, args, FIXED_NOW);
    const two = await runBotSmoke(second, args, FIXED_NOW);
    expect(one.ok).toBe(true);
    expect(two.ok).toBe(true);
    // Within each run the retry already reuses its key; across runs the same
    // identity must replay the same key, not mint a fresh one.
    expect(first.announcementKeys).toHaveLength(2);
    expect(second.announcementKeys).toHaveLength(2);
    expect(first.announcementKeys[0]).toBe(first.announcementKeys[1]);
    expect(second.announcementKeys[0]).toBe(first.announcementKeys[0]);
    expect(second.announcementKeys[1]).toBe(first.announcementKeys[0]);
    expect(first.announcementKeys[0]).toMatch(UUID_RE);
    // Event carrier and payload bytes are stable too.
    expect(first.eventKeys).toHaveLength(1);
    expect(second.eventKeys).toEqual(first.eventKeys);
    expect(first.eventKeys[0]).toMatch(UUID_RE);
    expect(second.announcementBodies).toEqual(first.announcementBodies);
    expect(second.eventPayloads).toEqual(first.eventPayloads);
  });

  it("distinct run identities stay distinct", async () => {
    const first = countingSmokeClient();
    const second = countingSmokeClient();
    await runBotSmoke(first, withRunId<SmokeArgs>({ ...VALID_SMOKE }, RUN_A), FIXED_NOW);
    await runBotSmoke(second, withRunId<SmokeArgs>({ ...VALID_SMOKE }, RUN_B), FIXED_NOW);
    expect(first.announcementKeys[0]).not.toBe(second.announcementKeys[0]);
    expect(first.eventKeys[0]).not.toBe(second.eventKeys[0]);
  });

  it("role assignment keeps its natural idempotency under a run identity", async () => {
    const client = countingSmokeClient();
    const report = await runBotSmoke(
      client,
      withRunId<SmokeArgs>({ ...VALID_SMOKE }, RUN_A),
      FIXED_NOW,
    );
    expect(report.ok).toBe(true);
    // role.assign takes no key: the first call is the bare assignment, and the
    // announcement/event carriers below are the only minted keys.
    expect(client.calls[0]).toBe("role.assign");
    expect(client.announcementKeys).toHaveLength(2);
    expect(client.eventKeys).toHaveLength(1);
  });

  it("a malformed run identity fails before the first effect", async () => {
    for (const runId of ["", "   ", OVERLONG_RUN, "has space", "has/slash", "has@at"]) {
      const client = countingSmokeClient();
      await expect(
        runBotSmoke(client, withRunId<SmokeArgs>({ ...VALID_SMOKE }, runId), FIXED_NOW),
      ).rejects.toThrow(BotTerminalError);
      expect(client.calls).toEqual([]);
    }
  });

  it("a run identity at the 64-character cap is admitted", async () => {
    const client = countingSmokeClient();
    const report = await runBotSmoke(
      client,
      withRunId<SmokeArgs>({ ...VALID_SMOKE }, AT_CAP_RUN),
      FIXED_NOW,
    );
    expect(report.ok).toBe(true);
    expect(client.calls).toHaveLength(4);
  });
});

describe("smoke partial-failure resume replays the announcement carrier", () => {
  it("a failed event apply followed by a repeat reuses the same carriers and bytes", async () => {
    const seenKeys: string[] = [];
    const seenBodies: string[] = [];
    let eventAttempts = 0;
    const flaky = {
      assignRole: async (): Promise<RoleAssignResult> => ROLE_OK,
      postAnnouncement: async (
        a: { channelKey: string; body: string },
        key: string,
      ): Promise<AnnouncementResult> => {
        seenKeys.push(key);
        seenBodies.push(a.body);
        // A stable carrier replays the original message instead of posting twice.
        const firstIndex = seenKeys.indexOf(key);
        const replayed = firstIndex !== seenKeys.length - 1;
        return {
          ok: true,
          requestId: "r2",
          messageId: `m-${key.slice(0, 8)}`,
          replayed,
        };
      },
      upsertEvent: async (): Promise<EventUpsertResult> => {
        eventAttempts++;
        if (eventAttempts === 1) throw new Error("synthetic closed-loopback failure");
        return EVENT_OK;
      },
    };
    const args = withRunId<SmokeArgs>({ ...VALID_SMOKE }, RUN_A);
    const one = await runBotSmoke(flaky, args, FIXED_NOW);
    expect(one.ok).toBe(false);
    const keysAfterFirst = [...seenKeys];
    const bodiesAfterFirst = [...seenBodies];
    const two = await runBotSmoke(flaky, args, FIXED_NOW);
    expect(two.ok).toBe(true);
    // The resume posts nothing new: the same announcement key and bytes.
    expect(seenKeys.slice(keysAfterFirst.length)).toEqual(keysAfterFirst);
    expect(seenBodies.slice(bodiesAfterFirst.length)).toEqual(bodiesAfterFirst);
  });
});

describe("drill repeat with the same run identity reuses its carrier", () => {
  it("two applies of the same plan share the announcement carrier and body", async () => {
    const first = countingDrillBot();
    const second = countingDrillBot();
    const args = withRunId<DrillArgs>({ ...VALID_DRILL }, DRILL_RUN_A);
    const one = await runInternalActionDrill(first as unknown as BotClient, args, FIXED_NOW);
    const two = await runInternalActionDrill(second as unknown as BotClient, args, FIXED_NOW);
    expect(one.ok).toBe(true);
    expect(two.ok).toBe(true);
    expect(first.announcementKeys).toHaveLength(1);
    expect(second.announcementKeys).toEqual(first.announcementKeys);
    expect(first.announcementKeys[0]).toMatch(UUID_RE);
    expect(second.announcementBodies).toEqual(first.announcementBodies);
  });

  it("distinct drill identities stay distinct", async () => {
    const first = countingDrillBot();
    const second = countingDrillBot();
    await runInternalActionDrill(
      first as unknown as BotClient,
      withRunId<DrillArgs>({ ...VALID_DRILL }, DRILL_RUN_A),
      FIXED_NOW,
    );
    await runInternalActionDrill(
      second as unknown as BotClient,
      withRunId<DrillArgs>({ ...VALID_DRILL }, DRILL_RUN_B),
      FIXED_NOW,
    );
    expect(first.announcementKeys[0]).not.toBe(second.announcementKeys[0]);
  });

  it("role.assign keeps its null carrier under a run identity", async () => {
    const bot = countingDrillBot();
    const report = await runInternalActionDrill(
      bot as unknown as BotClient,
      withRunId<DrillArgs>({ ...VALID_DRILL }, DRILL_RUN_A),
      FIXED_NOW,
    );
    expect(report.ok).toBe(true);
    const carrierCheck = report.checks.find((c) => c.label.includes("null carrier"));
    expect(carrierCheck?.ok).toBe(true);
    expect(bot.calls).toEqual(["role.assign", "announcement.post"]);
  });

  it("a malformed drill run identity fails before dispatch or handling", async () => {
    for (const runId of ["", OVERLONG_RUN, "has space", "has/slash"]) {
      const bot = countingDrillBot();
      await expect(
        runInternalActionDrill(
          bot as unknown as BotClient,
          withRunId<DrillArgs>({ ...VALID_DRILL }, runId),
          FIXED_NOW,
        ),
      ).rejects.toThrow(BotTerminalError);
      expect(bot.calls).toEqual([]);
    }
  });
});

describe("drill partial-failure resume replays its announcement", () => {
  it("a failed announcement handling followed by a repeat reuses the same carrier", async () => {
    const seenKeys: string[] = [];
    let attempts = 0;
    const flaky = {
      assignRole: async (): Promise<RoleAssignResult> => ROLE_OK,
      postAnnouncement: async (
        _a: { channelKey: string; body: string },
        key: string,
      ): Promise<AnnouncementResult> => {
        attempts++;
        seenKeys.push(key);
        if (attempts === 1) throw new Error("synthetic closed-loopback failure");
        return { ok: true, requestId: "r2", messageId: `m-${key.slice(0, 8)}`, replayed: true };
      },
      upsertEvent: async (): Promise<EventUpsertResult> => EVENT_OK,
    };
    const args = withRunId<DrillArgs>({ ...VALID_DRILL }, DRILL_RUN_A);
    const one = await runInternalActionDrill(flaky as unknown as BotClient, args, FIXED_NOW);
    expect(one.ok).toBe(false);
    const two = await runInternalActionDrill(flaky as unknown as BotClient, args, FIXED_NOW);
    expect(two.ok).toBe(true);
    expect(seenKeys).toHaveLength(2);
    expect(seenKeys[1]).toBe(seenKeys[0]);
  });
});

describe("global producer semantics stay untouched", () => {
  it("two direct announcement dispatches still mint distinct keys", async () => {
    const sent: QueueMessage[] = [];
    const queue = {
      send: async (b: unknown): Promise<unknown> => void sent.push(b as QueueMessage),
    };
    const action = { channelKey: "c", body: "b" };
    await dispatchAnnouncement(queue, action);
    await dispatchAnnouncement(queue, action);
    const keys = sent.map(
      (m) => (m as Extract<QueueMessage, { kind: "announcement" }>).idempotencyKey,
    );
    expect(keys).toHaveLength(2);
    expect(keys[0]).toMatch(UUID_RE);
    expect(keys[1]).toMatch(UUID_RE);
    expect(keys[0]).not.toBe(keys[1]);
  });
});

// ---------------------------------------------------------------------------
// Probe redaction: raw transport text never reaches the report
// ---------------------------------------------------------------------------

describe("probe reports redact raw exception text", () => {
  const MARKER = "fixture-marker-raw-text";

  it("a smoke transport throw surfaces a static failure without the raw message", async () => {
    const client = {
      ...countingSmokeClient(),
      assignRole: async (): Promise<RoleAssignResult> => {
        throw new Error(`connection reset ${MARKER}`);
      },
    };
    const report = await runBotSmoke(client, { ...VALID_SMOKE }, FIXED_NOW);
    expect(report.ok).toBe(false);
    const text = JSON.stringify(report);
    expect(text).not.toContain(MARKER);
    expect(text).not.toContain("connection reset");
  });

  it("a drill transport throw surfaces a static failure without the raw message", async () => {
    const bot = {
      ...countingDrillBot(),
      assignRole: async (): Promise<RoleAssignResult> => {
        throw new Error(`connection reset ${MARKER}`);
      },
    };
    const report = await runInternalActionDrill(
      bot as unknown as BotClient,
      { ...VALID_DRILL },
      FIXED_NOW,
    );
    expect(report.ok).toBe(false);
    expect(JSON.stringify(report)).not.toContain(MARKER);
  });
});

// ---------------------------------------------------------------------------
// CLI preview/apply (subprocess, synthetic configuration only)
// ---------------------------------------------------------------------------

const SECRET = "fixture-only-secret-value";
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
): { code: number; stdout: string; stderr: string; out: string } {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    ...BASE_ENV,
    ...overrides,
  };
  for (const name of drop) delete env[name];
  try {
    const stdout = execFileSync(
      process.execPath,
      ["--import", "./bin/ts-hook.mjs", script, ...args],
      { encoding: "utf8", env, timeout: 30_000 },
    );
    return { code: 0, stdout, stderr: "", out: stdout };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    const stdout = err.stdout ?? "";
    const stderr = err.stderr ?? "";
    return { code: err.status ?? -1, stdout, stderr, out: `${stdout}${stderr}` };
  }
}

const SMOKE = "bin/internal-action-smoke.mjs";
const DRILL = "bin/internal-action-drill.mjs";
const SMOKE_VALID = [
  `--discord-id=${VALID_SMOKE.discordId}`,
  `--role-key=${VALID_SMOKE.roleKey}`,
  `--channel-key=${VALID_SMOKE.channelKey}`,
  `--event-key=${VALID_SMOKE.eventKey}`,
];
const DRILL_VALID = [
  `--discord-id=${VALID_DRILL.discordId}`,
  `--role-key=${VALID_DRILL.roleKey}`,
  `--channel-key=${VALID_DRILL.channelKey}`,
];

// A preview succeeds without secrets and names the plan plus the explicit
// apply next action; it never carries executed proof.
function expectPreview(r: { code: number; out: string }): void {
  expect(r.code).toBe(0);
  expect(r.out).toMatch(/plan|preview/i);
  expect(r.out).toMatch(/--apply/);
  expect(r.out).not.toContain("check(s) failed");
  expect(r.out).not.toContain("NEEDS WORK");
  expect(r.out).not.toContain("message_id=");
  expect(r.out).not.toContain("handled: done");
  expect(r.out).not.toContain(SECRET);
}

describe("smoke defaults to an effect-free plan", () => {
  it("a preview without secrets exits 0 and names the apply next action", () => {
    expectPreview(runCli(SMOKE, SMOKE_VALID, {}, ["BOT_SHARED_SECRET", "BOT_KEY_ID"]));
  });

  it("a preview with secrets still attempts nothing", () => {
    expectPreview(runCli(SMOKE, SMOKE_VALID));
  });

  it("announcement-only previews without its skipped inputs", () => {
    expectPreview(
      runCli(SMOKE, ["--announcement-only", `--channel-key=${VALID_SMOKE.channelKey}`], {}, [
        "BOT_SHARED_SECRET",
        "BOT_KEY_ID",
      ]),
    );
  });

  it("--apply without credentials fails exit 2 before any network", () => {
    const r = runCli(SMOKE, [...SMOKE_VALID, "--apply"], {}, ["BOT_SHARED_SECRET"]);
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/BOT_SHARED_SECRET/);
    expect(r.out).not.toContain("check(s) failed");
    expect(r.out).not.toContain(SECRET);
  });

  it("--apply with credentials attempts the run (closed loopback fails its checks)", () => {
    const r = runCli(SMOKE, [...SMOKE_VALID, "--apply"]);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/check\(s\) failed|NEEDS WORK/);
    expect(r.out).not.toContain(SECRET);
  });
});

describe("drill defaults to an effect-free plan", () => {
  it("a preview without secrets exits 0 and names the apply next action", () => {
    expectPreview(runCli(DRILL, DRILL_VALID, {}, ["BOT_SHARED_SECRET", "BOT_KEY_ID"]));
  });

  it("a preview with secrets still attempts nothing", () => {
    expectPreview(runCli(DRILL, DRILL_VALID));
  });

  it("--apply without credentials fails exit 2 before any network", () => {
    const r = runCli(DRILL, [...DRILL_VALID, "--apply"], {}, ["BOT_SHARED_SECRET"]);
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/BOT_SHARED_SECRET/);
    expect(r.out).not.toContain(SECRET);
  });

  it("--apply with credentials attempts the run (closed loopback fails its checks)", () => {
    const r = runCli(DRILL, [...DRILL_VALID, "--apply"]);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/check\(s\) failed|NEEDS WORK/);
    expect(r.out).not.toContain(SECRET);
  });

  it("a preview still requires its staging web origin", () => {
    const r = runCli(DRILL, DRILL_VALID, {}, ["APP_URL", "BOT_SHARED_SECRET"]);
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/APP_URL/);
  });
});

describe("invalid inputs fail before network, queue or credentials", () => {
  it.each([
    ["smoke preview", SMOKE, SMOKE_VALID, {}],
    ["smoke apply", SMOKE, [...SMOKE_VALID, "--apply"], {}],
    ["drill preview", DRILL, DRILL_VALID, {}],
    ["drill apply", DRILL, [...DRILL_VALID, "--apply"], {}],
  ])("%s refuses the production bot host before the secret check", (_label, script, args) => {
    const r = runCli(
      script as string,
      args as string[],
      { BOT_ENDPOINT_URL: "https://bot.internal.example" },
      ["BOT_SHARED_SECRET"],
    );
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/production/);
    expect(r.out).not.toMatch(/BOT_SHARED_SECRET/);
  });

  it.each([
    ["smoke preview", SMOKE, []],
    ["smoke apply", SMOKE, ["--apply"]],
    ["drill preview", DRILL, []],
    ["drill apply", DRILL, ["--apply"]],
  ])("%s names missing options with exit 2", (_label, script, args) => {
    const r = runCli(script as string, args as string[]);
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/missing required/);
    expect(r.out).not.toContain(SECRET);
  });

  it.each([
    ["smoke preview", SMOKE, ["--announcement-only"]],
    ["smoke apply", SMOKE, ["--announcement-only", "--apply"]],
  ])("%s refuses announcement-only with full-run options", (_label, script, extra) => {
    for (const contradiction of [
      `--discord-id=${VALID_SMOKE.discordId}`,
      `--role-key=${VALID_SMOKE.roleKey}`,
      `--event-key=${VALID_SMOKE.eventKey}`,
    ]) {
      const r = runCli(script as string, [
        ...(extra as string[]),
        `--channel-key=${VALID_SMOKE.channelKey}`,
        contradiction,
      ]);
      expect(r.code).toBe(2);
      expect(r.out).toMatch(/usage|contradict/i);
      expect(r.out).not.toContain("check(s) failed");
      expect(r.out).not.toContain(SECRET);
    }
  });

  it.each([
    [SMOKE, SMOKE_VALID],
    [DRILL, DRILL_VALID],
  ])("duplicate or valued booleans fail with exit 2", (script, valid) => {
    for (const args of [
      [...(valid as string[]), "--apply", "--apply"],
      [...(valid as string[]), "--apply=true"],
      [...(valid as string[]), "--json", "--json"],
      [...(valid as string[]), "--json=true"],
    ]) {
      const r = runCli(script as string, args);
      expect(r.code).toBe(2);
      expect(r.out).toMatch(/usage/i);
      expect(r.out).not.toContain(SECRET);
    }
  });

  it.each([
    [SMOKE, SMOKE_VALID],
    [DRILL, DRILL_VALID],
  ])("malformed run identities fail before the secret check", (script, valid) => {
    for (const bad of ["", "has space", "has/slash", "has@at", OVERLONG_RUN]) {
      const r = runCli(script as string, [...(valid as string[]), `--run-id=${bad}`], {}, [
        "BOT_SHARED_SECRET",
      ]);
      expect(r.code).toBe(2);
      expect(r.out).toMatch(/run-?id/i);
      expect(r.out).not.toMatch(/BOT_SHARED_SECRET/);
      expect(r.out).not.toContain("check(s) failed");
      expect(r.out).not.toContain(SECRET);
    }
  });

  it.each([
    [SMOKE, SMOKE_VALID],
    [DRILL, DRILL_VALID],
  ])("the space-separated and bare run-identity forms fail with exit 2", (script, valid) => {
    const base = valid as string[];
    for (const args of [
      [...base, "--run-id", RUN_A],
      [...base, "--run-id"],
      [...base, `--run-id=${RUN_A}`, `--run-id=${RUN_B}`],
    ]) {
      const r = runCli(script as string, args);
      expect(r.code).toBe(2);
      expect(r.out).toMatch(/usage|run-?id/i);
      expect(r.out).not.toContain(SECRET);
    }
  });

  it("a well-formed run identity is admitted in preview and apply", () => {
    const preview = runCli(SMOKE, [...SMOKE_VALID, `--run-id=${RUN_A}`], {}, ["BOT_SHARED_SECRET"]);
    expect(preview.code).toBe(0);
    expect(preview.out).toMatch(/plan|preview/i);
    const apply = runCli(SMOKE, [...SMOKE_VALID, `--run-id=${RUN_A}`, "--apply"], {}, [
      "BOT_SHARED_SECRET",
    ]);
    expect(apply.code).toBe(2);
    expect(apply.out).toMatch(/BOT_SHARED_SECRET/);
  });

  it("--dry-run with --apply refuses conflicting modes", () => {
    for (const [script, valid] of [
      [SMOKE, SMOKE_VALID],
      [DRILL, DRILL_VALID],
    ] as const) {
      const r = runCli(script, [...valid, "--dry-run", "--apply"]);
      expect(r.code).toBe(2);
      expect(r.out).toMatch(/usage/i);
    }
  });
});

// ---------------------------------------------------------------------------
// Versioned JSON plan/report with stable IDs, static codes, safe next actions
// ---------------------------------------------------------------------------

type JsonCheck = { id: string; label: string; ok?: boolean; detail?: string };
type JsonDoc = {
  version: number;
  mode: string;
  tool?: string;
  runId?: string | null;
  checks: JsonCheck[];
  failures?: string[];
  errorCode?: string;
  next: string[];
  [k: string]: unknown;
};

function parseJsonStdout(r: {
  code: number;
  stdout: string;
  stderr: string;
  out: string;
}): JsonDoc {
  expect(r.stdout).not.toBe("");
  const doc = JSON.parse(r.stdout) as JsonDoc;
  expect(typeof doc.version).toBe("number");
  expect(Array.isArray(doc.checks)).toBe(true);
  expect(Array.isArray(doc.next)).toBe(true);
  expect(doc.next.length).toBeGreaterThan(0);
  const text = r.out;
  expect(text).not.toContain(SECRET);
  return doc;
}

function expectStableChecks(doc: JsonDoc, expectedCount: number): void {
  expect(doc.checks).toHaveLength(expectedCount);
  const ids = doc.checks.map((c) => c.id);
  expect(new Set(ids).size).toBe(ids.length);
  for (const c of doc.checks) {
    expect(c.id).toMatch(ID_RE);
    expect(typeof c.label).toBe("string");
    expect(c.label.length).toBeGreaterThan(0);
  }
}

describe("versioned JSON plan and report", () => {
  it("a smoke preview emits a versioned plan with stable check IDs and a safe next action", () => {
    const one = parseJsonStdout(
      runCli(SMOKE, [...SMOKE_VALID, "--json"], {}, ["BOT_SHARED_SECRET"]),
    );
    expect(one.mode).toMatch(/plan/i);
    expectStableChecks(one, 6);
    expect(one.next.join("\n")).toMatch(/--apply/);
    const two = parseJsonStdout(
      runCli(SMOKE, [...SMOKE_VALID, "--json"], {}, ["BOT_SHARED_SECRET"]),
    );
    expect(two.version).toBe(one.version);
    expect(two.checks.map((c) => c.id)).toEqual(one.checks.map((c) => c.id));
  });

  it("an announcement-only preview emits its four planned checks", () => {
    const doc = parseJsonStdout(
      runCli(
        SMOKE,
        ["--announcement-only", `--channel-key=${VALID_SMOKE.channelKey}`, "--json"],
        {},
        ["BOT_SHARED_SECRET"],
      ),
    );
    expect(doc.mode).toMatch(/plan/i);
    expectStableChecks(doc, 4);
  });

  it("a drill preview emits a versioned plan with stable check IDs", () => {
    const doc = parseJsonStdout(
      runCli(DRILL, [...DRILL_VALID, "--json"], {}, ["BOT_SHARED_SECRET"]),
    );
    expect(doc.mode).toMatch(/plan/i);
    expectStableChecks(doc, 4);
    expect(doc.next.join("\n")).toMatch(/--apply/);
  });

  it("an apply report carries a static error code and redacted failures", () => {
    const r = runCli(SMOKE, [...SMOKE_VALID, "--apply", "--json"]);
    expect(r.code).toBe(1);
    const doc = parseJsonStdout(r);
    expect(doc.mode).toMatch(/report/i);
    expect(doc.errorCode).toMatch(CODE_RE);
    expectStableChecks(doc, 6);
    expect(JSON.stringify(doc)).not.toContain(SECRET);
    // The same failed apply repeats the same static code.
    const again = parseJsonStdout(runCli(SMOKE, [...SMOKE_VALID, "--apply", "--json"]));
    expect(again.errorCode).toBe(doc.errorCode);
  });

  it("a malformed run identity emits a static JSON error without raw text", () => {
    const r = runCli(SMOKE, [...SMOKE_VALID, "--run-id=has space", "--json"], {}, [
      "BOT_SHARED_SECRET",
    ]);
    expect(r.code).toBe(2);
    const doc = parseJsonStdout(r);
    expect(doc.errorCode).toMatch(CODE_RE);
    expect(doc.next.length).toBeGreaterThan(0);
    expect(r.out).not.toContain(SECRET);
  });

  it("JSON preserves the exit-code contract", () => {
    expect(runCli(SMOKE, SMOKE_VALID, {}, ["BOT_SHARED_SECRET"]).code).toBe(0);
    expect(runCli(SMOKE, [...SMOKE_VALID, "--json"], {}, ["BOT_SHARED_SECRET"]).code).toBe(0);
    expect(runCli(SMOKE, [...SMOKE_VALID, "--apply", "--json"]).code).toBe(1);
    expect(runCli(SMOKE, [...SMOKE_VALID, "--run-id=has space", "--json"]).code).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Generated event-key stability across previews with the same run identity
// ---------------------------------------------------------------------------

describe("a generated event key is stable for the same run identity", () => {
  it("two previews with the same run identity plan the same generated key", () => {
    const noEvent = SMOKE_VALID.slice(0, 3);
    const one = parseJsonStdout(
      runCli(SMOKE, [...noEvent, `--run-id=${RUN_A}`, "--json"], {}, ["BOT_SHARED_SECRET"]),
    );
    const two = parseJsonStdout(
      runCli(SMOKE, [...noEvent, `--run-id=${RUN_A}`, "--json"], {}, ["BOT_SHARED_SECRET"]),
    );
    const keyOf = (doc: JsonDoc): string => {
      const direct = (doc as { eventKey?: unknown }).eventKey;
      if (typeof direct === "string" && direct.length > 0) return direct;
      const text = JSON.stringify(doc);
      const m = text.match(/[A-Za-z0-9_-]{1,64}/);
      expect(m).not.toBeNull();
      return JSON.stringify(doc);
    };
    expect(keyOf(one)).toBe(keyOf(two));
  });

  it("distinct run identities plan distinct generated keys", () => {
    const noEvent = SMOKE_VALID.slice(0, 3);
    const one = parseJsonStdout(
      runCli(SMOKE, [...noEvent, `--run-id=${RUN_A}`, "--json"], {}, ["BOT_SHARED_SECRET"]),
    );
    const two = parseJsonStdout(
      runCli(SMOKE, [...noEvent, `--run-id=${RUN_B}`, "--json"], {}, ["BOT_SHARED_SECRET"]),
    );
    expect(JSON.stringify(one)).not.toBe(JSON.stringify(two));
  });
});

// ---------------------------------------------------------------------------
// Preserved transport contracts and authorized-caller wiring
// ---------------------------------------------------------------------------

describe("preserved contracts that must keep holding", () => {
  it("the signed transport never follows redirects", () => {
    const transport = readFileSync("src/bot/client-transport.ts", "utf8");
    expect(transport).toContain('redirect: "manual"');
    expect(transport).toContain("not followed");
  });

  it("the authorized staging caller passes explicit --apply", () => {
    const workflow = readFileSync(".github/workflows/staging-smoke.yml", "utf8");
    expect(workflow).toContain("--apply");
    // Both invocation shapes (announcement-only and full) apply explicitly.
    const applyCount = workflow.split("--apply").length - 1;
    expect(applyCount).toBeGreaterThanOrEqual(2);
  });

  it("no workflow invokes the internal-action tools without --apply", () => {
    const workflow = readFileSync(".github/workflows/staging-smoke.yml", "utf8");
    for (const line of workflow.split("\n")) {
      if (line.includes("smoke:internal-action") || line.includes("drill:internal-action")) {
        const block = workflow.slice(
          Math.max(0, workflow.indexOf(line) - 2000),
          workflow.indexOf(line) + 2000,
        );
        expect(block).toContain("--apply");
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Canonical short staging procedure
// ---------------------------------------------------------------------------

describe("canonical staging procedure", () => {
  it("one short doc explains preview, apply, repeat runs and the live-proof boundary", () => {
    const doc = readFileSync("docs/bot-probe-staging.md", "utf8");
    expect(doc.length).toBeGreaterThan(200);
    expect(doc.length).toBeLessThan(8000);
    expect(doc).toMatch(/preview/i);
    expect(doc).toMatch(/--apply/);
    expect(doc).toMatch(/repeat|resume|run-?id/i);
    expect(doc).toMatch(/live-?proof|held|boundary/i);
    expect(doc).toMatch(/throwaway/i);
    expect(doc).toMatch(/staging/i);
    expect(doc).toMatch(/production/i);
  });
});

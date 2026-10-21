import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBotClient } from "../src/bot/client";
import type { AnnouncementResult, EventUpsertResult, RoleAssignResult } from "../src/bot/client";
import type { BotClient, BotFailure } from "../src/jobs/types";
import { runBotSmoke } from "../src/probes/bot-smoke";
import {
  DRILL_CHECK_IDS,
  planInternalActionDrill,
  runInternalActionDrill,
} from "../src/probes/internal-action-drill";

// Builder-owned pins for the probe resume contract: a run identity replays
// byte-identical payloads across clocks, a drill transport throw keeps the
// planned check IDs, and an --apply --json run prints exactly one document.
// (Preview/apply acceptance lives in
// test/internal-action-preview-resume-acceptance.test.ts, which this file
// must not duplicate.)

const NOW_A = () => new Date("2026-10-01T00:00:00.000Z");
const NOW_B = () => new Date("2026-10-01T00:00:01.000Z");
const SMOKE_RUN = "resume-fix-smoke-1";
const SMOKE_RUN_OTHER = "resume-fix-smoke-2";
const DRILL_RUN = "resume-fix-drill-1";

const SMOKE_ARGS = {
  discordId: "900000000000009999",
  roleKey: "rocketleague",
  channelKey: "qa-throwaway",
  eventKey: "smoke-event-1",
};
const DRILL_ARGS = {
  discordId: SMOKE_ARGS.discordId,
  roleKey: SMOKE_ARGS.roleKey,
  channelKey: SMOKE_ARGS.channelKey,
};

const ROLE_OK: RoleAssignResult = { ok: true, requestId: "r1", outcome: "assigned" };
const EVENT_OK: EventUpsertResult = {
  ok: true,
  requestId: "r3",
  outcome: "created",
  discordEventId: "d1",
  replayed: false,
};

// A strict receiver: the same idempotency carrier with different payload
// bytes is refused as a mismatch instead of replaying, the way a
// payload-hashing bot answers a conflicting resume.
function strictSmokeReceiver() {
  const announcements = new Map<string, string>();
  const events = new Map<string, string>();
  const announcementKeys: string[] = [];
  const announcementBodies: string[] = [];
  const eventKeys: string[] = [];
  const eventPayloads: unknown[] = [];
  const mismatch = (): BotFailure => ({
    ok: false,
    code: "idempotent-payload-mismatch",
    status: 409,
    requestId: null,
    message: "",
    retryable: false,
    retryAfterSeconds: null,
  });
  return {
    announcementKeys,
    announcementBodies,
    eventKeys,
    eventPayloads,
    assignRole: async (): Promise<RoleAssignResult> => ROLE_OK,
    postAnnouncement: async (
      a: { channelKey: string; body: string },
      key: string,
    ): Promise<AnnouncementResult | BotFailure> => {
      announcementKeys.push(key);
      announcementBodies.push(a.body);
      const seen = announcements.get(key);
      if (seen !== undefined && seen !== a.body) return mismatch();
      const replayed = seen !== undefined;
      announcements.set(key, a.body);
      return { ok: true, requestId: "r2", messageId: `m-${key.slice(0, 8)}`, replayed };
    },
    upsertEvent: async (e: unknown, key: string): Promise<EventUpsertResult | BotFailure> => {
      eventKeys.push(key);
      eventPayloads.push(JSON.parse(JSON.stringify(e)));
      const bytes = JSON.stringify(e);
      const seen = events.get(key);
      if (seen !== undefined && seen !== bytes) return mismatch();
      events.set(key, bytes);
      return EVENT_OK;
    },
  };
}

function recordingDrillBot() {
  const keys: string[] = [];
  const bodies: string[] = [];
  return {
    keys,
    bodies,
    assignRole: async (): Promise<RoleAssignResult> => ROLE_OK,
    postAnnouncement: async (
      a: { channelKey: string; body: string },
      key: string,
    ): Promise<AnnouncementResult> => {
      keys.push(key);
      bodies.push(a.body);
      return { ok: true, requestId: "r2", messageId: `m-${key.slice(0, 8)}`, replayed: false };
    },
    upsertEvent: async (): Promise<EventUpsertResult> => EVENT_OK,
  };
}

describe("a run identity replays byte-identical smoke payloads across clocks", () => {
  it("two applies a second apart share carriers and bytes against a strict receiver", async () => {
    const receiver = strictSmokeReceiver();
    const args = { ...SMOKE_ARGS, runId: SMOKE_RUN };
    const one = await runBotSmoke(receiver, args, NOW_A);
    const two = await runBotSmoke(receiver, args, NOW_B);
    // The receiver is shared across both runs, like the real bot: the resume
    // replays instead of conflicting, so both runs pass.
    expect(one.ok).toBe(true);
    expect(two.ok).toBe(true);
    expect(receiver.announcementKeys).toHaveLength(4);
    expect(new Set(receiver.announcementKeys).size).toBe(1);
    expect(receiver.eventKeys).toHaveLength(2);
    expect(receiver.eventKeys[1]).toBe(receiver.eventKeys[0]);
    expect(receiver.announcementBodies.slice(2)).toEqual(receiver.announcementBodies.slice(0, 2));
    expect(receiver.eventPayloads[1]).toEqual(receiver.eventPayloads[0]);
  });

  it("distinct identities stay carrier- and payload-distinct", async () => {
    const first = strictSmokeReceiver();
    const second = strictSmokeReceiver();
    await runBotSmoke(first, { ...SMOKE_ARGS, runId: SMOKE_RUN }, NOW_A);
    await runBotSmoke(second, { ...SMOKE_ARGS, runId: SMOKE_RUN_OTHER }, NOW_A);
    expect(second.announcementKeys[0]).not.toBe(first.announcementKeys[0]);
    expect(second.eventKeys[0]).not.toBe(first.eventKeys[0]);
    expect(second.announcementBodies).not.toEqual(first.announcementBodies);
    expect(second.eventPayloads).not.toEqual(first.eventPayloads);
  });

  it("runs without an identity keep the wall clock", async () => {
    const first = strictSmokeReceiver();
    const second = strictSmokeReceiver();
    await runBotSmoke(first, { ...SMOKE_ARGS }, NOW_A);
    await runBotSmoke(second, { ...SMOKE_ARGS }, NOW_B);
    expect(second.announcementBodies).not.toEqual(first.announcementBodies);
    expect(second.eventPayloads).not.toEqual(first.eventPayloads);
  });
});

describe("a drill run identity replays its body across clocks", () => {
  it("two applies a second apart post the same body under the same carrier", async () => {
    const first = recordingDrillBot();
    const second = recordingDrillBot();
    const args = { ...DRILL_ARGS, runId: DRILL_RUN };
    const one = await runInternalActionDrill(first as unknown as BotClient, args, NOW_A);
    const two = await runInternalActionDrill(second as unknown as BotClient, args, NOW_B);
    expect(one.ok).toBe(true);
    expect(two.ok).toBe(true);
    expect(second.keys).toEqual(first.keys);
    expect(second.bodies).toEqual(first.bodies);
  });

  it("a drill without an identity keeps the wall clock", async () => {
    const first = recordingDrillBot();
    const second = recordingDrillBot();
    await runInternalActionDrill(first as unknown as BotClient, { ...DRILL_ARGS }, NOW_A);
    await runInternalActionDrill(second as unknown as BotClient, { ...DRILL_ARGS }, NOW_B);
    expect(second.bodies).not.toEqual(first.bodies);
  });
});

describe("a drill transport throw keeps the planned check IDs", () => {
  it("a throwing handler records its planned check as failed", async () => {
    const MARKER = "withheld-detail-marker";
    const bot = {
      ...recordingDrillBot(),
      assignRole: async (): Promise<RoleAssignResult> => {
        throw new Error(`connection reset ${MARKER}`);
      },
    };
    const report = await runInternalActionDrill(
      bot as unknown as BotClient,
      { ...DRILL_ARGS },
      NOW_A,
    );
    const planned = planInternalActionDrill({ ...DRILL_ARGS }, NOW_A);
    expect(report.ok).toBe(false);
    expect(report.checks.map((c) => c.id)).toEqual(planned.map((c) => c.id));
    expect(report.checks.find((c) => c.id === DRILL_CHECK_IDS.roleHandled)?.ok).toBe(false);
    expect(JSON.stringify(report)).not.toContain(MARKER);
  });
});

describe("bot client diagnostics routing", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const answeringFetch = async () =>
    new Response(
      JSON.stringify({ ok: true, result: { outcome: "assigned" }, request_id: "stub-request" }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  const opts = (extra: Record<string, unknown> = {}) => ({
    url: "https://bot-stub.invalid",
    secret: "fixture-secret",
    keyId: "fixture-key",
    fetchFn: answeringFetch as unknown as typeof fetch,
    ...extra,
  });

  it("logs success to stdout by default", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = createBotClient(opts());
    await client.assignRole({ userId: SMOKE_ARGS.discordId, roleKey: SMOKE_ARGS.roleKey });
    expect(info).toHaveBeenCalledWith("bot internal action succeeded", expect.anything());
    expect(warn).not.toHaveBeenCalled();
  });

  it("routes success to stderr with stderrDiagnostics", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = createBotClient(opts({ stderrDiagnostics: true }));
    await client.assignRole({ userId: SMOKE_ARGS.discordId, roleKey: SMOKE_ARGS.roleKey });
    expect(info).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith("bot internal action succeeded", expect.anything());
  });
});

describe("--apply --json against an answering bot prints exactly one document", () => {
  const STUB_ENV = {
    BOT_ENDPOINT_URL: "https://bot-stub.invalid",
    BOT_PRODUCTION_URL: "https://bot-prod.invalid",
    BOT_SHARED_SECRET: "fixture-only-secret-value",
    BOT_KEY_ID: "fixture-key",
    APP_URL: "https://next.togetherweown.com",
  };

  function runToolJson(script: string, args: string[]): string {
    return execFileSync(
      process.execPath,
      [
        "--import",
        "./bin/ts-hook.mjs",
        "--import",
        "./test/fixtures/answering-bot-fetch.mjs",
        script,
        ...args,
      ],
      { encoding: "utf8", env: { ...process.env, ...STUB_ENV }, timeout: 30_000 },
    );
  }

  type ReportDoc = { mode: string; ok: boolean; checks: Array<{ id: string }> };

  it("smoke exits 0 with parseable single-document stdout", () => {
    const stdout = runToolJson("bin/internal-action-smoke.mjs", [
      `--discord-id=${SMOKE_ARGS.discordId}`,
      `--role-key=${SMOKE_ARGS.roleKey}`,
      `--channel-key=${SMOKE_ARGS.channelKey}`,
      `--event-key=${SMOKE_ARGS.eventKey}`,
      `--run-id=${SMOKE_RUN}`,
      "--apply",
      "--json",
    ]);
    const doc = JSON.parse(stdout) as ReportDoc;
    expect(doc.mode).toBe("report");
    expect(doc.ok).toBe(true);
    expect(doc.checks).toHaveLength(6);
    expect(stdout.trim().split("\n")).toHaveLength(1);
  });

  it("drill exits 0 with parseable single-document stdout", () => {
    const stdout = runToolJson("bin/internal-action-drill.mjs", [
      `--discord-id=${DRILL_ARGS.discordId}`,
      `--role-key=${DRILL_ARGS.roleKey}`,
      `--channel-key=${DRILL_ARGS.channelKey}`,
      `--run-id=${DRILL_RUN}`,
      "--apply",
      "--json",
    ]);
    const doc = JSON.parse(stdout) as ReportDoc;
    expect(doc.mode).toBe("report");
    expect(doc.ok).toBe(true);
    expect(doc.checks).toHaveLength(4);
    expect(stdout.trim().split("\n")).toHaveLength(1);
  });
});

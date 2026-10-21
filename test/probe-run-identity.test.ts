import { describe, expect, it } from "vitest";
import type { AnnouncementResult, EventUpsertResult, RoleAssignResult } from "../src/bot/client";
import { BotTerminalError } from "../src/jobs/types";
import type { BotClient } from "../src/jobs/types";
import {
  DRILL_CHECK_IDS,
  planInternalActionDrill,
  runInternalActionDrill,
} from "../src/probes/internal-action-drill";
import { SMOKE_CHECK_IDS, planBotSmoke, runBotSmoke } from "../src/probes/bot-smoke";
import { deriveEventKey, deriveUuid, validateRunId } from "../src/probes/run-identity";

// Builder-owned contract for run identities and probe plans: validation,
// carrier/event-key derivation, and plan/report check-ID correspondence.
// (Repeat-execution, CLI preview/apply and redaction acceptance lives in
// test/internal-action-preview-resume-acceptance.test.ts, which this file
// must not duplicate.)

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FIXED_NOW = () => new Date("2026-10-01T00:00:00.000Z");

const ROLE_OK: RoleAssignResult = { ok: true, requestId: "r1", outcome: "assigned" };
const EVENT_OK: EventUpsertResult = {
  ok: true,
  requestId: "r3",
  outcome: "created",
  discordEventId: "d1",
  replayed: false,
};

function okSmokeClient() {
  let announcements = 0;
  return {
    assignRole: async (): Promise<RoleAssignResult> => ROLE_OK,
    postAnnouncement: async (): Promise<AnnouncementResult> => {
      announcements++;
      return { ok: true, requestId: "r2", messageId: "m1", replayed: announcements > 1 };
    },
    upsertEvent: async (): Promise<EventUpsertResult> => EVENT_OK,
  };
}

function okDrillBot() {
  return {
    assignRole: async (): Promise<RoleAssignResult> => ROLE_OK,
    postAnnouncement: async (): Promise<AnnouncementResult> => ({
      ok: true,
      requestId: "r2",
      messageId: "m1",
      replayed: false,
    }),
    upsertEvent: async (): Promise<EventUpsertResult> => EVENT_OK,
  };
}

describe("validateRunId", () => {
  it.each([["a"], ["smoke-repeat-1"], ["A9_-x"], ["r".repeat(64)]])("admits %s", (runId) => {
    expect(() => validateRunId(runId)).not.toThrow();
  });

  it.each([[""], ["   "], ["r".repeat(65)], ["-lead"], ["has space"], ["has/slash"], ["has@at"]])(
    "rejects %s as terminal without echoing it",
    (runId) => {
      let message = "";
      try {
        validateRunId(runId);
      } catch (e) {
        expect(e).toBeInstanceOf(BotTerminalError);
        message = (e as Error).message;
      }
      expect(message).toMatch(/run identity/);
      expect(message).not.toContain(runId.trim() === "" ? "NEVER-MATCHES-EMPTY" : runId);
    },
  );
});

describe("deriveUuid", () => {
  it("is a stable UUID per identity and purpose, distinct otherwise", () => {
    const a1 = deriveUuid("run-a", "smoke:announcement");
    expect(a1).toMatch(UUID_RE);
    expect(deriveUuid("run-a", "smoke:announcement")).toBe(a1);
    expect(deriveUuid("run-b", "smoke:announcement")).not.toBe(a1);
    expect(deriveUuid("run-a", "smoke:event")).not.toBe(a1);
    expect(deriveUuid("run-a", "smoke:event")).toMatch(UUID_RE);
  });
});

describe("deriveEventKey", () => {
  it("is stable per identity and keeps the generated-key shape", () => {
    const a1 = deriveEventKey("run-a");
    expect(a1).toMatch(/^tog10112-[0-9a-f]{12}$/);
    expect(deriveEventKey("run-a")).toBe(a1);
    expect(deriveEventKey("run-b")).not.toBe(a1);
  });
});

describe("planBotSmoke", () => {
  const FULL = {
    discordId: "900000000000009999",
    roleKey: "rocketleague",
    channelKey: "qa-throwaway",
    eventKey: "smoke-event-1",
  };

  it("plans the six full-run checks with the report's stable IDs", async () => {
    const planned = planBotSmoke(FULL, FIXED_NOW);
    expect(planned.map((c) => c.id)).toEqual([
      SMOKE_CHECK_IDS.roleAssign,
      SMOKE_CHECK_IDS.announcementPost,
      SMOKE_CHECK_IDS.retry,
      SMOKE_CHECK_IDS.replayFlag,
      SMOKE_CHECK_IDS.replayMessageId,
      SMOKE_CHECK_IDS.eventUpsert,
    ]);
    const report = await runBotSmoke(okSmokeClient(), FULL, FIXED_NOW);
    expect(report.ok).toBe(true);
    expect(report.checks.map((c) => c.id)).toEqual(planned.map((c) => c.id));
    expect(report.checks.map((c) => c.label)).toEqual(planned.map((c) => c.label));
  });

  it("plans the four announcement-only checks", () => {
    const planned = planBotSmoke({ announcementOnly: true, channelKey: "qa-throwaway" }, FIXED_NOW);
    expect(planned.map((c) => c.id)).toEqual([
      SMOKE_CHECK_IDS.announcementPost,
      SMOKE_CHECK_IDS.retry,
      SMOKE_CHECK_IDS.replayFlag,
      SMOKE_CHECK_IDS.replayMessageId,
    ]);
  });

  it("refuses an invalid input like the run itself", () => {
    expect(() => planBotSmoke({ ...FULL, eventKey: "k".repeat(65) }, FIXED_NOW)).toThrow(
      BotTerminalError,
    );
  });
});

describe("planInternalActionDrill", () => {
  const ARGS = {
    discordId: "900000000000009999",
    roleKey: "rocketleague",
    channelKey: "qa-throwaway",
  };

  it("plans the four drill checks with the report's stable IDs", async () => {
    const planned = planInternalActionDrill(ARGS, FIXED_NOW);
    expect(planned.map((c) => c.id)).toEqual([
      DRILL_CHECK_IDS.roleCarrier,
      DRILL_CHECK_IDS.announcementCarrier,
      DRILL_CHECK_IDS.roleHandled,
      DRILL_CHECK_IDS.announcementHandled,
    ]);
    const report = await runInternalActionDrill(
      okDrillBot() as unknown as BotClient,
      ARGS,
      FIXED_NOW,
    );
    expect(report.ok).toBe(true);
    expect(report.checks.map((c) => c.id)).toEqual(planned.map((c) => c.id));
    expect(report.checks.map((c) => c.label)).toEqual(planned.map((c) => c.label));
  });

  it("refuses an invalid input like the run itself", () => {
    expect(() => planInternalActionDrill({ ...ARGS, channelKey: "   " }, FIXED_NOW)).toThrow(
      BotTerminalError,
    );
  });
});

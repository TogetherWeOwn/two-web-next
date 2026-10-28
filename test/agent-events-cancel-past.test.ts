// route-inventory: POST /api/agent-events
// A past event cannot be cancelled. The refusal is the existing 409
// `event_not_open` envelope, and it must not update the row, insert an audit,
// or invoke the write-back callback. Draft and published cancels stay
// accepted; a cancelled event stays 409 and still audits the denial.
//
// Hermetic: the in-memory ingress double is wrapped only to seed one owned
// event row and apply a status update. The real `handleAgentEvent` service
// runs, so a mocked guard cannot hide an audit insert or a write-back.
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_CONFIG,
  handleAgentEvent,
  ulid,
  type Answer,
  type IngressConfig,
} from "../src/agent-events/service";
import { makeFakeAgentDb, type FakeAgentDb, type FakeGrant } from "./helpers/fake-agent-ingress-db";

const CALLER = "agent-under-test";
const CRED = "cred-cancel-past-001";
const GRANT_ID = "grant-cancel-past-1";

const cfg: IngressConfig = {
  ...DEFAULT_CONFIG,
  enabled: true,
  callerAgentId: CALLER,
  lockWaitMs: 50,
};

const REFUSAL = {
  code: "event_not_open",
  reason: "event_not_open",
  message: "That event is not in a position to make this move.",
  next: "Read the event and use a move it is open for.",
};

type SeedStatus = "draft" | "published" | "cancelled" | "past";

type SeededEvent = {
  id: string;
  event_key: string;
  agent_grant_id: string;
  status: SeedStatus;
  location: string;
  updates: number;
};

function liveGrant(): FakeGrant {
  return {
    id: GRANT_ID,
    agent_id: CALLER,
    guild_id: DEFAULT_CONFIG.stagingGuildId,
    expires_at: null,
    disabled_at: null,
  };
}

// The stock double answers event lookups with no row, which would 404 before
// the status guard. Seed one mutable row and apply the status write so the
// current success path can finish and the assertions can see it.
function seedEvent(fake: FakeAgentDb, status: SeedStatus) {
  const row: SeededEvent = {
    id: "evt-cancel-past",
    event_key: ulid(),
    agent_grant_id: GRANT_ID,
    status,
    location: "Voice: General",
    updates: 0,
  };
  const answer = (args: unknown[]): unknown[] | null => {
    const strings = args[0];
    const head = Array.isArray(strings) ? ((strings[0] as string) ?? "") : "";
    if (head.includes("UPDATE events SET status")) {
      row.status = args[1] as SeedStatus;
      row.updates += 1;
      return [];
    }
    if (head.startsWith("SELECT * FROM events WHERE")) return [{ ...row }];
    return null;
  };
  const wrap = (target: unknown): unknown =>
    new Proxy(target as object, {
      apply: async (fn, thisArg, args: unknown[]) => {
        const seeded = answer(args);
        if (seeded) return seeded;
        return Reflect.apply(fn as (...a: unknown[]) => unknown, thisArg, args);
      },
      get: (fn, prop) =>
        prop === "begin"
          ? (callback: (tx: unknown) => Promise<unknown>) =>
              (fn as { begin: (cb: (tx: unknown) => Promise<unknown>) => Promise<unknown> }).begin(
                (tx) => callback(wrap(tx)),
              )
          : Reflect.get(fn, prop),
    });
  return { sql: wrap(fake.sql) as FakeAgentDb["sql"], row };
}

async function setup(status: SeedStatus) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("fetch must not be called on the cancel path");
    }),
  );
  const fake = makeFakeAgentDb();
  await fake.addGrant(CRED, liveGrant());
  const { sql, row } = seedEvent(fake, status);
  const writeBacks: { eventKey: string; status: string }[] = [];
  const call = (idempotencyKey = randomUUID()): Promise<Answer> =>
    handleAgentEvent(
      sql,
      cfg,
      { op: "cancel", idempotency_key: idempotencyKey, event_key: row.event_key },
      CRED,
      null,
      {
        writeBack: async (writeBack) => {
          writeBacks.push(writeBack);
        },
      },
    );
  return { fake, row, writeBacks, call };
}

afterEach(() => vi.unstubAllGlobals());

describe("agent cancel of a past event", () => {
  it("answers 409 event_not_open, leaves the row, writes no audit, and dispatches no write-back", async () => {
    const { fake, row, writeBacks, call } = await setup("past");
    const answer = await call();

    expect(answer.status).toBe(409);
    expect(answer.body).toEqual({ ...REFUSAL, request_id: expect.any(String) });
    expect(row.status).toBe("past");
    expect(row.updates).toBe(0);
    expect(fake.audits).toEqual([]);
    expect(writeBacks).toEqual([]);
  });

  it("still cancels a draft or a published event, auditing once and writing back", async () => {
    for (const status of ["draft", "published"] as const) {
      const { fake, row, writeBacks, call } = await setup(status);
      const answer = await call();

      expect(answer.status).toBe(200);
      expect(answer.body).toMatchObject({
        event_key: row.event_key,
        status: "cancelled",
        request_id: expect.any(String),
      });
      expect(row.status).toBe("cancelled");
      expect(row.updates).toBe(1);
      expect(fake.audits).toEqual([
        expect.objectContaining({ operation: "cancel", result: "ok", reason: null }),
      ]);
      expect(writeBacks).toEqual([{ eventKey: row.event_key, status: "cancelled" }]);
    }
  });

  it("keeps a cancelled event refused, with the denial audited and no write-back", async () => {
    const { fake, row, writeBacks, call } = await setup("cancelled");
    const answer = await call();

    expect(answer.status).toBe(409);
    expect(answer.body).toEqual({ ...REFUSAL, request_id: expect.any(String) });
    expect(row.status).toBe("cancelled");
    expect(row.updates).toBe(0);
    expect(fake.audits).toEqual([
      expect.objectContaining({
        operation: "cancel",
        result: "denied",
        reason: "event_not_open",
      }),
    ]);
    expect(writeBacks).toEqual([]);
  });
});

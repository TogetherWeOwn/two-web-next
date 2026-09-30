import postgres from "postgres";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { databaseOptions, databaseUrl } from "../src/db/connection";
import type { Env, JobsEnv } from "../src/env";
import { enqueueSyncEvent, handleQueue, handleScheduled } from "../src/jobs/worker";
import { RECONCILE_CRON } from "../src/jobs/constants";

// Pool-construction test only: none of these sentinel URLs ever connects.
vi.mock("postgres", () => ({ default: vi.fn(() => Object.assign(
  vi.fn(async () => [{ key: "sync-event:e1" }]), { end: vi.fn(async () => {}) },
)) }));
vi.mock("../src/jobs/consumer", () => ({ consume: vi.fn(async () => {}) }));
vi.mock("../src/jobs/cron", () => ({ runScheduled: vi.fn(async () => {}),
  reconcileEvents: vi.fn(), pruneModelTables: vi.fn() }));
vi.mock("../src/sessions", () => ({ migrate: vi.fn(async () => {}) }));

const explicit = "postgres://explicit.invalid/db";
const bound = "postgres://bound.invalid/db";
const alias = "postgres://alias.invalid/db";
const environment = (sources: Record<string, unknown>) => ({ ...sources,
  SYNC_EVENT_QUEUE: { send: vi.fn(async () => {}) }, INTERNAL_ACTION_QUEUE: { send: vi.fn(async () => {}) },
}) as unknown as Env & JobsEnv;

beforeEach(() => vi.clearAllMocks());

for (const operation of ["producer", "consumer", "scheduled"] as const) {
  describe(`${operation} database selection matches web`, () => {
    for (const [name, sources, expected] of [
      ["explicit URL wins both bindings", { DATABASE_URL: explicit, DB: { connectionString: bound }, HYPERDRIVE: { connectionString: alias } }, explicit],
      ["DB wins alias", { DB: { connectionString: bound }, HYPERDRIVE: { connectionString: alias } }, bound],
      ["empty override uses DB", { DATABASE_URL: "", DB: { connectionString: bound } }, bound],
      ["alias is fallback only", { HYPERDRIVE: { connectionString: alias } }, alias],
    ] as const) {
      it(name, async () => {
        const env = environment(sources);
        if (operation === "producer") await enqueueSyncEvent(env, { kind: "sync-event", eventKey: "e1", idempotencyKey: crypto.randomUUID() });
        else if (operation === "consumer") await handleQueue({ messages: [] } as unknown as MessageBatch<unknown>, env);
        else await handleScheduled({ cron: RECONCILE_CRON } as ScheduledController, env);
        const calls = vi.mocked(postgres).mock.calls;
        expect(calls).toHaveLength(operation === "producer" ? 1 : 2);
        for (const call of calls) expect(call).toEqual([expected, databaseOptions]);
        if (databaseUrl(env)) expect(expected).toBe(databaseUrl(env));
      });
    }
  });
}

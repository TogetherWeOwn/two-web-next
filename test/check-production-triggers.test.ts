import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
// @ts-expect-error Standalone CI tooling has no declaration file.
import * as triggersProbe from "../ci/check-production-triggers.mjs";
// @ts-expect-error Standalone CI tooling has no declaration file.
import { readWranglerConfig } from "../ci/wrangler-config.mjs";
import { PRUNE_CRON, RECONCILE_CRON } from "../src/jobs/constants";

// Partial-success fixtures for the production trigger drift probe: a green
// version promotion can still leave production partially deployed, because
// versions upload/deploy never apply schedules or consumers. Every fixture
// below is one such partial state, plus the clean state and the pre-transfer
// transitional state. No live Cloudflare call: fetch is stubbed.

const SYNC = "two-web-next-production-sync-event";
const INTERNAL = "two-web-next-production-internal-action";

const expected = () =>
  triggersProbe.readExpectedTopology({
    webConfig: readWranglerConfig(readFileSync("wrangler.jsonc", "utf8")),
    jobsConfig: readWranglerConfig(readFileSync("wrangler.jobs.jsonc", "utf8")),
  });

const consumer = (
  script: string,
  settings: Record<string, number> = {},
): { script: string; settings: Record<string, number> } => ({
  script,
  settings: { batch_size: 10, max_retries: 10, max_wait_time_ms: 5000, ...settings },
});

type LiveConsumer = { script: string; settings: Record<string, number> };
type LiveState = {
  schedules: Record<string, string[] | null>;
  consumers: Record<string, LiveConsumer[] | null>;
};

const cleanLive = (): LiveState => ({
  schedules: {
    [triggersProbe.WEB_SCRIPT]: [],
    [triggersProbe.JOBS_SCRIPT]: [RECONCILE_CRON, PRUNE_CRON],
  },
  consumers: {
    [SYNC]: [consumer(triggersProbe.JOBS_SCRIPT)],
    [INTERNAL]: [consumer(triggersProbe.JOBS_SCRIPT)],
  },
});

describe("expected production topology", () => {
  it("derives the owner split from the reviewed configs", () => {
    const topology = expected();
    expect(topology.scripts[triggersProbe.WEB_SCRIPT]).toEqual({ crons: [] });
    expect(topology.scripts[triggersProbe.JOBS_SCRIPT]).toEqual({
      crons: [RECONCILE_CRON, PRUNE_CRON].sort(),
    });
    expect(Object.keys(topology.queues).sort()).toEqual([INTERNAL, SYNC]);
    // max_batch_timeout 5 (seconds) maps to max_wait_time_ms 5000: copying
    // the raw 5 would set a 5 ms wait.
    expect(topology.queues[SYNC]).toEqual({
      consumerScript: triggersProbe.JOBS_SCRIPT,
      settings: { batch_size: 10, max_retries: 10, max_wait_time_ms: 5000 },
    });
  });

  it("fails closed on an unexpected config shape", () => {
    const webConfig = {
      env: { production: { name: triggersProbe.WEB_SCRIPT, triggers: { crons: [] } } },
    };
    const jobsConfig = {
      env: {
        production: {
          name: triggersProbe.JOBS_SCRIPT,
          triggers: { crons: [RECONCILE_CRON] },
          queues: {
            consumers: [{ queue: SYNC, max_retries: 10, max_batch_size: 10, max_batch_timeout: 5 }],
          },
        },
      },
    };
    expect(() => triggersProbe.readExpectedTopology({ webConfig, jobsConfig })).not.toThrow();
    expect(() => triggersProbe.readExpectedTopology({ webConfig: {}, jobsConfig })).toThrow(
      "web env.production must name",
    );
    expect(() =>
      triggersProbe.readExpectedTopology({
        webConfig: {
          env: {
            production: { ...webConfig.env.production, queues: { consumers: [{ queue: SYNC }] } },
          },
        },
        jobsConfig,
      }),
    ).toThrow("must consume no queue");
    expect(() => triggersProbe.readExpectedTopology({ webConfig, jobsConfig: {} })).toThrow(
      "jobs env.production must name",
    );
    expect(() =>
      triggersProbe.readExpectedTopology({
        webConfig,
        jobsConfig: { env: { production: { ...jobsConfig.env.production, queues: {} } } },
      }),
    ).toThrow("must consume at least one queue");
  });
});

describe("partial-success fixtures", () => {
  it("passes the clean post-transfer state", () => {
    expect(triggersProbe.detectTriggerDrift(expected(), cleanLive())).toEqual([]);
  });

  it("matches crons regardless of live order", () => {
    const live = cleanLive();
    live.schedules[triggersProbe.JOBS_SCRIPT] = [PRUNE_CRON, RECONCILE_CRON];
    expect(triggersProbe.detectTriggerDrift(expected(), live)).toEqual([]);
  });

  it("fails transfer residue: the web Worker still holds crons", () => {
    const live = cleanLive();
    live.schedules[triggersProbe.WEB_SCRIPT] = [RECONCILE_CRON, PRUNE_CRON];
    const drift = triggersProbe.detectTriggerDrift(expected(), live);
    expect(drift).toHaveLength(1);
    expect(drift[0]).toContain(triggersProbe.WEB_SCRIPT);
    expect(drift[0]).toContain(RECONCILE_CRON);
  });

  it("fails the pre-transfer state: consumers and crons still on the web Worker", () => {
    const live = {
      schedules: {
        [triggersProbe.WEB_SCRIPT]: [RECONCILE_CRON, PRUNE_CRON],
        [triggersProbe.JOBS_SCRIPT]: null,
      },
      consumers: {
        [SYNC]: [consumer(triggersProbe.WEB_SCRIPT)],
        [INTERNAL]: [consumer(triggersProbe.WEB_SCRIPT)],
      },
    };
    const drift = triggersProbe.detectTriggerDrift(expected(), live);
    // The transfer's step-0 record asserts exactly this transitional diff:
    // every line must name the web Worker or the undeployed jobs script.
    expect(drift).toHaveLength(4);
    for (const line of drift)
      expect(line).toMatch(/two-web-next-production|two-web-jobs-production/);
    expect(drift.join("\n")).toContain("schedules unreadable (script not deployed?)");
  });

  it("fails attach-before-detach: both Workers consume the same queue", () => {
    const live = cleanLive();
    live.consumers[SYNC] = [
      consumer(triggersProbe.WEB_SCRIPT),
      consumer(triggersProbe.JOBS_SCRIPT),
    ];
    const drift = triggersProbe.detectTriggerDrift(expected(), live);
    expect(drift).toHaveLength(1);
    expect(drift[0]).toContain("exactly one consumer");
    expect(drift[0]).toContain(triggersProbe.WEB_SCRIPT);
  });

  it("fails a detached queue: no consumer at all", () => {
    const live = cleanLive();
    live.consumers[INTERNAL] = [];
    const drift = triggersProbe.detectTriggerDrift(expected(), live);
    expect(drift).toHaveLength(1);
    expect(drift[0]).toContain("got 0");
  });

  it("fails a missing production queue", () => {
    const live = cleanLive();
    live.consumers[SYNC] = null;
    const drift = triggersProbe.detectTriggerDrift(expected(), live);
    expect(drift).toEqual([`${SYNC}: queue missing live`]);
  });

  it("fails the verbatim-timeout trap: max_wait_time_ms copied as 5", () => {
    const live = cleanLive();
    live.consumers[SYNC] = [consumer(triggersProbe.JOBS_SCRIPT, { max_wait_time_ms: 5 })];
    const drift = triggersProbe.detectTriggerDrift(expected(), live);
    expect(drift).toEqual([`${SYNC}: consumer setting max_wait_time_ms is 5 != 5000`]);
  });

  it("fails a stale batch size on the right owner", () => {
    const live = cleanLive();
    live.consumers[INTERNAL] = [consumer(triggersProbe.JOBS_SCRIPT, { batch_size: 1 })];
    const drift = triggersProbe.detectTriggerDrift(expected(), live);
    expect(drift).toEqual([`${INTERNAL}: consumer setting batch_size is 1 != 10`]);
  });

  it("ignores extra live settings outside the three pinned fields", () => {
    const live = cleanLive();
    live.consumers[SYNC] = [
      {
        script: triggersProbe.JOBS_SCRIPT,
        settings: { ...consumer(triggersProbe.JOBS_SCRIPT).settings, max_concurrency: 4 },
      },
    ];
    expect(triggersProbe.detectTriggerDrift(expected(), live)).toEqual([]);
  });
});

describe("live state reads", () => {
  const ok = (result: unknown) => ({
    status: 200,
    text: async () => JSON.stringify({ success: true, result }),
  });
  const schedulesResponse = (crons: string[]) =>
    ok({ schedules: crons.map((cron) => ({ cron, created_on: "2026-10-21T00:00:00Z" })) });

  const stubFetch =
    (routes: Record<string, { status: number; text: () => Promise<string> }>) =>
    async (url: string) => {
      const path = url.replace("https://api.cloudflare.com/client/v4/accounts/test-acct", "");
      const route = routes[path];
      if (!route) throw new Error(`unexpected live call: ${path}`);
      return route;
    };

  const healthyRoutes = () => ({
    [`/workers/scripts/${triggersProbe.WEB_SCRIPT}/schedules`]: schedulesResponse([]),
    [`/workers/scripts/${triggersProbe.JOBS_SCRIPT}/schedules`]: schedulesResponse([
      RECONCILE_CRON,
      PRUNE_CRON,
    ]),
    "/queues?per_page=100": ok([
      { queue_id: "q-sync", queue_name: SYNC },
      { queue_id: "q-internal", queue_name: INTERNAL },
      { queue_id: "q-staging", queue_name: "two-sync-event" },
    ]),
    "/queues/q-sync/consumers": ok([
      {
        consumer_id: "c1",
        script: triggersProbe.JOBS_SCRIPT,
        type: "worker",
        settings: { batch_size: 10, max_retries: 10, max_wait_time_ms: 5000 },
      },
    ]),
    "/queues/q-internal/consumers": ok([
      {
        consumer_id: "c2",
        script_name: triggersProbe.JOBS_SCRIPT,
        type: "worker",
        settings: { batch_size: 10, max_retries: 10, max_wait_time_ms: 5000 },
      },
    ]),
  });

  it("maps schedules, queue ids and both consumer owner spellings", async () => {
    const live = await triggersProbe.fetchLiveState({
      accountId: "test-acct",
      token: "test-token",
      expected: expected(),
      fetchImpl: stubFetch(healthyRoutes()),
    });
    expect(live.schedules[triggersProbe.WEB_SCRIPT]).toEqual([]);
    expect(live.schedules[triggersProbe.JOBS_SCRIPT]).toEqual([RECONCILE_CRON, PRUNE_CRON].sort());
    expect(live.consumers[SYNC]).toEqual([consumer(triggersProbe.JOBS_SCRIPT)]);
    expect(live.consumers[INTERNAL]).toEqual([consumer(triggersProbe.JOBS_SCRIPT)]);
  });

  it("reads a missing schedules endpoint as undeployed, not clean", async () => {
    const routes = healthyRoutes();
    routes[`/workers/scripts/${triggersProbe.JOBS_SCRIPT}/schedules`] = {
      status: 404,
      text: async () => JSON.stringify({ success: false, errors: [{ code: 10090 }] }),
    };
    const live = await triggersProbe.fetchLiveState({
      accountId: "test-acct",
      token: "test-token",
      expected: expected(),
      fetchImpl: stubFetch(routes),
    });
    expect(live.schedules[triggersProbe.JOBS_SCRIPT]).toBeNull();
  });

  it("fails closed on unreadable live state", async () => {
    const base = { accountId: "test-acct", token: "test-token", expected: expected() };
    await expect(
      triggersProbe.fetchLiveState({ ...base, accountId: "", fetchImpl: stubFetch({}) }),
    ).rejects.toThrow("CF_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are required");
    const failing = healthyRoutes();
    failing["/queues?per_page=100"] = {
      status: 403,
      text: async () => JSON.stringify({ success: false, errors: [{ code: 10000 }] }),
    };
    await expect(
      triggersProbe.fetchLiveState({ ...base, fetchImpl: stubFetch(failing) }),
    ).rejects.toThrow("queue list unreadable");
    const malformed = healthyRoutes();
    malformed[`/queues/q-sync/consumers`] = { status: 200, text: async () => "not json" };
    await expect(
      triggersProbe.fetchLiveState({ ...base, fetchImpl: stubFetch(malformed) }),
    ).rejects.toThrow("unreadable response");
    const cronless = healthyRoutes();
    cronless[`/workers/scripts/${triggersProbe.JOBS_SCRIPT}/schedules`] = ok({
      schedules: [{ created_on: "2026-10-21T00:00:00Z" }],
    });
    await expect(
      triggersProbe.fetchLiveState({ ...base, fetchImpl: stubFetch(cronless) }),
    ).rejects.toThrow("unreadable schedules");
    const truncated = healthyRoutes();
    truncated["/queues?per_page=100"] = {
      status: 200,
      text: async () =>
        JSON.stringify({
          success: true,
          result: [{ queue_id: "q-sync", queue_name: SYNC }],
          result_info: { total_count: 101, page: 1, per_page: 100 },
        }),
    };
    await expect(
      triggersProbe.fetchLiveState({ ...base, fetchImpl: stubFetch(truncated) }),
    ).rejects.toThrow("queue list truncated");
  });

  it("triggersProbe.main() returns the drift lines without exiting", async () => {
    const drift = await triggersProbe.main({
      env: { CF_ACCOUNT_ID: "test-acct", CLOUDFLARE_API_TOKEN: "test-token" },
      fetchImpl: stubFetch(healthyRoutes()),
    });
    expect(drift).toEqual([]);
  });
});

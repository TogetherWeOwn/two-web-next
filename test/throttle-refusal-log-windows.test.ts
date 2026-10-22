// Builder-owned boundary/accounting regressions; the paired acceptance suite stays untouched.
// Exercise production guard/shield entry points with local SQL fixtures, never a live store.
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Sql } from "../src/sessions";
import type { EnvWithThrottle } from "../src/throttle";
import { makeFakeAgentDb } from "./helpers/fake-agent-ingress-db";
import { withThrottleTx } from "./helpers/throttle-tx-double";

let now: number;
let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  // A fresh isolate per case resets log tokens AND pending shed counts without
  // exporting a production reset seam or depending on an hour-long refill.
  vi.resetModules();
  now = Date.UTC(2026, 9, 22);
  vi.spyOn(Date, "now").mockImplementation(() => now);
  vi.spyOn(Math, "random").mockReturnValue(0.999);
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => vi.restoreAllMocks());

async function refusalSource(source: "guard" | "shield") {
  if (source === "guard") {
    const { throttleGuard } = await import("../src/throttle");
    const sql = withThrottleTx((async (strings: TemplateStringsArray) => {
      const text = strings.join("?");
      if (text.includes("SELECT count(*)")) return [{ n: 999, wait: 42 }];
      if (text.includes("DELETE FROM web_throttle_hits")) return [];
      throw new Error("Unexpected throttle statement");
    }) as unknown as Sql);
    const app = new Hono<{ Bindings: EnvWithThrottle }>();
    app.get(
      "/probe",
      async (c) => (await throttleGuard(c, "login-callback", 10)) ?? c.text("allowed"),
    );
    return {
      code: "throttle.refused",
      payload: { throttle: "login-callback", outcome: "rate_limited" },
      call: async () =>
        (
          await app.request(
            "/probe",
            { headers: { "cf-connecting-ip": "192.0.2.44", accept: "application/json" } },
            { THROTTLE_STORE: async () => sql } as unknown as EnvWithThrottle,
          )
        ).status,
    };
  }
  const { shield } = await import("../src/agent-events/shield");
  const { DEFAULT_CONFIG } = await import("../src/agent-events/service");
  const fake = makeFakeAgentDb();
  fake.hits.push({ bucket: "shield:ip:198.51.100.9", at: now });
  return {
    code: "agent-events.shield.refused",
    payload: { bucket_class: "anonymous", outcome: "rate_limited" },
    call: async () => {
      // Keep the admission budget spent even during the long idle cap probe:
      // only the log bucket, not the SQL admission window, is under test here.
      fake.hits[0]!.at = now;
      return (await shield(
        fake.sql,
        { ...DEFAULT_CONFIG, routePerMinute: 1 },
        "ip:198.51.100.9",
        "refusal-window-probe",
        { kind: "anonymous" },
      ))!.status;
    },
  };
}

describe.each(["guard", "shield"] as const)("%s refusal log windows", (source) => {
  let probe: Awaited<ReturnType<typeof refusalSource>>;

  beforeEach(async () => {
    probe = await refusalSource(source);
  });

  async function refuse(count = 1) {
    for (let i = 0; i < count; i++) expect(await probe.call()).toBe(429);
  }

  function expectLogs(individual: number, sheds: number[]) {
    expect(warn.mock.calls.filter(([code]: unknown[]) => code === probe.code)).toEqual(
      Array.from({ length: individual }, () => [probe.code, probe.payload]),
    );
    expect(warn.mock.calls.filter(([code]: unknown[]) => code === `${probe.code}.shed`)).toEqual(
      sheds.map((dropped) => [`${probe.code}.shed`, { dropped }]),
    );
    expect(warn).toHaveBeenCalledTimes(individual + sheds.length);
  }

  it("refills at 3000ms, not 2999ms, retaining fractional credit across calls", async () => {
    await refuse(20);
    expectLogs(20, []);
    await refuse();
    expectLogs(20, [1]);
    now += 2_999;
    await refuse();
    expectLogs(20, [1]);
    now += 1;
    await refuse();
    expectLogs(21, [1]);
    await refuse();
    expectLogs(21, [1, 2]);
    now += 1;
    await refuse();
    expectLogs(21, [1, 2]);
    now += 1_499;
    await refuse();
    expectLogs(21, [1, 2]);
    now += 1_500;
    await refuse();
    expectLogs(22, [1, 2]);
    await refuse();
    expectLogs(22, [1, 2, 3]);
  });

  it("caps refill at the 20-token burst after a long idle", async () => {
    await refuse(20);
    expectLogs(20, []);
    now += 120_000;
    await refuse(20);
    expectLogs(40, []);
    await refuse();
    expectLogs(40, [1]);
  });

  it("reports exact accumulated drops and resets after each shed emission", async () => {
    await refuse(100);
    expectLogs(20, [1]);
    now += 2_999;
    await refuse();
    expectLogs(20, [1]);
    now += 1;
    await refuse(2);
    expectLogs(21, [1, 81]);
    now += 3_000;
    await refuse(2);
    expectLogs(22, [1, 81, 1]);
    // Four pending drops stay silent even if idle time replenishes a log token.
    await refuse(4);
    expectLogs(22, [1, 81, 1]);
    now += 3_000;
    await refuse();
    expectLogs(23, [1, 81, 1]);
    await refuse();
    expectLogs(23, [1, 81, 1, 5]);
  });
});

describe("shield refusal telemetry follows the final audit decision", () => {
  it.each(["55P03", "57014", "23505"])(
    "does not log a 429 when audit fails with %s",
    async (code) => {
      const { shield } = await import("../src/agent-events/shield");
      const { DEFAULT_CONFIG } = await import("../src/agent-events/service");
      const fake = makeFakeAgentDb();
      fake.hits.push({ bucket: "shield:ip:198.51.100.9", at: now });
      const sql = new Proxy(fake.sql, {
        apply(target, thisArg, args) {
          if (
            (args[0] as TemplateStringsArray).join("?").includes("INSERT INTO agent_event_audits")
          ) {
            throw Object.assign(new Error("simulated audit failure"), { code });
          }
          return Reflect.apply(target, thisArg, args);
        },
        get(target, prop) {
          if (prop === "begin") return async (fn: (tx: unknown) => Promise<unknown>) => fn(sql);
          return Reflect.get(target, prop);
        },
      });
      vi.mocked(Math.random).mockReturnValue(0);
      const call = () =>
        shield(sql, { ...DEFAULT_CONFIG, routePerMinute: 1 }, "ip:198.51.100.9", "audit-probe", {
          kind: "anonymous",
        });
      if (code === "23505") {
        await expect(call()).rejects.toMatchObject({ code });
      } else {
        expect(await call()).toMatchObject({ status: 503, body: { reason: "operation_busy" } });
      }
      expect(warn).not.toHaveBeenCalled();
      // A subsequent 429 still has the entire log burst: the failed audit did not spend a token.
      vi.mocked(Math.random).mockReturnValue(0.999);
      for (let i = 0; i < 20; i++) expect((await call())!.status).toBe(429);
      expect(warn.mock.calls).toEqual(
        Array.from({ length: 20 }, () => [
          "agent-events.shield.refused",
          { bucket_class: "anonymous", outcome: "rate_limited" },
        ]),
      );
    },
  );
});

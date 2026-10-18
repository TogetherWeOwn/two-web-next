// Regression: pool close failure in `agentEventsAdmission`'s `finally`
// resolves silently on every exit path.
//
// A rejecting `sql.end()` must never surface as an unhandled rejection,
// whether admission admits, shield-refuses, throws, or downstream answers
// 413 / 400 after `next()`. The middleware still answers normally.
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { agentEventsAdmission } from "../src/agent-events/route";

const state = vi.hoisted(() => ({
  endCalls: 0,
  admitMode: "admit" as "admit" | "shield" | "throw",
}));

// Non-injected pool double: every statement succeeds; only `end` fails.
vi.mock("postgres", () => ({
  default: () => {
    const sql = (async () => []) as unknown as Record<string, unknown>;
    sql.begin = async (fn: (tx: unknown) => unknown) => fn(sql);
    sql.unsafe = async () => [];
    sql.end = async () => {
      state.endCalls += 1;
      throw new Error("pool close boom");
    };
    return sql;
  },
}));

vi.mock("../src/agent-events/service", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../src/agent-events/service")>();
  return {
    ...orig,
    admitAgentEvent: async () => {
      if (state.admitMode === "shield") return { status: 429, body: { reason: "rate_limited" } };
      if (state.admitMode === "throw") throw new Error("service boom");
      return { handle: async () => ({ status: 200, body: { ok: true } }) };
    },
  };
});

const env = {
  APP_URL: "https://next.example.test",
  AGENT_EVENTS_ENABLED: "true",
  AGENT_EVENTS_CALLER_AGENT_ID: "agent-under-test",
  AGENT_DB: { connectionString: "postgres://fixture.invalid/never-connected" },
} as unknown as Env;

function execution() {
  const waited: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: vi.fn((p: Promise<unknown>) => {
      waited.push(p);
    }),
    passThroughOnException: vi.fn(),
    props: {},
  };
  return { ctx, waited };
}

function mount(downstreamStatus?: number) {
  const app = new Hono<{ Bindings: Env }>();
  app.post("/api/agent-events", agentEventsAdmission, async (c) => {
    if (downstreamStatus !== undefined)
      return c.json({ reason: "downstream" }, downstreamStatus as 200);
    return c.json({ ok: true }, 200);
  });
  return app;
}

async function call(downstreamStatus?: number) {
  const { ctx, waited } = execution();
  const res = await mount(downstreamStatus).request(
    "/api/agent-events",
    { method: "POST", body: "{}" },
    env,
    ctx as never,
  );
  return { res, waited, ctx };
}

beforeEach(() => {
  state.endCalls = 0;
  state.admitMode = "admit";
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => vi.restoreAllMocks());

describe("agent ingress pool close without unhandled rejection", () => {
  it("admitted path answers normally and the close settles silently", async () => {
    const { res, waited, ctx } = await call();
    expect(res.status).toBe(200);
    expect(state.endCalls).toBe(1);
    expect(ctx.waitUntil).toHaveBeenCalledOnce();
    expect(waited).toHaveLength(1);
    await expect(waited[0]).resolves.toBeUndefined();
  });

  it("shield refusal answers normally and the close settles silently", async () => {
    state.admitMode = "shield";
    const { res, waited } = await call();
    expect(res.status).toBe(429);
    expect(state.endCalls).toBe(1);
    expect(waited).toHaveLength(1);
    await expect(waited[0]).resolves.toBeUndefined();
  });

  it("413 downstream answers normally and the close settles silently", async () => {
    const { res, waited } = await call(413);
    expect(res.status).toBe(413);
    expect(state.endCalls).toBe(1);
    expect(waited).toHaveLength(1);
    await expect(waited[0]).resolves.toBeUndefined();
  });

  it("source-failure downstream answers normally and the close settles silently", async () => {
    const { res, waited } = await call(400);
    expect(res.status).toBe(400);
    expect(state.endCalls).toBe(1);
    expect(waited).toHaveLength(1);
    await expect(waited[0]).resolves.toBeUndefined();
  });

  it("service failure answers 500 and the close settles silently", async () => {
    state.admitMode = "throw";
    const { res, waited } = await call();
    expect(res.status).toBe(500);
    expect(state.endCalls).toBe(1);
    expect(waited).toHaveLength(1);
    await expect(waited[0]).resolves.toBeUndefined();
  });
});

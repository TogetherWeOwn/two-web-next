import { afterEach, describe, expect, it, vi } from "vitest";
import type { JobsEnv } from "../src/env";
import { STAGING_APP_URL } from "../src/qa";
import { env as baseEnv } from "./helpers/member-data";

const db = vi.hoisted(() => ({ end: vi.fn(async () => {}) }));
vi.mock("postgres", () => ({ default: vi.fn(() => db) }));
import { handleQueue } from "../src/jobs/worker";

afterEach(() => vi.restoreAllMocks());

describe("deployed queue wrapper's probe gate (mocked SQL, no network)", () => {
  it.each([
    { APP_URL: STAGING_APP_URL, QA_AUTH_TOKEN: "fixture-qa", pages: true },
    { APP_URL: "https://togetherweown.com", QA_AUTH_TOKEN: "fixture-qa", pages: false },
    { APP_URL: STAGING_APP_URL, QA_AUTH_TOKEN: undefined, pages: false },
  ])("uses qaEnabled for $APP_URL / token $QA_AUTH_TOKEN", async ({ pages, ...gate }) => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const ack = vi.fn(), retry = vi.fn();
    const batch = { messages: [{ body: { kind: "alert-probe" }, attempts: 1, ack, retry }] } as unknown as MessageBatch;
    const env = {
      ...baseEnv, ...gate, DB: { connectionString: "postgres://agent_test@agent-testdb:5432/two_web_next" },
    } as JobsEnv;
    await handleQueue(batch, env);
    expect(ack).toHaveBeenCalledOnce();
    expect(retry).not.toHaveBeenCalled();
    const critical = errors.mock.calls.map(([line]) => String(line)).filter((line) => line.startsWith('{"level":"critical"'));
    if (pages) expect(critical.map((line) => JSON.parse(line))).toMatchObject([{ event: "queue.failing", job: "AlertProbe", attempts: 1 }]);
    else expect(errors).not.toHaveBeenCalled();
    expect(db.end).toHaveBeenCalled();
  });
});

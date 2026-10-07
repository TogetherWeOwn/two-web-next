import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { pgEventStore } from "../src/jobs/events";
import { previewFailedJob } from "../src/jobs/preview";

const mocks = vi.hoisted(() => ({ begin: vi.fn(), end: vi.fn(), factory: vi.fn() }));
vi.mock("postgres", () => ({ default: mocks.factory }));
const sourceUrl = "postgres://agent_test@agent-testdb:5432/two_web_next";
const bindings = { DATABASE_URL: sourceUrl } as Env;

describe("preview source resource ownership", () => {
  beforeEach(() => {
    mocks.begin.mockResolvedValue(null);
    mocks.end.mockResolvedValue(undefined);
    mocks.factory.mockReturnValue({ begin: mocks.begin, end: mocks.end });
  });
  afterEach(() => vi.resetAllMocks());

  it.each([false, true])(
    "store construction is inert with bypassReadCache=%s",
    (bypassReadCache) => {
      const sqlTag = vi.fn();
      pgEventStore(sqlTag as unknown as Parameters<typeof pgEventStore>[0], { bypassReadCache });
      expect(sqlTag).not.toHaveBeenCalled();
    },
  );

  it("uses the Worker source configuration with bounded connections and closes on success", async () => {
    expect(await previewFailedJob(bindings, 7)).toBeNull();
    expect(mocks.factory).toHaveBeenCalledExactlyOnceWith(
      sourceUrl,
      expect.objectContaining({
        max: 1,
        prepare: false,
        fetch_types: false,
        connect_timeout: 2,
        connection: { statement_timeout: 5000 },
      }),
    );
    expect(mocks.begin).toHaveBeenCalledExactlyOnceWith(
      "isolation level repeatable read read only",
      expect.any(Function),
    );
    expect(mocks.end).toHaveBeenCalledExactlyOnceWith({ timeout: 1 });
  });

  it("uses the established DB binding only when DATABASE_URL is empty", async () => {
    await previewFailedJob({ DATABASE_URL: "", DB: { connectionString: sourceUrl } } as Env, 7);
    expect(mocks.factory.mock.calls[0]![0]).toBe(sourceUrl);
    expect(mocks.end).toHaveBeenCalledTimes(1);
  });

  it("missing source configuration refuses without constructing a pool", async () => {
    await expect(previewFailedJob({} as Env, 7)).rejects.toThrow("no source database configured");
    expect(mocks.factory).not.toHaveBeenCalled();
  });

  it("source connection/check errors close resources without attempting a fallback", async () => {
    mocks.begin.mockRejectedValue(new Error("fixture source failure"));
    await expect(
      previewFailedJob(
        {
          ...bindings,
          DB: { connectionString: "unused fixture binding" },
        } as Env,
        7,
      ),
    ).rejects.toThrow("fixture source failure");
    expect(mocks.factory).toHaveBeenCalledTimes(1);
    expect(mocks.end).toHaveBeenCalledExactlyOnceWith({ timeout: 1 });
  });

  it("invalid numeric selectors close the newly owned pool before rejecting", async () => {
    await expect(previewFailedJob(bindings, 0)).rejects.toThrow("invalid failure ID");
    expect(mocks.begin).not.toHaveBeenCalled();
    expect(mocks.end).toHaveBeenCalledTimes(1);
  });

  it("a resource-close failure cannot release successful advice", async () => {
    mocks.end.mockRejectedValue(new Error("fixture close failure"));
    await expect(previewFailedJob(bindings, 7)).rejects.toThrow("fixture close failure");
    expect(mocks.end).toHaveBeenCalledExactlyOnceWith({ timeout: 1 });
  });
});

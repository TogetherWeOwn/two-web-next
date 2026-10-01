import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createMemberDataFixture } from "./helpers/member-data-db";
import { createUsersProfilesFixture } from "./helpers/import-users-profiles-db";

const state = vi.hoisted(() => ({ events: [] as string[], failAt: "", failure: new Error("synthetic operation failed") }));
vi.mock("node:crypto", () => ({ randomUUID: () => "synthetic-fixture" }));
vi.mock("drizzle-orm/migrator", () => ({ readMigrationFiles: () => [{ sql: ["SELECT 1", "SELECT 2"] }] }));
vi.mock("drizzle-orm/postgres-js", () => ({ drizzle: () => ({
  delete: async () => { state.events.push("delete"); if (state.failAt === "delete") throw state.failure; },
}) }));
vi.mock("postgres", () => ({ default: (_url: string, options: { connection?: { search_path: string } }) => {
  const name = options.connection?.search_path ?? "admin";
  const event = (operation: string) => {
    state.events.push(`${name}:${operation}`);
    if (state.failAt === `${name}:${operation}`) throw state.failure;
  };
  const sql = Object.assign(async () => { event("query"); }, {
    unsafe: async (text: string) => { event(text.startsWith("CREATE SCHEMA") ? "create" : text.startsWith("DROP SCHEMA") ? "drop" : "unsafe"); },
    end: async () => { event("end"); },
    begin: async (fn: (client: unknown) => Promise<unknown>): Promise<unknown> => { event("begin"); return fn(sql); },
  });
  return sql;
} }));

beforeEach(() => { state.events = []; state.failAt = ""; vi.spyOn(console, "log").mockImplementation(() => {}); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
const url = "postgres://agent_test@agent-testdb:5432/two_web_next";

it.each([createMemberDataFixture, createUsersProfilesFixture])("retains SQL/transaction/reset/disposal ordering with timing enabled", async (create) => {
  async function lifecycle(flag: string) {
    vi.stubEnv("TEST_TIMINGS", flag);
    state.events = [];
    const fixture = await create(url);
    await fixture.reset();
    await fixture.dispose();
    await fixture.dispose();
    return [...state.events];
  }
  const original = await lifecycle("");
  expect(original.length).toBeGreaterThan(5);
  expect(await lifecycle("1")).toEqual(original);
});

it.each(["admin:create", "w15_syntheticfixture:unsafe"])("retains member setup failure and owned cleanup at %s", async (failAt) => {
  vi.stubEnv("TEST_TIMINGS", "1");
  state.failAt = failAt;
  await expect(createMemberDataFixture(url)).rejects.toBe(state.failure);
  expect(state.events).toContain("w15_syntheticfixture:end");
  expect(state.events.at(-1)).toBe("admin:end");
  expect(state.events.includes("admin:drop")).toBe(failAt !== "admin:create");
});

it("retains reset failure while diagnostics are unable to log", async () => {
  vi.stubEnv("TEST_TIMINGS", "1");
  vi.mocked(console.log).mockImplementation(() => { throw new Error("synthetic sink failure"); });
  const fixture = await createMemberDataFixture(url);
  state.failAt = "delete";
  await expect(fixture.reset()).rejects.toBe(state.failure);
  state.failAt = "";
  await fixture.dispose();
  expect(state.events.at(-1)).toBe("admin:end");
});

it("retains import setup failure and both client closures", async () => {
  vi.stubEnv("TEST_TIMINGS", "1");
  state.failAt = "next_up_syntheticfixture:unsafe";
  await expect(createUsersProfilesFixture(url)).rejects.toBe(state.failure);
  expect(state.events).toContain("legacy_up_syntheticfixture:end");
  expect(state.events).toContain("next_up_syntheticfixture:end");
  expect(state.events.slice(-2)).toEqual(["admin:drop", "admin:end"]);
});

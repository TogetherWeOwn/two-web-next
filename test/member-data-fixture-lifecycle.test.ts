import { beforeEach, expect, it, vi } from "vitest";
import { createMemberDataFixture } from "./helpers/member-data-db";

// Driver doubles only: exercise ordering and failure propagation without a DB.
const mocks = vi.hoisted(() => {
  const tx = { unsafe: vi.fn(async (_statement: string) => []) };
  const admin = { unsafe: vi.fn(async (_statement: string) => []), end: vi.fn(async (_options?: unknown) => {}) };
  const client = {
    unsafe: vi.fn(async (_statement: string) => []),
    begin: vi.fn(async (fn: (sql: typeof tx) => Promise<void>) => fn(tx)),
    end: vi.fn(async (_options?: unknown) => {}),
  };
  const postgres = vi.fn();
  const migrations = vi.fn(() => [
    { sql: ['CREATE TABLE users (id text PRIMARY KEY)', '   '] },
    { sql: ['CREATE TABLE profiles (id text REFERENCES "public".users(id))'] },
  ]);
  return { tx, admin, client, postgres, migrations };
});
vi.mock("postgres", () => ({ default: mocks.postgres }));
vi.mock("drizzle-orm/migrator", () => ({ readMigrationFiles: mocks.migrations }));
vi.mock("drizzle-orm/postgres-js", () => ({ drizzle: vi.fn(() => ({})) }));
beforeEach(() => {
  vi.clearAllMocks();
  mocks.postgres.mockImplementationOnce(() => mocks.admin).mockImplementationOnce(() => mocks.client);
});
const url = "postgres://agent_test@agent-testdb:5432/two_web_next";

it("replays every nonempty canonical statement in order in one schema-scoped transaction", async () => {
  const fixture = await createMemberDataFixture(url);
  try {
    expect(mocks.admin.unsafe.mock.calls).toEqual([[`CREATE SCHEMA "${fixture.schemaName}"`]]);
    expect(mocks.client.begin).toHaveBeenCalledTimes(1);
    expect(mocks.client.unsafe).not.toHaveBeenCalled();
    expect(mocks.tx.unsafe.mock.calls).toEqual([
      ['CREATE TABLE users (id text PRIMARY KEY)'],
      [`CREATE TABLE profiles (id text REFERENCES "${fixture.schemaName}".users(id))`],
    ]);
    const options = mocks.postgres.mock.calls[1]![1];
    expect(options.max).toBe(1);
    expect(options.connection).toEqual({ search_path: fixture.schemaName });
    expect(mocks.migrations).toHaveBeenCalledTimes(1);
  } finally { await fixture.dispose(); }
});

it("bounds administrative DDL without imposing a timeout on the scoped test workload", async () => {
  const fixture = await createMemberDataFixture(url);
  try {
    expect(mocks.postgres.mock.calls[0]![1].connection).toEqual({ statement_timeout: 2000, lock_timeout: 1000 });
    expect(mocks.postgres.mock.calls[1]![1].connection).toEqual({ search_path: fixture.schemaName });
  } finally { await fixture.dispose(); }
});

it("shares in-flight disposal and only completes after schema drop and both pool shutdowns", async () => {
  const fixture = await createMemberDataFixture(url);
  let release!: () => void;
  mocks.client.end.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));
  const first = fixture.dispose();
  const second = fixture.dispose();
  try {
    expect(second).toBe(first);
    expect(mocks.admin.unsafe).toHaveBeenCalledTimes(1);
    expect(mocks.admin.end).not.toHaveBeenCalled();
    await expect(fixture.reset()).rejects.toThrow("fixture is disposed");
  } finally { release(); await Promise.all([first, second]); }
  expect(mocks.client.end).toHaveBeenCalledExactlyOnceWith({ timeout: 1 });
  expect(mocks.admin.unsafe).toHaveBeenLastCalledWith(`DROP SCHEMA "${fixture.schemaName}" CASCADE`);
  expect(mocks.admin.end).toHaveBeenCalledExactlyOnceWith({ timeout: 1 });
  expect(fixture.dispose()).toBe(first);
});

it("preserves a failed disposal for every caller instead of reporting false completion", async () => {
  const fixture = await createMemberDataFixture(url);
  const failure = new Error("fixture drop failed");
  mocks.admin.unsafe.mockRejectedValueOnce(failure);
  const disposal = fixture.dispose();
  await expect(disposal).rejects.toBe(failure);
  expect(fixture.dispose()).toBe(disposal);
  await expect(fixture.dispose()).rejects.toBe(failure);
  expect(mocks.admin.end).toHaveBeenCalledExactlyOnceWith({ timeout: 1 });
});

it("still drops the owned schema and closes the admin pool if client shutdown fails", async () => {
  const fixture = await createMemberDataFixture(url);
  const failure = new Error("fixture client shutdown failed");
  mocks.client.end.mockRejectedValueOnce(failure);
  await expect(fixture.dispose()).rejects.toBe(failure);
  expect(mocks.admin.unsafe).toHaveBeenLastCalledWith(`DROP SCHEMA "${fixture.schemaName}" CASCADE`);
  expect(mocks.admin.end).toHaveBeenCalledExactlyOnceWith({ timeout: 1 });
});

it("rolls back a failed bootstrap and disposes before propagating its error", async () => {
  const failure = new Error("canonical migration failed");
  mocks.tx.unsafe.mockRejectedValueOnce(failure);
  await expect(createMemberDataFixture(url)).rejects.toBe(failure);
  expect(mocks.client.begin).toHaveBeenCalledTimes(1);
  expect(mocks.tx.unsafe).toHaveBeenCalledTimes(1);
  expect(mocks.admin.unsafe.mock.calls[1]![0]).toMatch(/^DROP SCHEMA "w15_[a-f0-9]+" CASCADE$/);
  expect(mocks.client.end).toHaveBeenCalledExactlyOnceWith({ timeout: 1 });
  expect(mocks.admin.end).toHaveBeenCalledExactlyOnceWith({ timeout: 1 });
});

it("closes both pools without dropping a schema it never created", async () => {
  const failure = new Error("fixture create failed");
  mocks.admin.unsafe.mockRejectedValueOnce(failure);
  await expect(createMemberDataFixture(url)).rejects.toBe(failure);
  expect(mocks.admin.unsafe).toHaveBeenCalledTimes(1);
  expect(mocks.client.begin).not.toHaveBeenCalled();
  expect(mocks.client.end).toHaveBeenCalledExactlyOnceWith({ timeout: 1 });
  expect(mocks.admin.end).toHaveBeenCalledExactlyOnceWith({ timeout: 1 });
});

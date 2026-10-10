import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DISCORD_STORE_DEADLINE_MS,
  DISCORD_STORE_SQL_TIMEOUT_MS,
} from "../src/events/discord-snapshot-postgres";
import { DISCORD_READ_DEADLINE_MS } from "../src/events/discord-transients";
import {
  DISCORD_CACHE_FRESH_MS,
  DISCORD_CACHE_STALE_MS,
  DISCORD_FAILURE_HOLD_MS,
  DISCORD_REFRESH_LEASE_MS,
} from "../src/events/discord-snapshot";

const doc = readFileSync(new URL("../docs/performance-budgets.md", import.meta.url), "utf8");
// Comma-grouped thousands ("1,500 ms") and plain ("1500 ms") are the same bound.
const flat = doc.replace(/,/g, "");
const lineFor = (label: RegExp): string => {
  const line = flat.split("\n").find((line) => label.test(line));
  expect(line, `budgets doc line for ${label}`).toBeDefined();
  return line!;
};
const rowFor = lineFor;
// Whole-number match: "500 ms" must not match inside "1500 ms".
const num = (ms: number): RegExp => new RegExp(`(^|\\D)${ms} ms`);

describe("performance budgets snapshot path", () => {
  it("pins the asserted deadline constants", () => {
    expect(DISCORD_STORE_DEADLINE_MS).toBe(1500);
    expect(DISCORD_STORE_SQL_TIMEOUT_MS).toBe(400);
    expect(DISCORD_READ_DEADLINE_MS).toBe(1000);
    expect(DISCORD_CACHE_FRESH_MS).toBe(60_000);
    expect(DISCORD_CACHE_STALE_MS).toBe(600_000);
    expect(DISCORD_REFRESH_LEASE_MS).toBe(5_000);
    expect(DISCORD_FAILURE_HOLD_MS).toBe(10_000);
  });

  it("documents snapshot cold-claim, stale-serve and refresh-lease rows", () => {
    expect(doc).toMatch(/snapshot cold-claim/i);
    expect(doc).toMatch(/stale-serve/i);
    expect(doc).toMatch(/refresh-lease/i);
    expect(doc).toContain("test/discord-snapshot-deadline.test.ts");
  });

  it("keeps each documented bound equal to its asserted constant", () => {
    expect(rowFor(/snapshot cold-claim/i)).toMatch(num(DISCORD_STORE_DEADLINE_MS));
    const stale = rowFor(/stale-serve/i);
    expect(stale).toMatch(num(DISCORD_CACHE_FRESH_MS));
    expect(stale).toMatch(num(DISCORD_CACHE_STALE_MS));
    expect(rowFor(/refresh-lease/i)).toMatch(num(DISCORD_REFRESH_LEASE_MS));
    expect(lineFor(/headers-and-body deadline/i)).toMatch(num(DISCORD_READ_DEADLINE_MS));
    const statements = lineFor(/lock timeout/i);
    expect(statements).toMatch(num(DISCORD_STORE_SQL_TIMEOUT_MS));
    expect(statements).toMatch(num(DISCORD_STORE_SQL_TIMEOUT_MS - 50));
    expect(lineFor(/retry hold/i)).toMatch(num(DISCORD_FAILURE_HOLD_MS));
  });
});

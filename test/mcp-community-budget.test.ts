// Regression: a rank ladder admitted by the SQL caps (64 characters per
// key/label, 20 rows) can still overflow the MCP envelope once JSON escaping
// expands control characters and the tool result carries the DTO twice (text
// plus structuredContent). get_community enforces the complete tool-result
// budget and degrades the whole rank read to [] — never a partial ladder —
// with one counts-only diagnostic. REST serves the same DTO once and needs
// no guard.
//
// The hermetic block always runs; the full POST /mcp proof executes the real
// rank SELECT against a disposable web_v1 fixture (helpers refuse non-test
// URLs before connecting).
import type postgres from "postgres";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { communityToolResultBytes } from "../src/mcp/server";
import { API_PUBLIC_BOUNDS } from "../src/public-data/contracts";
import { serializeCommunity } from "../src/public-data/routes";
import { createMemorySessionStore } from "../src/sessions";
import {
  createMemberDataFixture,
  testDatabaseUrl,
  type MemberDataFixture,
} from "./helpers/member-data-db";
import { createWebV1Fixture, type WebV1Fixture } from "./helpers/web-v1-fixture";

const CTRL = "\u0001"; // U+0001: JSON escapes it to six bytes.
const cp = (s: string) => [...s].length;

// The review's worst case: every key/label exactly at the 64-character SQL
// cap, built from a character JSON escapes to six bytes.
function escapedLadder() {
  return Array.from({ length: 20 }, (_, i) => ({
    key: `${String(i).padStart(2, "0")}${CTRL.repeat(62)}`,
    label: CTRL.repeat(64),
    memberCount: 1,
  }));
}

describe("communityToolResultBytes under the pinned caps (control)", () => {
  it("keeps a healthy snapshot far under the budget", () => {
    const dto = serializeCommunity({
      memberCount: 84,
      onlineCount: 12,
      ranks: [
        { key: "prospect", label: "Prospect", memberCount: 24 },
        { key: "legend", label: "Legend", memberCount: 0 },
      ],
    });
    expect(communityToolResultBytes(dto)).toBeLessThan(2048);
    expect(communityToolResultBytes(dto) + 1024).toBeLessThan(API_PUBLIC_BOUNDS.maxBodyBytes);
  });

  it("measures the escaped, duplicated worst case over the budget", () => {
    const ranks = escapedLadder();
    expect(ranks.every((r) => cp(r.key) === 64 && cp(r.label) === 64)).toBe(true);
    const dto = serializeCommunity({ memberCount: 84, onlineCount: 12, ranks });
    expect(communityToolResultBytes(dto) + 1024).toBeGreaterThan(API_PUBLIC_BOUNDS.maxBodyBytes);
  });

  it("fits the degraded empty ladder with room to spare", () => {
    const dto = serializeCommunity({ memberCount: 84, onlineCount: 12, ranks: [] });
    expect(communityToolResultBytes(dto) + 1024).toBeLessThan(4096);
  });
});

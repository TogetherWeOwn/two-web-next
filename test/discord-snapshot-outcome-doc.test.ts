import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DISCORD_SNAPSHOT_OUTCOMES,
  SAFE_SNAPSHOT_SQLSTATES,
} from "../src/events/discord-transients";

// Offline documentation drift check; the outcome log's behavior is covered by
// test/discord-events-cache.test.ts.
const logs = readFileSync(new URL("../docs/runbook-logs.md", import.meta.url), "utf8");
const section = logs.split("## Discord snapshot outcome")[1]!.split("\n## ")[0]!;

function pinnedList(sentence: RegExp): string[] {
  const match = section.match(sentence);
  expect(match, `pinned sentence ${sentence}`).toBeDefined();
  return [...match![1]!.matchAll(/`([^`]+)`/g)].map((m) => m[1]!);
}

describe("Discord snapshot outcome documentation pin", () => {
  it("documents exactly the outcomes the code can emit", () => {
    const documented = pinnedList(/exactly these outcomes: ((`[^`]+`(?:, `[^`]+`)*))/);
    expect([...documented].sort()).toEqual([...DISCORD_SNAPSHOT_OUTCOMES].sort());
  });

  it("gives every outcome a meaning row", () => {
    for (const outcome of DISCORD_SNAPSHOT_OUTCOMES) {
      expect(section).toContain(`| \`${outcome}\` |`);
    }
  });

  it("documents exactly the allowlisted SQLSTATE codes", () => {
    const documented = pinnedList(
      /Only these SQLSTATE codes can appear as `code`: ((`[^`]+`(?:, `[^`]+`)*))/,
    );
    expect([...documented].sort()).toEqual([...SAFE_SNAPSHOT_SQLSTATES].sort());
  });
});

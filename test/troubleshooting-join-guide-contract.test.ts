// Guide contract: docs/troubleshooting-join.md documents exactly JOIN_OUTCOMES
// and distinguishes local admission 429 from Discord automatic-add backoff.
//
// The behavior (provider-backoff header + distinct rate_limited row) shipped
// elsewhere; this file pins only the member-support wording so the guide
// cannot drift from the code. DB-free: reads the markdown and imports the
// outcome constant. No database, no network, no live Discord.
import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { describe, expect, it } from "vitest";
import { JOIN_OUTCOMES } from "../src/join/service";

const guide = readFileSync(new URL("../docs/troubleshooting-join.md", import.meta.url), "utf8");

function outcomeSection(body: string = guide): string {
  const parts = body.split("The join attempt outcomes are");
  expect(parts.length, "guide has the join attempt outcomes section").toBe(2);
  return parts[1]!.split("\n## ")[0]!;
}

function documentedOutcomes(body: string = guide): string[] {
  const section = outcomeSection(body);
  const rows = [...section.matchAll(/^\| `([a-z_]+)` \|/gm)].map((m) => m[1]!);
  expect(rows.length, "outcome table has rows").toBeGreaterThan(0);
  expect(new Set(rows).size, "outcome table has no duplicate rows").toBe(rows.length);
  return [...rows].sort();
}

describe("troubleshooting-join guide contract", () => {
  it("documents exactly the outcomes the code can record", () => {
    expect(documentedOutcomes()).toEqual([...JOIN_OUTCOMES].sort());
  });

  it("gives every outcome a meaning row, including rate_limited", () => {
    const section = outcomeSection();
    for (const outcome of JOIN_OUTCOMES) {
      expect(
        section.split("\n").some((line) => line.startsWith(`| \`${outcome}\` |`)),
        `outcome table row for ${outcome}`,
      ).toBe(true);
    }
  });

  it("distinguishes local admission 429 from Discord backoff on a 200 recovery", () => {
    // Local admission: website budget, no attempt row.
    expect(guide).toMatch(/website 429 is local\s+admission/i);
    expect(guide).toMatch(/records no join-attempt row/s);
    // Provider backoff: 200 recovery with Retry-After, distinct outcome.
    expect(guide).toMatch(/Discord automatic-add backoff/);
    expect(guide).toMatch(/`rate_limited`.*recorded|records.*`rate_limited`/s);
    expect(guide).toContain("Retry-After");
    // The 200 status must never read as a successful join.
    expect(guide).toMatch(/the 200 (status )?does not mean joined/i);
    expect(guide).toMatch(/A 200 response on another recovery page is not a successful join/);
  });

  it("preserves fresh-journey, invite, no-replay and no-session advice", () => {
    // Wait, then a fresh journey or the invite — never a callback replay.
    expect(guide).toMatch(/then start a\s?fresh journey/i);
    expect(guide).toMatch(/use the invite/i);
    expect(guide).toContain("Do not reload, bookmark, share or replay `/join/callback`");
    expect(guide).toMatch(/replay `\/join\/callback`/);
    // A failed one-click join creates no session.
    expect(guide).toMatch(/does \*\*not\*\* issue a new signed-in session/);
    expect(guide).toMatch(/Do not promise that a recovery page signed them in/);
  });

  it("negative control: a synthetic table missing rate_limited does not match", () => {
    const section = outcomeSection();
    const withoutRateLimited = guide.replace(`| \`rate_limited\` |`, "| `__removed__` |");
    // Guard the synthesis itself: the replacement really removed the row.
    expect(withoutRateLimited).not.toContain("| `rate_limited` |");
    expect(section).toContain("| `rate_limited` |");
    const synthetic = documentedOutcomes(withoutRateLimited);
    expect(synthetic).not.toEqual([...JOIN_OUTCOMES].sort());
    expect(synthetic).not.toContain("rate_limited");
  });
});

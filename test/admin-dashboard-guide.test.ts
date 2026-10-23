import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { describe, expect, it } from "vitest";

const guide = readFileSync(new URL("../docs/moderator-admin-guide.md", import.meta.url), "utf8");

describe("dashboard guide parity", () => {
  it("lists the five dashboard resource cards", () => {
    const intro = /`\/admin` has ([\s\S]*?)cards plus/.exec(guide)?.[1] ?? "";
    expect([...intro.matchAll(/\*\*([^*]+)\*\*/g)].map((match) => match[1])).toEqual([
      "Events",
      "Featured content",
      "Activity log",
      "Join attempts",
      "Moderation settings",
    ]);
  });

  it("includes rate_limited in the Outcome filter and preserves the meaning reference", () => {
    const filter = /Use \*\*Outcome\*\* \(([^)]+)\)/.exec(guide)?.[1] ?? "";
    expect([...filter.matchAll(/`([^`]+)`/g)].map((match) => match[1])).toEqual([
      "added",
      "already_member",
      "error",
      "denied",
      "degraded",
      "rate_limited",
    ]);
    expect(guide).toContain(
      "[join troubleshooting guide](troubleshooting-join.md#moderator-diagnostics-and-escalation)",
    );
  });
});

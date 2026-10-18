import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { profileClientErrors } from "../src/islands/contracts";
import { validateProfile } from "../src/profiles/validation";

const TOO_LONG = "Games list is too long.";

describe("profile games_text 1700 code-point client mirror", () => {
  it("accepts 1700 and rejects 1701 with the server's exact copy", () => {
    for (const unit of ["a", "🎮"]) {
      const games = Array.from(
        { length: 20 },
        (_, i) => String(i) + unit.repeat(80 - String(i).length),
      );
      const list = games.join("\n");
      const at = list + " ".repeat(1700 - [...list].length);
      const over = `${at} `;
      expect([...at]).toHaveLength(1700);
      expect([...over]).toHaveLength(1701);
      expect(profileClientErrors({ bio: "", games_text: at, timezone: "" })).toEqual({});
      expect(profileClientErrors({ bio: "", games_text: over, timezone: "" }).games).toBe(TOO_LONG);
      expect(validateProfile({ bio: "", games_text: over, timezone: "" })).toEqual({
        ok: false,
        errors: { games: TOO_LONG },
      });
    }
  });

  it("binder mirrors the cap before any fetch", () => {
    const js = readFileSync("assets/islands/member-profile.js", "utf8");
    expect(js).toContain(TOO_LONG);
    expect(js).toMatch(/1700/);
  });
});

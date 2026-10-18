// Builder-owned unit cover for the numeric JSON shapes of the leaderboard
// opt-out switch: `normalizeLeaderboardOptOut` and `validateProfile` accept
// 1/0 and reject other numbers. Keeps src/profiles line coverage above the
// 97.7% floor without touching Test Author-owned acceptance tests.
import { describe, expect, it } from "vitest";
import { normalizeLeaderboardOptOut, validateProfile } from "../src/profiles/validation";

const FULL_JSON = { bio: "bio", games: ["Chess"], timezone: "Europe/London" };

describe("leaderboard opt-out numeric shapes", () => {
  it("maps JSON numbers 1 and 0 to the stored flag", () => {
    expect(normalizeLeaderboardOptOut(1)).toBe(true);
    expect(normalizeLeaderboardOptOut(0)).toBe(false);
    expect(validateProfile({ ...FULL_JSON, leaderboard_opt_out: 1 })).toMatchObject({
      ok: true,
      attrs: { leaderboardOptOut: true },
    });
    expect(validateProfile({ ...FULL_JSON, leaderboard_opt_out: 0 })).toMatchObject({
      ok: true,
      attrs: { leaderboardOptOut: false },
    });
  });

  it("rejects other numbers with a field error", () => {
    expect(normalizeLeaderboardOptOut(2)).toBeUndefined();
    expect(validateProfile({ ...FULL_JSON, leaderboard_opt_out: 2 })).toEqual({
      ok: false,
      errors: { leaderboard_opt_out: expect.any(String) },
    });
  });

  it("reads numeric arrays element by element", () => {
    expect(normalizeLeaderboardOptOut([0, 1])).toBe(true);
    expect(normalizeLeaderboardOptOut([1, 0])).toBe(false);
    expect(normalizeLeaderboardOptOut([2])).toBeUndefined();
  });
});

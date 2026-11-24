import { describe, expect, it, vi } from "vitest";
import { PROFILE_COPY, PROFILE_MIN_FILL_MS } from "../src/islands/contracts-member-profile";
import { baseline, fixture, OWNER, REQUEST_ID, response } from "./fixtures/kit-profile-write";

const saved = { saved: true, message: PROFILE_COPY.saved };

describe("Kit profile write HTTP adapter", () => {
  it("accepts the editor payload at the timing boundary and swallows a fast valid draft", async ({
    onTestFinished,
  }) => {
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    onTestFinished(() => {
      clock.mockRestore();
    });
    const { write, save, find, throttle, rotate, sessionGet } = await fixture();
    const editor = {
      bio: "  Synthetic editor draft  ",
      games_text: "Chess\r\n Go \nChess",
      timezone: "Europe/London",
      leaderboard_opt_out: true,
      website: "",
      formOpenedAt: now - PROFILE_MIN_FILL_MS,
    };
    for (const body of [
      editor,
      { ...editor, formOpenedAt: editor.formOpenedAt + 1 },
      { ...editor, website: "filled" },
    ]) {
      const res = response(await write(JSON.stringify(body)));
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("private, no-store");
      expect(res.headers.get("vary")).toBeNull();
      expect(await res.json()).toEqual(saved);
    }
    expect(sessionGet).toHaveBeenCalledBefore(throttle);
    expect(throttle).toHaveBeenCalledBefore(find);
    expect(throttle).toHaveBeenNthCalledWith(1, `profile-write:${OWNER}`);
    expect(rotate).not.toHaveBeenCalled();
    expect(save).toHaveBeenCalledExactlyOnceWith(OWNER, {
      bio: "Synthetic editor draft",
      games: ["Chess", "Go"],
      timezone: "Europe/London",
      leaderboardOptOut: true,
    });
    const olderClient = response(await write(JSON.stringify({ games: [] })));
    expect(olderClient.status).toBe(200);
    expect(save.mock.lastCall?.[1]).not.toHaveProperty("leaderboardOptOut");
  });

  it.each([
    ["guest", 401, "Cookie"],
    ["non-member", 403, "Accept"],
    ["moderator", 403, "Accept"],
  ] as const)("refuses %s without reading or changing the target", async (role, status, vary) => {
    const { write, id, find, save, throttle } = await fixture(role);
    const res = response(await write("{"));
    expect(res.status).toBe(status);
    expect(res.headers.get("vary")).toBe(vary);
    expect(await res.text()).not.toContain(baseline.bio);
    expect(find).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    expect(throttle.mock.calls).toEqual(role === "moderator" ? [[`profile-write:${id}`]] : []);
  });

  it("keeps malformed request contents out of diagnostics", async ({ onTestFinished }) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    onTestFinished(() => {
      warn.mockRestore();
    });
    const { write, save } = await fixture();
    const res = response(await write('{"bio":"PRIVATE_SYNTHETIC_TEXT"'));
    expect(res.status).toBe(400);
    expect(await res.text()).not.toContain("PRIVATE_SYNTHETIC_TEXT");
    expect(warn).toHaveBeenCalledWith("profile.write.malformed_body", {
      exception: "SyntaxError",
      content_type: "application/json",
      request_id: REQUEST_ID,
    });
    expect(save).not.toHaveBeenCalled();
  });
});

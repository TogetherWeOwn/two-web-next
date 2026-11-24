import { describe, expect, it, vi } from "vitest";
import { BODY_LIMIT_BYTES } from "../src/http/body-limit";
import { PROFILE_COPY, PROFILE_MIN_FILL_MS } from "../src/islands/contracts-member-profile";
import { baseline, fixture, OWNER, PATH, REQUEST_ID, response } from "./fixtures/kit-profile-write";

describe("Kit profile write refusals", () => {
  it("keeps the cap, throttle and POST override ahead of the profile store", async () => {
    const { write, throttle, find, sessionGet } = await fixture();
    const large = response(await write("x".repeat(BODY_LIMIT_BYTES.form + 1)));
    expect(large.status).toBe(413);
    expect(sessionGet).not.toHaveBeenCalled();
    throttle.mockResolvedValueOnce({ limited: true, retryAfter: 9 });
    const limited = response(await write("{"));
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("9");
    for (const form of ["{}", new URLSearchParams("_method=PATCH&_method=PATCH")]) {
      const invalid = response(await write(form, "POST"));
      expect(invalid.status).toBe(405);
      expect(invalid.headers.get("allow")).toBe("GET, PATCH, POST");
      expect(invalid.headers.get("vary")).toBe("Accept");
      expect(await invalid.json()).toEqual({
        error: "method_not_allowed",
        request_id: REQUEST_ID,
      });
    }
    expect(find).not.toHaveBeenCalled();
  });

  it("refuses an unsupported PATCH body without replacing saved fields", async () => {
    const { write, save, store } = await fixture();
    const res = response(await write("unrecognized", "PATCH", { "content-type": "text/plain" }));
    expect(res.status).toBe(415);
    expect(res.headers.get("vary")).toBe("Accept");
    expect(await res.json()).toEqual({
      error: "unsupported_media_type",
      request_id: REQUEST_ID,
    });
    expect(save).not.toHaveBeenCalled();
    expect(store.rows.get(OWNER)).toEqual(baseline);
  });

  it("preserves the throttle outage policy and logs only fixed diagnostic fields", async ({
    onTestFinished,
  }) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    onTestFinished(() => {
      warn.mockRestore();
    });
    const { write, save, throttle } = await fixture();
    throttle.mockRejectedValueOnce(new TypeError("Synthetic private diagnostic text"));
    const res = response(await write('{"games":[]}'));
    expect(res.status).toBe(200);
    expect(save).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      JSON.stringify({
        event: "profile.throttle.store_failed",
        throttle: "profile-write",
        exception: "TypeError",
        request_id: REQUEST_ID,
      }),
    );
  });

  it("retains an admitted native draft separately from the baseline and preserves checkbox order", async () => {
    const { write, save } = await fixture();
    const form = new URLSearchParams({
      _method: "PATCH",
      bio: "New synthetic text <fixture>",
      games_text: "Go\nGo",
      timezone: "not/a-zone",
      leaderboard_opt_out: "0",
      website: "",
      formOpenedAt: String(Date.now() - PROFILE_MIN_FILL_MS - 10),
    });
    form.append("leaderboard_opt_out", "1");
    const draft = await write(form, "POST", { accept: "text/html" });
    expect(draft).toMatchObject({
      status: 422,
      member: baseline,
      errors: { timezone: expect.any(String) },
      values: {
        bio: "New synthetic text <fixture>",
        games_text: "Go\nGo",
        timezone: "not/a-zone",
        leaderboard_opt_out: true,
      },
    });
    expect(save).not.toHaveBeenCalled();
    form.set("timezone", "Europe/London");
    const res = response(await write(form, "POST", { accept: "text/html" }));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(PATH);
    expect(res.headers.get("vary")).toBeNull();
    expect(save).toHaveBeenCalledExactlyOnceWith(OWNER, {
      bio: "New synthetic text <fixture>",
      games: ["Go"],
      timezone: "Europe/London",
      leaderboardOptOut: true,
    });
  });

  it("warns with bounded parser diagnostics and treats a cancelled save as uncertain", async ({
    onTestFinished,
  }) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    onTestFinished(() => {
      warn.mockRestore();
      error.mockRestore();
    });
    const { write, save, find, sessionGet } = await fixture();
    const synthetic = "PRIVATE_SYNTHETIC_DRAFT";
    for (const [body, exception] of [
      [`{"bio":"${synthetic}"`, "SyntaxError"],
      [`["${synthetic}"]`, "TypeError"],
    ] as const) {
      const res = response(await write(body));
      expect(res.status).toBe(400);
      expect(res.headers.get("vary")).toBe("Accept");
      expect(await res.text()).not.toContain(synthetic);
      expect(warn.mock.lastCall).toEqual([
        "profile.write.malformed_body",
        { exception, content_type: "application/json", request_id: REQUEST_ID },
      ]);
    }
    expect(save).not.toHaveBeenCalled();
    save.mockRejectedValueOnce(
      Object.assign(new Error(synthetic), { name: "PostgresError", code: "57014" }),
    );
    const cancelled = response(await write(JSON.stringify({ bio: synthetic, games: [] })));
    expect(cancelled.status).toBe(503);
    expect(cancelled.headers.get("vary")).toBe("Accept");
    expect(await cancelled.json()).toEqual({
      error: "profile_save_uncertain",
      message: PROFILE_COPY.saveUncertain,
      request_id: REQUEST_ID,
    });
    expect(save).toHaveBeenCalledOnce();
    find.mockRejectedValueOnce(new Error(synthetic));
    expect(response(await write("{}")).status).toBe(503);
    sessionGet.mockRejectedValueOnce(new Error(synthetic));
    expect(response(await write("{}")).status).toBe(503);
    for (const event of [
      "profile save failed",
      "Profile request failed; refusing contents.",
      "profiles could not resolve the session; refusing.",
    ]) {
      expect(error).toHaveBeenCalledWith(event, { exception: "Error", request_id: REQUEST_ID });
    }
    expect(JSON.stringify([...warn.mock.calls, ...error.mock.calls])).not.toContain(synthetic);
  });

  it("keeps a native form draft after a classified outage without retrying", async ({
    onTestFinished,
  }) => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    onTestFinished(() => {
      log.mockRestore();
    });
    const { write, save, store } = await fixture();
    const form = new URLSearchParams({ _method: "PATCH", bio: "Retained draft", timezone: "UTC" });
    save.mockRejectedValueOnce(Object.assign(new Error("failed"), { code: "ECONNRESET" }));
    const rejected = await write(form, "POST", { accept: "text/html" });
    expect(rejected).toMatchObject({
      status: 503,
      member: baseline,
      errors: { save: PROFILE_COPY.saveFailed },
      values: { bio: "Retained draft" },
    });
    expect(save).toHaveBeenCalledOnce();
    expect(store.rows.get(OWNER)).toEqual(baseline);
  });
});

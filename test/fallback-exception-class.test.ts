// Builder-owned: exception-class hardening for the X3 fallback warns.
// The throttle and moderator classifiers are name-derived (sibling
// queueExceptionClass precedent); these pin the two bounds that keep a
// hostile error name out of log shape: line breaks collapse to "_" and the
// value is capped at 100 chars, with empty falling back to "unknown".
// Hermetic: throwing store double + stubbed fetch, no database, no network.
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { recomputeModerator } from "../src/roles";
import type { Sql } from "../src/sessions";
import { type EnvWithThrottle, throttleGuard } from "../src/throttle";

const GUILD = "111111111111111111";
const USER_ID = "222222222222222222";
const BOT_TOKEN = "***synthetic-class-bound-bot-token***";
const ROLE_ID = "123456789012345678";

function probeApp(throttleStore: () => Promise<Sql | null>) {
  const app = new Hono<{ Bindings: EnvWithThrottle }>();
  app.get("/probe", async (c) => {
    const limited = await throttleGuard(c, "probe", 10);
    if (limited) return limited;
    return c.json({ limited: false });
  });
  return () =>
    app.request("/probe", { headers: { "cf-connecting-ip": "192.0.2.44" } }, {
      THROTTLE_STORE: throttleStore,
    } as unknown as EnvWithThrottle);
}

function namedError(name: string): Error {
  const err = new Error("synthetic class-bound marker");
  err.name = name;
  return err;
}

function modOpts() {
  return { guildId: GUILD, userId: USER_ID, botToken: BOT_TOKEN, moderatorRoleIds: [ROLE_ID] };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("fallback warn exception classes are log-safe", () => {
  it("throttle store throw collapses line breaks in the class", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const get = probeApp(async () => {
      throw namedError("Evil\nClass\rForge");
    });
    const res = await get();
    expect(res.status).toBe(200);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      "Throttle store failed; allowing the request.",
      expect.objectContaining({ throttle: "probe", exception: "Evil_Class_Forge" }),
    );
  });

  it("throttle store throw bounds an overlong class at 100 chars", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const get = probeApp(async () => {
      throw namedError("A".repeat(150));
    });
    const res = await get();
    expect(res.status).toBe(200);
    expect(warn).toHaveBeenCalledTimes(1);
    const payload = warn.mock.calls[0]?.[1] as { exception?: unknown };
    expect(payload.exception).toBe("A".repeat(100));
  });

  it("moderator transport throw collapses line breaks in the class", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(namedError("Evil\nClass")));
    await expect(recomputeModerator(modOpts())).resolves.toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("moderator recompute lookup transport failed", {
      exception: "Evil_Class",
      guild_id: GUILD,
    });
  });

  it("moderator transport throw maps an empty class to unknown", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(namedError("")));
    await expect(recomputeModerator(modOpts())).resolves.toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("moderator recompute lookup transport failed", {
      exception: "unknown",
      guild_id: GUILD,
    });
  });
});

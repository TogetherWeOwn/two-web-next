import { serializeSigned } from "hono/utils/cookie";
import { describe, expect, it, vi } from "vitest";
import type { AccessSink } from "../src/access-log";
import type { Env } from "../src/env";
import {
  PROFILE_COPY,
  PROFILE_HONEY_FIELD,
  PROFILE_MIN_FILL_MS,
  type ProfileWriteBody,
} from "../src/islands/contracts-member-profile";
import { patchProfileJson } from "../src/profiles/patch-core";
import { profilesApp } from "../src/profiles/routes";
import { createMemoryProfileStore } from "../src/profiles/store";
import { createMemorySessionStore, hashToken, newSessionToken } from "../src/sessions";

const OWNER = "111111111111111111";
const OTHER = "222222222222222222";
const VALID = { bio: " Do some good. ", games: ["Chess", "Chess"], leaderboard_opt_out: true };
const SAVED = { saved: true, message: PROFILE_COPY.saved };
const ENV = {
  APP_URL: "https://fixture.example.test",
  SESSION_SECRET: "synthetic-session-signing-material",
} as Env;

function editorBody(formOpenedAt: number): ProfileWriteBody {
  return {
    bio: " Do some good. ",
    games_text: "Chess\nChess",
    timezone: "",
    leaderboard_opt_out: true,
    website: "",
    formOpenedAt,
  };
}

type Role = "owner" | "non-owner" | "moderator" | "guest" | "non-member";

function fixture(role: Role, limited = false) {
  const viewerId = role === "owner" ? OWNER : OTHER;
  const store = createMemoryProfileStore([
    { id: OWNER, username: "member", bio: null, avatar: null, games: [], timezone: null },
  ]);
  const find = vi.spyOn(store, "find");
  const save = vi.spyOn(store, "save");
  const readJson = vi.fn<() => Promise<unknown>>(async () => VALID);
  const throttle = vi.fn(async (_bucket: string) =>
    limited ? ({ limited: true, retryAfter: 31 } as const) : ({ limited: false } as const),
  );
  const accessLog = vi.fn<AccessSink>(async () => true);
  const deps = {
    storeFor: vi.fn<() => Promise<typeof store | null>>(async () => store),
    admitMember: vi.fn<Parameters<typeof patchProfileJson>[2]["admitMember"]>(async () => {
      if (role === "guest") return { kind: "guest" };
      if (role === "non-member") return { kind: "forbidden" };
      return { kind: "member", id: viewerId };
    }),
    throttle,
  };

  // Wire the audit spy to the real Hono read boundary, not to the dormant core.
  async function hono(method: string, body: unknown = VALID) {
    const sessionStore = createMemorySessionStore();
    const headers = new Headers({ accept: "application/json", "content-type": "application/json" });
    if (role !== "guest") {
      const token = newSessionToken();
      await sessionStore.create({
        tokenHash: await hashToken(token),
        userId: viewerId,
        username: "viewer",
        avatar: null,
        member: role !== "non-member",
        moderator: role === "moderator",
        expiresAt: new Date(Date.now() + 60_000),
      });
      const signed = await serializeSigned("__Host-two_session", token, ENV.SESSION_SECRET, {
        path: "/",
        secure: true,
      });
      headers.set("cookie", signed.split(";")[0]!);
    }
    return profilesApp({
      sessionStore,
      store,
      stats: async () => null,
      accessLog,
      throttle,
    }).request(
      `/members/${OWNER}`,
      { method, headers, body: method === "PATCH" ? JSON.stringify(body) : undefined },
      ENV,
    );
  }
  return { viewerId, deps, find, save, readJson, accessLog, hono };
}

describe("dormant profile JSON PATCH core", () => {
  it("saves only the owner, with Hono's JSON success body and no member-read audit", async ({
    onTestFinished,
  }) => {
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    onTestFinished(() => {
      clock.mockRestore();
    });
    const body = editorBody(now - PROFILE_MIN_FILL_MS);
    for (const implementation of ["core", "hono"]) {
      const f = fixture("owner");
      if (implementation === "core") {
        f.readJson.mockResolvedValueOnce(body);
        expect(await patchProfileJson(OWNER, f.readJson, f.deps)).toEqual({
          kind: "saved",
          body: SAVED,
        });
        expect(f.deps.admitMember).toHaveBeenCalledBefore(f.deps.throttle);
        expect(f.deps.throttle).toHaveBeenCalledBefore(f.deps.storeFor);
        expect(f.deps.storeFor).toHaveBeenCalledBefore(f.find);
        expect(f.find).toHaveBeenCalledBefore(f.readJson);
        expect(f.readJson).toHaveBeenCalledBefore(f.save);
      } else {
        const response = await f.hono("PATCH", body);
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual(SAVED);
      }
      expect(f.deps.throttle).toHaveBeenCalledExactlyOnceWith(`profile-write:${OWNER}`);
      expect(f.find).toHaveBeenCalledExactlyOnceWith(OWNER);
      expect(f.save).toHaveBeenCalledExactlyOnceWith(OWNER, {
        bio: "Do some good.",
        games: ["Chess"],
        timezone: null,
        leaderboardOptOut: true,
      });
      expect(f.accessLog).not.toHaveBeenCalled();
    }
  });

  it("returns the same Hono success body without writing when the editor opens too recently", async () => {
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      const body = editorBody(now - PROFILE_MIN_FILL_MS + 1);
      const f = fixture("owner");
      f.readJson.mockResolvedValueOnce(body);
      expect(await patchProfileJson(OWNER, f.readJson, f.deps)).toEqual({
        kind: "saved",
        body: SAVED,
      });
      const response = await f.hono("PATCH", body);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(SAVED);
      expect(f.save).not.toHaveBeenCalled();
      expect(f.accessLog).not.toHaveBeenCalled();
    } finally {
      clock.mockRestore();
    }
  });

  it.each([
    ["guest", false, "guest", 401],
    ["non-member", false, "forbidden", 403],
    ["non-owner", false, "nonOwner", 403],
    ["moderator", false, "nonOwner", 403],
    ["non-owner", true, "limited", 429],
    ["owner", true, "limited", 429],
  ] as const)(
    "%s (limited=%s) is refused without touching body, store or audit",
    async (role, limited, kind, status) => {
      const f = fixture(role, limited);
      expect(await patchProfileJson(OWNER, f.readJson, f.deps)).toEqual(
        limited ? { kind, retryAfter: 31 } : { kind },
      );
      expect(f.deps.storeFor).not.toHaveBeenCalled();
      expect(f.readJson).not.toHaveBeenCalled();
      expect(f.deps.throttle.mock.calls).toEqual(
        role === "guest" || role === "non-member" ? [] : [[`profile-write:${f.viewerId}`]],
      );

      const live = fixture(role, limited);
      const response = await live.hono("PATCH");
      expect(live.deps.throttle.mock.calls).toEqual(f.deps.throttle.mock.calls);
      expect(response.status).toBe(status);
      if (limited) expect(response.headers.get("retry-after")).toBe("31");
      for (const candidate of [f, live]) {
        expect(candidate.find).not.toHaveBeenCalled();
        expect(candidate.save).not.toHaveBeenCalled();
        expect(candidate.accessLog).not.toHaveBeenCalled();
      }
    },
  );

  it.each(["GET", "HEAD"])("the Hono audit fixture records a cross-member %s", async (method) => {
    const f = fixture("non-owner");
    const response = await f.hono(method);
    expect(response.status).toBe(200);
    if (method === "HEAD") expect(await response.text()).toBe("");
    expect(f.accessLog).toHaveBeenCalledExactlyOnceWith({
      viewerDiscordId: OTHER,
      viewerUserId: OTHER,
      resource: "profile",
      action: "view",
      subjectUserIds: [OWNER],
      route: "profiles.show",
    });
    const self = fixture("owner");
    expect((await self.hono(method)).status).toBe(200);
    expect(self.accessLog).not.toHaveBeenCalled();
  });

  it.each([
    [{ bio: "No list" }, "invalid"],
    [{ ...VALID, user_id: OTHER }, "invalid"],
    [{ [PROFILE_HONEY_FIELD]: "filled" }, "invalid"],
    [{ ...VALID, [PROFILE_HONEY_FIELD]: "filled" }, "saved"],
  ])("rejects an invalid body or swallows a trapped write: %j → %s", async (body, kind) => {
    const f = fixture("owner");
    f.readJson.mockResolvedValue(body);
    const result = await patchProfileJson(OWNER, f.readJson, f.deps);
    expect(result.kind).toBe(kind);
    if (kind === "saved") expect(result).toEqual({ kind, body: SAVED });
    expect(f.save).not.toHaveBeenCalled();
  });

  it.each([[null], [[]], [42]])(
    "reports a parsed non-object body (%j) without saving",
    async (body) => {
      const f = fixture("owner");
      f.readJson.mockResolvedValueOnce(body);
      expect(await patchProfileJson(OWNER, f.readJson, f.deps)).toEqual({
        kind: "badRequest",
        reason: "nonObjectJson",
      });
      expect(f.save).not.toHaveBeenCalled();
    },
  );

  it("reports a JSON parser failure without returning the exception or saving", async () => {
    const f = fixture("owner");
    f.readJson.mockRejectedValue(new SyntaxError());
    expect(await patchProfileJson(OWNER, f.readJson, f.deps)).toEqual({
      kind: "badRequest",
      reason: "invalidJson",
    });
    expect(f.save).not.toHaveBeenCalled();
  });

  it("propagates a save failure without retrying or reporting success", async () => {
    const f = fixture("owner");
    const failure = new Error("fixture save failed");
    f.save.mockRejectedValueOnce(failure);
    await expect(patchProfileJson(OWNER, f.readJson, f.deps)).rejects.toBe(failure);
    expect(f.save).toHaveBeenCalledOnce();
  });

  it("stops before the throttle when admission is unavailable", async () => {
    const f = fixture("owner");
    f.deps.admitMember.mockResolvedValueOnce({ kind: "unavailable" });
    expect(await patchProfileJson(OWNER, f.readJson, f.deps)).toEqual({ kind: "unavailable" });
    expect(f.deps.throttle).not.toHaveBeenCalled();
    expect(f.deps.storeFor).not.toHaveBeenCalled();
    expect(f.readJson).not.toHaveBeenCalled();
  });

  it("does not parse a body when the admitted owner's store or row is missing", async () => {
    const f = fixture("owner");
    f.deps.storeFor.mockResolvedValueOnce(null);
    expect(await patchProfileJson(OWNER, f.readJson, f.deps)).toEqual({ kind: "unavailable" });
    f.find.mockResolvedValueOnce(null);
    expect(await patchProfileJson(OWNER, f.readJson, f.deps)).toEqual({ kind: "notFound" });
    expect(f.readJson).not.toHaveBeenCalled();
    expect(f.save).not.toHaveBeenCalled();
  });
});

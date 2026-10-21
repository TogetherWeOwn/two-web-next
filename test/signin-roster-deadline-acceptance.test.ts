// A pending optional roster write must not withhold mandatory sign-in. The 5s
// observer is the existing optional analytics safety envelope, not a latency SLO.
// The real-DB companion proves SQL cancellation and scoped settings; this seam
// deliberately cannot make progress on its own (driver/transport stall).
import { setTimeout as realSleep } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemorySessionStore, hashToken, type Sql } from "../src/sessions";
import {
  bearer,
  CALLERS,
  expectIssued,
  identity,
  latch,
  prepareSignin,
  priorSession,
  signinEnv,
  stubSigninDiscord,
} from "./helpers/signin-roster";

const MAX_OPTIONAL_WAIT_MS = 5_000;
const ERROR_PROBE = "roster-error-message-must-not-escape";

function rosterFixture(mode: "held" | "healthy" | "reject") {
  const entered = latch<void>();
  const gate = latch<void>();
  const rows = new Map<string, unknown>();
  const writes: { text: string; values: unknown[] }[] = [];
  let cancelled = false;
  if (mode === "healthy") gate.resolve();
  if (mode === "reject") gate.reject(new Error(ERROR_PROBE));
  // Observe even a pre-rejected fixture before the route reaches it.
  void gate.promise.catch(() => {});
  const query = (text: string, values: unknown[] = []) => {
    if (/insert\s+into\s+users\b/i.test(text)) {
      writes.push({ text, values });
      entered.resolve();
      const pending = gate.promise.then(() => {
        if (!cancelled) {
          const [id, username, avatar, member] = values;
          rows.set(String(id), { id, username, avatar, member });
        }
        return [];
      });
      return Object.assign(pending, {
        cancel: () => {
          cancelled = true;
          gate.reject(new Error(ERROR_PROBE));
        },
      });
    }
    if (
      /^(\s*)(set\b|select\s+(set_config|current_setting)\b|begin\b|commit\b|rollback\b)/i.test(
        text,
      )
    )
      return Promise.resolve([]);
    throw new Error(`Unexpected roster fixture SQL: ${text}`);
  };
  const sql = Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]) => query(strings.join("?"), values),
    {
      unsafe: query,
      begin: async (...args: unknown[]) => {
        const fn = args.find((arg) => typeof arg === "function") as (
          tx: unknown,
        ) => Promise<unknown>;
        return fn(sql);
      },
      reserve: async () => sql,
      release: vi.fn(),
      end: vi.fn(async () => {}),
    },
  );
  return { sql: sql as unknown as Sql, end: sql.end, entered, gate, rows, writes };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe.each(CALLERS)("%s optional roster issuance", (caller) => {
  it("issues the normal session after the application deadline while the optional query is still parked", async () => {
    const roster = rosterFixture("held");
    const store = createMemorySessionStore();
    const prior = await priorSession(store);
    const env = signinEnv({ SESSION_STORE: store, ROSTER_STORE: roster.sql });
    const calls = stubSigninDiscord();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const invoke = await prepareSignin(caller, env, prior.cookie);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    let observed: Response | undefined;
    const response = invoke().then((value) => {
      observed = value;
      return value;
    });
    try {
      await roster.entered.promise;
      await vi.advanceTimersByTimeAsync(MAX_OPTIONAL_WAIT_MS);
      // Token hashing and cookie signing run on real WebCrypto, not the clock.
      for (let i = 0; i < 20 && !observed; i++) await realSleep(5);
      expect(
        observed,
        "optional roster wait still withheld session issuance after 5s",
      ).toBeDefined();
      await expectIssued(observed!, caller, store);
      expect(await store.get(prior.hash)).toBeNull();
      expect(roster.writes).toHaveLength(1);
      expect(roster.rows.size).toBe(0);
      expect(roster.end).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith("roster upsert failed", {
        request_id: observed!.headers.get("X-Request-ID"),
        exception: expect.any(String),
      });
      expect(JSON.stringify(warn.mock.calls)).not.toContain(ERROR_PROBE);
      expect(calls).toHaveLength(caller === "qa" ? 0 : 4);
      const callsAtResponse = [...calls];
      // A late failure is observed, not retried and not a second issuance.
      roster.gate.reject(new Error(ERROR_PROBE));
      await realSleep(10);
      expect(calls).toEqual(callsAtResponse);
      expect(roster.writes).toHaveLength(1);
      expect(JSON.stringify(warn.mock.calls)).not.toContain(ERROR_PROBE);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      // Settle the original work even on RED; no orphan crosses fake-clock tests.
      roster.gate.resolve();
      vi.useRealTimers();
      await response;
    }
  });

  it("waits for healthy completion inside the deadline and refreshes the same row before session creation", async () => {
    const roster = rosterFixture("held");
    const expected = identity(caller);
    roster.rows.set(expected.userId, {
      id: expected.userId,
      username: "Old name",
      avatar: "old",
      member: false,
    });
    const base = createMemorySessionStore();
    let creates = 0;
    const store = {
      ...base,
      create: async (row: Parameters<typeof base.create>[0]) => {
        creates++;
        expect(roster.rows.get(expected.userId)).toEqual({
          id: expected.userId,
          username: expected.username,
          avatar: expected.avatar,
          member: true,
        });
        await base.create(row);
      },
    };
    const invoke = await prepareSignin(
      caller,
      signinEnv({ SESSION_STORE: store, ROSTER_STORE: roster.sql }),
    );
    stubSigninDiscord();
    let finished = false;
    const response = invoke().then((value) => {
      finished = true;
      return value;
    });
    try {
      await roster.entered.promise;
      await realSleep(10);
      expect(finished).toBe(false);
      expect(creates).toBe(0);
    } finally {
      roster.gate.resolve();
    }
    await expectIssued(await response, caller, store);
    expect(creates).toBe(1);
    expect(roster.rows.size).toBe(1);
    expect(roster.writes).toHaveLength(1);
    expect(roster.writes[0]!.values).toEqual([
      expected.userId,
      expected.username,
      expected.avatar,
      true,
    ]);
    expect(roster.writes[0]!.text).not.toMatch(/moderator/i);
    expect(roster.end).not.toHaveBeenCalled();
  });

  it("warns safely on immediate optional rejection without changing cookies or replacement", async () => {
    const roster = rosterFixture("reject");
    const store = createMemorySessionStore();
    const prior = await priorSession(store);
    stubSigninDiscord();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const invoke = await prepareSignin(
      caller,
      signinEnv({ SESSION_STORE: store, ROSTER_STORE: roster.sql }),
      prior.cookie,
    );
    const response = await invoke();
    await expectIssued(response, caller, store);
    expect(await store.get(prior.hash)).toBeNull();
    expect(roster.rows.size).toBe(0);
    expect(roster.end).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith("roster upsert failed", {
      request_id: response.headers.get("X-Request-ID"),
      exception: "Error",
    });
    expect(JSON.stringify(warn.mock.calls)).not.toContain(ERROR_PROBE);
  });

  it.each(["create", "replace"] as const)(
    "does not swallow a mandatory %s failure after the optional deadline",
    async (method) => {
      const roster = rosterFixture("held");
      const base = createMemorySessionStore();
      const prior = method === "replace" ? await priorSession(base) : null;
      let attempts = 0;
      const store = {
        ...base,
        [method]: async () => {
          attempts++;
          throw new Error("mandatory-session-failure");
        },
      };
      stubSigninDiscord();
      vi.spyOn(console, "error").mockImplementation(() => {});
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const invoke = await prepareSignin(
        caller,
        signinEnv({ SESSION_STORE: store, ROSTER_STORE: roster.sql }),
        prior?.cookie,
      );
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      let observed: Response | undefined;
      const pending = invoke().then((response) => {
        observed = response;
        return response;
      });
      try {
        await roster.entered.promise;
        await vi.advanceTimersByTimeAsync(MAX_OPTIONAL_WAIT_MS);
        for (let i = 0; i < 20 && !observed; i++) await realSleep(5);
        expect(observed, "mandatory failure must settle after optional timeout").toBeDefined();
        expect(observed!.status).toBe(500);
        expect(attempts).toBe(1);
        expect(
          observed!.headers
            .getSetCookie()
            .some((cookie) => /^__Host-two_(session|session_status)=/.test(cookie)),
        ).toBe(false);
        expect(observed!.headers.get("location")).toBeNull();
        if (prior) expect(await base.get(prior.hash)).not.toBeNull();
        expect(roster.end).not.toHaveBeenCalled();
      } finally {
        roster.gate.resolve();
        vi.useRealTimers();
        await pending;
      }
    },
  );

  it.each(["create", "replace"] as const)(
    "keeps a mandatory session %s failure fail-closed",
    async (method) => {
      const roster = rosterFixture("healthy");
      const base = createMemorySessionStore();
      const prior = method === "replace" ? await priorSession(base) : null;
      const store = {
        ...base,
        [method]: async () => {
          throw new Error("mandatory-session-failure");
        },
      };
      stubSigninDiscord();
      vi.spyOn(console, "error").mockImplementation(() => {});
      const invoke = await prepareSignin(
        caller,
        signinEnv({ SESSION_STORE: store, ROSTER_STORE: roster.sql }),
        prior?.cookie,
      );
      const response = await invoke();
      expect(response.status).toBe(500);
      expect(
        response.headers
          .getSetCookie()
          .some((cookie) => /^__Host-two_(session|session_status)=/.test(cookie)),
      ).toBe(false);
      expect(response.headers.get("location")).toBeNull();
      if (prior) expect(await base.get(prior.hash)).not.toBeNull();
      expect(roster.rows.size).toBe(1);
      expect(roster.end).not.toHaveBeenCalled();
    },
  );
});

it.each([
  { joinStatus: 201, member: true, redirect: "/profile" },
  { joinStatus: 403, member: false, redirect: "/?n=join_failed" },
])(
  "OAuth keeps provider membership=$member and denies moderator without matching roles",
  async ({ joinStatus, member, redirect }) => {
    const roster = rosterFixture("healthy");
    const store = createMemorySessionStore();
    const env = signinEnv({ SESSION_STORE: store, ROSTER_STORE: roster.sql });
    stubSigninDiscord(joinStatus, []);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const invoke = await prepareSignin("oauth", env);
    const response = await invoke();
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(redirect);
    expect(await store.get(await hashToken(bearer(response)))).toEqual({
      userId: "42",
      username: "Roster Member",
      avatar: "avatar-new",
      member,
      moderator: false,
    });
    expect(roster.rows.get("42")).toEqual({
      id: "42",
      username: "Roster Member",
      avatar: "avatar-new",
      member,
    });
    expect(roster.writes[0]!.text).not.toMatch(/moderator/i);
  },
);

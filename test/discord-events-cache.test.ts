import { describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import {
  cachedDiscordEventsSource,
  liveDiscordEventsSource,
  type DiscordEventsSource,
} from "../src/events/discord-transients";
import {
  DISCORD_CACHE_FRESH_MS,
  DISCORD_CACHE_STALE_MS,
  DISCORD_FAILURE_HOLD_MS,
  DISCORD_REFRESH_LEASE_MS,
  DISCORD_SNAPSHOT_CLEANUP_BATCH,
  DISCORD_SNAPSHOT_MAX_KEYS,
  DISCORD_SNAPSHOT_MAX_ROWS,
  DISCORD_SNAPSHOT_MAX_BYTES,
  discordSnapshotKey,
  encodeDiscordSnapshot,
  decodeDiscordSnapshot,
} from "../src/events/discord-snapshot";
import type { DiscordTransient } from "../src/islands/contracts";
import {
  discordSnapshotBoundaryRows,
  memoryDiscordBacking,
  memoryDiscordStore,
} from "./helpers/discord-snapshot-store";

const env = { APP_URL: "https://calendar.example", DISCORD_GUILD_ID: "123" } as Env;
const row = (id = "1"): DiscordTransient => ({
  discordId: id,
  status: "scheduled",
  title: `Event ${id}`,
  description: null,
  location: null,
  startsAt: new Date("2030-01-02T20:00:00Z"),
  endsAt: new Date("2030-01-02T21:00:00Z"),
});
function harness(script: Array<DiscordTransient[] | "fail">, retryAfter?: number) {
  let now = 1_000_000;
  const backing = memoryDiscordBacking(() => now);
  let calls = 0,
    failed = false;
  const inner: DiscordEventsSource = {
    lastReadFailed: () => failed,
    lastReadFailure: () => (failed ? { reason: "status", status: 429, retryAfter } : null),
    async upcoming() {
      const value = script[Math.min(calls++, script.length - 1)] ?? "fail";
      failed = value === "fail";
      return value === "fail" ? [] : value;
    },
  };
  const request = async (bindings = env) => {
    const source = cachedDiscordEventsSource(bindings, inner, memoryDiscordStore(backing));
    const rows = await source.upcoming();
    return { rows, failed: source.lastReadFailed() };
  };
  return {
    backing,
    inner,
    request,
    calls: () => calls,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("shared Discord snapshots", () => {
  it.each([{ rows: [] }, { rows: [row()] }])(
    "retains a successful snapshot across independent request stores",
    async ({ rows }) => {
      const h = harness([rows, "fail"]);
      expect(await h.request()).toEqual({ rows, failed: false });
      h.advance(DISCORD_CACHE_FRESH_MS - 1);
      expect(await h.request()).toEqual({ rows, failed: false });
      expect(h.calls()).toBe(1);
      h.advance(1);
      expect(await h.request()).toEqual({ rows, failed: false });
      expect(h.calls()).toBe(2);
    },
  );
  it("refreshes at exactly 60 seconds", async () => {
    const h = harness([[row("1")], [row("2")]]);
    await h.request();
    h.advance(DISCORD_CACHE_FRESH_MS);
    expect((await h.request()).rows[0]!.discordId).toBe("2");
  });
  it("never extends successful age on failure and expires at 600, not 660 seconds", async () => {
    const h = harness([[row()], "fail"], 1000);
    await h.request();
    h.advance(DISCORD_CACHE_FRESH_MS);
    expect((await h.request()).failed).toBe(false);
    h.advance(DISCORD_CACHE_STALE_MS - DISCORD_CACHE_FRESH_MS - 1);
    expect((await h.request()).failed).toBe(false);
    h.advance(1);
    expect(await h.request()).toEqual({ rows: [], failed: true });
    expect(h.calls()).toBe(2);
    expect(h.backing.entries.get(discordSnapshotKey(env))!.succeededAt).toBe(1_000_000);
  });
  it.each([undefined, NaN, -1, Infinity, 0, 1])(
    "honors the default hold for retry %s",
    async (retry) => {
      const h = harness(["fail", []], retry);
      expect((await h.request()).failed).toBe(true);
      h.advance(DISCORD_FAILURE_HOLD_MS - 1);
      expect((await h.request()).failed).toBe(true);
      expect(h.calls()).toBe(1);
      h.advance(1);
      expect((await h.request()).failed).toBe(false);
      expect(h.calls()).toBe(2);
    },
  );
  it("honors a propagated longer numeric 429 retry", async () => {
    const h = harness(["fail", []], 35.25);
    await h.request();
    h.advance(35_249);
    await h.request();
    expect(h.calls()).toBe(1);
    h.advance(1);
    expect((await h.request()).failed).toBe(false);
    expect(h.calls()).toBe(2);
  });
  it("keys by configured origin and guild, never token, search or caller", async () => {
    const h = harness([[row("a")], [row("b")], [row("c")]]);
    expect((await h.request()).rows[0]!.discordId).toBe("a");
    expect((await h.request({ ...env, DISCORD_BOT_TOKEN: "changed" })).rows[0]!.discordId).toBe(
      "a",
    );
    expect(
      (await h.request({ ...env, APP_URL: "https://another.example" })).rows[0]!.discordId,
    ).toBe("b");
    expect((await h.request({ ...env, DISCORD_GUILD_ID: "456" })).rows[0]!.discordId).toBe("c");
    expect(discordSnapshotKey(env)).not.toContain("changed");
  });
  it.each(["https://user:pass@calendar.example", "https://calendar.example/path", "not-a-url"])(
    "refuses an invalid configured origin",
    async (APP_URL) => {
      const h = harness([[]]);
      expect((await h.request({ ...env, APP_URL })).failed).toBe(true);
      expect(h.calls()).toBe(0);
    },
  );
  it("reconstructs caller arrays, objects and both Dates independently", async () => {
    const original = row();
    const h = harness([[original]]);
    const first = await h.request();
    original.title = "input mutation";
    original.startsAt.setTime(0);
    first.rows[0]!.title = "caller mutation";
    first.rows[0]!.startsAt.setTime(0);
    first.rows[0]!.endsAt!.setTime(0);
    first.rows.length = 0;
    expect((await h.request()).rows).toEqual([row()]);
  });
  it("serves stale immediately to a losing refresh caller, without awaiting owner I/O", async () => {
    const h = harness([[row()]]);
    await h.request();
    h.advance(DISCORD_CACHE_FRESH_MS);
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const owner = cachedDiscordEventsSource(
      env,
      {
        upcoming: async () => {
          await gate;
          return [row("2")];
        },
        lastReadFailed: () => false,
      },
      memoryDiscordStore(h.backing),
    );
    const pending = owner.upcoming();
    const loser = vi.fn(async () => []);
    const source = cachedDiscordEventsSource(
      env,
      { upcoming: loser, lastReadFailed: () => true },
      memoryDiscordStore(h.backing),
    );
    expect(await source.upcoming()).toEqual([row()]);
    expect(source.lastReadFailed()).toBe(false);
    expect(loser).not.toHaveBeenCalled();
    release();
    expect(await pending).toEqual([row("2")]);
  });
  it.each([true, false])(
    "fences late %s success/failure against a replacement lease and snapshot",
    async (success) => {
      const h = harness([[]]);
      const key = discordSnapshotKey(env);
      const a = memoryDiscordStore(h.backing),
        b = memoryDiscordStore(h.backing);
      const old = await a.claim(key);
      h.advance(DISCORD_REFRESH_LEASE_MS);
      const next = await b.claim(key);
      expect(next.token).not.toBe(old.token);
      await a.complete(
        key,
        old.token!,
        success ? { payload: encodeDiscordSnapshot([row("old")]) } : { retryMs: 30_000 },
      );
      expect(h.backing.entries.get(key)!.token).toBe(next.token);
      await b.complete(key, next.token!, { payload: encodeDiscordSnapshot([row("new")]) });
      await a.complete(
        key,
        old.token!,
        success ? { payload: encodeDiscordSnapshot([row("old")]) } : { retryMs: 30_000 },
      );
      expect((await h.request()).rows).toEqual([row("new")]);
      expect(h.backing.entries.get(key)!.retryAt).toBe(0);
    },
  );
  it("does not publish even when an expired owner is not yet replaced", async () => {
    const h = harness([[]]);
    const store = memoryDiscordStore(h.backing),
      key = discordSnapshotKey(env);
    const claim = await store.claim(key);
    h.advance(DISCORD_REFRESH_LEASE_MS);
    await store.complete(key, claim.token!, { payload: "[]" });
    expect(h.backing.entries.get(key)!.payload).toBeNull();
  });
  it("does not fall back to Discord on store failures or corruption", async () => {
    const h = harness([[]]);
    const source = cachedDiscordEventsSource(env, h.inner, {
      claim: async () => {
        throw new Error("private DSN");
      },
      complete: async () => {
        throw new Error();
      },
    });
    expect(await source.upcoming()).toEqual([]);
    expect(source.lastReadFailed()).toBe(true);
    expect(h.calls()).toBe(0);
    await h.request();
    h.backing.entries.get(discordSnapshotKey(env))!.payload = [{ raw: "corruption" }];
    expect((await h.request()).failed).toBe(true);
    expect(h.calls()).toBe(1);
  });
  it.each([{ rows: [] }, { rows: [row()] }])(
    "serves successful live rows when completion storage fails",
    async ({ rows }) => {
      const h = harness([rows]),
        store = memoryDiscordStore(h.backing);
      const source = cachedDiscordEventsSource(env, h.inner, {
        claim: store.claim,
        complete: async () => {
          throw new Error();
        },
      });
      expect(await source.upcoming()).toEqual(rows);
      expect(source.lastReadFailed()).toBe(false);
      expect(h.calls()).toBe(1);
    },
  );
  it("logs only an allowlisted SQLSTATE when completion storage fails", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      const h = harness([[row()]]),
        store = memoryDiscordStore(h.backing);
      const source = cachedDiscordEventsSource(env, h.inner, {
        claim: store.claim,
        complete: async () => {
          throw Object.assign(new Error("private DSN"), { code: "55P03" });
        },
      });
      expect(await source.upcoming()).toEqual([row()]);
      expect(source.lastReadFailed()).toBe(false);
      expect(info).toHaveBeenNthCalledWith(
        1,
        "Discord snapshot outcome",
        expect.objectContaining({ completionFailed: true, code: "55P03" }),
      );

      const unsafe = harness([[row()]]),
        unsafeStore = memoryDiscordStore(unsafe.backing);
      const unsafeSource = cachedDiscordEventsSource(env, unsafe.inner, {
        claim: unsafeStore.claim,
        complete: async () => {
          throw Object.assign(new Error("private DSN"), { code: "P0001" });
        },
      });
      expect(await unsafeSource.upcoming()).toEqual([row()]);
      expect(info.mock.calls[1]?.[1]).not.toHaveProperty("code");
      expect(JSON.stringify(info.mock.calls)).not.toContain("private DSN");
    } finally {
      info.mockRestore();
    }
  });
  it("uses a usable stale snapshot when completion storage fails after a read failure", async () => {
    const stale = [row("stale")],
      h = harness([stale, "fail"]),
      store = memoryDiscordStore(h.backing);
    let completions = 0;
    const source = cachedDiscordEventsSource(env, h.inner, {
      claim: store.claim,
      complete: async (...args) => {
        if (++completions === 2) throw new Error();
        return store.complete(...args);
      },
    });
    expect(await source.upcoming()).toEqual(stale);
    h.advance(DISCORD_CACHE_FRESH_MS);
    expect(await source.upcoming()).toEqual(stale);
    expect(source.lastReadFailed()).toBe(false);
    expect(h.calls()).toBe(2);
  });
  it("does not count claim latency twice when rechecking stale age", async () => {
    vi.useFakeTimers();
    try {
      const stale = [row("stale")],
        h = harness([stale]),
        store = memoryDiscordStore(h.backing);
      await h.request();
      h.advance(DISCORD_CACHE_STALE_MS - 600);
      let failed = false;
      const source = cachedDiscordEventsSource(
        env,
        {
          lastReadFailed: () => failed,
          async upcoming() {
            await new Promise<void>((resolve) => setTimeout(resolve, 200));
            h.advance(200);
            failed = true;
            return [];
          },
        },
        {
          claim: async (key) => {
            await new Promise<void>((resolve) => setTimeout(resolve, 300));
            h.advance(300);
            return store.claim(key);
          },
          complete: async () => {
            throw new Error();
          },
        },
      );
      const pending = source.upcoming();
      await vi.advanceTimersByTimeAsync(500);
      expect(await pending).toEqual(stale);
      expect(source.lastReadFailed()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
  it("includes post-sample claim completion latency in stale-age checks", async () => {
    vi.useFakeTimers();
    try {
      const stale = [row("stale")],
        h = harness([stale, "fail"]),
        store = memoryDiscordStore(h.backing);
      await h.request();
      h.advance(DISCORD_CACHE_STALE_MS - 10);
      const source = cachedDiscordEventsSource(env, h.inner, {
        claim: async (key) => {
          const claim = await store.claim(key);
          await new Promise<void>((resolve) => setTimeout(resolve, 20));
          h.advance(20);
          return claim;
        },
        complete: async () => {
          throw new Error();
        },
      });
      const pending = source.upcoming();
      await vi.advanceTimersByTimeAsync(20);
      expect(await pending).toEqual([]);
      expect(source.lastReadFailed()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
  it("fails closed to stale data when completion fails without a claim clock anchor", async () => {
    vi.useFakeTimers();
    try {
      const stale = [row("stale")],
        h = harness([stale, "fail"]),
        store = memoryDiscordStore(h.backing);
      await h.request();
      h.advance(DISCORD_CACHE_STALE_MS - 500);
      const source = cachedDiscordEventsSource(env, h.inner, {
        claim: async (key) => {
          const claim = await store.claim(key);
          delete claim.nowQueryStartedAt;
          await new Promise<void>((resolve) => setTimeout(resolve, 500));
          h.advance(500);
          return claim;
        },
        complete: async () => {
          throw new Error();
        },
      });
      const pending = source.upcoming();
      await vi.advanceTimersByTimeAsync(500);
      expect(await pending).toEqual([]);
      expect(source.lastReadFailed()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
  it("serves live rows when completion fails without a claim clock anchor", async () => {
    const rows = [row()],
      h = harness([rows]),
      store = memoryDiscordStore(h.backing);
    const source = cachedDiscordEventsSource(env, h.inner, {
      claim: async (key) => {
        const claim = await store.claim(key);
        delete claim.nowQueryStartedAt;
        return claim;
      },
      complete: async () => {
        throw new Error();
      },
    });
    expect(await source.upcoming()).toEqual(rows);
    expect(source.lastReadFailed()).toBe(false);
  });
  it("reports failure when completion fails and neither live nor stale data are available", async () => {
    const h = harness(["fail"]),
      store = memoryDiscordStore(h.backing);
    const source = cachedDiscordEventsSource(env, h.inner, {
      claim: store.claim,
      complete: async () => {
        throw new Error();
      },
    });
    expect(await source.upcoming()).toEqual([]);
    expect(source.lastReadFailed()).toBe(true);
  });
  it("bounds new-key admission and cleanup without deleting live leases or holds", async () => {
    const h = harness([[]]);
    const store = memoryDiscordStore(h.backing);
    for (let i = 0; i < DISCORD_SNAPSHOT_MAX_KEYS; i++) await store.claim(`key-${i}`);
    await expect(store.claim("over-capacity")).rejects.toThrow();
    h.advance(DISCORD_REFRESH_LEASE_MS);
    await store.complete("key-0", (await store.claim("key-0")).token!, { retryMs: 60_000 });
    await store.claim("new-key");
    expect(h.backing.entries.size).toBe(
      DISCORD_SNAPSHOT_MAX_KEYS - DISCORD_SNAPSHOT_CLEANUP_BATCH + 1,
    );
    expect(h.backing.entries.has("key-0")).toBe(true);
  });
  it.each([["active"], { value: "active" }, 1, null].map((status) => ({ status })))(
    "rejects a corrupt non-string status $status",
    ({ status }) => {
      const payload = JSON.parse(encodeDiscordSnapshot([row()]));
      payload[0].status = status;
      expect(() => decodeDiscordSnapshot(payload)).toThrow();
    },
  );
  it.each([
    { label: "NUL ID", overrides: { id: "bad\u0000" } },
    { label: "unpaired ID", overrides: { id: "bad\ud800" } },
    { label: "long ID", overrides: { id: "x".repeat(65) } },
    { label: "NUL title", overrides: { name: "bad\u0000" } },
    { label: "high surrogate title", overrides: { name: "bad\ud800" } },
    { label: "low surrogate title", overrides: { name: "bad\udc00" } },
    { label: "long title", overrides: { name: "x".repeat(257) } },
    { label: "unpaired description", overrides: { description: "bad\ud800" } },
    { label: "long description", overrides: { description: "x".repeat(4001) } },
    { label: "NUL location", overrides: { entity_metadata: { location: "bad\u0000" } } },
    { label: "unpaired location", overrides: { entity_metadata: { location: "bad\udc00" } } },
    { label: "long location", overrides: { entity_metadata: { location: "x".repeat(1001) } } },
  ])("drops a live $label row without suppressing its healthy sibling", async ({ overrides }) => {
    const raw = {
      id: "healthy",
      name: "Healthy",
      status: 1,
      scheduled_start_time: "2030-01-02T20:00:00Z",
    };
    const http = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(
        async () => new Response(JSON.stringify([raw, { ...raw, id: "bad", ...overrides }])),
      );
    try {
      const backing = memoryDiscordBacking(() => 1_000_000);
      const source = cachedDiscordEventsSource(
        env,
        liveDiscordEventsSource(env),
        memoryDiscordStore(backing),
      );
      const result = await source.upcoming(new Date("2030-01-01T00:00:00Z"));
      expect(result.map((r) => r.discordId)).toEqual(["healthy"]);
      expect(source.lastReadFailed()).toBe(false);
      expect(http).toHaveBeenCalledTimes(1);
    } finally {
      http.mockRestore();
    }
  });
  it.each(["\ud800", "\udc00", "\udc00\ud800", "\ud800x\udc00"])(
    "refuses unpaired UTF-16 before storage and shares a hold on stale refresh failure",
    async (title) => {
      expect(() => encodeDiscordSnapshot([{ ...row(), title }])).toThrow();
      const corrupt = JSON.parse(encodeDiscordSnapshot([row()]));
      corrupt[0].description = title;
      expect(() => decodeDiscordSnapshot(corrupt)).toThrow();
      const h = harness([[row()], [{ ...row("bad"), title }]]);
      await h.request();
      h.advance(DISCORD_CACHE_FRESH_MS);
      expect(await h.request()).toEqual({ rows: [row()], failed: false });
      const entry = h.backing.entries.get(discordSnapshotKey(env))!;
      expect(entry.succeededAt).toBe(1_000_000);
      expect(entry.retryAt).toBe(1_000_000 + DISCORD_CACHE_FRESH_MS + DISCORD_FAILURE_HOLD_MS);
    },
  );
  it("accepts well-formed astral, combining and escaped display strings", () => {
    const input = {
      ...row(),
      title: "Launch 🚀 é",
      description: 'quotes " backslash \\ tab\t newline\n',
      location: "東京",
    };
    expect(decodeDiscordSnapshot(JSON.parse(encodeDiscordSnapshot([input])))).toEqual([input]);
  });
  it("reserves jsonb separator overhead at the exact stored byte boundary", () => {
    const rows = discordSnapshotBoundaryRows();
    const encoded = encodeDiscordSnapshot(rows);
    expect(new TextEncoder().encode(encoded).byteLength).toBe(
      DISCORD_SNAPSHOT_MAX_BYTES - (14 * rows.length - 1),
    );
    rows[0]!.title += "x";
    expect(new TextEncoder().encode(JSON.stringify(rows)).byteLength).toBeLessThan(
      DISCORD_SNAPSHOT_MAX_BYTES,
    );
    expect(() => encodeDiscordSnapshot(rows)).toThrow();
    expect(() => decodeDiscordSnapshot(JSON.parse(JSON.stringify(rows)))).toThrow();
  });
  it("bounds payloads and admits only serialized display fields", () => {
    expect(() =>
      encodeDiscordSnapshot(Array.from({ length: DISCORD_SNAPSHOT_MAX_ROWS + 1 }, () => row())),
    ).toThrow();
    expect(() =>
      encodeDiscordSnapshot([{ ...row(), description: "x".repeat(DISCORD_SNAPSHOT_MAX_BYTES) }]),
    ).toThrow();
    expect(() =>
      decodeDiscordSnapshot([
        { ...JSON.parse(encodeDiscordSnapshot([row()]))[0], token: "hidden" },
      ]),
    ).toThrow();
    expect(
      JSON.parse(encodeDiscordSnapshot([{ ...row(), token: "hidden" } as DiscordTransient]))[0],
    ).not.toHaveProperty("token");
    expect(() =>
      decodeDiscordSnapshot([
        { ...JSON.parse(encodeDiscordSnapshot([row()]))[0], startsAt: "invalid" },
      ]),
    ).toThrow();
  });
});

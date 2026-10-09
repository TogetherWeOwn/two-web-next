import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createBotClient } from "../src/bot/client";
import { observeDiscordEvent, signedEventReader } from "../src/bot/event-read";
import { BotTransportError } from "../src/jobs/types";
import { DeliveryMute, createTailWorker } from "../tail/worker";

// The Workers runtime throws on fetch(..., { redirect: "error" }) ("won't be implemented"), so a
// Worker-side call written that way fails on every request while unit tests with stubbed fetch pass.
// Node-run scripts (bin/, ci/) may keep "error"; code that ships in a Worker must use "manual".
const WORKER_ROOTS = ["src", "tail"];
const ERROR_MODE = /redirect\s*:\s*["']error["']/;
const MANUAL_MODE = /redirect\s*:\s*["']manual["']/;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    return /\.(ts|js|mjs)$/.test(name) ? [path] : [];
  });
}

describe("Worker fetch redirect mode", () => {
  it('never uses redirect: "error" in code that runs on Workers', () => {
    const offenders = WORKER_ROOTS.flatMap(files).filter((f) =>
      ERROR_MODE.test(readFileSync(f, "utf8")),
    );
    expect(offenders).toEqual([]);
  });
});

// Every Worker call site fixed for the redirect-"error" throw must keep an explicit
// `redirect: "manual"`. The error-mode guard above stays green when the option is deleted
// entirely (a revert to the default "follow"), so pin the option's presence per file: dropping
// any one of these lines fails the matching assertion below.
const PINNED_MANUAL_SITES = [
  { file: "src/bot/client.ts", minManual: 1 },
  { file: "src/bot/event-read.ts", minManual: 1 },
  { file: "tail/worker.ts", minManual: 3 },
] as const;

describe("Worker redirect-manual pin", () => {
  for (const { file, minManual } of PINNED_MANUAL_SITES) {
    it(`keeps an explicit redirect manual in ${file}`, () => {
      const hits = readFileSync(file, "utf8").match(new RegExp(MANUAL_MODE, "g")) ?? [];
      expect(hits.length).toBeGreaterThanOrEqual(minManual);
    });
  }
});

// Workers fetch semantics for the redirect option:
// - "error" is unimplemented: the call throws before any network I/O.
// - "follow" (the default when the option is omitted) follows the redirect to the next origin.
// - "manual" hands the 3xx back to the caller untouched.
// The emulator below reproduces exactly that, so these tests prove the fixed call sites take the
// 3xx back and refuse it — without throwing the Workers TypeError and without following.
const WORKERS_REDIRECT_TYPE_ERROR =
  'Invalid redirect value, must be one of "follow" or "manual" ("error" won\'t be implemented ...)';

function workersRedirectEmulator(options: { redirect: () => Response; followed: () => Response }) {
  const seen: (RequestInit | undefined)[] = [];
  const fetchFn = (async (_url: string, init?: RequestInit) => {
    seen.push(init);
    const mode = init?.redirect ?? "follow";
    if (mode === "error") throw new TypeError(WORKERS_REDIRECT_TYPE_ERROR);
    if (mode === "follow") return options.followed();
    if (mode === "manual") return options.redirect();
    throw new TypeError(`Invalid redirect value, must be one of "follow" or "manual"`);
  }) as unknown as typeof fetch;
  return { fetchFn, seen };
}

const BOT_OPTS = {
  url: "https://bot-staging.internal.example",
  secret: "fixture-secret-not-a-credential",
  keyId: "web-staging",
};
const SNOWFLAKE = "900000000000009999";

function botRedirectEmulator() {
  return workersRedirectEmulator({
    redirect: () =>
      new Response(
        JSON.stringify({ ok: true, result: { outcome: "assigned" }, request_id: "r1" }),
        {
          status: 307,
          headers: {
            "content-type": "application/json",
            location: "https://elsewhere.example/internal/actions",
          },
        },
      ),
    // A following client would trust this as a success, so the refusal assertion below is
    // sensitive to a revert: on "follow" the call resolves instead of rejecting.
    followed: () =>
      new Response(
        JSON.stringify({ ok: true, result: { outcome: "assigned" }, request_id: "r1" }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
  });
}

describe("Worker redirect-manual behavior", () => {
  it("bot client takes the 3xx back and refuses it instead of throwing or following", async () => {
    const { fetchFn, seen } = botRedirectEmulator();
    const client = createBotClient({ ...BOT_OPTS, fetchFn });
    // The "not followed" message proves the explicit 3xx refusal ran: an "error"-mode revert
    // throws "bot unreachable: Invalid redirect value ..." instead, and a default-mode revert
    // follows to the 200 above and resolves, failing this rejection outright.
    await expect(client.assignRole({ userId: SNOWFLAKE, roleKey: "rocketleague" })).rejects.toThrow(
      BotTransportError,
    );
    await expect(client.assignRole({ userId: SNOWFLAKE, roleKey: "rocketleague" })).rejects.toThrow(
      /not followed/,
    );
    expect(seen).toHaveLength(2);
    for (const init of seen) expect(init?.redirect).toBe("manual");
  });

  it("event reader reports a redirect as unreachable instead of parsing or following it", async () => {
    const observation = {
      event_id: "1545644954272137000",
      name: "Independent bot name",
      starts_at: "2030-07-01T19:00:00Z",
      location: "Voice",
      status: "scheduled",
      observed_at: "2030-07-01T18:00:00Z",
    };
    const { fetchFn, seen } = workersRedirectEmulator({
      // The body carries a typed error code so the explicit 3xx guard in
      // signedEventReader is pinned: with the guard the reader returns
      // bot_unreachable without parsing; if the guard is removed the body
      // parses to "redirect_body", failing the assertion below.
      redirect: () =>
        new Response(JSON.stringify({ ok: false, error: { code: "redirect_body" } }), {
          status: 302,
          headers: {
            "content-type": "application/json",
            location: "https://elsewhere.example/",
          },
        }),
      // A following reader would trust this as an observation, so the unreachable assertion
      // below fails on a revert to the default "follow".
      followed: () =>
        new Response(JSON.stringify({ ok: true, result: observation }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    });
    const reader = signedEventReader(
      { baseUrl: "https://bot.fixture.test", keyId: "fixture-key", secret: BOT_OPTS.secret },
      fetchFn,
    );
    expect(
      await observeDiscordEvent(
        { event_key: "01FIXTURE000000000000000000", discord_event_id: observation.event_id },
        reader,
      ),
    ).toEqual({ unavailable: "verification_unavailable", reason: "bot_unreachable" });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.redirect).toBe("manual");
  });

  it("tail alert delivery treats a redirect as not delivered and never follows it", async () => {
    const { fetchFn, seen } = workersRedirectEmulator({
      redirect: () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://elsewhere.example/" },
        }),
      // A following delivery would record success, so the delivery_failed assertion below
      // fails on a revert to the default "follow".
      followed: () =>
        new Response(JSON.stringify({ id: "msg-1" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    });
    const lines: string[] = [];
    const worker = createTailWorker({
      fetch: fetchFn,
      sink: (line) => lines.push(line),
      mute: new DeliveryMute(() => Date.parse("2030-07-01T00:00:00Z")),
    });
    const requestAlert = {
      level: "critical",
      event: "error.alert",
      fingerprint: "TypeError@/join",
      route: "/join",
      exception: "TypeError",
      method: "POST",
      message: "password=never-send",
      body: { token: "never-send" },
    };
    await worker.tail(
      [
        {
          scriptName: "two-web-next",
          logs: [
            {
              message: [JSON.stringify(requestAlert)],
              timestamp: Date.parse("2030-07-01T00:00:00Z"),
              level: "error",
            },
          ],
        },
      ],
      { OPS_ALERT_WEBHOOK_URL: "https://discord.com/api/webhooks/123456789/test-only-token" },
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]?.redirect).toBe("manual");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!).delivery).toBe("ops.alert.delivery_failed");
  });

  it("tail uptime probe keeps a redirect as a failed probe with its status, never ok", async () => {
    const { fetchFn, seen } = workersRedirectEmulator({
      redirect: () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://elsewhere.example/up" },
        }),
      // A following probe would see the healthy origin and stay silent, so the paging
      // assertion below fails on a revert to the default "follow".
      followed: () =>
        new Response(null, { status: 200, headers: { "x-two-origin": "two-web-next" } }),
    });
    const lines: string[] = [];
    const worker = createTailWorker({
      fetch: fetchFn,
      sink: (line) => lines.push(line),
      mute: new DeliveryMute(() => Date.parse("2030-07-01T00:00:00Z")),
      sleep: async () => {},
    });
    await worker.scheduled(
      { cron: "*/5 * * * *", scheduledTime: Date.parse("2030-07-01T00:00:00Z"), noRetry() {} },
      {
        OPS_ALERT_WEBHOOK_URL: "https://discord.com/api/webhooks/123456789/test-only-token",
        UPTIME_URL: "https://next.togetherweown.com/up",
      },
    );
    const gets = seen.filter((init) => init?.method === "GET");
    const posts = seen.filter((init) => init?.method === "POST");
    // Two failed probes, then one page: the 302 is a failure with its status, not a throw
    // (status 0) and not a silent success.
    expect(gets).toHaveLength(2);
    for (const init of seen) expect(init?.redirect).toBe("manual");
    expect(posts).toHaveLength(1);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({
      event: "uptime.down",
      status: 302,
      delivery: "ops.alert.delivery_failed",
    });
  });
});

// Acceptance contract: the Tail synthetic prober covers the /join
// conversion path alongside the existing /, /events and /login checks.
//
// Pre-fix red proof: /join is never probed, so a /join-down fixture
// stays silent — every test below that expects a /join probe or a
// synthetic.down page for /join fails against the three-check set.
// The guards that already hold (existing checks unchanged, off-boundary
// runs probe /up only) pass before and after.
//
// Post-fix contract, all under the existing synthetic policy — no new
// threshold, channel, retry or cadence:
// - /join is a page check like / and /events: healthy is 200 + HTML.
//   The healthy fixture body carries the stable anonymous marker
//   ("One click with Discord", as pinned by the deploy smoke) so a
//   body-marker implementation satisfies this suite too; a missing
//   marker is deliberately not pinned as a failure, because other
//   hermetic Tail fixtures answer page checks with an empty body.
// - One failure retries only /join after the existing delay; a second
//   failure pages synthetic.down with check /join, muted independently
//   of the other checks and of the failing status, re-paging only once
//   the existing mute window expires.
// - No state mutation: the probe is an anonymous GET with manual
//   redirects and never requests /auth/discord — not directly, and
//   not by following a /join redirect into the sign-in entry (that hop
//   mints OAuth state). Nothing from a probe Location ever reaches a
//   page payload or a delivery receipt.
//
// Everything is hermetic: injected fetch/sleep, a fake clock, no
// webhook, database or network contact.
import { describe, expect, it, vi } from "vitest";
import { DeliveryMute, MUTE_MS, createTailWorker } from "../tail/worker";

const timestamp = Date.parse("2026-10-01T00:00:00Z");
const secret = "https://discord.com/api/webhooks/123456789/test-only-token";
const uptime = "https://next.togetherweown.com/up";
const upEnv = { OPS_ALERT_WEBHOOK_URL: secret, UPTIME_URL: uptime };

type Probe = {
  status?: number;
  origin?: string | null;
  contentType?: string | null;
  location?: string | null;
  body?: string | null;
  throw?: unknown;
};

// Healthy synthetic answers per path. /join answers 200 + HTML whose
// body carries the join page's stable anonymous marker, mirroring the
// deploy. There is deliberately no /auth/discord answer: the prober
// must never request that state-minting hop.
const healthySynthetic = (path: string): Probe => {
  if (path === "/login") return { status: 302, location: "/auth/discord" };
  if (path === "/join")
    return {
      status: 200,
      contentType: "text/html; charset=UTF-8",
      body: "<main><h1>Join us</h1><p>One click with Discord</p></main>",
    };
  return { status: 200, contentType: "text/html; charset=UTF-8", body: "<main>ok</main>" };
};

function fixture(probes: Probe[], synthetic: Partial<Record<string, Probe[]>> = {}) {
  let now = timestamp;
  const sleeps: number[] = [];
  const queue = [...probes];
  let last: Probe = { status: 500 };
  const syntheticQueues = new Map(
    Object.entries(synthetic).map(([path, list]) => [path, [...(list ?? [])]]),
  );
  const send = vi.fn(async (...args: [string, RequestInit?]) => {
    const [target, init] = args;
    if (init?.method === "POST") return new Response(null, { status: 200 });
    const path = new URL(target).pathname;
    let next: Probe;
    if (path === "/up") {
      next = queue.shift() ?? last;
      last = next;
    } else {
      next = syntheticQueues.get(path)?.shift() ?? healthySynthetic(path);
    }
    if (next.throw) throw next.throw;
    const headers: Record<string, string> = {};
    if (next.origin != null) headers["x-two-origin"] = next.origin;
    if (next.contentType != null) headers["content-type"] = next.contentType;
    if (next.location != null) headers.location = next.location;
    return new Response(next.body ?? null, {
      status: next.status ?? 200,
      headers: Object.keys(headers).length ? headers : undefined,
    });
  });
  const sink = vi.fn();
  const worker = createTailWorker({
    fetch: send as unknown as typeof fetch,
    sink,
    mute: new DeliveryMute(() => now),
    now: () => now,
    sleep: async (ms: number) => {
      sleeps.push(ms);
    },
  });
  const event = { cron: "* * * * *", scheduledTime: timestamp, noRetry() {} };
  return {
    worker,
    send,
    sink,
    sleeps,
    event,
    advance: (ms: number) => {
      now += ms;
      event.scheduledTime += ms;
    },
  };
}

const probeGets = (send: ReturnType<typeof vi.fn>) =>
  (send.mock.calls as unknown as [string, RequestInit][]).filter(
    ([, init]) => init?.method !== "POST",
  );
const getsFor = (send: ReturnType<typeof vi.fn>, path: string) =>
  probeGets(send).filter(([target]) => new URL(target).pathname === path);
const pagePosts = (send: ReturnType<typeof vi.fn>) =>
  (send.mock.calls as unknown as [string, RequestInit][]).filter(
    ([, init]) => init?.method === "POST",
  );
const pageContent = (page: [string, RequestInit]) =>
  JSON.parse(JSON.parse(page[1].body as string).content as string);

describe("acceptance: Tail synthetic covers /join", () => {
  it("a fully healthy boundary run probes /join once alongside the existing checks and stays silent", async () => {
    const fx = fixture([{ status: 200, origin: "two-web-next" }]);
    await fx.worker.scheduled(fx.event, upEnv);
    const paths = probeGets(fx.send).map(([target]) => new URL(target).pathname);
    // Position is not pinned; membership and counts are. The existing
    // three checks stay probed, and /join joins them.
    expect(paths.sort()).toEqual(["/", "/events", "/join", "/login", "/up"]);
    expect(getsFor(fx.send, "/auth/discord")).toHaveLength(0);
    for (const [, init] of probeGets(fx.send)) {
      expect(init?.method).toBe("GET");
      expect(init?.redirect).toBe("manual");
    }
    expect(pagePosts(fx.send)).toHaveLength(0);
    expect(fx.sink).not.toHaveBeenCalled();
    expect(fx.sleeps).toHaveLength(0);
  });

  it("red proof: a persistently failing /join pages synthetic.down on the second failure", async () => {
    const fx = fixture([{ status: 200, origin: "two-web-next" }], {
      "/join": [{ status: 500 }, { status: 503 }],
    });
    await fx.worker.scheduled(fx.event, upEnv);
    expect(getsFor(fx.send, "/join")).toHaveLength(2);
    expect(getsFor(fx.send, "/auth/discord")).toHaveLength(0);
    const pages = pagePosts(fx.send);
    expect(pages).toHaveLength(1);
    expect(pages[0]![0]).toBe(`${secret}?wait=true`);
    const payload = JSON.parse(pages[0]![1].body as string);
    expect(payload.allowed_mentions).toEqual({ parse: [] });
    expect(pageContent(pages[0]!)).toEqual({
      event: "synthetic.down",
      check: "/join",
      target: "next.togetherweown.com",
      status: 503,
      timestamp: expect.any(String),
    });
    expect(fx.sink).toHaveBeenCalledOnce();
    expect(JSON.parse(fx.sink.mock.calls[0]![0])).toMatchObject({
      event: "synthetic.down",
      check: "/join",
      delivery: "ops.alert.delivered",
    });
  });

  it("one /join failure then a success sends no page, retrying only /join after the existing delay", async () => {
    const fx = fixture([{ status: 200, origin: "two-web-next" }], {
      "/join": [{ status: 500 }, healthySynthetic("/join")],
    });
    await fx.worker.scheduled(fx.event, upEnv);
    expect(getsFor(fx.send, "/join")).toHaveLength(2);
    expect(getsFor(fx.send, "/")).toHaveLength(1);
    expect(getsFor(fx.send, "/events")).toHaveLength(1);
    expect(getsFor(fx.send, "/login")).toHaveLength(1);
    expect(fx.sleeps).toEqual([10_000]);
    expect(pagePosts(fx.send)).toHaveLength(0);
    expect(fx.sink).not.toHaveBeenCalled();
  });

  it("/join answering 200 non-HTML pages synthetic.down for /join", async () => {
    const probe: Probe = { status: 200, contentType: "application/json", body: "{}" };
    const fx = fixture([{ status: 200, origin: "two-web-next" }], {
      "/join": [probe, probe],
    });
    await fx.worker.scheduled(fx.event, upEnv);
    const pages = pagePosts(fx.send);
    expect(pages).toHaveLength(1);
    expect(pageContent(pages[0]!)).toMatchObject({
      event: "synthetic.down",
      check: "/join",
    });
  });

  it("a /join probe error counts as a failure and pages after the retry also errors", async () => {
    const timeout = new DOMException("The operation timed out.", "TimeoutError");
    const fx = fixture([{ status: 200, origin: "two-web-next" }], {
      "/join": [{ throw: timeout }, { throw: timeout }],
    });
    await fx.worker.scheduled(fx.event, upEnv);
    expect(getsFor(fx.send, "/join")).toHaveLength(2);
    const pages = pagePosts(fx.send);
    expect(pages).toHaveLength(1);
    expect(pageContent(pages[0]!)).toMatchObject({
      event: "synthetic.down",
      check: "/join",
      target: "next.togetherweown.com",
    });
  });

  it("no state mutation: a /join redirect into sign-in is a failure, is never followed, and leaks nothing", async () => {
    const probe: Probe = {
      status: 302,
      location: "https://next.togetherweown.com/auth/discord?state=fixture-state-value",
    };
    const fx = fixture([{ status: 200, origin: "two-web-next" }], {
      "/join": [probe, probe],
    });
    await fx.worker.scheduled(fx.event, upEnv);
    // The OAuth entry is never contacted, by any probe, in any run here.
    expect(getsFor(fx.send, "/auth/discord")).toHaveLength(0);
    const joinGets = getsFor(fx.send, "/join");
    expect(joinGets).toHaveLength(2);
    for (const [, init] of joinGets) expect(init?.redirect).toBe("manual");
    const pages = pagePosts(fx.send);
    expect(pages).toHaveLength(1);
    expect(pageContent(pages[0]!)).toMatchObject({
      event: "synthetic.down",
      check: "/join",
    });
    // Nothing from the redirect target reaches the page or the receipt.
    expect(pages[0]![1].body as string).not.toContain("fixture-state-value");
    expect(fx.sink.mock.calls[0]![0]).not.toContain("fixture-state-value");
    expect(pages[0]![1].body as string).not.toContain(secret.split("/").pop()!);
  });

  it("/join pages independently: /join and /events down together page once each", async () => {
    const down: Probe[] = [{ status: 500 }, { status: 500 }];
    const fx = fixture([{ status: 200, origin: "two-web-next" }], {
      "/join": [...down],
      "/events": [...down],
    });
    await fx.worker.scheduled(fx.event, upEnv);
    const pages = pagePosts(fx.send);
    expect(pages).toHaveLength(2);
    expect(pages.map((page) => pageContent(page).check).sort()).toEqual(["/events", "/join"]);
  });

  it("a /join check flapping to a different failing status within the mute window stays muted, then re-pages after it", async () => {
    const fx = fixture(
      [
        { status: 200, origin: "two-web-next" },
        { status: 200, origin: "two-web-next" },
        { status: 200, origin: "two-web-next" },
      ],
      {
        "/join": [
          { status: 500 },
          { status: 500 },
          { status: 503 },
          { status: 503 },
          { status: 503 },
          { status: 503 },
        ],
      },
    );
    await fx.worker.scheduled(fx.event, upEnv);
    expect(pagePosts(fx.send)).toHaveLength(1);
    expect(pageContent(pagePosts(fx.send)[0]!)).toEqual({
      event: "synthetic.down",
      check: "/join",
      target: "next.togetherweown.com",
      status: 500,
      timestamp: expect.any(String),
    });

    // Same check, still inside the mute window, now failing as 503: the
    // status must not split the mute identity.
    await fx.worker.scheduled(fx.event, upEnv);
    expect(getsFor(fx.send, "/join")).toHaveLength(4);
    expect(pagePosts(fx.send)).toHaveLength(1);
    expect(fx.sink).toHaveBeenCalledOnce();

    fx.advance(MUTE_MS);
    await fx.worker.scheduled(fx.event, upEnv);
    expect(getsFor(fx.send, "/join")).toHaveLength(6);
    const pages = pagePosts(fx.send);
    expect(pages).toHaveLength(2);
    expect(pageContent(pages[1]!)).toEqual({
      event: "synthetic.down",
      check: "/join",
      target: "next.togetherweown.com",
      status: 503,
      timestamp: expect.any(String),
    });
    expect(fx.sink).toHaveBeenCalledTimes(2);
  });

  it("/join still pages when /up is down (synthetics are not gated on health)", async () => {
    const fx = fixture([{ status: 500 }, { status: 500 }], {
      "/join": [{ status: 500 }, { status: 500 }],
    });
    await fx.worker.scheduled(fx.event, upEnv);
    const pages = pagePosts(fx.send);
    expect(pages).toHaveLength(1);
    expect(pageContent(pages[0]!)).toMatchObject({
      event: "synthetic.down",
      check: "/join",
    });
  });

  it("guard: a run off the five-minute boundary probes /up only — /join is not probed", async () => {
    const fx = fixture([{ status: 200, origin: "two-web-next" }], {
      "/join": [{ status: 500 }, { status: 500 }],
    });
    fx.advance(60_000); // 00:01 — inside the five-minute synthetic interval.
    await fx.worker.scheduled(fx.event, upEnv);
    expect(probeGets(fx.send).map(([target]) => new URL(target).pathname)).toEqual(["/up"]);
    expect(pagePosts(fx.send)).toHaveLength(0);
  });
});

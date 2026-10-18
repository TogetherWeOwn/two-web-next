// Acceptance contract: Tail uptime/synthetic pages carry build
// attribution read from the /up body the prober already fetched.
//
// Pre-fix red proof: the scheduled prober discards the /up response
// body, so uptime.down and synthetic.down pages name no build even
// when that body publicly carries revision { version_id, commit }.
// Every attribution assertion below fails before the fix; the guards
// that already hold (pages still fire, exact probe sets, garbage is
// never echoed) pass before and after.
//
// Post-fix contract:
// - revision.commit is accepted only through the existing exact
//   40-hex SHA allowlist. A valid commit attaches optional build_sha,
//   plus version_id only when the same revision marker carries a Worker
//   Version UUID (a raw non-UUID string is omitted, never echoed: it
//   could push the page past Discord's 2,000-character limit).
// - A body that stalls after its headers yields absent attribution on a
//   2 s independent deadline — never the cooperative fetch signal — so
//   the scheduled run still pages and still runs its synthetic checks.
// - Attribution comes from the /up body observed in the run that
//   pages — including a failing 503 /up body, which still carries the
//   marker. An unreadable body in the paging run yields absent
//   attribution, never a throw and never a stale SHA blamed from an
//   earlier run (the same no-blame-the-previous-build discipline the
//   aggregate summaries already follow).
// - Non-SHA commit values are ignored entirely: no build_sha, and the
//   raw value reaches neither the page payload nor the delivery
//   receipt.
// - No extra probe traffic and no alert-protocol change: the probed
//   path sets, retry, mute identity and page shapes are otherwise
//   exactly as before. Attribution is payload only — a new build
//   answering /up mid-incident does not split the mute and re-page.
//
// Everything is hermetic: injected fetch/sleep, a fake clock, no
// webhook, database or network contact.
import { describe, expect, it, vi } from "vitest";
import { DeliveryMute, createTailWorker } from "../tail/worker";

const timestamp = Date.parse("2026-10-01T00:00:00Z");
const secret = "https://discord.com/api/webhooks/123456789/test-only-token";
const uptime = "https://next.togetherweown.com/up";
const upEnv = { OPS_ALERT_WEBHOOK_URL: secret, UPTIME_URL: uptime };

const shaA = "0123456789abcdef0123456789abcdef01234567";
const shaB = "89abcdef0123456789abcdef0123456789abcdef";
const versionId = "81da0f67-1e2c-4b6e-9a53-0c7c1d2e3f40";

// Recorded /up body shapes (see the /up revision-marker suite): the
// marker is informational and rides healthy and degraded bodies alike.
const upBody = (revision: unknown) =>
  JSON.stringify({
    status: "healthy",
    db: "ok",
    pending_migrations: 0,
    queue: { status: "healthy", pending: 0 },
    member_access_log_enforcement: "enforcing",
    revision,
  });
const markedBody = (commit: unknown = shaA, version: unknown = versionId) =>
  upBody({ version_id: version, commit });

type Probe = {
  status?: number;
  origin?: string | null;
  contentType?: string | null;
  location?: string | null;
  body?: string | null;
  throw?: unknown;
  // Headers plus one chunk, then the stream never closes: the attribution
  // read must yield absent attribution on its own deadline instead of
  // stalling the scheduled run.
  stall?: boolean;
};

// A body that sends headers plus one chunk and then stalls forever.
const stalledStream = () =>
  new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"status":"degraded",'));
    },
  });

// Healthy synthetic answers per path. There is deliberately no
// /auth/discord answer: the prober must never request that hop.
const healthySynthetic = (path: string): Probe => {
  if (path === "/login") return { status: 302, location: "/auth/discord" };
  return { status: 200, contentType: "text/html; charset=UTF-8", body: "<main>ok</main>" };
};

const healthyUp = (body: string | null = markedBody()): Probe => ({
  status: 200,
  origin: "two-web-next",
  contentType: "application/json",
  body,
});
const downUp = (body: string | null = markedBody()): Probe => ({
  status: 503,
  origin: "two-web-next",
  contentType: "application/json",
  body,
});

function fixture(
  up: Probe | Probe[] | (() => Probe),
  synthetic: Partial<Record<string, Probe[]>> = {},
) {
  let now = timestamp;
  const sleeps: number[] = [];
  const queue = Array.isArray(up) ? [...up] : null;
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
      // Later cron runs repeat the last probe shape: health stays as set up.
      if (queue) {
        next = queue.shift() ?? last;
        last = next;
      } else if (typeof up === "function") {
        next = up();
      } else if (Array.isArray(up)) {
        next = last; // Unreachable: array inputs always take the queue path.
      } else {
        next = up;
      }
    } else {
      next = syntheticQueues.get(path)?.shift() ?? healthySynthetic(path);
    }
    if (next.throw) throw next.throw;
    const headers: Record<string, string> = {};
    if (next.origin != null) headers["x-two-origin"] = next.origin;
    if (next.contentType != null) headers["content-type"] = next.contentType;
    if (next.location != null) headers.location = next.location;
    const responseInit = {
      status: next.status ?? 200,
      headers: Object.keys(headers).length ? headers : undefined,
    };
    if (next.stall) return new Response(stalledStream(), responseInit);
    return new Response(next.body ?? null, responseInit);
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

type Fixture = ReturnType<typeof fixture>;

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
const pageFor = (fx: Fixture, event: string) =>
  pagePosts(fx.send)
    .map((page) => pageContent(page))
    .find((content) => content.event === event);

// Three failing one-minute runs: health red for 121 s, past the >2 min gate.
async function runDownPastGate(fx: Fixture) {
  await fx.worker.scheduled(fx.event, upEnv);
  fx.advance(60_000);
  await fx.worker.scheduled(fx.event, upEnv);
  fx.advance(61_000);
  await fx.worker.scheduled(fx.event, upEnv);
}

const eventsDownTwice: Partial<Record<string, Probe[]>> = {
  "/events": [{ status: 500 }, { status: 503 }],
};

describe("acceptance: Tail pages carry build attribution from /up", () => {
  it("red proof: synthetic.down carries build_sha and version_id from the same run's healthy /up body", async () => {
    const fx = fixture(healthyUp(), eventsDownTwice);
    await fx.worker.scheduled(fx.event, upEnv);
    const pages = pagePosts(fx.send);
    expect(pages).toHaveLength(1);
    expect(pages[0]![0]).toBe(`${secret}?wait=true`);
    const payload = JSON.parse(pages[0]![1].body as string);
    expect(payload.allowed_mentions).toEqual({ parse: [] });
    expect(JSON.parse(payload.content)).toEqual({
      event: "synthetic.down",
      check: "/events",
      target: "next.togetherweown.com",
      status: 503,
      build_sha: shaA,
      version_id: versionId,
      timestamp: expect.any(String),
    });
    expect(fx.sink).toHaveBeenCalledOnce();
    expect(JSON.parse(fx.sink.mock.calls[0]![0])).toMatchObject({
      event: "synthetic.down",
      check: "/events",
      build_sha: shaA,
      delivery: "ops.alert.delivered",
    });
    // Attribution is read from the probe already made: /up is fetched
    // exactly once, and the probed set is otherwise unchanged.
    expect(getsFor(fx.send, "/up")).toHaveLength(1);
    // First probes in check order, then the one retry of the failing check.
    expect(probeGets(fx.send).map(([target]) => new URL(target).pathname)).toEqual([
      "/up",
      "/",
      "/events",
      "/join",
      "/login",
      "/events",
    ]);
  });

  it("red proof: uptime.down carries build_sha and version_id from the failing /up body", async () => {
    const fx = fixture(downUp());
    await runDownPastGate(fx);
    const pages = pagePosts(fx.send);
    expect(pages).toHaveLength(1);
    expect(pageContent(pages[0]!)).toEqual({
      event: "uptime.down",
      status: 503,
      down_seconds: 121,
      build_sha: shaA,
      version_id: versionId,
      timestamp: expect.any(String),
    });
    expect(fx.sink).toHaveBeenCalledOnce();
    expect(JSON.parse(fx.sink.mock.calls[0]![0])).toMatchObject({
      event: "uptime.down",
      build_sha: shaA,
      delivery: "ops.alert.delivered",
    });
  });

  it("a synthetic page and the later uptime page for one incident name the same build", async () => {
    const fx = fixture(downUp(), eventsDownTwice);
    await runDownPastGate(fx);
    const synthetic = pageFor(fx, "synthetic.down");
    const uptimePage = pageFor(fx, "uptime.down");
    expect(synthetic).toMatchObject({
      check: "/events",
      build_sha: shaA,
      version_id: versionId,
    });
    expect(uptimePage).toMatchObject({
      status: 503,
      build_sha: shaA,
      version_id: versionId,
    });
  });

  it("a valid commit without a version_id attaches build_sha alone", async () => {
    const fx = fixture(healthyUp(upBody({ commit: shaA })), eventsDownTwice);
    await fx.worker.scheduled(fx.event, upEnv);
    const content = pageContent(pagePosts(fx.send)[0]!);
    expect(content).toEqual({
      event: "synthetic.down",
      check: "/events",
      target: "next.togetherweown.com",
      status: 503,
      build_sha: shaA,
      timestamp: expect.any(String),
    });
    expect(content).not.toHaveProperty("version_id");
  });

  it.each([
    ["a numeric version_id", 7],
    ["an object version_id", { id: versionId }],
    ["an empty version_id", ""],
    ["a null version_id", null],
  ])("an unusable %s is omitted while build_sha still attaches", async (_label, version) => {
    const fx = fixture(healthyUp(markedBody(shaA, version)), eventsDownTwice);
    await fx.worker.scheduled(fx.event, upEnv);
    const content = pageContent(pagePosts(fx.send)[0]!);
    expect(content.build_sha).toBe(shaA);
    expect(content).not.toHaveProperty("version_id");
  });

  it("attribution names the build from the paging run, not an earlier run's build", async () => {
    let current = downUp(markedBody(shaA));
    const fx = fixture(() => current);
    await fx.worker.scheduled(fx.event, upEnv);
    fx.advance(60_000);
    await fx.worker.scheduled(fx.event, upEnv);
    // A new deploy answers /up (still failing) before the page fires.
    current = downUp(markedBody(shaB));
    fx.advance(61_000);
    await fx.worker.scheduled(fx.event, upEnv);
    const content = pageContent(pagePosts(fx.send)[0]!);
    expect(content.event).toBe("uptime.down");
    expect(content.build_sha).toBe(shaB);
  });

  it("an unreadable body in the paging run omits attribution instead of blaming the previous build", async () => {
    let current = downUp(markedBody(shaA));
    const fx = fixture(() => current);
    await fx.worker.scheduled(fx.event, upEnv);
    fx.advance(60_000);
    await fx.worker.scheduled(fx.event, upEnv);
    current = downUp("<html><body>503 from somewhere upstream</body></html>");
    fx.advance(61_000);
    await fx.worker.scheduled(fx.event, upEnv);
    const pages = pagePosts(fx.send);
    expect(pages).toHaveLength(1);
    const content = pageContent(pages[0]!);
    expect(content.event).toBe("uptime.down");
    expect(content).not.toHaveProperty("build_sha");
    expect(content).not.toHaveProperty("version_id");
    expect(pages[0]![1].body as string).not.toContain(shaA);
  });

  it("a 503 body that stalls after its headers still pages uptime.down unattributed", {
    timeout: 30_000,
  }, async () => {
    const stalled: Probe = {
      status: 503,
      origin: "two-web-next",
      contentType: "application/json",
      stall: true,
    };
    const fx = fixture(stalled);
    // Three red runs past the >2 min gate: six stalled reads at the 2 s
    // attribution deadline. The vitest timeout is the stall detector:
    // without the independent deadline this run would hang it.
    await runDownPastGate(fx);
    const pages = pagePosts(fx.send);
    expect(pages).toHaveLength(1);
    const content = pageContent(pages[0]!);
    expect(content.event).toBe("uptime.down");
    expect(content.status).toBe(503);
    expect(content).not.toHaveProperty("build_sha");
    expect(content).not.toHaveProperty("version_id");
  });

  it("a healthy body that stalls after its headers still lets the failing check page", {
    timeout: 15_000,
  }, async () => {
    const stalled: Probe = {
      status: 200,
      origin: "two-web-next",
      contentType: "application/json",
      stall: true,
    };
    const fx = fixture(stalled, eventsDownTwice);
    await fx.worker.scheduled(fx.event, upEnv);
    const pages = pagePosts(fx.send);
    expect(pages).toHaveLength(1);
    const content = pageContent(pages[0]!);
    expect(content).toMatchObject({ event: "synthetic.down", check: "/events" });
    expect(content).not.toHaveProperty("build_sha");
    expect(content).not.toHaveProperty("version_id");
  });

  it("a non-UUID version_id string is omitted, never echoed, while build_sha still attaches", async () => {
    const bogus = "rollback-81da0f67-ever";
    const fx = fixture(healthyUp(markedBody(shaA, bogus)), eventsDownTwice);
    await fx.worker.scheduled(fx.event, upEnv);
    const pages = pagePosts(fx.send);
    expect(pages).toHaveLength(1);
    const content = pageContent(pages[0]!);
    expect(content.build_sha).toBe(shaA);
    expect(content).not.toHaveProperty("version_id");
    // The rejected raw value reaches neither the page nor the receipt.
    expect(pages[0]![1].body as string).not.toContain(bogus);
    expect(fx.sink.mock.calls[0]![0]).not.toContain(bogus);
  });

  it("an over-cap body yields absent attribution instead of buffering unboundedly", async () => {
    const fx = fixture(healthyUp(`${markedBody()}${" ".repeat(70_000)}`), eventsDownTwice);
    await fx.worker.scheduled(fx.event, upEnv);
    const pages = pagePosts(fx.send);
    expect(pages).toHaveLength(1);
    const content = pageContent(pages[0]!);
    expect(content).toMatchObject({ event: "synthetic.down", check: "/events" });
    expect(content).not.toHaveProperty("build_sha");
    expect(content).not.toHaveProperty("version_id");
    expect(getsFor(fx.send, "/up")).toHaveLength(1);
  });

  it("attribution does not split the mute: a new build mid-incident does not re-page", async () => {
    let current = healthyUp(markedBody(shaA));
    const down: Probe = { status: 500 };
    const fx = fixture(() => current, { "/events": [down, down, down, down] });
    await fx.worker.scheduled(fx.event, upEnv);
    expect(pagePosts(fx.send)).toHaveLength(1);
    expect(pageContent(pagePosts(fx.send)[0]!).build_sha).toBe(shaA);

    current = healthyUp(markedBody(shaB));
    await fx.worker.scheduled(fx.event, upEnv);
    expect(getsFor(fx.send, "/events")).toHaveLength(4);
    expect(pagePosts(fx.send)).toHaveLength(1);
    expect(fx.sink).toHaveBeenCalledOnce();
  });

  it.each([
    ["a manual non-SHA tag", "manual-never-send"],
    ["an uppercase SHA", shaA.toUpperCase()],
    ["a short SHA", shaA.slice(0, 12)],
    ["an over-long hex string", `${shaA}a`],
    ["a SHA with trailing text", `${shaA}\nextra-never-send`],
    ["a SHA with surrounding spaces", ` ${shaA} `],
  ])(
    "positive control: %s is ignored — the page fires unattributed and echoes nothing",
    async (_label, commit) => {
      const fx = fixture(healthyUp(markedBody(commit)), eventsDownTwice);
      await fx.worker.scheduled(fx.event, upEnv);
      const pages = pagePosts(fx.send);
      expect(pages).toHaveLength(1);
      const content = pageContent(pages[0]!);
      expect(content).toMatchObject({ event: "synthetic.down", check: "/events" });
      expect(content).not.toHaveProperty("build_sha");
      // The rejected raw value reaches neither the page nor the receipt.
      // (Trimmed: the JSON envelope legitimately contains spaces/newlines
      // of its own, but never the commit characters themselves.)
      expect(pages[0]![1].body as string).not.toContain(commit.trim());
      expect(fx.sink.mock.calls[0]![0]).not.toContain(commit.trim());
      expect(getsFor(fx.send, "/up")).toHaveLength(1);
    },
  );

  it.each([
    ["a null commit (the recorded non-SHA shape)", null],
    ["a numeric commit", 42],
    ["an object commit", { sha: shaA }],
    ["a missing commit", undefined],
  ])(
    "positive control: %s attaches no build_sha and the page still fires",
    async (_label, commit) => {
      const revision =
        commit === undefined ? { version_id: versionId } : { version_id: versionId, commit };
      const fx = fixture(healthyUp(upBody(revision)), eventsDownTwice);
      await fx.worker.scheduled(fx.event, upEnv);
      const pages = pagePosts(fx.send);
      expect(pages).toHaveLength(1);
      const content = pageContent(pages[0]!);
      expect(content).toMatchObject({ event: "synthetic.down", check: "/events" });
      expect(content).not.toHaveProperty("build_sha");
    },
  );

  it.each([
    ["a non-JSON body", "not json {"],
    ["an HTML error body", "<html><body>Bad gateway</body></html>"],
    ["a JSON array body", JSON.stringify([{ revision: { commit: shaA } }])],
    ["a JSON string body", JSON.stringify(`revision ${shaA}`)],
    ["a JSON null body", "null"],
    ["a body with no revision marker", JSON.stringify({ status: "healthy", db: "ok" })],
    ["a non-object revision", upBody(`commit=${shaA}`)],
    ["an empty body", ""],
    ["no body at all", null],
  ])(
    "positive control: %s never throws — the page fires with attribution absent",
    async (_label, body) => {
      const fx = fixture(healthyUp(body), eventsDownTwice);
      await fx.worker.scheduled(fx.event, upEnv);
      const pages = pagePosts(fx.send);
      expect(pages).toHaveLength(1);
      const content = pageContent(pages[0]!);
      expect(content).toMatchObject({ event: "synthetic.down", check: "/events" });
      expect(content).not.toHaveProperty("build_sha");
      expect(content).not.toHaveProperty("version_id");
      // A SHA-shaped string buried in an unparseable shape is not scraped.
      expect(pages[0]![1].body as string).not.toContain(shaA);
      expect(getsFor(fx.send, "/up")).toHaveLength(1);
    },
  );

  it("guard: a healthy marked /up body changes nothing — same probes, no page, no retry", async () => {
    const fx = fixture(healthyUp());
    await fx.worker.scheduled(fx.event, upEnv);
    expect(probeGets(fx.send).map(([target]) => new URL(target).pathname)).toEqual([
      "/up",
      "/",
      "/events",
      "/join",
      "/login",
    ]);
    for (const [, init] of probeGets(fx.send)) {
      expect(init?.method).toBe("GET");
      expect(init?.redirect).toBe("manual");
    }
    expect(pagePosts(fx.send)).toHaveLength(0);
    expect(fx.sink).not.toHaveBeenCalled();
    expect(fx.sleeps).toHaveLength(0);
  });

  it("guard: an unreadable healthy /up body is still just healthy — no page, no retry, no throw", async () => {
    const fx = fixture(healthyUp(`{{{ ${shaA}`));
    await fx.worker.scheduled(fx.event, upEnv);
    expect(getsFor(fx.send, "/up")).toHaveLength(1);
    expect(pagePosts(fx.send)).toHaveLength(0);
    expect(fx.sink).not.toHaveBeenCalled();
    expect(fx.sleeps).toHaveLength(0);
  });
});

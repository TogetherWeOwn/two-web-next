// Acceptance contract: future-skew drops are accounted, not silent, and a
// dead-batch 400 says which kind of dead it is.
//
// Admission policy is already settled and must not move: a batch stamped
// beyond now plus the documented slack is dropped on the tail path and
// rejected with 400 on the aggregator /observe wire, while merely-late
// and one-bucket-ahead batches still count (pinned end to end in
// tail-batch-skew.test.ts). What is missing is observability. The tail
// path drops a skewed trace with a bare continue, so an operator cannot
// tell "nothing happened" from "a poisoned clock is eating traffic";
// the /observe wire answers the same bare 400 for a future-skewed batch,
// a structurally malformed batch, and an unparseable body, so clock skew
// is indistinguishable from payload corruption in the logs.
//
// The contract pinned here, on both boundaries:
// - Tail path: each tail() invocation that drops future-skewed traces
//   emits exactly one accounting line naming the skew drop and the
//   number of traces dropped in that invocation (not a running total,
//   not one line per trace). The line goes to the worker's log sink /
//   console like the existing alert receipts — never to the webhook —
//   and carries no trace payload data.
// - Aggregator /observe: a future-skewed but otherwise valid batch
//   still gets status 400, with a distinct log line naming the skew
//   rejection; malformed payloads (structurally invalid batches and
//   unparseable bodies alike) still get 400, with a log line naming
//   them malformed/invalid and never claiming skew. A batch that is
//   both malformed and future-stamped is malformed: the skew line is
//   reserved for batches that would have counted but for their stamp.
// - Counting semantics are unchanged everywhere: skewed counts never
//   land, prior in-window counts survive, merely-late and
//   one-bucket-ahead batches count exactly as before and produce no
//   positive drop accounting.
// - The alert/uptime runbook documents the new lines so an operator
//   who sees one knows what it means.
//
// Log lines are matched semantically (a skew/drop naming plus the
// dropped count; skew vs malformed/invalid wording), never by exact
// string: field names and phrasing are the builder's choice. No live
// webhook, database, or network: the Durable Object runs over fake
// storage and the worker over mock fetch, mirroring the skew suite.
// The aggregator's clock is the real wall clock, so its fixtures are
// dated from Date.now().
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AggregateTracker,
  AlertAggregator,
  DeliveryMute,
  SPIKE_MIN_CRASHES,
  createTailWorker,
  type SpikeAlert,
  type TraceBatch,
} from "../tail/worker";

const t0 = Date.parse("2026-10-01T00:00:00Z");
const DAY_MS = 86_400_000;
const MAIN = "two-web-next";
const sha = "0123456789abcdef0123456789abcdef01234567";
const secret = "https://discord.com/api/webhooks/123456789/test-only-token";
const env = { OPS_ALERT_WEBHOOK_URL: secret };
const MARKER = "never-log-this-marker";

const crash = (at: number, crashes = 1, script = MAIN): TraceBatch => ({
  script,
  at,
  requests: 0,
  errors: 0,
  crashes,
});

// --- log-line matching (semantic, not exact strings) ---

const isSkewDropLine = (line: string) => /skew/i.test(line) && /drop/i.test(line);
const isSkewLine = (line: string) => /skew/i.test(line);
const isMalformedLine = (line: string) => /malformed|invalid/i.test(line) && !/skew/i.test(line);

// Does this line report `n` as a dropped/skew/count figure? JSON lines
// are read by field name; plain-text lines by the number itself.
function reportsCount(line: string, n: number): boolean {
  try {
    const parsed: unknown = JSON.parse(line);
    if (parsed && typeof parsed === "object") {
      const hits: number[] = [];
      const walk = (value: unknown, key: string) => {
        if (typeof value === "number" && /drop|skew|count/i.test(key)) hits.push(value);
        if (value && typeof value === "object") {
          for (const [k, v] of Object.entries(value)) walk(v, k);
        }
      };
      walk(parsed, "");
      if (hits.length > 0) return hits.includes(n);
    }
  } catch {
    // Not JSON: fall through to the text check.
  }
  return new RegExp(`\\b${n}\\b`).test(line);
}

function captureConsole() {
  const lines: string[] = [];
  for (const method of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      lines.push(
        args.map((a) => (typeof a === "string" ? a : (JSON.stringify(a) ?? String(a)))).join(" "),
      );
    });
  }
  return lines;
}

afterEach(() => {
  vi.restoreAllMocks();
});

// --- tail-path fixture: local-fallback worker on a mutable wall clock ---

function workerFixture() {
  let now = t0;
  const send = vi.fn(async () => new Response(null, { status: 200 }));
  const sinkLines: string[] = [];
  const consoleLines = captureConsole();
  const tracker = new AggregateTracker(() => now);
  const worker = createTailWorker({
    fetch: send as unknown as typeof fetch,
    sink: (line: string) => sinkLines.push(line),
    mute: new DeliveryMute(() => now),
    tracker,
    now: () => now,
    sleep: async () => {},
  });
  const contents = () =>
    (send.mock.calls as unknown as [string, RequestInit][])
      .filter(([url]) => url === `${secret}?wait=true`)
      .map(([, init]) => JSON.parse(JSON.parse(init.body as string).content));
  const logLines = () => [...sinkLines, ...consoleLines];
  const skewDropLines = () => logLines().filter(isSkewDropLine);
  const storedCrashes = () =>
    (tracker.snapshot()[MAIN]?.buckets ?? []).reduce((n, b) => n + b.crashes, 0);
  return {
    worker,
    tracker,
    contents,
    logLines,
    skewDropLines,
    storedCrashes,
    setNow: (value: number) => {
      now = value;
    },
  };
}

const fetchTrace = (status: number, at: number) => ({
  scriptName: MAIN,
  scriptVersion: { tag: sha },
  outcome: "ok",
  exceptions: [],
  eventTimestamp: at,
  event: {
    request: { method: "GET", url: "https://example.test/private?token=never-send" },
    response: { status },
  },
  logs: [],
});

const crashTrace = (at: number) => ({
  scriptName: MAIN,
  scriptVersion: { tag: sha },
  outcome: "exception",
  exceptions: [{ name: "BoomError", message: "password=never-send", timestamp: at }],
  eventTimestamp: at,
  event: { queue: "private-queue", batchSize: 1 },
  logs: [],
});

// --- aggregator fixture: Durable Object over fake storage ---

function aggregatorFixture() {
  const store = new Map<string, unknown>();
  const state = {
    storage: {
      get: async (key: string) => structuredClone(store.get(key)),
      put: async (key: string, value: unknown) => {
        store.set(key, structuredClone(value));
      },
    },
  };
  const aggregator = new AlertAggregator(state as never);
  const logLines = captureConsole();
  const observeRaw = (body: string) =>
    aggregator.fetch(new Request("https://aggregator.invalid/observe", { method: "POST", body }));
  const observe = (batch: unknown) => observeRaw(JSON.stringify(batch));
  const storedBuckets = (script = MAIN) => {
    const stored = (store.get("scripts") ?? {}) as Record<
      string,
      { buckets: { at: number; requests: number; errors: number; crashes: number }[] }
    >;
    return stored[script]?.buckets ?? [];
  };
  const storedCrashes = () => storedBuckets().reduce((n, b) => n + b.crashes, 0);
  return { aggregator, observe, observeRaw, storedBuckets, storedCrashes, logLines };
}

describe("tail path: future-skew drops are counted in one accounting line per invocation", () => {
  it("accounts three skewed traces dropped in one invocation as a single line reporting 3, and none of their counts land", async () => {
    const f = workerFixture();
    await f.worker.tail(
      Array.from({ length: SPIKE_MIN_CRASHES - 1 }, () => crashTrace(t0)),
      env,
    );
    expect(f.contents()).toHaveLength(0);

    await f.worker.tail(
      [crashTrace(t0 + DAY_MS), fetchTrace(500, t0 + DAY_MS), fetchTrace(200, t0 + DAY_MS)],
      env,
    );

    // Drop semantics unchanged: no page, prior counts intact.
    expect(f.contents()).toHaveLength(0);
    expect(f.storedCrashes()).toBe(SPIKE_MIN_CRASHES - 1);
    // Exactly one accounting line for the invocation, reporting 3.
    const lines = f.skewDropLines();
    expect(lines).toHaveLength(1);
    expect(reportsCount(lines[0]!, 3)).toBe(true);
    // The accounting carries no trace payload data.
    expect(lines[0]).not.toMatch(/never-send|example\.test|private-queue/);
  });

  it("counts only the skewed traces in a mixed invocation, while the on-time trace lands and pages", async () => {
    const f = workerFixture();
    await f.worker.tail(
      Array.from({ length: SPIKE_MIN_CRASHES - 1 }, () => crashTrace(t0)),
      env,
    );

    await f.worker.tail(
      [crashTrace(t0), crashTrace(t0 + DAY_MS), fetchTrace(200, t0 + DAY_MS)],
      env,
    );

    // The on-time crash is the fifth and pages with exact real counts:
    // the skewed crash and skewed request contribute nothing.
    expect(f.contents()).toHaveLength(1);
    expect(f.contents()[0]).toMatchObject({
      event: "error.spike",
      script: MAIN,
      requests: 0,
      errors: 0,
      crashes: SPIKE_MIN_CRASHES,
    });
    const lines = f.skewDropLines();
    expect(lines).toHaveLength(1);
    expect(reportsCount(lines[0]!, 2)).toBe(true);
  });

  it("reports drops per invocation, not as a running total", async () => {
    const f = workerFixture();
    await f.worker.tail([crashTrace(t0 + DAY_MS)], env);
    expect(f.skewDropLines()).toHaveLength(1);
    expect(reportsCount(f.skewDropLines()[0]!, 1)).toBe(true);

    await f.worker.tail([fetchTrace(500, t0 + DAY_MS)], env);
    const lines = f.skewDropLines();
    expect(lines).toHaveLength(2);
    expect(reportsCount(lines[1]!, 1)).toBe(true);
    expect(f.contents()).toHaveLength(0);
    expect(f.storedCrashes()).toBe(0);
  });

  it("does not account a future-stamped trace from an untracked script as a skew drop", async () => {
    const f = workerFixture();
    await f.worker.tail([{ ...crashTrace(t0 + DAY_MS), scriptName: "some-other-worker" }], env);
    // Untracked scripts never become batches, skewed or not: no
    // positive drop count may be reported for them.
    for (const line of f.skewDropLines()) expect(reportsCount(line, 0)).toBe(true);
    expect(f.contents()).toHaveLength(0);
  });

  it("still counts a merely-late crash and reports no positive drop count for it", async () => {
    const f = workerFixture();
    await f.worker.tail(
      Array.from({ length: SPIKE_MIN_CRASHES - 1 }, () => crashTrace(t0)),
      env,
    );
    f.setNow(t0 + 60_000);
    // Stamped a minute ago, arriving now: late, not skewed.
    await f.worker.tail([crashTrace(t0)], env);

    expect(f.contents()).toHaveLength(1);
    expect(f.contents()[0]).toMatchObject({ event: "error.spike", crashes: SPIKE_MIN_CRASHES });
    for (const line of f.skewDropLines()) expect(reportsCount(line, 0)).toBe(true);
  });

  it("still counts a one-bucket-ahead crash within the slack and reports no positive drop count for it", async () => {
    const f = workerFixture();
    await f.worker.tail(
      Array.from({ length: SPIKE_MIN_CRASHES - 1 }, () => crashTrace(t0)),
      env,
    );
    await f.worker.tail([crashTrace(t0 + 30_000)], env);

    expect(f.contents()).toHaveLength(1);
    expect(f.contents()[0]).toMatchObject({ event: "error.spike", crashes: SPIKE_MIN_CRASHES });
    for (const line of f.skewDropLines()) expect(reportsCount(line, 0)).toBe(true);
  });
});

describe("aggregator /observe: the dead-batch 400 distinguishes skew from malformed", () => {
  it("answers 400 with a skew log line for a future-skewed but otherwise valid batch, and counts nothing", async () => {
    const now = Date.now();
    const f = aggregatorFixture();
    for (let i = 0; i < SPIKE_MIN_CRASHES - 1; i++) {
      expect((await f.observe(crash(now))).status).toBe(200);
    }
    const loggedBefore = f.logLines.length;

    const skewed = await f.observe({ ...crash(now + DAY_MS), note: MARKER });
    expect(skewed.status).toBe(400);

    const fresh = f.logLines.slice(loggedBefore);
    expect(fresh.filter(isSkewLine).length).toBeGreaterThanOrEqual(1);
    expect(fresh.join("\n")).not.toContain(MARKER);
    // Nothing landed and the window survives: the next on-time crash pages.
    expect(f.storedCrashes()).toBe(SPIKE_MIN_CRASHES - 1);
    const page = await f.observe(crash(now + 1_000));
    expect(page.status).toBe(200);
    expect(await page.json()).toMatchObject({ event: "error.spike", crashes: SPIKE_MIN_CRASHES });
  });

  it("answers 400 with a malformed log line (never skew) for structurally invalid batches", async () => {
    const now = Date.now();
    const cases: [string, unknown][] = [
      [
        "errors exceed requests plus crashes",
        { script: MAIN, at: now, requests: 1, errors: 5, crashes: 0, note: MARKER },
      ],
      [
        "unknown script",
        { script: "some-other-worker", at: now, requests: 1, errors: 0, crashes: 0 },
      ],
      ["negative count", { script: MAIN, at: now, requests: -1, errors: 0, crashes: 0 }],
      ["missing timestamp", { script: MAIN, requests: 1, errors: 0, crashes: 0 }],
      ["not an object", [MAIN, now, 1, 0, 0]],
    ];
    for (const [name, body] of cases) {
      const f = aggregatorFixture();
      const response = await f.observe(body);
      expect(response.status, name).toBe(400);
      expect(f.logLines.filter(isMalformedLine).length, name).toBeGreaterThanOrEqual(1);
      expect(f.logLines.filter(isSkewLine), name).toHaveLength(0);
      expect(f.logLines.join("\n"), name).not.toContain(MARKER);
      expect(f.storedBuckets(), name).toHaveLength(0);
      vi.restoreAllMocks();
    }
  });

  it("calls a batch that is both malformed and future-stamped malformed, not skew", async () => {
    const now = Date.now();
    const f = aggregatorFixture();
    const response = await f.observe({
      script: "some-other-worker",
      at: now + DAY_MS,
      requests: 1,
      errors: 0,
      crashes: 0,
    });
    expect(response.status).toBe(400);
    expect(f.logLines.filter(isMalformedLine).length).toBeGreaterThanOrEqual(1);
    expect(f.logLines.filter(isSkewLine)).toHaveLength(0);
  });

  it("answers 400 with a malformed log line (never skew) for an unparseable body", async () => {
    const f = aggregatorFixture();
    const response = await f.observeRaw(`{"script": "${MARKER}",`);
    expect(response.status).toBe(400);
    expect(f.logLines.filter(isMalformedLine).length).toBeGreaterThanOrEqual(1);
    expect(f.logLines.filter(isSkewLine)).toHaveLength(0);
    expect(f.logLines.join("\n")).not.toContain(MARKER);
    expect(f.storedBuckets()).toHaveLength(0);
  });

  it("still counts a merely-late wire batch, with no skew or malformed line", async () => {
    const now = Date.now();
    const f = aggregatorFixture();
    for (let i = 0; i < SPIKE_MIN_CRASHES - 1; i++) await f.observe(crash(now));
    const page = await f.observe(crash(now - 60_000));
    expect(page.status).toBe(200);
    const alert = (await page.json()) as SpikeAlert | null;
    expect(alert).toMatchObject({ event: "error.spike", crashes: SPIKE_MIN_CRASHES });
    expect(f.logLines.filter(isSkewLine)).toHaveLength(0);
    expect(f.logLines.filter(isMalformedLine)).toHaveLength(0);
  });

  it("still counts a one-bucket-ahead wire batch, with no skew or malformed line", async () => {
    const now = Date.now();
    const f = aggregatorFixture();
    for (let i = 0; i < SPIKE_MIN_CRASHES - 1; i++) await f.observe(crash(now));
    const page = await f.observe(crash(now + 30_000));
    expect(page.status).toBe(200);
    const alert = (await page.json()) as SpikeAlert | null;
    expect(alert).toMatchObject({ event: "error.spike", crashes: SPIKE_MIN_CRASHES });
    expect(f.logLines.filter(isSkewLine)).toHaveLength(0);
    expect(f.logLines.filter(isMalformedLine)).toHaveLength(0);
  });
});

describe("runbook: skew-drop observability is documented for operators", () => {
  it("documents the future-skew drop accounting and the skew-vs-malformed 400 in an alert/uptime runbook", () => {
    const runbooks = ["runbook-alerts.md", "runbook-observability.md", "runbook-logs.md"];
    const documented = runbooks.some((name) => {
      const text = readFileSync(
        fileURLToPath(new URL(`../docs/${name}`, import.meta.url).href),
        "utf8",
      );
      return (
        /skew/i.test(text) && /drop/i.test(text) && (/400/.test(text) || /malformed/i.test(text))
      );
    });
    expect(documented).toBe(true);
  });
});

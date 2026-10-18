import { afterEach, describe, expect, it, vi } from "vitest";
import { recordAttempt } from "../src/join/service";
import type { Sql } from "../src/sessions";

// Acceptance: a failed join_attempts write is joinable to the request trace.
//
// `recordAttempt` swallows a throwing INSERT so analytics never break the
// join, and warns with the exception class and outcome only. That warn must
// also carry the attempt's validated request ID as `request_id` — the same
// value the INSERT was about to store in `join_attempts.request_id`, passed
// through the correlation-ID validator (ULID / Ray shapes only) — so an
// operator can join the dropped row to the request log line and the admin
// viewer's request_id lookup. When there is no valid ID (null, or a raw
// string that is not a correlation ID) the field is omitted from the
// serialized warn, and the raw value never surfaces. Nothing else may be
// added: never the exception message or statement text (either can quote a
// live token), and never the attempt's source or Discord ID.
//
// Hermetic: an in-memory Sql double whose INSERT throws on demand. No
// database, no network.

// Valid correlation IDs (the validator's two accepted shapes).
const ULID_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const RAY_ID = "0123456789abcdef-LHR";

// Probes that must never appear in any warn output.
const RAW_REQUEST_ID = "raw-request-probe-must-never-surface";
const ERROR_PROBE = "attempt-insert-error-probe-must-never-surface";
const SOURCE_PROBE = "source-probe-must-never-surface";
const DISCORD_PROBE = "discord-probe-must-never-surface";

function fakeSql({ throwOnInsert = false } = {}) {
  const attempts: {
    outcome: string;
    source: string | null;
    requestId: string | null;
    discordId: string | null;
  }[] = [];
  let insertTries = 0;
  const sql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const head = strings[0] ?? "";
    if (head.includes("INSERT INTO join_attempts")) {
      insertTries += 1;
      if (throwOnInsert) {
        // The message deliberately quotes statement-shaped text and a probe:
        // logging the message (or the statement) anywhere fails these tests.
        throw new TypeError(
          `INSERT INTO join_attempts (outcome, source, request_id, discord_id) failed: ${ERROR_PROBE}`,
        );
      }
      const [outcome, source, requestId, discordId] = values as [
        string,
        string | null,
        string | null,
        string | null,
      ];
      attempts.push({ outcome, source, requestId, discordId });
      return [];
    }
    throw new Error(`fakeSql: unexpected statement: ${head.slice(0, 80)}`);
  }) as unknown as Sql;
  (sql as { unsafe: (q: string) => Promise<unknown> }).unsafe = async () => [];
  return {
    sql,
    attempts,
    get insertTries() {
      return insertTries;
    },
  };
}

type WarnPayload = Record<string, unknown>;

// Capture console.warn calls verbatim. Errors render with their message so a
// `console.warn(err)` slip is caught by the leak checks, not hidden by JSON.
function captureWarns() {
  const calls: unknown[][] = [];
  vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
    calls.push(args);
  });
  const rendered = () =>
    calls
      .map((args) =>
        args
          .map((a) =>
            a instanceof Error ? `${a.name}: ${a.message}` : (JSON.stringify(a) ?? String(a)),
          )
          .join(" "),
      )
      .join("\n");
  return { calls, rendered };
}

// The single warn's payload object (second argument), asserted to exist.
function warnPayload(calls: unknown[][]): WarnPayload {
  expect(calls).toHaveLength(1);
  const [message, payload] = calls[0]!;
  expect(message).toBe("join attempt write failed");
  expect(payload).toBeTypeOf("object");
  expect(payload).not.toBeNull();
  return payload as WarnPayload;
}

// Keys that survive serialization (an undefined `request_id` is omitted by
// JSON, which is exactly the "absent -> omitted" contract).
function serializedKeys(payload: WarnPayload): string[] {
  return Object.keys(JSON.parse(JSON.stringify(payload)) as WarnPayload).sort();
}

function expectNoLeak(rendered: string) {
  expect(rendered).not.toContain(ERROR_PROBE);
  expect(rendered).not.toContain("INSERT INTO join_attempts");
  expect(rendered).not.toContain(SOURCE_PROBE);
  expect(rendered).not.toContain(DISCORD_PROBE);
  expect(rendered).not.toContain(RAW_REQUEST_ID);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("recordAttempt write failure warns with the trace-joining request_id", () => {
  it("carries a ULID requestId as request_id alongside exception class and outcome", async () => {
    const { calls, rendered } = captureWarns();
    const fake = fakeSql({ throwOnInsert: true });
    await expect(
      recordAttempt(fake.sql, {
        outcome: "added",
        source: SOURCE_PROBE,
        requestId: ULID_ID,
        discordId: DISCORD_PROBE,
      }),
    ).resolves.toBeUndefined();
    // Analytics never retry and never break the join: one try, resolved.
    expect(fake.insertTries).toBe(1);
    expect(fake.attempts).toEqual([]);

    const payload = warnPayload(calls);
    expect(payload.request_id).toBe(ULID_ID);
    expect(payload.outcome).toBe("added");
    expect(payload.exception).toBe("TypeError");
    // Exactly these fields: no source, no Discord ID, nothing extra.
    expect(serializedKeys(payload)).toEqual(["exception", "outcome", "request_id"]);
    expectNoLeak(rendered());
  });

  it("carries a Ray-shaped requestId as request_id", async () => {
    const { calls, rendered } = captureWarns();
    const fake = fakeSql({ throwOnInsert: true });
    await expect(
      recordAttempt(fake.sql, {
        outcome: "error",
        source: SOURCE_PROBE,
        requestId: RAY_ID,
        discordId: DISCORD_PROBE,
      }),
    ).resolves.toBeUndefined();
    expect(fake.insertTries).toBe(1);

    const payload = warnPayload(calls);
    expect(payload.request_id).toBe(RAY_ID);
    expect(payload.outcome).toBe("error");
    expect(payload.exception).toBe("TypeError");
    expect(serializedKeys(payload)).toEqual(["exception", "outcome", "request_id"]);
    expectNoLeak(rendered());
  });

  it("omits request_id when requestId is null, and still resolves", async () => {
    const { calls, rendered } = captureWarns();
    const fake = fakeSql({ throwOnInsert: true });
    await expect(
      recordAttempt(fake.sql, {
        outcome: "denied",
        source: SOURCE_PROBE,
        requestId: null,
        discordId: DISCORD_PROBE,
      }),
    ).resolves.toBeUndefined();
    expect(fake.insertTries).toBe(1);
    expect(fake.attempts).toEqual([]);

    const payload = warnPayload(calls);
    expect(payload.request_id).toBeUndefined();
    expect(JSON.stringify(payload)).not.toContain("request_id");
    expect(payload.outcome).toBe("denied");
    expect(payload.exception).toBe("TypeError");
    expect(serializedKeys(payload)).toEqual(["exception", "outcome"]);
    expectNoLeak(rendered());
  });

  it("omits request_id for a raw non-correlation requestId, never logging it raw", async () => {
    const { calls, rendered } = captureWarns();
    const fake = fakeSql({ throwOnInsert: true });
    await expect(
      recordAttempt(fake.sql, {
        outcome: "degraded",
        source: SOURCE_PROBE,
        requestId: RAW_REQUEST_ID,
        discordId: DISCORD_PROBE,
      }),
    ).resolves.toBeUndefined();
    expect(fake.insertTries).toBe(1);

    const payload = warnPayload(calls);
    expect(payload.request_id).toBeUndefined();
    expect(JSON.stringify(payload)).not.toContain("request_id");
    expect(payload.outcome).toBe("degraded");
    expect(payload.exception).toBe("TypeError");
    expect(serializedKeys(payload)).toEqual(["exception", "outcome"]);
    expectNoLeak(rendered());
  });
});

describe("healthy-store controls (no warn, rows land verbatim)", () => {
  it("a succeeding INSERT records the row and warns nothing", async () => {
    const { calls } = captureWarns();
    const fake = fakeSql();
    await expect(
      recordAttempt(fake.sql, {
        outcome: "added",
        source: "web-homepage",
        requestId: ULID_ID,
        discordId: "42",
      }),
    ).resolves.toBeUndefined();
    expect(fake.insertTries).toBe(1);
    expect(fake.attempts).toEqual([
      { outcome: "added", source: "web-homepage", requestId: ULID_ID, discordId: "42" },
    ]);
    expect(calls).toEqual([]);
  });

  it("a null store is a no-op that resolves and warns nothing", async () => {
    const { calls } = captureWarns();
    await expect(
      recordAttempt(null, {
        outcome: "added",
        source: "web-homepage",
        requestId: ULID_ID,
        discordId: "42",
      }),
    ).resolves.toBeUndefined();
    expect(calls).toEqual([]);
  });
});

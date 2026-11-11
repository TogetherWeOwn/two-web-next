import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { describe, expect, it } from "vitest";

// Pinned mirror of the canonical bot-site contract v2 fixture.
//
// Source of truth: two-bot `crates/core/tests/fixtures/bot-site-contract-v2.json`
// (contract `docs/bot-site-contract.md` §2), published at canonical commit
// `91e1bc5dc0c68e9fe8549d7adeae1b2f5b86f5d9` and merged unchanged, so this
// file is copied byte-for-byte to `test/fixtures/bot-site-contract-v2.json`
// and the SHA-256 below must equal the digest recorded on the bot card.
// Any drift on either side fails one of the two CIs.
//
// Shape-only throughout: on this revision the site has no production parser
// for `voice.snapshot`, `event.attendance.read` or `botlog.read` yet (there
// is no `src/bot/attendance-read.ts` on `main`, and the widget parser in
// `src/discord-widget.ts` parses `widget.json`, not this wire). The checks
// below mirror the same fail-closed discipline those parsers must follow —
// whole-payload shape, snowflake / Zulu / bound checks, correlated refusals,
// opaque cursors — without claiming to call a parser that does not exist.
// When a parser lands, replace the matching shape-only check with a real
// parser call. The `implemented == false` pins for the five unlanded verbs
// force exactly that tightening.

const FIXTURE_URL = new URL("./fixtures/bot-site-contract-v2.json", import.meta.url);
const PINNED_SHA256 = "fcdf59304987b96c08b6243e4606cd49d2fa2a64abc7819d1cd831310c207d8f";

const raw = readFileSync(FIXTURE_URL);

type JsonObject = { [key: string]: unknown };

const object = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const SNOWFLAKE = /^\d{1,20}$/;
const ISO_ZULU = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const EVENT_KEY = /^[A-Za-z0-9._:-]{1,200}$/;
const BOTLOG_KINDS = [
  "event.opened",
  "event.updated",
  "event.cancelled",
  "announcement.posted",
  "rank.assigned",
  "member.joined",
];

const loadFixture = (): JsonObject => {
  const parsed: unknown = JSON.parse(raw.toString("utf8"));
  if (!object(parsed) || !object(parsed.verbs)) throw new Error("fixture shape");
  return parsed;
};

const verb = (fixture: JsonObject, name: string): JsonObject => {
  const verbs = fixture.verbs as JsonObject;
  const entry = verbs[name];
  if (!object(entry)) throw new Error(`missing verb ${name}`);
  return entry;
};

const str = (value: unknown): string => {
  if (typeof value !== "string") throw new Error("expected string");
  return value;
};

const arr = (value: unknown): unknown[] => {
  if (!Array.isArray(value)) throw new Error("expected array");
  return value;
};

const isCursor = (value: unknown): boolean =>
  value === null || (typeof value === "string" && value.length > 0);

const isSnowflake = (value: unknown): boolean => typeof value === "string" && SNOWFLAKE.test(value);

function assertZulu(value: unknown): void {
  expect(typeof value).toBe("string");
  expect(ISO_ZULU.test(value as string)).toBe(true);
  expect(Number.isNaN(Date.parse(value as string))).toBe(false);
}

function assertVoiceResult(result: JsonObject): void {
  expect(result.v).toBe(1);
  assertZulu(result.observed_at);
  expect(typeof result.total_in_voice).toBe("number");
  expect(Number.isInteger(result.total_in_voice)).toBe(true);
  expect((result.total_in_voice as number) >= 0).toBe(true);
  for (const room of arr(result.rooms)) {
    if (!object(room)) throw new Error("room shape");
    expect(isSnowflake(room.channel_id)).toBe(true);
    expect(str(room.name).length).toBeGreaterThan(0);
    for (const id of arr(room.member_ids)) expect(isSnowflake(id)).toBe(true);
    // Additive v2 fields are optional: the legacy golden omits them and must
    // pass the same checker so older bot builds stay readable.
    if ("occupied_since" in room) {
      if (room.occupied_since !== null) assertZulu(room.occupied_since);
      else expect(room.occupied_since).toBeNull();
    }
    if ("event_key" in room) expect(EVENT_KEY.test(str(room.event_key))).toBe(true);
  }
}

function snapshotRefusalMatches(refusal: JsonObject, requestId: string): boolean {
  return (
    typeof requestId === "string" &&
    requestId.length > 0 &&
    refusal.request_id === requestId &&
    refusal.ok === false &&
    object(refusal.error) &&
    refusal.error.code === "discord_unavailable" &&
    refusal.error.message === "request refused" &&
    refusal.error.retryable === true &&
    !("result" in refusal)
  );
}

function rankDetailValid(entry: JsonObject): boolean {
  // Shape-only pin of the closed rank ladder: the golden detail is `soldier`.
  // A real ladder parser does not exist on the site side yet, so unknown,
  // missing or malformed details must fail this check rather than render.
  return entry.kind !== "rank.assigned" || entry.detail === "soldier";
}

function assertBotlogPage(request: JsonObject, page: JsonObject): void {
  expect(request.action).toBe("botlog.read");
  expect(isCursor(request.after)).toBe(true);
  expect("after" in request).toBe(true);
  const limit = request.limit;
  expect(typeof limit).toBe("number");
  expect(Number.isInteger(limit)).toBe(true);
  expect((limit as number) >= 1 && (limit as number) <= 200).toBe(true);
  expect(page.v).toBe(1);
  const entries = arr(page.entries);
  expect(entries.length <= (limit as number)).toBe(true);
  for (const entry of entries) {
    if (!object(entry)) throw new Error("entry shape");
    const seq = str(entry.seq);
    expect(seq.length).toBeGreaterThan(0);
    // Cursors are opaque: the goldens are publication labels, never snowflakes,
    // timestamps or integers the site may parse as ordering.
    expect(/^\d+$/.test(seq)).toBe(false);
    expect(/:/.test(seq)).toBe(false);
    assertZulu(entry.at);
    expect(BOTLOG_KINDS).toContain(str(entry.kind));
    expect(rankDetailValid(entry)).toBe(true);
    if ("subject_id" in entry) expect(isSnowflake(entry.subject_id)).toBe(true);
  }
  if (entries.length > 0) {
    const last = entries[entries.length - 1] as JsonObject;
    expect(page.next).toBe(last.seq);
  } else {
    expect(page.next).toEqual(request.after);
  }
}

describe("bot-site contract v2 pinned mirror", () => {
  it("matches the pinned SHA-256 byte-for-byte", () => {
    expect(createHash("sha256").update(raw).digest("hex")).toBe(PINNED_SHA256);
    expect(raw.length).toBeGreaterThan(0);
    // The copy carries no tracker ids: it is byte-identical to the bot repo.
    expect(raw.toString("utf8")).not.toMatch(/TWO-\d+|PAP-\d+/);
  });

  it("carries exactly the six bot-origin verbs and no echo.frozen", () => {
    const fixture = loadFixture();
    expect(typeof fixture.comment).toBe("string");
    expect(Object.keys(fixture.verbs as JsonObject).sort()).toEqual(
      [
        "botlog.read",
        "event.attendance.read",
        "place_offer.send",
        "reminder.send",
        "voice.move_member",
        "voice.snapshot",
      ].sort(),
    );
    expect(raw.toString("utf8")).not.toContain("echo.frozen");
  });

  it("pins idempotency requirements and unlanded verbs", () => {
    const fixture = loadFixture();
    const expected: Record<string, boolean> = {
      "voice.snapshot": false,
      "voice.move_member": false,
      "reminder.send": true,
      "place_offer.send": true,
      "event.attendance.read": false,
      "botlog.read": false,
    };
    for (const [name, needsKey] of Object.entries(expected)) {
      expect(verb(fixture, name).needs_idempotency_key).toBe(needsKey);
    }
    expect(verb(fixture, "voice.snapshot").implemented).toBe(true);
    for (const name of [
      "voice.move_member",
      "reminder.send",
      "place_offer.send",
      "event.attendance.read",
      "botlog.read",
    ]) {
      expect(verb(fixture, name).implemented).toBe(false);
    }
  });

  it("accepts voice.snapshot full and legacy shapes with a correlated refusal", () => {
    const fixture = loadFixture();
    const snapshot = verb(fixture, "voice.snapshot");
    expect((snapshot.request as JsonObject).action).toBe("voice.snapshot");
    const results = snapshot.results as JsonObject;
    assertVoiceResult(results.full as JsonObject);
    assertVoiceResult(results.legacy as JsonObject);
    const requestId = str(snapshot.request_id);
    expect(requestId.length).toBeGreaterThan(0);
    expect(snapshotRefusalMatches(results.refusal as JsonObject, requestId)).toBe(true);
    // Correlation is exact: a dropped, mismatched or malformed id must fail.
    expect(snapshotRefusalMatches({}, requestId)).toBe(false);
    expect(
      snapshotRefusalMatches(
        { ...(results.refusal as JsonObject), request_id: "00000000000000000000000002" },
        requestId,
      ),
    ).toBe(false);
    expect(snapshotRefusalMatches(results.refusal as JsonObject, "")).toBe(false);
  });

  it("accepts event.attendance.read shape-only (no site parser yet)", () => {
    const fixture = loadFixture();
    const attendance = verb(fixture, "event.attendance.read");
    const request = attendance.request as JsonObject;
    expect(request.action).toBe("event.attendance.read");
    expect(EVENT_KEY.test(str(request.event_key))).toBe(true);
    const read = (attendance.results as JsonObject).read as JsonObject;
    expect(read.v).toBe(1);
    expect(read.event_key).toBe(request.event_key);
    const window = read.window as JsonObject;
    assertZulu(window.starts_at);
    assertZulu(window.ends_at);
    expect(Date.parse(window.ends_at as string) > Date.parse(window.starts_at as string)).toBe(
      true,
    );
    expect(Number.isInteger(read.threshold_minutes)).toBe(true);
    expect((read.threshold_minutes as number) > 0).toBe(true);
    expect(Number.isInteger(read.peak_concurrent)).toBe(true);
    expect((read.peak_concurrent as number) >= 0).toBe(true);
    expect(arr(read.rooms).length).toBeLessThanOrEqual(100);
    for (const room of arr(read.rooms)) {
      if (!object(room)) throw new Error("attendance room shape");
      expect(isSnowflake(room.channel_id)).toBe(true);
      const name = str(room.name_at_close);
      expect(name.length >= 1 && name.length <= 100).toBe(true);
    }
    expect(arr(read.members).length).toBeLessThanOrEqual(500);
    for (const member of arr(read.members)) {
      if (!object(member)) throw new Error("attendance member shape");
      expect(isSnowflake(member.discord_id)).toBe(true);
      expect(Number.isInteger(member.minutes)).toBe(true);
      expect((member.minutes as number) >= 0).toBe(true);
      expect(Number.isInteger(member.sessions)).toBe(true);
      expect((member.sessions as number) >= 1).toBe(true);
      if (member.first_joined_at !== null) assertZulu(member.first_joined_at);
    }
    expect(typeof read.final).toBe("boolean");
    expect(((attendance.results as JsonObject).not_found as JsonObject).outcome).toBe("not_found");
  });

  it("accepts botlog.read pages with opaque cursors and retained empty position", () => {
    const fixture = loadFixture();
    const botlog = verb(fixture, "botlog.read");
    expect(arr(botlog.kinds)).toEqual(BOTLOG_KINDS);
    const initial = botlog.initial_request as JsonObject;
    expect(initial.after).toBeNull();
    expect("after" in initial).toBe(true);
    const continuation = botlog.request as JsonObject;
    expect(typeof continuation.after).toBe("string");
    expect((continuation.after as string).length).toBeGreaterThan(0);
    const results = botlog.results as JsonObject;
    const firstPage = results.first_page as JsonObject;
    const initiallyEmpty = results.initially_empty as JsonObject;
    const page = results.page as JsonObject;
    const empty = results.empty as JsonObject;
    expect(arr(firstPage.entries).length).toBeGreaterThan(0);
    expect(arr(initiallyEmpty.entries)).toEqual([]);
    expect(arr(page.entries).length).toBeGreaterThan(0);
    expect(arr(empty.entries)).toEqual([]);
    assertBotlogPage(initial, firstPage);
    assertBotlogPage(initial, initiallyEmpty);
    assertBotlogPage(continuation, page);
    assertBotlogPage(continuation, empty);
    expect(firstPage.next).toBe(continuation.after);
    expect(initiallyEmpty.next).toBeNull();
    // Original event time may decrease: the page golden is intentionally not
    // monotonic, and the site must not require sorted `at` values.
    const ats = arr(page.entries).map((entry) => (entry as JsonObject).at as string);
    const sorted = [...ats].sort();
    expect(ats).not.toEqual(sorted);
    // The rank golden carries the valid ladder detail, and bad details fail.
    const rank = arr(page.entries).find(
      (entry): entry is JsonObject => object(entry) && entry.kind === "rank.assigned",
    ) as JsonObject;
    expect(rank.detail).toBe("soldier");
    expect(rankDetailValid({ ...rank, detail: "ember-3" })).toBe(false);
    expect(rankDetailValid({ ...rank, detail: true })).toBe(false);
    const noDetail: JsonObject = { ...rank };
    delete noDetail.detail;
    expect(rankDetailValid(noDetail)).toBe(false);
    // Cursor shape is explicit null-or-nonempty-string only.
    expect(isCursor(null)).toBe(true);
    expect(isCursor("test-publication-origin")).toBe(true);
    expect(isCursor("")).toBe(false);
    expect(isCursor(0)).toBe(false);
    expect(isCursor(false)).toBe(false);
  });
});

import { createHash, createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  InvalidActionRequestError,
  announcementPayload,
  eventUpsertPayload,
} from "../src/bot/actions";
import { encodeCanonicalJson, signInternalAction } from "../src/bot/signer";

// Local fixtures only: no bot client, environment credentials, network or database.
const KEY_ID = "unicode-fixture";
const SECRET = "fixture-only-unicode-signing-key-do-not-use";
const TIMESTAMP = 1787173135;
const NONCE = "9f1c0a2b3d4e5f60718293a4b5c6d7e8";

const event = {
  eventKey: "unicode-fixture",
  name: "Fixture event",
  startsAt: new Date("2026-09-01T18:00:00Z"),
  endsAt: new Date("2026-09-01T19:00:00Z"),
  location: "https://example.invalid/fixture",
  description: "Fixture description",
};

// These wire strings are constructed from fixture values, never from the shipped
// builder or encoder. Field order, unescaped Unicode and slashes are byte contracts.
const boundaries = [
  {
    label: "announcement body",
    field: "body",
    limit: 2000,
    build: (value: string) => announcementPayload({ channelKey: "fixture-channel", body: value }),
    wire: (value: string) =>
      `{"action":"announcement.post","channel_key":"fixture-channel","body":"${value}"}`,
  },
  {
    label: "event name",
    field: "name",
    limit: 100,
    build: (value: string) => eventUpsertPayload({ ...event, name: value }),
    wire: (value: string) =>
      `{"action":"event.upsert","event_key":"unicode-fixture","name":"${value}",` +
      '"starts_at":"2026-09-01T18:00:00Z","ends_at":"2026-09-01T19:00:00Z",' +
      '"location":"https://example.invalid/fixture","description":"Fixture description"}',
  },
  {
    label: "event description",
    field: "description",
    limit: 1000,
    build: (value: string) => eventUpsertPayload({ ...event, description: value }),
    wire: (value: string) =>
      '{"action":"event.upsert","event_key":"unicode-fixture","name":"Fixture event",' +
      '"starts_at":"2026-09-01T18:00:00Z","ends_at":"2026-09-01T19:00:00Z",' +
      `"location":"https://example.invalid/fixture","description":"${value}"}`,
  },
];

const alphabets = [
  {
    label: "astral",
    value: (limit: number) => "🚀".repeat(limit),
    codeUnits: (limit: number) => 2 * limit,
    bytes: (limit: number) => 4 * limit,
  },
  {
    label: "mixed ASCII/BMP/astral",
    value: (limit: number) => "Aé🚀".repeat(Math.floor(limit / 3)) + "A".repeat(limit % 3),
    codeUnits: (limit: number) => 4 * Math.floor(limit / 3) + (limit % 3),
    bytes: (limit: number) => 7 * Math.floor(limit / 3) + (limit % 3),
  },
];

describe.each(boundaries)("$label code-point boundary", ({ field, limit, build, wire }) => {
  describe.each(alphabets)("$label", ({ value, codeUnits, bytes }) => {
    it("preserves the exact-limit value through canonical JSON and reference signing", async () => {
      const input = value(limit);
      expect([...input]).toHaveLength(limit);
      expect(input).toHaveLength(codeUnits(limit));
      expect(Buffer.byteLength(input, "utf8")).toBe(bytes(limit));
      expect(input.length).toBeGreaterThan(limit);

      const payload = build(input);
      expect(payload[field]).toBe(input);
      const body = encodeCanonicalJson(payload);
      const expectedBody = wire(input);
      expect(body).toBe(expectedBody);
      expect(JSON.parse(body)).toEqual(payload);
      expect(JSON.parse(body)[field]).toBe(input);
      expect(Buffer.from(body, "utf8")).toEqual(Buffer.from(expectedBody, "utf8"));

      // Independent node:crypto reference hashes the expected UTF-8 wire bytes,
      // not the output of encodeCanonicalJson or the signer's digest helper.
      const digest = createHash("sha256").update(Buffer.from(expectedBody, "utf8")).digest("hex");
      const canonical = `POST\n/internal/actions\n${TIMESTAMP}\n${NONCE}\n${digest}`;
      const signature = createHmac("sha256", Buffer.from(SECRET, "utf8"))
        .update(Buffer.from(canonical, "utf8"))
        .digest("hex");
      expect(await signInternalAction(KEY_ID, SECRET, body, TIMESTAMP, NONCE)).toEqual({
        "X-TWO-Key-Id": KEY_ID,
        "X-TWO-Timestamp": String(TIMESTAMP),
        "X-TWO-Nonce": NONCE,
        "X-TWO-Signature": `sha256=${signature}`,
      });
      expect(payload[field]).toBe(input);
    });

    it.each(["é", "🚀"])("refuses N+1 after appending %s", (extra) => {
      const input = value(limit) + extra;
      expect([...input]).toHaveLength(limit + 1);
      expect(() => build(input)).toThrow(InvalidActionRequestError);
      expect(() => build(input)).toThrow(`this one is ${limit + 1}.`);
    });
  });
});

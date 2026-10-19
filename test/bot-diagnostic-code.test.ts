// Closed diagnosticCode vocabulary pins.
//
// `diagnosticCode` classifies untrusted provider codes into a closed
// vocabulary shared by transport logs and queue failure diagnostics.
// Provider strings can echo secrets, so unknown values collapse to the
// fixed literal "unknown": never cleaned, truncated, or alphabet-filtered,
// and the output carries nothing derived from its input.
//
// Hermetic: pure function. No live bot, no database, synthetic canaries only.
import { describe, expect, it } from "vitest";
import { diagnosticCode } from "../src/bot/diagnostic-code";

const MEMBERS = [
  "malformed",
  "unauthorized",
  "stale_request",
  "action_not_allowed",
  "replayed",
  "in_progress",
  "discord_rejected",
  "rate_limited",
  "internal",
  "discord_unavailable",
  "upstream_timeout",
];

const CANARY = "CANARY-DIAGNOSTIC-CODE-7q2m8z4t";

const NEAR_MISSES = [
  // Case variants.
  "Malformed",
  "MALFORMED",
  "Rate_Limited",
  "RATE_LIMITED",
  "Internal",
  "UNKNOWN",
  // The fallback literal itself is not a member: it collapses by fallback.
  "unknown",
  // Whitespace and control affixes.
  " malformed",
  "malformed ",
  "malformed\n",
  "\tmalformed",
  "rate_limited ",
  " internal",
  // Truncations and affixes.
  "malforme",
  "alformed",
  "malformedx",
  "xmalformed",
  "unauthorizedd",
  "unauthorize",
  "internals",
  "replay",
  // Separator swaps.
  "stale-request",
  "stale request",
  "staleRequest",
  "action-not-allowed",
  "action not allowed",
  "in-progress",
  "inprogress",
  "discord-rejected",
  "discord.rejected",
  "discordrejected",
  "rate-limited",
  "rate limited",
  "rateLimited",
  "upstream-timeout",
  "upstreamTimeout",
  "discord-unavailable",
  "discordunavailable",
  // Lookalikes.
  "unauthorised",
  "re-played",
];

const SECRET_BEARING = [
  CANARY,
  `malformed:${CANARY}`,
  `${CANARY}:rate_limited`,
  `Bearer ${CANARY}`,
  `{"code":"internal","token":"${CANARY}"}`,
  `token=${CANARY}&code=internal`,
  `discord_token_${CANARY}`,
  `webhook https://discord.example/api/webhooks/${CANARY}`,
  `pem-private-key-block(${CANARY})`,
  `SELECT * FROM sessions WHERE token='${CANARY}'; DROP TABLE sessions;--`,
  CANARY.repeat(10),
  "x".repeat(1000),
];

const HOSTILE_STRINGS = [
  // Object-prototype lookups must not pass: membership is a Set, not a map.
  "__proto__",
  "constructor",
  "prototype",
  "toString",
  "hasOwnProperty",
  "valueOf",
  // Stringified primitives are not members.
  "0",
  "123",
  "true",
  "false",
  "null",
  "undefined",
  "NaN",
  "Infinity",
  // Unicode and control smuggling.
  "malformed\u200b",
  "ｍalformed",
  "internal\u0000",
  "rate_limited🔥",
  "internal\nDROP TABLE jobs;--",
  "bad code!\nDROP",
  "a b/c:d",
  "foo.bar-baz_1",
];

const UNKNOWN_STRINGS = [...NEAR_MISSES, ...SECRET_BEARING, ...HOSTILE_STRINGS];

const NON_STRINGS: unknown[] = [
  undefined,
  null,
  0,
  1,
  -1,
  Number.NaN,
  true,
  false,
  {},
  [],
  ["malformed"],
  { code: "internal" },
  Symbol("internal"),
  Symbol.for("rate_limited"),
  10n,
  () => "internal",
];

describe("diagnosticCode round-trips the closed 11-member vocabulary", () => {
  it("pins the vocabulary to exactly 11 distinct members", () => {
    expect(MEMBERS).toHaveLength(11);
    expect(new Set(MEMBERS).size).toBe(11);
  });

  it.each(MEMBERS)("round-trips %s", (code) => {
    expect(diagnosticCode(code)).toBe(code);
  });
});

describe("diagnosticCode collapses unknown inputs to exactly unknown", () => {
  it("maps the empty string to unknown", () => {
    expect(diagnosticCode("")).toBe("unknown");
  });

  it.each(NON_STRINGS)("maps non-string %p to unknown", (code) => {
    expect(diagnosticCode(code)).toBe("unknown");
  });

  it.each(NEAR_MISSES)("maps near-miss %p to unknown", (code) => {
    expect(diagnosticCode(code)).toBe("unknown");
  });

  it.each(SECRET_BEARING)("maps secret-bearing input to unknown without the canary", (code) => {
    const out = diagnosticCode(code);
    expect(out).toBe("unknown");
    expect(out).not.toContain(CANARY);
  });

  it.each(HOSTILE_STRINGS)("maps hostile string %p to unknown", (code) => {
    expect(diagnosticCode(code)).toBe("unknown");
  });

  it("collapses every distinct unknown input to one identical fixed string", () => {
    // The no-substring property is input-independence: the fallback literal
    // can coincide with an input substring (e.g. the input "unknown"), so
    // disjointness is unprovable and the wrong property. Identical output
    // across distinct inputs proves nothing input-derived survives.
    const outputs = new Set(UNKNOWN_STRINGS.map((code) => diagnosticCode(code)));
    expect(outputs).toEqual(new Set(["unknown"]));
  });

  it("is stable: classifying twice changes nothing", () => {
    for (const code of [...MEMBERS, "", ...UNKNOWN_STRINGS, ...NON_STRINGS]) {
      expect(diagnosticCode(diagnosticCode(code))).toBe(diagnosticCode(code));
    }
  });

  it("keeps the unknown corpus genuinely outside the vocabulary", () => {
    // Corpus hygiene: a member typed into the unknown lists would still fail
    // loudly against this implementation, but would pass vacuously against a
    // fallback-for-everything regression. Pin the corpus against the list.
    expect(UNKNOWN_STRINGS.length).toBeGreaterThan(0);
    for (const code of UNKNOWN_STRINGS) {
      expect(MEMBERS).not.toContain(code);
    }
  });
});

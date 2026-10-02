// Pure public feed builders only: no app, database, network or clock reads.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { eventIcs, eventsIcsCollection } from "../src/events/feeds";

type EventRow = Parameters<typeof eventIcs>[0];
const OPTIONS = { seed: 11432, numRuns: 50 };
const APP_URL = "https://next.example.test";
const enc = new TextEncoder();
const FIELDS = [
  { field: "title", prefix: "SUMMARY:" },
  { field: "description", prefix: "DESCRIPTION:" },
  { field: "location", prefix: "LOCATION:" },
] as const;

const row = (overrides: Partial<EventRow> = {}): EventRow => ({
  id: 1,
  eventKey: "01J0000000000000000000ABCD",
  title: "Game night",
  game: null,
  description: "Bring stims.",
  location: "Voice: General",
  timezone: "UTC",
  startsAt: new Date("2026-07-15T18:00:00Z"),
  endsAt: new Date("2026-07-15T20:00:00Z"),
  createdAt: new Date("2026-07-01T12:00:00Z"),
  updatedAt: new Date("2026-07-01T12:00:00Z"),
  capacity: null,
  status: "published",
  rsvpOpen: true,
  icsSequence: 0n,
  syncRevision: 1,
  syncedRevision: 0,
  discordEventId: null,
  discordSyncFailedAt: null,
  discordSyncFailureCode: null,
  agentGrantId: null,
  proofMarker: null,
  agentVersion: 1,
  createdBy: null,
  recurrenceFrequency: null,
  recurrenceCount: null,
  recurrenceEndsOn: null,
  parentEventId: null,
  recurrenceIndex: null,
  ...overrides,
});

// Unicode scalars, excluding surrogates, replacement characters and noncharacters.
// The ASCII boundary generator uses letters so escaping cannot move the target.
const codePoints = [
  fc.integer({ min: 0x41, max: 0x5a }),
  fc.integer({ min: 0xa0, max: 0x7ff }),
  fc
    .oneof(fc.integer({ min: 0x800, max: 0xd7ff }), fc.integer({ min: 0xe000, max: 0xfffc }))
    .filter((cp) => cp < 0xfdd0 || cp > 0xfdef),
  fc.integer({ min: 0x10000, max: 0x10fffd }).filter((cp) => (cp & 0xffff) < 0xfffe),
].map((arbitrary) => arbitrary.map((cp) => String.fromCodePoint(cp)));

function checkedLogicalLines(body: string): string[] {
  expect(body.endsWith("\r\n")).toBe(true);
  expect(body.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/);
  for (const line of body.split("\r\n").slice(0, -1)) {
    expect(enc.encode(line).length).toBeLessThanOrEqual(75);
    expect(line).not.toMatch(/[\uD800-\uDFFF�]/u);
  }
  // RFC 5545 unfolding removes the CRLF and exactly one continuation whitespace.
  return body
    .replace(/\r\n[ \t]/g, "")
    .split("\r\n")
    .slice(0, -1);
}

// Independent TEXT reader: reject bare delimiters/unknown escapes rather than
// mirroring the builder's chained replacements (notably for literal \\n text).
function readText(value: string): string {
  let out = "";
  for (let i = 0; i < value.length; i++) {
    const char = value[i]!;
    if (char !== "\\") {
      if (/[;,\r\n]/.test(char)) throw new Error("Unescaped ICS TEXT delimiter");
      out += char;
      continue;
    }
    const escaped = value[++i];
    if (escaped === "n" || escaped === "N") out += "\n";
    else if (escaped === "\\" || escaped === "," || escaped === ";") out += escaped;
    else throw new Error(`Invalid ICS TEXT escape: ${escaped}`);
  }
  return out;
}

const normalized = (value: string) => value.replace(/\r\n|\r/g, "\n");
const values = (lines: string[], prefix: string) =>
  lines
    .filter((line) => line.startsWith(prefix))
    .map((line) => readText(line.slice(prefix.length)));

function expectRoundTrip(body: string, event: EventRow): void {
  const lines = checkedLogicalLines(body);
  expect(values(lines, "SUMMARY:")).toEqual([normalized(event.title)]);
  expect(values(lines, "DESCRIPTION:")).toEqual([
    normalized(event.description!),
    normalized(event.title),
  ]);
  expect(values(lines, "LOCATION:")).toEqual([normalized(event.location!)]);
}

const builders = [
  { name: "per-event", render: (event: EventRow) => eventIcs(event, APP_URL) },
  { name: "collection", render: (event: EventRow) => eventsIcsCollection([event], APP_URL) },
];

const mixedText = fc
  .array(
    fc.oneof(
      ...codePoints,
      fc.constantFrom(",", ";", "\\", "\n", "\r\n", "\r", "\\n", "\\N", " ", "\t", "é", "👩‍💻"),
    ),
    { minLength: 1, maxLength: 100 },
  )
  .map(
    (tokens) =>
      // Force all supported escapes, literal backslash-n/N and several folds even
      // when shrinking selects a short token array. Preserve leading whitespace.
      ` \t,;\\literal\\n\\N\nCR\rCRLF\r\n${tokens.join("")}${"é中😀".repeat(40)} trailing `,
  );

describe("seeded ICS octet and TEXT properties", () => {
  for (const [index, point] of codePoints.entries()) {
    const width = index + 1;
    it(`${width}-byte scalars at 74/75/76 octets on first and repeated continuation lines`, () => {
      fc.assert(
        fc.property(point, (char) => {
          expect(enc.encode(char).length).toBe(width);
          for (const { field, prefix } of FIELDS) {
            for (const boundary of [74, 75, 76]) {
              // Continuations spend one of their 75 octets on the leading space.
              for (const continuation of [0, 1, 3]) {
                const octets = boundary + 74 * continuation;
                const value = "x".repeat(octets - enc.encode(prefix).length - width) + char;
                expect(enc.encode(prefix + value).length).toBe(octets);
                const event = row({ [field]: value });
                const body = eventIcs(event, APP_URL);
                expectRoundTrip(body, event);
                // DESCRIPTION also appears in VALARM; inspect the first property.
                const start = body.indexOf(`\r\n${prefix}`) + 2;
                const physical = body.slice(start).split("\r\n");
                const end = physical.findIndex((line, i) => i > 0 && !line.startsWith(" "));
                const folded = physical.slice(0, end);
                expect(folded.length).toBeGreaterThanOrEqual(continuation + 1);
                if (continuation === 0 && boundary <= 75) expect(folded).toHaveLength(1);
                if (boundary === 76) expect(folded.length).toBeGreaterThan(continuation + 1);
              }
            }
          }
        }),
        OPTIONS,
      );
    });
  }

  for (const { name, render } of builders) {
    it(`${name}: round-trips generated Unicode and escaped TEXT through repeated folds`, () => {
      fc.assert(
        fc.property(mixedText, mixedText, mixedText, (title, description, location) => {
          const event = row({ title, description, location });
          const body = render(event);
          expect(body.split("\r\n").filter((line) => line.startsWith(" ")).length).toBeGreaterThan(
            12,
          );
          expectRoundTrip(body, event);
        }),
        OPTIONS,
      );
    });
  }

  it.each(["\n", "\r", "\r\n"])(
    "normalizes newline %j without confusing literal backslash-n/N",
    (newline) => {
      const text = `,;\\n\\N\\${newline}é中😀${newline} tail `;
      const event = row({ title: text, description: text, location: text });
      const body = eventIcs(event, APP_URL);
      expect(checkedLogicalLines(body)).toContain("SUMMARY:\\,\\;\\\\n\\\\N\\\\\\né中😀\\n tail ");
      expectRoundTrip(body, event);
    },
  );
});

import { describe, expect, it } from "vitest";
import { parseEventForm, parseHumanEventForm, ValidationError } from "../src/admin/validation";

// parseHumanEventForm is the browser-form entry point: CRLF and lone CR in the
// seven free-text fields become LF before the existing trim/count/store steps.
// parseEventForm stays the raw machine parser and keeps CRLF untouched.

const base = {
  title: "Game night",
  timezone: "UTC",
  starts_at: "2030-01-01 18:00",
  ends_at: "2030-01-01 19:00",
};
const fields = [
  { field: "title", max: 100, key: "title" },
  { field: "game", max: 100, key: "game" },
  { field: "location", max: 255, key: "location" },
  { field: "organizer_name", max: 500, key: "organizer_name" },
  { field: "description", max: 1000, key: "description" },
  { field: "accessibility_notes", max: 1000, key: "accessibilityNotes" },
  { field: "join_instructions", max: 5000, key: "join_instructions" },
] as const;
const optional = fields.filter((f) => f.field !== "title");
const breaks = [
  { label: "LF", value: "\n" },
  { label: "CR", value: "\r" },
  { label: "CRLF", value: "\r\n" },
] as const;
const patterns = [
  { label: "ASCII", characters: ["x"] },
  { label: "astral", characters: ["😀"] },
  { label: "mixed BMP/astral", characters: ["界", "😀", "x"] },
];

function text(characters: string[], count: number): string {
  return Array.from({ length: count }, (_, i) => characters[i % characters.length]).join("");
}
function errorsOf(run: () => unknown): Record<string, string> {
  try {
    run();
  } catch (e) {
    if (e instanceof ValidationError) return e.fields;
    throw e;
  }
  throw new Error("expected a ValidationError");
}
function outcome(run: () => unknown): unknown {
  try {
    return { ok: run() };
  } catch (e) {
    if (e instanceof ValidationError) return { fields: e.fields };
    throw e;
  }
}
// N code points once breaks are normalised: one separator plus filler.
function boundaryText(characters: string[], n: number, sep: string): string {
  return `${text(characters, 1)}${sep}${text(characters, n - 2)}`;
}
function human(extra: Record<string, unknown>) {
  return parseHumanEventForm({ ...base, ...extra });
}
function raw(extra: Record<string, unknown>) {
  return parseEventForm({ ...base, ...extra });
}

describe("parseHumanEventForm newline normalization", () => {
  for (const { field, key } of fields) {
    describe(field, () => {
      for (const { label, value } of breaks) {
        it(`stores ${label} as LF`, () => {
          const input = { [field]: `first${value}second` };
          expect((human(input) as Record<string, unknown>)[key]).toBe("first\nsecond");
        });
      }
      it("normalises CR followed by CRLF to two LFs and keeps blank lines", () => {
        const input = { [field]: "a\r\r\nb\n\rc\r\n\r\nd" };
        expect((human(input) as Record<string, unknown>)[key]).toBe("a\n\nb\n\nc\n\nd");
      });
      it("trims surrounding whitespace, tabs and edge breaks after normalising", () => {
        const input = { [field]: " \t\r\n a\r\n\tb \t\r" };
        expect((human(input) as Record<string, unknown>)[key]).toBe("a\n\tb");
      });
      it("treats a break-only value as blank", () => {
        const input = { [field]: "\r\n\r \t\n" };
        if (field === "title") {
          expect(errorsOf(() => human(input))).toEqual({ title: "Give the event a title." });
        } else {
          expect((human(input) as Record<string, unknown>)[key]).toBeNull();
        }
      });
      for (const { label, value } of breaks) {
        for (const pattern of patterns) {
          const max = fields.find((f) => f.field === field)!.max;
          it(`counts ${label} as one character at ${max} and ${max + 1} (${pattern.label})`, () => {
            const ok = boundaryText(pattern.characters, max, value);
            const tooLong = boundaryText(pattern.characters, max + 1, value);
            const stored = (human({ [field]: ok }) as Record<string, unknown>)[key] as string;
            expect([...stored]).toHaveLength(max);
            expect(stored).toBe(ok.replace(/\r\n|\r/g, "\n"));
            expect(Object.keys(errorsOf(() => human({ [field]: tooLong })))).toEqual([field]);
          });
        }
      }
      it("keeps the raw parser counting CRLF as two characters at the same boundary", () => {
        const max = fields.find((f) => f.field === field)!.max;
        const input = { [field]: boundaryText(["x"], max, "\r\n") };
        expect(Object.keys(errorsOf(() => raw(input)))).toEqual([field]);
        expect([...(human(input) as unknown as Record<string, string>)[key]!]).toHaveLength(max);
      });
      it("keeps the raw parser storing CRLF and lone CR unchanged", () => {
        for (const value of ["\r\n", "\r"]) {
          const parsed = raw({ [field]: `first${value}second` }) as unknown as Record<
            string,
            unknown
          >;
          expect(parsed[key]).toBe(`first${value}second`);
        }
      });
    });
  }

  describe("raw forbidden controls", () => {
    const forbidden = [
      { label: "NUL", value: "\u0000" },
      { label: "backspace", value: "\u0008" },
      { label: "DEL", value: "\u007f" },
      { label: "zero-width space", value: "​" },
      { label: "BOM", value: "﻿" },
    ];
    for (const { field } of fields) {
      for (const { label, value } of forbidden) {
        it(`rejects ${label} in ${field} alongside CRLF`, () => {
          const input = { [field]: `a\r\n${value}b` };
          expect(errorsOf(() => human(input))[field]).toBe(
            "Remove control or invisible characters.",
          );
          expect(errorsOf(() => raw(input))[field]).toBe("Remove control or invisible characters.");
        });
      }
      it(`rejects a leading or trailing BOM in ${field} that trim would remove`, () => {
        for (const value of ["﻿a\r\nb", "a\r\nb﻿", "\r\n﻿"]) {
          const input = { [field]: value };
          expect(errorsOf(() => human(input))[field]).toBe(
            "Remove control or invisible characters.",
          );
        }
      });
    }
  });

  describe("blank, null, omission and non-string semantics", () => {
    for (const { field, key } of optional) {
      it(`${field}: omitted, null, empty and whitespace all store null`, () => {
        for (const value of [undefined, null, "", "  \t "]) {
          const parsed = human({ [field]: value }) as unknown as Record<string, unknown>;
          expect(parsed[key] ?? null).toBeNull();
        }
      });
      it(`${field}: refuses non-strings exactly as the raw parser does`, () => {
        for (const value of [5, true, {}, ["a\r\nb"]]) {
          const input = { [field]: value };
          const errors = errorsOf(() => human(input));
          expect(errors[field]).toBe(`The ${field} must be text.`);
          expect(errors).toEqual(errorsOf(() => raw(input)));
        }
      });
    }
    it("refuses a missing or non-string title like the raw parser", () => {
      for (const value of [undefined, null, "", 5, {}]) {
        const errors = errorsOf(() => human({ title: value }));
        expect(errors.title).toBe("Give the event a title.");
        expect(errors).toEqual(errorsOf(() => raw({ title: value })));
      }
    });
  });

  describe("fields outside the seven stay on existing policy", () => {
    it("leaves join_url handling identical to the raw parser", () => {
      const prefix = "https://example.com/";
      const inputs = [
        `${prefix}a`,
        `${prefix}a\r\n`,
        `${prefix}a\r\nb`,
        `${prefix}a\rb`,
        `${prefix}${"a".repeat(2048 - prefix.length - 2)}\r\n`,
        `${prefix}${"a".repeat(2048 - prefix.length)}`,
        `${prefix}${"a".repeat(2049 - prefix.length)}`,
        "ftp://example.com/",
        "not a url",
      ];
      for (const join_url of inputs) {
        expect(outcome(() => human({ join_url }))).toEqual(outcome(() => raw({ join_url })));
      }
      expect(
        errorsOf(() => human({ join_url: `${prefix}${"a".repeat(2049 - prefix.length)}` }))
          .join_url,
      ).toBe("Keep the public joining link to 2048 characters.");
      expect(errorsOf(() => human({ join_url: "ftp://example.com/" })).join_url).toBe(
        "Enter a valid public HTTP or HTTPS link without sign-in credentials.",
      );
    });
    it("leaves timezone handling identical to the raw parser", () => {
      for (const timezone of [
        undefined,
        null,
        "",
        " UTC\r\n",
        "Europe/London\r",
        "UTC\r\nx",
        "Mars/Base",
      ]) {
        expect(outcome(() => human({ timezone }))).toEqual(outcome(() => raw({ timezone })));
      }
      expect(human({ timezone: undefined }).timezone).toBe("Europe/London");
      expect(errorsOf(() => human({ timezone: "Mars/Base" })).timezone).toBe(
        "Unknown timezone: Mars/Base.",
      );
      expect(errorsOf(() => human({ timezone: 5 })).timezone).toBe("The timezone must be text.");
    });
  });

  it("returns the same result as the raw parser when no field contains a CR", () => {
    const input = {
      ...base,
      game: "Chess",
      location: "Discord",
      organizer_name: "Ada",
      description: "line one\nline two",
      accessibility_notes: "step free",
      join_url: "https://example.com/join",
      join_instructions: "Click\nthe link",
      capacity: "8",
    };
    expect(parseHumanEventForm(input)).toEqual(parseEventForm(input));
  });

  it("does not mutate the submitted data", () => {
    const input = { ...base, description: "a\r\nb" };
    human(input);
    parseHumanEventForm(input);
    expect(input.description).toBe("a\r\nb");
  });
});

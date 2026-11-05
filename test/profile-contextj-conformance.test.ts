// RFC 5892 Appendix A.1/A.2 contexts are evaluated in the original input.
// The oracle is the unmodified, licensed Unicode 17.0.0 UCD fixture, not
// Script=Arabic or general-category approximations of Joining_Type.
import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { describe, expect, it } from "vitest";
import { JOINING_LEFT, JOINING_RIGHT, JOINING_TRANSPARENT } from "../src/admin/joining-types";
import { containsControlCharacters } from "../src/admin/validation-shared";
import { validateProfile } from "../src/profiles/validation";

const F = String.fromCodePoint;
const BEH = F(0x0628);
const ALEF = F(0x0627);
const ZWNJ = F(0x200c);
const FAMILY = F(0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467, 0x200d, 0x1f466);
const entries = readFileSync(
  new URL("./fixtures/unicode-17.0.0/DerivedJoiningType.txt", import.meta.url),
  "utf8",
)
  .split("\n")
  .flatMap((line) => {
    const match = /^([0-9A-F]+)(?:\.\.([0-9A-F]+))?\s*;\s*([CDLRT])\s*#/.exec(line);
    if (!match) return [];
    const start = parseInt(match[1]!, 16);
    const end = parseInt(match[2] ?? match[1]!, 16);
    return Array.from({ length: end - start + 1 }, (_, i) => ({
      cp: start + i,
      type: match[3]!,
    }));
  });

// These are independently forbidden by the Cc/bidi/invisible policy, even
// when the UCD calls them transparent. Exempting a joiner must not erase them.
function forbiddenElsewhere(cp: number): boolean {
  return (
    (cp >= 0x202a && cp <= 0x202e) ||
    (cp >= 0x2066 && cp <= 0x2069) ||
    cp === 0x200b ||
    cp === 0xfeff
  );
}

const malformed = [
  `${ALEF}${ZWNJ}${BEH}`, // R cannot be the left joining boundary.
  `${BEH}${ZWNJ}${F(0x0621)}`, // HAMZA is U, not R or D.
  `${BEH}${ZWNJ}${FAMILY}${BEH}`, // Removing emoji must not join the boundaries.
  `${BEH}${FAMILY}${ZWNJ}${BEH}`,
  `${BEH}${F(0x0903)}${ZWNJ}${BEH}`, // Mc is not automatically transparent.
  `${BEH}${ZWNJ}${F(0x0903)}${BEH}`,
  `${BEH}\n${ZWNJ}${BEH}`, // Removing allowed whitespace must not create context.
  `${BEH}${ZWNJ}${ZWNJ}${BEH}`,
  F(0x06a9, 0x062a, 0x0627, 0x200c, 0x0647, 0x0627), // Old misspelled "books" fixture.
];

describe("RFC 5892 joining-type boundaries", () => {
  it("matches the UCD over the entire Unicode code-point space, including default U", () => {
    const oracle = new Uint8Array(0x110000);
    for (const { cp, type } of entries) {
      oracle[cp] = type === "D" ? 3 : type === "L" ? 1 : type === "R" ? 2 : type === "T" ? 4 : 0;
    }
    const mismatches: string[] = [];
    for (let cp = 0; cp < oracle.length; cp++) {
      const char = F(cp);
      const actual =
        Number(JOINING_LEFT.test(char)) |
        (Number(JOINING_RIGHT.test(char)) << 1) |
        (Number(JOINING_TRANSPARENT.test(char)) << 2);
      if (actual !== oracle[cp]) mismatches.push(`U+${cp.toString(16)}`);
    }
    expect(mismatches).toEqual([]);
  });

  it("does not manufacture joining contexts or accept non-joining boundaries", () => {
    for (const value of malformed) {
      expect(containsControlCharacters(value), JSON.stringify(value)).toBe(true);
    }
  });

  it("checks every UCD joining letter in both boundary directions", () => {
    for (const { cp, type } of entries.filter((entry) => "CDLR".includes(entry.type))) {
      // ZWJ has its own contextual rule and cannot serve as a joining letter.
      const label = `U+${cp.toString(16)} (${type})`;
      expect(containsControlCharacters(`${F(cp)}${ZWNJ}${BEH}`), `left ${label}`).toBe(
        type !== "L" && type !== "D",
      );
      expect(containsControlCharacters(`${BEH}${ZWNJ}${F(cp)}`), `right ${label}`).toBe(
        type !== "R" && type !== "D",
      );
    }
  });

  it("skips exactly transparent context without erasing independently forbidden input", () => {
    for (const { cp } of entries.filter((entry) => entry.type === "T")) {
      const label = `U+${cp.toString(16)}`;
      const mark = F(cp);
      const blocked = forbiddenElsewhere(cp);
      expect(containsControlCharacters(`${BEH}${mark}${ZWNJ}${mark}${BEH}`), label).toBe(blocked);
      // A transparent character cannot turn alef's R into an L/D boundary.
      expect(containsControlCharacters(`${ALEF}${ZWNJ}${mark}${BEH}`), label).toBe(true);
    }
  });

  it("preserves valid mixed emoji, Indic, Persian and non-Arabic joining text", () => {
    for (const value of [
      `${FAMILY} ${BEH}${ZWNJ}${BEH} ${FAMILY}`,
      F(0x0915, 0x094d, 0x200d, 0x0930),
      F(0x06a9, 0x062a, 0x0627, 0x0628, 0x200c, 0x0647, 0x0627),
      F(0x0712, 0x200c, 0x0712), // Syriac D boundaries.
      F(0x1820, 0x200c, 0x1820), // Mongolian D boundaries.
      F(0x10ac0, 0x200c, 0x10ac0), // Astral Manichaean D boundaries.
    ]) {
      expect(containsControlCharacters(value)).toBe(false);
      expect(validateProfile({ bio: value, games: [value], timezone: "UTC" })).toEqual({
        ok: true,
        attrs: { bio: value, games: [value], timezone: "UTC" },
      });
    }
  });

  it("refuses malformed contexts in every profile field before trim", () => {
    for (const value of malformed) {
      const valid = { bio: "Hello", games: ["Chess"], timezone: "UTC" };
      expect(validateProfile({ ...valid, bio: value }).ok).toBe(false);
      expect(validateProfile({ ...valid, games: [value] }).ok).toBe(false);
      expect(validateProfile({ ...valid, games_text: value }).ok).toBe(false);
    }
  });
});

// Independently enumerated ccc=9 oracle: UnicodeData 17.0.0, all 69 entries.
// https://www.unicode.org/Public/17.0.0/ucd/UnicodeData.txt
// SHA-256: 2e1efc1dcb59c575eedf5ccae60f95229f706ee6d031835247d843c11d96470c
const ALL_VIRAMAS = [
  0x094d, 0x09cd, 0x0a4d, 0x0acd, 0x0b4d, 0x0bcd, 0x0c4d, 0x0ccd, 0x0d3b, 0x0d3c, 0x0d4d, 0x0dca,
  0x0e3a, 0x0eba, 0x0f84, 0x1039, 0x103a, 0x1714, 0x1715, 0x1734, 0x17d2, 0x1a60, 0x1b44, 0x1baa,
  0x1bab, 0x1bf2, 0x1bf3, 0x2d7f, 0xa806, 0xa82c, 0xa8c4, 0xa953, 0xa9c0, 0xaaf6, 0xabed, 0x10a3f,
  0x11046, 0x11070, 0x1107f, 0x110b9, 0x11133, 0x11134, 0x111c0, 0x11235, 0x112ea, 0x1134d, 0x113ce,
  0x113cf, 0x113d0, 0x11442, 0x114c2, 0x115bf, 0x1163f, 0x116b6, 0x1172b, 0x11839, 0x1193d, 0x1193e,
  0x119e0, 0x11a34, 0x11a47, 0x11a99, 0x11c3f, 0x11d44, 0x11d45, 0x11d97, 0x11f41, 0x11f42, 0x1612f,
];

describe("RFC 5892 virama boundary", () => {
  it("admits both joiners after all 69 viramas, not only the table tail", () => {
    expect(ALL_VIRAMAS).toHaveLength(69);
    for (const cp of ALL_VIRAMAS) {
      for (const joiner of [0x200c, 0x200d]) {
        expect(containsControlCharacters(F(0x61, cp, joiner, 0x62)), `U+${cp.toString(16)}`).toBe(
          false,
        );
      }
      expect(containsControlCharacters(F(cp, 0x200b)), `U+${cp.toString(16)}`).toBe(true);
    }
  });

  it("refuses adjacent non-virama code points for both joiners", () => {
    for (const cp of ALL_VIRAMAS) {
      for (const neighbor of [cp - 1, cp + 1].filter((point) => !ALL_VIRAMAS.includes(point))) {
        for (const joiner of [0x200c, 0x200d]) {
          expect(
            containsControlCharacters(F(0x61, neighbor, joiner, 0x62)),
            `U+${neighbor.toString(16)}`,
          ).toBe(true);
        }
      }
    }
  });
});

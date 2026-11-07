// Shared admin-validation base (W11). Pure move out of `./validation`: the
// error shape every form parser throws, plus the text helpers the event and
// featured leaves share. `./validation` re-exports every public name below,
// so all existing importers keep working untouched; `str`/`fail` stay
// leaf-internal (exported only for the sibling leaves).

import {
  JOINING_LEFT_RANGES,
  JOINING_RIGHT_RANGES,
  JOINING_TRANSPARENT_RANGES,
} from "./joining-types";

/** Field errors keyed by field name, in the form's own terms. */
export type FieldErrors = Record<string, string>;

export class ValidationError extends Error {
  constructor(readonly fields: FieldErrors) {
    super(`invalid input: ${Object.keys(fields).join(", ")}`);
  }
}

export function str(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t === "" ? null : t;
}

export function fail(fields: FieldErrors): never {
  throw new ValidationError(fields);
}

// Legacy NoControlCharacters: allow tab/LF/CR, genuine emoji ZWJ sequences
// and orthographic joiners, but refuse other Cc and invisible/bidi format
// chars.
// Shared with the machine ingress (validateFields) so both writers apply one
// rule; check the raw submitted text, not its trimmed value (trim removes BOM).
//
// Contextual joiners follow RFC 5892 Appendix A.1/A.2: A.1 admits ZWJ and ZWNJ immediately after a virama
// (Canonical_Combining_Class=Virama, e.g. Sinhala RAKAARAANSAYA U+0DCA U+200D
// U+0DBB, Unicode 17.0 section 13.2.1 Table 13-3); A.2 additionally admits
// ZWNJ between joining letters (required for Persian). V8 RegExp has no
// ccc/joining-type property escapes. Use the exact Unicode 17.0.0 joining
// types (generated in ./joining-types), not script/category approximations.
// Context is always read from the original text: removing an emoji or an
// already-admitted joiner must not manufacture a new joining boundary.
// Every UCD entry with Canonical_Combining_Class=Virama (UnicodeData
// 17.0.0): Mn viramas like Sinhala U+0DCA and Mc viramas like Balinese
// U+1B44, Javanese U+A9C0, Grantha U+1134D. Stored as hex deltas off the
// sorted list to keep the Kit server bundle small.
const VIRAMA_DELTAS =
  "94d,80,80,80,80,80,80,80,6e,1,11,7d,70,80,ca,b5,1,6da,1,1f,9e,28e,e4,66,1,47,1,118c,7a87,26,98,8f,6d,136,f7,5e52,607,2a,f,3a,7a,1,8c,75,b5,63,81,1,1,72,80,fd,80,77,75,10e,104,1,a2,54,13,52,1a6,105,1,52,1aa,1,41ed";

// Decode ./joining-types' base-36 "gap,length" pairs into flat [start, end]
// bounds; membership is a binary search.
function decodeRanges(encoded: string): Uint32Array {
  const parts = encoded.split(",");
  const bounds = new Uint32Array(parts.length);
  let cp = 0;
  for (let i = 0; i < parts.length; i += 2) {
    bounds[i] = cp += parseInt(parts[i]!, 36);
    bounds[i + 1] = cp += parseInt(parts[i + 1]!, 36);
    cp++;
  }
  return bounds;
}

function inRanges(bounds: Uint32Array, char: string): boolean {
  const cp = char.codePointAt(0)!;
  let lo = 0;
  let hi = bounds.length / 2 - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cp < bounds[mid * 2]!) hi = mid - 1;
    else if (cp > bounds[mid * 2 + 1]!) lo = mid + 1;
    else return true;
  }
  return false;
}

// Decoded on first use, not at module load: a top-level decode is a side
// effect, so bundles that import this module only for ValidationError or
// str() (Kit client nodes) would have to keep every table.
let tables: {
  viramas: Set<number>;
  left: Uint32Array;
  right: Uint32Array;
  transparent: Uint32Array;
};
function joiningTables(): typeof tables {
  if (tables) return tables;
  const viramas = new Set<number>();
  let cp = 0;
  for (const d of VIRAMA_DELTAS.split(",")) viramas.add((cp += parseInt(d, 16)));
  tables = {
    viramas,
    left: decodeRanges(JOINING_LEFT_RANGES),
    right: decodeRanges(JOINING_RIGHT_RANGES),
    transparent: decodeRanges(JOINING_TRANSPARENT_RANGES),
  };
  return tables;
}

/** Joining_Type L or D (joins toward the following character). */
export const joinsLeft = (char: string): boolean => inRanges(joiningTables().left, char);
/** Joining_Type R or D (joins toward the preceding character). */
export const joinsRight = (char: string): boolean => inRanges(joiningTables().right, char);
/** Joining_Type T (skipped when finding the joining boundaries). */
export const isJoinTransparent = (char: string): boolean =>
  inRanges(joiningTables().transparent, char);

function isAdmitted(chars: string[], i: number): boolean {
  const prev = i > 0 ? chars[i - 1]! : null;
  if (prev !== null && joiningTables().viramas.has(prev.codePointAt(0)!)) return true;
  if (chars[i] !== "\u200C") return false;
  let j = i - 1;
  while (j >= 0 && isJoinTransparent(chars[j]!)) j--;
  let k = i + 1;
  while (k < chars.length && isJoinTransparent(chars[k]!)) k++;
  return j >= 0 && k < chars.length && joinsLeft(chars[j]!) && joinsRight(chars[k]!);
}

// Default_Ignorable_Code_Point (UCD 17.0.0 DerivedCoreProperties) minus the
// joiners and variation selectors handled below, plus the interlinear
// annotation controls: bidi controls and marks (LRM, RLM, ALM), ZWSP, BOM,
// soft hyphen, CGJ, word joiner and invisible operators, Hangul fillers,
// Khmer inherent vowels, Mongolian vowel separator and tag characters. A tag
// is admitted only inside an emoji subdivision flag (U+1F3F4, 2-6 tag
// letters or digits, CANCEL TAG); TAG_FLAG removes those before the test.
const INVISIBLE =
  /[\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180E\u200B\u200E\u200F\u202A-\u202E\u2060-\u206F\u3164\uFEFF\uFFA0\uFFF0-\uFFFB\u{1BCA0}-\u{1BCA3}\u{1D173}-\u{1D17A}\u{E0000}-\u{E00FF}\u{E01F0}-\u{E0FFF}]/u;
const TAG_FLAG = /\u{1F3F4}[\u{E0030}-\u{E0039}\u{E0061}-\u{E007A}]{2,6}\u{E007F}/gu;
// A variation selector (standardized, ideographic or Mongolian FVS) must
// follow a base character: a leading or stacked run is invisible and can
// carry hidden data.
const STACKED_SELECTOR =
  /(?:^|[\uFE00-\uFE0F\u180B-\u180D\u180F\u{E0100}-\u{E01EF}])[\uFE00-\uFE0F\u180B-\u180D\u180F\u{E0100}-\u{E01EF}]/u;

export function containsControlCharacters(value: string): boolean {
  const stripped = value.replace(/[\t\n\r]/g, "");
  if (/\p{Cc}/u.test(stripped)) return true;
  if (INVISIBLE.test(value.replace(TAG_FLAG, ""))) return true;
  if (STACKED_SELECTOR.test(value)) return true;
  if (!/[\u200C\u200D]/u.test(value)) return false;

  // Record only the ZWJ offsets admitted by complete emoji matches, without
  // deleting anything. Emoji and orthographic contexts see identical input.
  const emojiJoiners = new Set<number>();
  for (const match of value.matchAll(
    /(?:\p{Extended_Pictographic}[\u{FE00}-\u{FE0F}\p{Mn}\p{Me}\p{Sk}\u{E0020}-\u{E007F}]*\u{200D})+\p{Extended_Pictographic}[\u{FE00}-\u{FE0F}\p{Mn}\p{Me}\p{Sk}\u{E0020}-\u{E007F}]*/gu,
  )) {
    for (let i = match.index; i < match.index + match[0].length; i++) {
      if (value[i] === "\u200D") emojiJoiners.add(i);
    }
  }
  const chars = Array.from(value);
  let offset = 0;
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i]!;
    if (
      (ch === "\u200C" || ch === "\u200D") &&
      !emojiJoiners.has(offset) &&
      !isAdmitted(chars, i)
    ) {
      return true;
    }
    offset += ch.length;
  }
  return false;
}

// Shared admin-validation base (W11). Pure move out of `./validation`: the
// error shape every form parser throws, plus the text helpers the event and
// featured leaves share. `./validation` re-exports every public name below,
// so all existing importers keep working untouched; `str`/`fail` stay
// leaf-internal (exported only for the sibling leaves).

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
// and orthographic joiners, but refuse other Cc and targeted invisible/bidi
// format chars.
// Shared with the machine ingress (validateFields) so both writers apply one
// rule; check the raw submitted text, not its trimmed value (trim removes BOM).
//
// Contextual joiners follow RFC 5892 Appendix A.1/A.2, the standard the
// reviewer asked for: A.1 admits ZWJ and ZWNJ immediately after a virama
// (Canonical_Combining_Class=Virama, e.g. Sinhala RAKAARAANSAYA U+0DCA U+200D
// U+0DBB, Unicode 17.0 section 13.2.1 Table 13-3); A.2 additionally admits
// ZWNJ between joining letters (required for Persian). V8 RegExp has no
// ccc/joining-type property escapes, so the virama context is an explicit
// code-point set (every UCD entry with ccc=9, Mn and Mc alike, taken from
// UnicodeData 17.0.0) and the joining context is an Arabic-script letter on
// each side (Script=Arabic plus General_Category Letter, approximating
// Joining_Type L/D before and R/D after) with combining marks skipped as the
// transparent run. A lone joiner between Latin letters still refuses below.
const VIRAMA_CHARS =
  "\u{094D}\u{09CD}\u{0A4D}\u{0ACD}\u{0B4D}\u{0BCD}\u{0C4D}\u{0CCD}\u{0D3B}\u{0D3C}\u{0D4D}\u{0DCA}\u{0E3A}\u{0EBA}\u{0F84}\u{1039}\u{103A}\u{1714}\u{1715}\u{1734}\u{17D2}\u{1A60}\u{1B44}\u{1BAA}\u{1BAB}\u{1BF2}\u{1BF3}\u{2D7F}\u{A806}\u{A82C}\u{A8C4}\u{A953}\u{A9C0}\u{AAF6}\u{ABED}\u{10A3F}\u{11046}\u{11070}\u{1107F}\u{110B9}\u{11133}\u{11134}\u{111C0}\u{11235}\u{112EA}\u{1134D}\u{113CE}\u{113CF}\u{113D0}\u{11442}\u{114C2}\u{115BF}\u{1163F}\u{116B6}\u{1172B}\u{11839}\u{1193D}\u{1193E}\u{119E0}\u{11A34}\u{11A47}\u{11A99}\u{11C3F}\u{11D44}\u{11D45}\u{11D97}\u{11F41}\u{11F42}\u{1612F}";
const VIRAMA_SET = new Set(Array.from(VIRAMA_CHARS));

function isArabicJoiningLetter(ch: string): boolean {
  return /\p{Script=Arabic}/u.test(ch) && /\p{L}/u.test(ch);
}

function isTransparentMark(ch: string): boolean {
  return /\p{M}/u.test(ch);
}

// Drop only the joiners the contextual rules admit; every other joiner
// stays for the refusal test below. A loop (not one global replace) keeps
// every occurrence covered no matter how many clusters a value carries.
function withoutContextualJoiners(value: string): string {
  const chars = Array.from(value);
  const drop = new Array<boolean>(chars.length).fill(false);
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i]!;
    if (ch !== "\u200C" && ch !== "\u200D") continue;
    const prev = i > 0 ? chars[i - 1]! : null;
    if (prev !== null && VIRAMA_SET.has(prev)) {
      drop[i] = true;
      continue;
    }
    if (ch === "\u200C") {
      let j = i - 1;
      while (j >= 0 && isTransparentMark(chars[j]!)) j--;
      let k = i + 1;
      while (k < chars.length && isTransparentMark(chars[k]!)) k++;
      if (
        j >= 0 &&
        k < chars.length &&
        isArabicJoiningLetter(chars[j]!) &&
        isArabicJoiningLetter(chars[k]!)
      ) {
        drop[i] = true;
      }
    }
  }
  return chars.filter((_, idx) => !drop[idx]).join("");
}

export function containsControlCharacters(value: string): boolean {
  const stripped = value.replace(/[\t\n\r]/g, "");
  if (/\p{Cc}/u.test(stripped)) return true;
  // Match the original text: removing whitespace can manufacture an emoji.
  const withoutEmojiJoiners = value.replace(
    /(?:\p{Extended_Pictographic}[\u{FE00}-\u{FE0F}\p{Mn}\p{Me}\p{Sk}\u{E0020}-\u{E007F}]*\u{200D})+\p{Extended_Pictographic}[\u{FE00}-\u{FE0F}\p{Mn}\p{Me}\p{Sk}\u{E0020}-\u{E007F}]*/gu,
    "",
  );
  const withoutOrthographicJoiners = withoutContextualJoiners(withoutEmojiJoiners);
  return /[\u{202A}-\u{202E}\u{2066}-\u{2069}\u{200B}-\u{200D}\u{FEFF}]/u.test(
    withoutOrthographicJoiners,
  );
}

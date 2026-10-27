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
// Every UCD entry with Canonical_Combining_Class=Virama (UnicodeData
// 17.0.0): Mn viramas like Sinhala U+0DCA and Mc viramas like Balinese
// U+1B44, Javanese U+A9C0, Grantha U+1134D. Stored as hex deltas off the
// sorted list to keep the Kit server bundle small; decoded once at load.
const VIRAMA_DELTAS =
  "94d,80,80,80,80,80,80,80,6e,1,11,7d,70,80,ca,b5,1,6da,1,1f,9e,28e,e4,66,1,47,1,118c,7a87,26,98,8f,6d,136,f7,5e52,607,2a,f,3a,7a,1,8c,75,b5,63,81,1,1,72,80,fd,80,77,75,10e,104,1,a2,54,13,52,1a6,105,1,52,1aa,1,41ed";
const VIRAMAS = new Set<number>();
{
  let cp = 0;
  for (const d of VIRAMA_DELTAS.split(",")) VIRAMAS.add((cp += parseInt(d, 16)));
}

function isJoiningLetter(ch: string): boolean {
  return /\p{Script=Arabic}/u.test(ch) && /\p{L}/u.test(ch);
}

// Drop only the joiners the contextual rules admit; every other joiner
// stays for the refusal test below. A loop (not one global replace) keeps
// every occurrence covered no matter how many clusters a value carries.
function withoutContextualJoiners(value: string): string {
  const chars = Array.from(value);
  let out = "";
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i]!;
    if ((ch !== "\u200C" && ch !== "\u200D") || !isAdmitted(chars, i)) out += ch;
  }
  return out;
}

function isAdmitted(chars: string[], i: number): boolean {
  const prev = i > 0 ? chars[i - 1]! : null;
  if (prev !== null && VIRAMAS.has(prev.codePointAt(0)!)) return true;
  if (chars[i] !== "\u200C") return false;
  let j = i - 1;
  while (j >= 0 && /\p{M}/u.test(chars[j]!)) j--;
  let k = i + 1;
  while (k < chars.length && /\p{M}/u.test(chars[k]!)) k++;
  return j >= 0 && k < chars.length && isJoiningLetter(chars[j]!) && isJoiningLetter(chars[k]!);
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

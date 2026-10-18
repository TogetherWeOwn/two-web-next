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

// Legacy NoControlCharacters: allow tab/LF/CR and genuine emoji ZWJ
// sequences, but refuse other Cc and targeted invisible/bidi format chars.
// Shared with the machine ingress (validateFields) so both writers apply one
// rule; check the raw submitted text, not its trimmed value (trim removes BOM).
export function containsControlCharacters(value: string): boolean {
  const stripped = value.replace(/[\t\n\r]/g, "");
  if (/\p{Cc}/u.test(stripped)) return true;
  // Match the original text: removing whitespace can manufacture an emoji.
  const withoutEmojiJoiners = value.replace(
    /(?:\p{Extended_Pictographic}[\u{FE00}-\u{FE0F}\p{Mn}\p{Me}\p{Sk}\u{E0020}-\u{E007F}]*\u{200D})+\p{Extended_Pictographic}[\u{FE00}-\u{FE0F}\p{Mn}\p{Me}\p{Sk}\u{E0020}-\u{E007F}]*/gu,
    "",
  );
  return /[\u{202A}-\u{202E}\u{2066}-\u{2069}\u{200B}-\u{200D}\u{FEFF}]/u.test(withoutEmojiJoiners);
}

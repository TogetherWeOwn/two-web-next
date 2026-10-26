// Matching-input normalization, shared by SQL reads and presentation without
// importing logging or database modules into static-page renderer graphs.

/** NUL is rejected by PostgreSQL text parameters; HTML preprocessing turns
 * CR/CRLF into LF. Preserve case and internal whitespace for literal matching. */
export function matchQuery(raw: string | null | undefined): string | null {
  const text = (raw ?? "")
    .replace(/\u0000/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .trim();
  return text === "" ? null : text;
}

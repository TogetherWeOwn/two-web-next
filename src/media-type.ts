// Shared media-type helpers: response selection and request admission must agree
// on what counts as JSON. Media types are case-insensitive (RFC 2045 §5.1) and
// may carry `;` parameters. Accept is a comma-separated list of media ranges;
// a parameter value may itself be a quoted string containing commas, semicolons
// or escaped quotes, so splitting must respect quotes.
export const mediaType = (value: string | null | undefined): string => {
  const input = value ?? "";
  let inQuotes = false;
  let escaped = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\" && inQuotes) {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (ch === ";" && !inQuotes) return input.slice(0, i).trim().toLowerCase();
  }
  return input.trim().toLowerCase();
};

export const isJsonMediaType = (value: string | null | undefined): boolean =>
  mediaType(value) === "application/json";

// Split an Accept header on commas that sit outside quoted parameter values.
// A backslash inside quotes escapes the next character (e.g. `\"`), so an
// escaped quote never toggles the quoted state.
export const splitAcceptRanges = (value: string | null | undefined): string[] => {
  const input = value ?? "";
  const out: string[] = [];
  let current = "";
  let inQuotes = false;
  let escaped = false;
  for (const ch of input) {
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\" && inQuotes) {
      current += ch;
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inQuotes = !inQuotes;
      current += ch;
      continue;
    }
    if (ch === "," && !inQuotes) {
      out.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  out.push(current);
  return out;
};

// Response selection mirrors request admission: a range selects JSON only when
// its type/subtype is exactly application/json. Substring lookalikes
// (application/jsonx, x-application/json, quoted parameter notes) stay on the
// HTML path. Preference weighting and wildcards are unchanged: any exact JSON
// range selects JSON, anything else keeps the native HTML contract.
export const acceptsJson = (value: string | null | undefined): boolean =>
  splitAcceptRanges(value).some((range) => mediaType(range) === "application/json");

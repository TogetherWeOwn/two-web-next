// Accept parsing follows Hono 4.13.18's utils/accept.ts. Only media type and
// quality are needed here; other parameters still affect where a range ends.
const isWhitespace = (char: string) => char !== "" && " \t\r\n".includes(char);

function skipWhitespace(header: string, index: number): number {
  while (isWhitespace(header.charAt(index))) index++;
  return index;
}

function trimEnd(header: string, start: number, end: number): string {
  while (end > start && isWhitespace(header.charAt(end - 1))) end--;
  return header.slice(start, end);
}

function scanTo(header: string, start: number, delimiters: string, escaped = false): number {
  for (let i = start; i < header.length; i++) {
    const char = header.charAt(i);
    if (escaped && char === "\\") i++;
    else if (delimiters.includes(char)) return i;
  }
  return header.length;
}

function readParameterValue(header: string, start: number): [value: string, end: number] {
  if (header.charAt(start) === "=") return ["", scanTo(header, start + 1, ";,")];
  const end = scanTo(header, start, ';,"');
  if (header.charAt(end) !== '"') return [trimEnd(header, start, end), end];

  const close = scanTo(header, end + 1, '"', true);
  if (close === header.length) return [trimEnd(header, start, close), close];
  const next = skipWhitespace(header, close + 1);
  if (next < header.length && !";,".includes(header.charAt(next))) {
    return ["", scanTo(header, next, ";,")];
  }
  return [header.slice(start + 1, close).replace(/\\(.)/g, "$1"), next];
}

function parseQuality(value: string | undefined): number {
  const q = value === "NaN" ? 0 : Number(value);
  return Number.isNaN(q) ? 1 : Math.min(1, Math.max(0, q));
}

function parseRanges(header: string) {
  const ranges: { type: string; q: number }[] = [];
  let i = 0;
  while (i < header.length) {
    const start = skipWhitespace(header, i);
    i = scanTo(header, start, ";,");
    const type = trimEnd(header, start, i).toLowerCase();
    if (!type && header.charAt(i) === ";") {
      // A missing media type discards the range up to the next unquoted comma.
      i = scanTo(header, i + 1, ',"');
      while (header.charAt(i) === '"') {
        i = scanTo(header, scanTo(header, i + 1, '"', true) + 1, ',"');
      }
    } else {
      let q: string | undefined;
      let upperQ: string | undefined;
      while (header.charAt(i) === ";") {
        const keyStart = skipWhitespace(header, i + 1);
        i = scanTo(header, keyStart, "=;,");
        if (header.charAt(i) !== "=") continue;
        const key = trimEnd(header, keyStart, i);
        const [value, end] = readParameterValue(header, skipWhitespace(header, i + 1));
        i = end;
        if (value && key === "q") q = value;
        if (value && key === "Q") upperQ = value;
      }
      if (type) ranges.push({ type, q: parseQuality(q ?? upperQ) });
    }
    i++;
  }
  // Preserve parser order for equal quality, including duplicate media ranges.
  return ranges.sort((a, b) => b.q - a.q);
}

const ERROR_TYPES = ["text/html", "application/json"] as const;

export function negotiateErrorAccept(accept: string | null | undefined) {
  const ranges = parseRanges(accept ?? "");
  const candidates = ERROR_TYPES.map((type) => {
    let specificity = -1;
    let q = 0;
    let order = ranges.length;
    const wildcard = `${type.split("/")[0]}/*`;
    // An exact q=0 still overrides a positive wildcard for that type.
    ranges.forEach((range, index) => {
      const rank =
        range.type === type ? 2 : range.type === wildcard ? 1 : range.type === "*/*" ? 0 : -1;
      if (rank > specificity) {
        specificity = rank;
        q = range.q;
        order = index;
      }
    });
    return { type, q, specificity, order };
  });
  const html = candidates[0]!;
  candidates.sort((a, b) => b.q - a.q || b.specificity - a.specificity || a.order - b.order);
  const preferred = candidates[0]!;
  const type = preferred.q > 0 ? preferred.type : "text/html";
  return { type, prefersHtml: type === "text/html" && html.q > 0 && html.specificity === 2 };
}

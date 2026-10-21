// Fail-loud JSON-lines parser for alert/log assertions.
//
// Console spies capture every `console.error` call; a silent `try/catch → null`
// around `JSON.parse` lets a non-JSON line slip through and the suite still
// passes on the filtered subset. This helper splits the calls into `parsed`
// (single-string args that parse) and `skipped` (anything else), so each
// caller can `expect(skipped).toEqual([])` and a stray line fails the suite
// instead of passing.
export type ParsedJsonLine = {
  raw: string;
  value: unknown;
};

export type SkippedJsonLine = {
  raw: string;
  reason: string;
};

export function parseJsonLines(calls: unknown[][]): {
  parsed: ParsedJsonLine[];
  skipped: SkippedJsonLine[];
} {
  const parsed: ParsedJsonLine[] = [];
  const skipped: SkippedJsonLine[] = [];
  for (const args of calls) {
    // Multi-arg calls (e.g. console.error("agent-events failed", { exception })) are
    // plain-text implementation logs, not JSON-line candidates: ignore them
    // here. Only a single-string call must parse, so a stray non-JSON line in
    // that shape lands in `skipped` and the caller's `expect(skipped).toEqual`
    // fails the suite instead of passing on the filtered subset.
    if (args.length !== 1) continue;
    if (typeof args[0] !== "string") {
      skipped.push({ raw: String(args[0]), reason: "expected a single string log line" });
      continue;
    }
    const raw = args[0] as string;
    try {
      parsed.push({ raw, value: JSON.parse(raw) as unknown });
    } catch (error) {
      skipped.push({
        raw,
        reason: error instanceof Error ? error.message : "unparseable log line",
      });
    }
  }
  return { parsed, skipped };
}

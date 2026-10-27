// Presentation only: SQL remains the matching authority, including when its
// collation finds a match that JavaScript cannot faithfully locate.
export interface SearchSegment {
  text: string;
  match: boolean;
}

type Span = { start: number; end: number };
const PASSAGE_POINTS = 318; // Leave room for an ellipsis at each end (320 total).

function locate(points: string[], query: string): Span[] {
  const needle = query.toLowerCase();
  if (!needle) return [];
  const folded = points.join("").toLowerCase();
  const boundaries = new Map<number, number>([[0, 0]]);
  let offset = 0;
  for (let i = 0; i < points.length; i++) {
    offset += points[i]!.toLowerCase().length;
    boundaries.set(offset, i + 1);
  }
  const spans: Span[] = [];
  let cursor = 0;
  while (cursor < folded.length) {
    const found = folded.indexOf(needle, cursor);
    if (found === -1) break;
    const start = boundaries.get(found);
    const end = boundaries.get(found + needle.length);
    // Folding can expand a character (İ → i + combining dot). Only mark
    // complete original code points whose actual text independently matches.
    if (
      start !== undefined &&
      end !== undefined &&
      points.slice(start, end).join("").toLowerCase() === needle
    ) {
      spans.push({ start, end });
      cursor = found + needle.length;
    } else {
      cursor = found + 1;
    }
  }
  return spans;
}

/** Escaped-text segments for a full title or a bounded description passage.
 * The caller supplies the already-normalized literal query, never HTML. */
export function searchContext(text: string, query: string, passage = false): SearchSegment[] {
  if (!query) return [{ text, match: false }];
  const points = Array.from(text);
  const spans = locate(points, query);
  let start = 0;
  let end = points.length;
  if (passage && end > PASSAGE_POINTS) {
    const first = spans[0];
    if (first) {
      const padding = Math.floor((PASSAGE_POINTS - (first.end - first.start)) / 2);
      start = Math.max(0, Math.min(first.start - padding, end - PASSAGE_POINTS));
      // Prefer the matching sentence over unrelated preceding sentences, while
      // keeping the entire match inside the same bounded Unicode window.
      for (let i = start; i < first.start; i++) {
        if ([".", "!", "?", "\n"].includes(points[i]!)) start = i + 1;
      }
      while (start < first.start && points[start]!.trim() === "") start++;
    }
    end = Math.min(points.length, start + PASSAGE_POINTS);
  }
  const segments: SearchSegment[] = [];
  if (start) segments.push({ text: "…", match: false });
  let cursor = start;
  for (const span of spans) {
    if (span.start < start || span.end > end) continue;
    if (span.start > cursor)
      segments.push({ text: points.slice(cursor, span.start).join(""), match: false });
    segments.push({ text: points.slice(span.start, span.end).join(""), match: true });
    cursor = span.end;
  }
  if (cursor < end) segments.push({ text: points.slice(cursor, end).join(""), match: false });
  if (end < points.length) segments.push({ text: "…", match: false });
  return segments;
}

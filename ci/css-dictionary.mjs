// Deterministic build-time packing for generated inline stylesheets. Dictionary
// entries contain ASCII only, so markers cannot occur inside an expansion.
const FIRST_MARKER = 0x80;
const MAX_ENTRIES = 80;
const MAX_INPUT_LENGTH = 100_000;
const MAX_CANDIDATE_VISITS = 12_000_000;
const MAX_UNIQUE_CANDIDATES = 20_000;
const LENGTHS = [4, 8, 12, 16, 20, 24];

function size(value) {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

export function packCss(css) {
  if (css.length > MAX_INPUT_LENGTH || /[\u0080-Ï]/u.test(css)) {
    throw new Error("CSS is too large or contains reserved dictionary markers");
  }
  let packed = css;
  const dictionary = [];
  let visits = 0;
  while (dictionary.length < MAX_ENTRIES) {
    // A partial scan must never affect the selected entry or truncate the CSS.
    const roundVisits = LENGTHS.reduce(
      (sum, length) => sum + Math.max(0, packed.length - length + 1),
      0,
    );
    if (visits + roundVisits > MAX_CANDIDATE_VISITS) break;
    visits += roundVisits;
    let best = null;
    let bestSaving = 0;
    let bestStart = Infinity;
    let bestLengthIndex = Infinity;
    const marker = String.fromCharCode(FIRST_MARKER + dictionary.length);
    const markerSize = size(marker);
    for (const [lengthIndex, length] of LENGTHS.entries()) {
      const counts = new Map();
      for (let start = 0; start + length <= packed.length; start++) {
        const candidate = packed.slice(start, start + length);
        if (!/^[\x20-\x7e]+$/u.test(candidate)) continue;
        const previous = counts.get(candidate);
        if (!previous) {
          if (counts.size === MAX_UNIQUE_CANDIDATES) return { packed, dictionary };
          counts.set(candidate, { count: 1, end: start + length, start });
        } else if (start >= previous.end) {
          previous.count++;
          previous.end = start + length;
        }
      }
      for (const [candidate, { count, start }] of counts) {
        const entrySize = size(candidate);
        const saving = count * (entrySize - markerSize) - entrySize - 1;
        if (
          saving > bestSaving ||
          (saving === bestSaving &&
            saving > 0 &&
            (start < bestStart || (start === bestStart && lengthIndex < bestLengthIndex)))
        ) {
          best = candidate;
          bestSaving = saving;
          bestStart = start;
          bestLengthIndex = lengthIndex;
        }
      }
    }
    if (best === null) break;
    const next = packed.split(best).join(marker);
    if (size([next, [...dictionary, best]]) >= size([packed, dictionary])) break;
    packed = next;
    dictionary.push(best);
  }
  return { packed, dictionary };
}

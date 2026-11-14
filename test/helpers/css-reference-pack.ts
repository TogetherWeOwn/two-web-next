// Position-first reference for small fixtures; independent of the production packer.
export function referencePack(css: string, budget?: { visits: number; exhausted: boolean }) {
  let packed = css;
  const dictionary: string[] = [];
  const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");
  while (dictionary.length < 80) {
    const roundVisits = [4, 8, 12, 16, 20, 24].reduce(
      (total, length) => total + Math.max(0, packed.length - length + 1),
      0,
    );
    if (budget && budget.visits < roundVisits) {
      budget.exhausted = true;
      break;
    }
    if (budget) budget.visits -= roundVisits;
    const counts = new Map<string, { count: number; end: number }>();
    for (let start = 0; start < packed.length; start++) {
      for (const length of [4, 8, 12, 16, 20, 24]) {
        if (start + length > packed.length) break;
        const candidate = packed.slice(start, start + length);
        if (!/^[\x20-\x7e]+$/u.test(candidate)) break;
        const previous = counts.get(candidate);
        if (!previous) counts.set(candidate, { count: 1, end: start + length });
        else if (start >= previous.end) {
          previous.count++;
          previous.end = start + length;
        }
      }
    }
    let best: string | null = null;
    let bestSaving = 0;
    const marker = String.fromCharCode(0x80 + dictionary.length);
    for (const [candidate, { count }] of counts) {
      const entrySize = size(candidate);
      const saving = count * (entrySize - size(marker)) - entrySize - 1;
      if (saving > bestSaving) {
        best = candidate;
        bestSaving = saving;
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
